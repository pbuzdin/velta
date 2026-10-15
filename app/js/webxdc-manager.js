// webxdc-manager.js — opens webxdc apps in a sandboxed iframe and relays
// the webxdc API between the iframe (via postMessage) and the core
// (status updates, app info). The iframe is served by the webxdc://
// protocol handler in the Rust layer, which also injects the shim that
// defines window.webxdc inside the app.

import { CLOSE_SVG, toast, confirmModal } from "./ui.js";
import { LruCache } from "./lru.js";
import { wantsPanel } from "./webxdc-panel.js";

let core = null;
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

// The iframe origin depends on the platform: Windows and Android serve
// custom protocols at http://<scheme>.localhost, mac/linux at <scheme>://.
function baseFor(accountId) {
  const ua = navigator.userAgent || "";
  if (/Windows|Android/.test(ua)) return `http://webxdc.localhost/${accountId}`;
  return `webxdc://localhost/${accountId}`;
}

export function initWebxdc(coreInstance) {
  core = coreInstance;
  core.addEventListener("webxdc-status-update", (e) => {
    const d = e?.detail || {};
    handleStatusUpdate(Number(d.msgId), Number(d.serial) || 0);
  });
  core.addEventListener("webxdc-instance-deleted", (e) => {
    const d = e?.detail || {};
    if (active && active.msgId === Number(d.msgId)) closeWebxdc();
    serials.delete(Number(d.msgId));
  });
  core.addEventListener("webxdc-realtime-data", (e) => {
    const d = e?.detail || {};
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

async function handleCall(data) {
  const msgId = active?.msgId;
  switch (data.method) {
    case "getInfo": {
      const info = await getInfo(msgId);
      return { name: info.name, document: info.document || "", summary: info.summary || "",
        sourceCodeUrl: info.sourceCodeUrl || "", selfAddr: info.selfAddr || "",
        selfName: info.selfName || "", sendUpdateInterval: info.sendUpdateInterval ?? 1000,
        sendUpdateMaxSize: info.sendUpdateMaxSize ?? 0 };
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
      const update = data.params?.update;
      if (typeof update !== "object" || update === null) throw new Error("update must be an object");
      await core.sendWebxdcStatusUpdate(msgId, JSON.stringify(update), data.params?.description || null);
      return {};
    }
    // Realtime channel (joinRealtimeChannel in the shim): join = advertise
    // on the instance's iroh-gossip topic (core sends the hidden
    // advertisement mail); data rides send_webxdc_realtime_data; leave on
    // app close too. Peers arrive via WebxdcRealtimeData events above.
    case "realtimeJoin": {
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
        await core.leaveWebxdcRealtime(msgId).catch(() => {});
      }
      return {};
    }
    case "sendToChat":
      return sendToChat(data.params || {});
    case "importFiles":
      return importFiles((data.params || {}).filters);
    default:
      throw new Error(`unknown webxdc method: ${data.method}`);
  }
}

// webxdc.sendToChat: the app hands us a composed file (e.g. an .eml from an
// email-composer app); confirm, stage it under uploads/ via the same
// resolve_upload_path + fs-write pipeline the image send flow uses, and send
// it as a normal file message into the chat the app lives in.
async function sendToChat({ file, name, text }) {
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  if (!invoke) throw new Error("sendToChat requires the Velta app");
  if (!(file instanceof Blob) && !text) throw new Error("sendToChat: nothing to send");
  const msgId = active?.msgId;
  const msg = await core.getMessage(msgId).catch(() => null);
  if (!msg?.chatId) throw new Error("sendToChat: owning chat not found");
  const filename = name || file?.name || "file";
  const ok = await confirmModal("Send to chat", file ? `Send "${filename}" to this chat?` : "Send this text to this chat?", "Send", false);
  if (!ok) return { ok: false, cancelled: true };
  let dest = null;
  if (file instanceof Blob) {
    dest = await invoke("resolve_upload_path", { filename: `${Date.now()}-${filename}` });
    if (!dest) throw new Error("resolve_upload_path returned empty");
    const bytes = new Uint8Array(await file.arrayBuffer());
    await invoke("plugin:fs|write_file", bytes, { headers: { path: encodeURIComponent(dest) } });
  }
  await core.sendMessage(msg.chatId, { viewtype: "file", file: dest, filename, text: text || "" });
  toast(`Sent ${filename}`, 2200);
  return { ok: true };
}

// webxdc.importFiles: the app's file-attach picker. Uses the same tauri
// dialog + ContentResolver + fs-read pipeline as the chat attachment flow;
// picked bytes go back to the app as File objects over the postMessage
// bridge. Ceiling: the dialog plugin filters by extension only — mimeTypes
// in the filter are ignored (apps re-check types themselves).
async function importFiles(filters = {}) {
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  if (!invoke) return [];
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

export function appIconUrl(msgId, icon) {
  const base = baseFor(core.accountId);
  return `${base}/${msgId}/${icon || "icon.png"}`;
}

export function isWebxdcOpen(msgId) {
  return active?.msgId === Number(msgId);
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
    toast("webxdc apps run in the Velta app", 3000);
    return;
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
  iframe.setAttribute("sandbox", "allow-scripts allow-downloads allow-forms allow-modals");
  iframe.setAttribute("allow", "autoplay");
  // Theme rides the query string; webxdc-shim.js applies it as the
  // document's color-scheme so the frame's scrollbars match the shell.
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  // V-05/#63: register this instance with webxdc_serve BEFORE the frame
  // loads — the server refuses non-icon blobs for any other prefix, so an
  // open app cannot read another instance's files.
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  await invoke?.("webxdc_begin", { account, msg: Number(msgId) }).catch(() => {});
  iframe.src = `${base}/${msgId}/index.html?velta-theme=${theme}`;
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
    document.documentElement.classList.add("webxdc-panel-open");
  }
  wrap.appendChild(iframe);
  document.body.appendChild(wrap);

  const title = wrap.querySelector(".webxdc-title");
  const info = infoCache.get(msgId);
  title.textContent = info?.name || fallbackName || "Webxdc app";

  if (panel) wrap.setAttribute("aria-label", title.textContent);
  active = { msgId: Number(msgId), iframe, serial: serials.get(Number(msgId)) || 0, panel, wrap };
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
  document.documentElement.classList.toggle("webxdc-panel-open", !on);
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
  if (active?.realtime) core?.leaveWebxdcRealtime?.(active.msgId)?.catch?.(() => {});
  document.getElementById("webxdc-overlay")?.remove();
  document.documentElement.classList.remove("webxdc-panel-open");
  window.removeEventListener("message", onWindowMessage);
  active = null;
}

export function closeWebxdc() {
  if (!active) return;
  const ownEntry = history.state?.velta === "webxdc";
  closeWebxdcFrame();
  if (ownEntry) history.back();
}
