// webxdc-manager.js — opens webxdc apps in a sandboxed iframe and relays
// the webxdc API between the iframe (via postMessage) and the core
// (status updates, app info). The iframe is served by the webxdc://
// protocol handler in the Rust layer, which also injects the shim that
// defines window.webxdc inside the app.

import { CLOSE_SVG, toast, confirmModal } from "./ui.js";
import { LruCache } from "./lru.js";
import { wantsPanel } from "./webxdc-panel.js";
import { tauriInvoke } from "./tauri.js";
import { base64ToBytes } from "./identity-backup.js";
import { currentGroupCall, routeRealtime, routeStatusUpdate, joinGroupCall, leaveGroupCall, setGroupCallMuted, onGroupCallChange } from "./group-call-host.js";
import { trustedAppName } from "./xdc-trust.js";
import { askGroupCallConsent, groupCallEnv, oneToOneCallActive, setCallScreen } from "./group-call-ui.js";
import { cleanTitle } from "./group-call-signal.js";

let core = null;
export const WEBXDC_FRAME_ALLOW =
  "autoplay; microphone 'none'; camera 'none'; display-capture 'none'; geolocation 'none'";
let active = null; // { msgId, iframe, serial, realtime }
// Spec limit for one realtime payload (webxdc.d.ts: 128 000 bytes); the
// core's gossip caps a message at 128 KiB including its own trailer.
export const REALTIME_MAX = 128000;
// serials stays a plain Map: it is the delivered-serial watermark; evicting
// one would restart delivery at 0 and re-post old updates to an app. It is
// one number per opened/updated app, dropped on instance delete and cleared
// on account switch.
const serials = new Map(); // msgId -> last delivered serial
// Bounded (lru.js): 100 apps / 2 MB; a miss just re-asks the core.
const infoCache = new LruCache({ maxItems: 100, maxBytes: 2 * 1024 * 1024,
  sizeOf: (v) => JSON.stringify(v || {}).length * 2 }); // msgId -> info object

// Wasm PWA host (no Tauri shell): apps run through the service worker's
// webxdc route (app/webxdc-host/sw-route.js + frame.js, Step A of
// docs/research/beam-pwa-research.md).
export function isPwaHost() {
  return typeof window !== "undefined" && !window.__TAURI__ && !!window.VELTA_PWA?.wasmCore;
}

// Realtime channels need the core's iroh peer channels, which the wasm
// core does not run yet (Step B). Apps see `veltaRealtime: false` in
// getInfo and realtimeJoin rejects with REALTIME_UNAVAILABLE.
export const REALTIME_UNAVAILABLE = "Direct transfer (realtime channels) is not available in the Velta web app yet";
export function realtimeAvailable() {
  return !isPwaHost();
}

// The iframe origin depends on the platform: Windows and Android serve
// custom protocols at http://<scheme>.localhost, mac/linux at <scheme>://.
// The PWA serves <scope>webxdc-run/<account>/... from its service worker.
function baseFor(accountId) {
  if (isPwaHost()) return new URL(`webxdc-run/${accountId}`, document.baseURI).href;
  const ua = navigator.userAgent || "";
  if (/Windows|Android/.test(ua)) return `http://webxdc.localhost/${accountId}`;
  return `webxdc://localhost/${accountId}`;
}

export function initWebxdc(coreInstance) {
  core = coreInstance;
  core.addEventListener("webxdc-status-update", (e) => {
    const d = e?.detail || {};
    handleStatusUpdate(Number(d.msgId), Number(d.serial) || 0);
    routeStatusUpdate(d.msgId, d.serial); // a live group call in this instance (group-call-host.js)
  });
  core.addEventListener("webxdc-instance-deleted", (e) => {
    const d = e?.detail || {};
    if (active && active.msgId === Number(d.msgId)) closeWebxdc();
    serials.delete(Number(d.msgId));
  });
  core.addEventListener("webxdc-realtime-data", (e) => {
    const d = e?.detail || {};
    // KEEP: group-call frames ("VGC1") go to the host's call, never to the app.
    if (routeRealtime(d.msgId, d.data)) return;
    if (!active?.realtime || active.msgId !== Number(d.msgId)) return;
    post({ type: "velta-webxdc-realtime", data: Uint8Array.from(d.data || []) });
  });
  core.addEventListener("account-changing", () => {
    closeWebxdc();
    serials.clear();
    infoCache.clear(); // msg ids are per-account
  });
}

async function handleStatusUpdate(msgId, serial) {
  if (!active || active.msgId !== msgId) {
    // No app open: remember that updates exist so a later open starts fresh.
    serials.set(msgId, Math.max(serials.get(msgId) || 0, 0));
    return;
  }
  const last = active.serial || 0;
  if (serial <= last) return; // already delivered
  const { updates, serial: maxSerial } = await fetchUpdates(msgId, last);
  if (!active || active.msgId !== msgId) return;
  active.serial = maxSerial;
  serials.set(msgId, maxSerial);
  post({ type: "velta-webxdc-status-updates", updates, serial: maxSerial, done: true });
}

async function fetchUpdates(msgId, since) {
  const raw = await core.getWebxdcStatusUpdates(msgId, since);
  let updates = [];
  try { updates = JSON.parse(raw) || []; } catch { updates = []; }
  let maxSerial = since;
  for (const u of updates) maxSerial = Math.max(maxSerial, u.serial || 0);
  return { updates, serial: maxSerial };
}

function post(payload) {
  try { active?.iframe?.contentWindow?.postMessage(payload, "*"); } catch {}
}

// The whole update object goes to core verbatim (both hosts: native shim
// and PWA frame share this bridge), so `info`, `summary`, `document`,
// `href` and `notify` reach send_webxdc_status_update — core creates the
// WebxdcInfoMessage from `info` and stores `href` on it.
export async function sendStatusUpdate(c, msgId, params) {
  const update = params?.update;
  if (typeof update !== "object" || update === null || Array.isArray(update)) throw new Error("update must be an object");
  await c.sendWebxdcStatusUpdate(msgId, JSON.stringify(update), params?.description || null);
}

async function handleCall(data) {
  const msgId = active?.msgId;
  switch (data.method) {
    case "getInfo": {
      const info = await getInfo(msgId);
      return { name: info.name, document: info.document || "", summary: info.summary || "",
        sourceCodeUrl: info.sourceCodeUrl || "", selfAddr: info.selfAddr || "",
        selfName: info.selfName || "", sendUpdateInterval: info.sendUpdateInterval ?? 1000,
        sendUpdateMaxSize: info.sendUpdateMaxSize ?? 0, veltaRealtime: realtimeAvailable(),
        ...((await activeTrust()) === "group-call" ? { veltaCall: true, veltaTheme: themeTokens() } : { veltaCall: false }) };
    }
    case "getAllUpdates": {
      const { updates } = await fetchUpdates(msgId, 0);
      return { updates };
    }
    case "getStatusUpdates": {
      const since = Number(data.params?.serial) || 0;
      const { updates, serial } = await fetchUpdates(msgId, since);
      active.serial = Math.max(active.serial || 0, serial);
      serials.set(msgId, serial);
      return { updates, serial };
    }
    case "sendUpdate": {
      await sendStatusUpdate(core, msgId, data.params);
      return {};
    }
    // Realtime channel (joinRealtimeChannel in the shim): join = advertise
    // on the instance's iroh-gossip topic (core sends the hidden
    // advertisement mail); data rides send_webxdc_realtime_data; leave on
    // app close too. Peers arrive via WebxdcRealtimeData events above.
    case "realtimeJoin": {
      if (!realtimeAvailable()) throw new Error(REALTIME_UNAVAILABLE);
      if (!core.sendWebxdcRealtimeAdvertisement) throw new Error("realtime channels are not available");
      await core.sendWebxdcRealtimeAdvertisement(msgId);
      if (active?.msgId === msgId) active.realtime = true;
      return {};
    }
    case "realtimeSend": {
      if (!active?.realtime) throw new Error("realtime channel not joined");
      const bytes = realtimeBytes(data.params?.data);
      await core.sendWebxdcRealtimeData(msgId, Array.from(bytes));
      return {};
    }
    case "realtimeLeave": {
      if (active?.realtime && active.msgId === msgId) {
        active.realtime = false;
        if (currentGroupCall()?.msgId !== msgId) await core.leaveWebxdcRealtime(msgId).catch(() => {});
      }
      return {};
    }
    // PWA loader (webxdc-host/frame.js) asks for the app archive once per
    // page load; only the open app's own frame gets an answer (onWindowMessage
    // checks the source), and only for the open instance.
    // Group calls (docs/agents/group-calls.md): ONLY the trusted bundle may
    // drive the host's call; the host asks for consent and owns the mic.
    case "veltaCallJoin":
    case "veltaCallLeave":
    case "veltaCallMute":
    case "veltaCallState": {
      if ((await activeTrust()) !== "group-call") throw new Error("not available for this app");
      if (data.method === "veltaCallState") return callStateFor(msgId);
      if (data.method === "veltaCallMute") { if (currentGroupCall()?.msgId === msgId) setGroupCallMuted(!!data.params?.muted); return callStateFor(msgId); }
      if (data.method === "veltaCallLeave") { if (currentGroupCall()?.msgId === msgId) await leaveGroupCall(); return callStateFor(msgId); }
      await joinCallFromApp(msgId);
      return callStateFor(msgId);
    }
    case "veltaBundle":
      return { xdc: await readXdcArchive(msgId) };
    case "sendToChat":
      return sendToChat(data.params || {});
    case "importFiles":
      return importFiles((data.params || {}).filters);
    default:
      throw new Error(`unknown webxdc method: ${data.method}`);
  }
}

// --- group calls -------------------------------------------------------
const trustCache = new Map(); // msgId -> Promise<name|null>
function trustFor(msgId) {
  if (!trustCache.has(msgId)) {
    const p = readAppBytes(msgId).then((b) => trustedAppName(b), () => null);
    trustCache.set(msgId, p);
    p.then((v) => { if (v === null) trustCache.delete(msgId); }); // retry later (file not there yet)
  }
  return trustCache.get(msgId);
}
async function activeTrust() {
  return active?.trust ? active.trust : null;
}
// Design-system tokens the call screen uses, with the live (theme + custom
// accent) values, so the iframe matches the host without its own palette.
export const CALL_THEME_TOKENS = ["--bg", "--bg-sidebar", "--bg-hover", "--bg-active", "--bg-bubble-in", "--accent", "--accent-hover",
  "--on-accent", "--accent-text", "--text", "--text-dim", "--green", "--danger", "--border", "--shadow", "--radius-bubble"];
function themeTokens() {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const k of CALL_THEME_TOKENS) { const v = cs.getPropertyValue(k).trim(); if (v) out[k] = v; }
  out["color-scheme"] = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  return out;
}
/** Is this instance the trusted built-in group-call app? (chat cards) */
export async function isGroupCallApp(msgId) {
  return (await trustFor(Number(msgId))) === "group-call";
}
/** Join from the chat card (no app frame needed). */
export async function joinGroupCallFor(msgId) {
  msgId = Number(msgId);
  if (!(await isGroupCallApp(msgId))) throw new Error("not a Velta group call");
  await joinCallFromApp(msgId);
}
/**
 * Right after "Group call" sent the app: the name + creator for the card
 * and Delta Chat's view (status update, `document` = the name in DC).
 */
export async function announceGroupCall(msgId, title) {
  const info = await getInfo(Number(msgId));
  const t = cleanTitle(title);
  await core.sendWebxdcStatusUpdate(Number(msgId), JSON.stringify({
    payload: { veltaCall: { vgc: 1, t: "meta", from: info.selfAddr || "", sid: "meta", ts: Date.now(), title: t, creatorName: info.selfName || "" } },
    document: t, summary: "Group call",
  }), "");
}
// The .xdc bytes of an instance: PWA from the core's file store, Tauri via
// read_media_bytes (scoped to the accounts dir, the core's blob path).
async function readAppBytes(msgId) {
  if (typeof core?.readWebxdcArchive === "function") return core.readWebxdcArchive(msgId); // mock core (demo/e2e)
  if (isPwaHost()) return readXdcArchive(msgId);
  const invoke = tauriInvoke();
  if (!invoke) throw new Error("no shell");
  const msg = await core.getMessage(msgId);
  if (!msg?.filePath) throw new Error("app archive not found");
  const buf = await invoke("read_media_bytes", { src: msg.filePath });
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}
function callStateFor(msgId) {
  const s = currentGroupCall();
  if (s && s.msgId === msgId) return s.snapshot();
  return { state: s ? "elsewhere" : "idle", participants: [] };
}
async function joinCallFromApp(msgId) {
  const s = currentGroupCall();
  if (s?.msgId === msgId) return;
  if (s) throw new Error("You are already in another group call — leave it first");
  if (oneToOneCallActive()) throw new Error("Finish the current call first");
  const msg = await core.getMessage(msgId).catch(() => null);
  let chatName = "";
  try { chatName = (await core.getChat(msg?.chatId))?.name || ""; } catch {}
  if (!(await askGroupCallConsent(chatName))) throw new Error("cancelled");
  const info = await getInfo(msgId);
  await joinGroupCall({
    core, msgId, chatId: msg?.chatId, chatName,
    selfId: info.selfAddr || `self-${core.accountId}`, selfName: info.selfName || "",
    realtime: realtimeAvailable(), relayOnly: true, busy: oneToOneCallActive,
    env: { ...groupCallEnv(), releaseRealtime: (m) => (active?.realtime && active.msgId === m) ? null : core.leaveWebxdcRealtime(m) },
  });
}
// Push call state to the open trusted app.
onGroupCallChange((snap) => {
  if (!active?.trust) return;
  active.trust.then((t) => {
    if (t !== "group-call" || !active) return;
    if (snap && snap.msgId !== active.msgId) return post({ type: "velta-call-state", state: callStateFor(active.msgId) });
    post({ type: "velta-call-state", state: snap || callStateFor(active.msgId) });
  });
});
export { trustFor as _trustForTests };

// webxdc.sendToChat: the app hands us a composed file (e.g. an .eml from an
// email-composer app); confirm, stage it under uploads/ via the same
// resolve_upload_path + fs-write pipeline the image send flow uses, and send
// it as a normal file message into the chat the app lives in.
async function sendToChat({ file, name, text }) {
  const invoke = tauriInvoke();
  const write = core?.transport?.writeCoreFile;
  if (!invoke && typeof write !== "function") throw new Error("sendToChat requires the Velta app");
  if (!(file instanceof Blob) && !text) throw new Error("sendToChat: nothing to send");
  const msgId = active?.msgId;
  const msg = await core.getMessage(msgId).catch(() => null);
  if (!msg?.chatId) throw new Error("sendToChat: owning chat not found");
  const filename = name || file?.name || "file";
  const ok = await confirmModal("Send to chat", file ? `Send "${filename}" to this chat?` : "Send this text to this chat?", "Send", false);
  if (!ok) return { ok: false, cancelled: true };
  let dest = null;
  let temp = false;
  if (file instanceof Blob) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (invoke) {
      dest = await invoke("resolve_upload_path", { filename: `${Date.now()}-${filename}` });
      if (!dest) throw new Error("resolve_upload_path returned empty");
      await invoke("plugin:fs|write_file", bytes, { headers: { path: encodeURIComponent(dest) } });
    } else {
      // Wasm PWA: the core reads the worker memfs (same as chat attachments).
      dest = `/uploads/${Date.now()}-${String(filename).replace(/[\\/]/g, "_")}`;
      await write.call(core.transport, dest, bytes);
      temp = true;
    }
  }
  try {
    await core.sendMessage(msg.chatId, { viewtype: "file", file: dest, filename, text: text || "" });
  } finally {
    if (temp) core.transport.removeCoreFile?.(dest)?.catch?.(() => {});
  }
  toast(`Sent ${filename}`, 2200);
  return { ok: true };
}

// webxdc.importFiles: the app's file-attach picker. Uses the same tauri
// dialog + ContentResolver + fs-read pipeline as the chat attachment flow;
// picked bytes go back to the app as File objects over the postMessage
// bridge. Ceiling: the dialog plugin filters by extension only — mimeTypes
// in the filter are ignored (apps re-check types themselves).
async function importFiles(filters = {}) {
  const invoke = tauriInvoke();
  if (!invoke) return isPwaHost() ? pickFilesInBrowser(filters) : [];
  const exts = (filters.extensions || []).map(e => String(e).replace(/^\./, ""));
  let picked;
  try {
    picked = await invoke("plugin:dialog|open", {
      options: {
        multiple: !!filters.multiple,
        ...(exts.length ? { filters: [{ name: "Files", extensions: exts }] } : {}),
      },
    });
  } catch { return []; }
  if (!picked) return [];
  const list = Array.isArray(picked) ? picked : [picked];
  // V-07/#65: fs reads are scope-gated; the user's pick is the consent.
  for (const p of list) {
    if (!/^content:\/\//.test(p)) {
      await invoke("allow_picked_path", { path: p }).catch(() => {});
    }
  }
  const files = [];
  for (let p of list) {
    try {
      if (/^content:\/\//.test(p)) {
        p = await invoke("resolve_content_uri", { uri: p, filename: String(Date.now()) });
      }
      const bytes = new Uint8Array(await invoke("plugin:fs|read_file", { path: p }));
      const name = p.replace(/\\/g, "/").split("/").pop();
      files.push(new File([bytes], name));
    } catch { /* skip unreadable pick */ }
  }
  return files;
}

// PWA importFiles: a host-side <input type=file>. The tap inside the app
// frame carries user activation up to this page (UAv2), so the picker opens.
export function acceptFor(filters = {}) {
  const exts = (filters.extensions || []).map(e => "." + String(e).replace(/^\./, ""));
  const mimes = (filters.mimeTypes || []).map(String);
  return [...exts, ...mimes].join(",");
}
function pickFilesInBrowser(filters = {}) {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.multiple = !!filters.multiple;
    const accept = acceptFor(filters);
    if (accept) inp.accept = accept;
    inp.style.display = "none";
    let settled = false;
    const done = (files) => { if (settled) return; settled = true; inp.remove(); resolve(files); };
    inp.addEventListener("change", () => done([...(inp.files || [])]));
    inp.addEventListener("cancel", () => done([]));
    document.body.appendChild(inp);
    inp.click();
  });
}

// PWA: the open app's .xdc archive (the loader unzips it inside the sandbox).
async function readXdcArchive(msgId) {
  if (!isPwaHost()) throw new Error("veltaBundle is only used by the web app");
  const read = core?.transport?.readCoreFile;
  if (typeof read !== "function") throw new Error("this core cannot read app files");
  const msg = await core.getMessage(msgId);
  let path = msg?.filePath;
  if (!path) throw new Error("app archive not found");
  if (!path.startsWith("/") && window.veltaAccountsDir) path = `${window.veltaAccountsDir.replace(/\/$/, "")}/${path}`;
  const bytes = await read.call(core.transport, path);
  if (!bytes || !bytes.byteLength) throw new Error("app archive is empty");
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

// PWA chat cards: the SW asks for icon files (any instance — icons are
// visible to every chat member, same exemption as native webxdc_serve).
export const ICON_PATH_RE = /^icon\.[a-z]+$/;
export async function serveIconRequest(data) {
  if (!core || Number(data?.account) !== Number(core.accountId)) throw new Error("wrong account");
  const path = String(data?.path || "");
  if (!ICON_PATH_RE.test(path)) throw new Error("not an icon");
  const b64 = await core.getWebxdcBlob(Number(data.msg), path);
  if (!b64) throw new Error("missing");
  return base64ToBytes(String(b64));
}
if (typeof navigator !== "undefined" && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type !== "velta-webxdc-icon") return;
    const port = e.ports?.[0];
    if (!port) return;
    serveIconRequest(e.data)
      .then((bytes) => port.postMessage({ bytes }))
      .catch((err) => port.postMessage({ error: String(err?.message || err) }));
  });
}

// Payload from the frame (structured clone) → bytes, spec-capped.
export function realtimeBytes(data) {
  let b;
  if (data instanceof Uint8Array) b = data;
  else if (data instanceof ArrayBuffer) b = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) b = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else throw new Error("realtime data must be a Uint8Array");
  if (b.byteLength > REALTIME_MAX) throw new Error(`realtime data too large (${b.byteLength} > ${REALTIME_MAX})`);
  return b;
}

async function getInfo(msgId) {
  if (!infoCache.has(msgId)) {
    let info = { name: "Webxdc app", icon: "", summary: "", sourceCodeUrl: "",
      internetAccess: false, selfAddr: "", selfName: "",
      sendUpdateInterval: 1000, sendUpdateMaxSize: 0 };
    try {
      const fetched = await core.getWebxdcInfo(msgId);
      // Cache only real answers: a rejected or empty RPC (core busy,
      // forwarded-copy quirks) must stay uncached so a later prefetch
      // retries the fetch instead of serving the generic fallback forever.
      if (!fetched) return info;
      info = { ...info, ...fetched };
      infoCache.set(msgId, info);
    } catch { return info; }
  }
  return infoCache.get(msgId);
}

export function infoFor(msgId) {
  return infoCache.get(msgId) || null;
}

export async function prefetchInfo(msgId) {
  await getInfo(Number(msgId));
  return infoCache.get(Number(msgId)) || null;
}

// Cold start: chat rows render before the core/account is ready, so the first
// get_webxdc_info calls reject (getInfo then returns the uncached fallback
// and prefetchInfo null). The card used to retry once after 2 s and then
// stay on the filename + generic glyph until the next restart. Keep retrying
// with backoff while the card is alive; resolves the info or null.
export const WEBXDC_INFO_RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000];
export async function loadInfoWithRetry(msgId, { alive = () => true, delays = WEBXDC_INFO_RETRY_MS, wait = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    let info = null;
    try { info = await prefetchInfo(msgId); } catch { info = null; }
    if (!alive()) return null;
    if (info?.name) return info;
    if (attempt >= delays.length) return info;
    await wait(delays[attempt]);
    if (!alive()) return null;
  }
}

// The built-in Velta Beam app (send-direct*.xdc): older builds shipped other
// manifest names/icons, so the card always shows the bundled name and icon
// (a plain app asset: no webxdc scheme, loads on Android and the PWA).
export const BEAM_FILE_RE = /^send-direct(-\d+)?\.xdc$/i;
export const GROUP_CALL_FILE_RE = /^group-call(-\d+)?\.xdc$/i;
export function builtinAppCard(fileName) {
  // Card cosmetics only — trust for group calls is the bundle hash (xdc-trust.js).
  if (GROUP_CALL_FILE_RE.test(String(fileName || ""))) return { name: "Velta Group Call", iconUrl: new URL("../webxdc/group-call/icon.png", import.meta.url).href };
  if (!BEAM_FILE_RE.test(String(fileName || ""))) return null;
  return { name: "Velta Beam", iconUrl: new URL("../webxdc/send-direct/icon.png", import.meta.url).href };
}

export function appIconUrl(msgId, icon) {
  const base = baseFor(core.accountId);
  return `${base}/${msgId}/${icon || "icon.png"}`;
}

// Start document for an info message's webxdc `href` (DC opens the app at
// it). Only the query and fragment are honored and the path stays
// index.html: the native host injects the shim into index.html only, and an
// href must never point outside the instance. Returns e.g. "index.html?x#y".
export function webxdcStartPath(href) {
  if (typeof href !== "string" || !href) return "index.html";
  let u;
  try { u = new URL(href, "https://xdc.invalid/app/"); } catch { return "index.html"; }
  if (u.origin !== "https://xdc.invalid") return "index.html";
  return "index.html" + u.search + u.hash;
}

// A core info message created by a webxdc update's `info` field
// (SystemMessage::WebxdcInfoMessage); parentId is the app instance.
export function isWebxdcInfoMsg(m) {
  return !!m && m.kind === "service" && m.systemType === "WebxdcInfoMessage" && Number(m.parentId) > 0;
}

// #138: apps opened as a bottom panel (the built-in Velta Beam) leave the
// chat usable above them; the panel can expand to full screen and back.
// Toggling only flips classes on the overlay — the iframe is never moved or
// re-created, so the app (and a running transfer) is not reloaded.

export async function openWebxdc(msgId, fallbackName = "Webxdc app", opts = {}) {
  if (typeof document === "undefined") return;
  // The webxdc.localhost handler only exists inside the Tauri shell. In a
  // plain browser (demo/dev) the frame would 404 every asset and spam the
  // console — explain instead of opening a dead overlay.
  if (!window.__TAURI__) {
    if (!isPwaHost()) {
      toast("webxdc apps run in the Velta app", 3000);
      return;
    }
    // The loader document only exists through the service worker (it sets
    // the sandbox CSP); without a controller the frame would 404.
    if (!navigator.serviceWorker?.controller) {
      toast("Reload Velta once to enable apps (service worker not active yet)", 4000);
      return;
    }
  }
  // Already open: keep the running frame (a reload would kill a transfer).
  if (active?.msgId === Number(msgId) && document.getElementById("webxdc-overlay")) {
    if (active.panel) active.wrap?.querySelector(".webxdc-close")?.focus();
    return;
  }
  if (active) closeWebxdcFrame(); // reopen: no history touch, entry reused below
  const account = core.accountId;
  const base = baseFor(account);
  const iframe = document.createElement("iframe");
  // No allow-same-origin: each app document gets a unique opaque origin, so
  // webxdc apps can neither reach the host page nor each other's data. The
  // shim's postMessage bridge and no-cors subresource loads work unchanged;
  // webxdc_serve sends Access-Control-Allow-Origin: * for fetch() calls.
  // webxdc-shim.js backs localStorage/sessionStorage with memory in that
  // origin (app state lives in status updates anyway).
  // PWA: the opaque origin comes from the `sandbox` CSP header the service
  // worker sends with the loader document (sw-route.js WEBXDC_FRAME_CSP).
  // The ATTRIBUTE must keep allow-same-origin there: Chromium skips the
  // service worker for frames whose sandbox attribute lacks it, and the
  // loader document would 404. Header and attribute flags combine, so the
  // document is still opaque; the attribute still blocks popups and top
  // navigation for anything the frame loads. frame.js refuses to run unless
  // its origin is "null"; the SW gives every other same-scope iframe
  // navigation a `sandbox` CSP too. KEEP all three.
  iframe.setAttribute("sandbox", isPwaHost()
    ? "allow-scripts allow-same-origin allow-downloads allow-forms allow-modals"
    : "allow-scripts allow-downloads allow-forms allow-modals");
  // KEEP: webxdc never gets capture/location (Phase 0, webxdc-group-calls.md);
  // trusted call apps use the HOST's media via webxdc.veltaCall instead.
  iframe.setAttribute("allow", WEBXDC_FRAME_ALLOW);
  iframe.setAttribute("referrerpolicy", "no-referrer");
  // Theme rides the query string for reference only; the app document's color-scheme is left alone
  // (see webxdc-shim.js).
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  // V-05/#63: register this instance with webxdc_serve BEFORE the frame
  // loads — the server refuses non-icon blobs for any other prefix, so an
  // open app cannot read another instance's files.
  const invoke = tauriInvoke();
  await invoke?.("webxdc_begin", { account, msg: Number(msgId) }).catch(() => {});
  const start = webxdcStartPath(opts.href);
  const q = start.indexOf("?"), h = start.indexOf("#");
  const hash = h >= 0 ? start.slice(h) : "";
  const search = q >= 0 ? start.slice(q + 1, h >= 0 ? h : undefined) : "";
  iframe.src = `${base}/${msgId}/index.html?${search ? search + "&" : ""}velta-theme=${theme}${hash}`;
  iframe.className = "webxdc-frame";

  const wrap = document.createElement("div");
  wrap.id = "webxdc-overlay";
  const panel = wantsPanel(infoCache.get(msgId)?.name || fallbackName, opts);
  wrap.innerHTML = `
    <div class="webxdc-bar">
      <div class="webxdc-title"></div>
      ${panel ? `<button type="button" class="webxdc-expand icon-btn" aria-expanded="false" title="Expand to full screen" aria-label="Expand to full screen"><span aria-hidden="true">⤢</span></button>` : ""}
      <button type="button" class="webxdc-close icon-btn" title="Close app" aria-label="Close app">${CLOSE_SVG}</button>
    </div>`;
  if (panel) {
    // A panel is a non-modal region: no focus trap, the chat stays reachable.
    wrap.classList.add("webxdc-panel");
    wrap.setAttribute("role", "region");
  }
  wrap.appendChild(iframe);
  // Panel: in the chat view's layout flow right below the chat header, so the
  // message list shrinks between it and the composer (never overlays the
  // input, also with the Android keyboard open). Inserted once — the frame is
  // never moved afterwards (moving an iframe reloads it).
  const chatHead = panel ? document.querySelector("#chat-view > .chat-head") : null;
  if (chatHead) chatHead.after(wrap);
  else document.body.appendChild(wrap);

  const title = wrap.querySelector(".webxdc-title");
  const info = infoCache.get(msgId);
  title.textContent = info?.name || fallbackName || "Webxdc app";

  if (panel) wrap.setAttribute("aria-label", title.textContent);
  active = { msgId: Number(msgId), iframe, serial: serials.get(Number(msgId)) || 0, panel, wrap };
  active.trust = trustFor(Number(msgId)); // group calls: bundle-hash check, before the app can ask
  active.trust.then((t) => { if (t === "group-call" && active?.msgId === Number(msgId)) setCallScreen(Number(msgId)); });
  wrap.querySelector(".webxdc-close").addEventListener("click", () => closeWebxdc());
  wrap.querySelector(".webxdc-expand")?.addEventListener("click", () => setWebxdcExpanded(!isWebxdcExpanded()));
  if (panel) {
    // No history entry while it is a panel: BACK keeps working for the chat
    // underneath; expanding pushes one so BACK collapses (see popstate).
    window.addEventListener("message", onWindowMessage);
    return;
  }
  // Android BACK closes the app: the pushed history entry pops (WebView
  // history navigation) and popstate tears the overlay down — same pattern
  // as openChat/closeChat in app.js and the HTML attachment viewer.
  if (history.state?.velta !== "webxdc") history.pushState({ velta: "webxdc" }, "");
  window.addEventListener("message", onWindowMessage);
}

function onWindowMessage(e) {
  if (!active) return;
  if (e.source !== active.iframe?.contentWindow) return;
  const d = e.data || {};
  if (d.type !== "velta-webxdc-call") return;
  handleCall(d)
    .then((result) => post({ type: "velta-webxdc-response", id: d.id, result }))
    .catch((error) => post({ type: "velta-webxdc-response", id: d.id, error: String(error?.message || error) }));
}

// BACK pops the entry pushed by openWebxdc; ✕/programmatic closes consume
// the same entry via history.back() — either way the frame tears down once.
window.addEventListener("popstate", (e) => {
  if (!active || e.state?.velta === "webxdc") return;
  if (active.panel) { if (isWebxdcExpanded()) applyExpanded(false); return; }
  closeWebxdcFrame();
});

export function isWebxdcExpanded() {
  return !!active?.wrap?.classList.contains("webxdc-expanded");
}

function applyExpanded(on) {
  const wrap = active?.wrap;
  if (!wrap) return;
  wrap.classList.toggle("webxdc-expanded", on);
  const b = wrap.querySelector(".webxdc-expand");
  if (b) {
    const label = on ? "Collapse to panel" : "Expand to full screen";
    b.setAttribute("aria-expanded", String(on));
    b.title = label; b.setAttribute("aria-label", label);
    b.firstElementChild.textContent = on ? "⤡" : "⤢";
  }
}

/** Panel apps only: expand to full screen (true) or back to the panel. */
export function setWebxdcExpanded(on) {
  if (!active?.panel || on === isWebxdcExpanded()) return;
  if (on) {
    applyExpanded(true);
    history.pushState({ velta: "webxdc" }, "");
  } else if (history.state?.velta === "webxdc") {
    history.back(); // popstate collapses
  } else {
    applyExpanded(false);
  }
}

function closeWebxdcFrame() {
  // Closing the app leaves its realtime channel (spec: leave() or unload).
  // A group call in this instance keeps the channel (the host owns it).
  if (active?.realtime && currentGroupCall()?.msgId !== active.msgId) core?.leaveWebxdcRealtime?.(active.msgId)?.catch?.(() => {});
  document.getElementById("webxdc-overlay")?.remove();
  window.removeEventListener("message", onWindowMessage);
  active = null;
  setCallScreen(null); // the in-call bar may show again
}

export function closeWebxdc() {
  if (!active) return;
  const ownEntry = history.state?.velta === "webxdc";
  closeWebxdcFrame();
  if (ownEntry) history.back();
}
