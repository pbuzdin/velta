// SOCKS5 proxy support (every native app): UI side of
// velta-app/src-tauri/src/proxy.rs.
//
// A proxy is added by accepting a velta://proxy?… link (paste, deep link,
// QR code, chat card); several can be saved (proxies.json in the shell),
// one or none is active. The shell writes the active proxy's URL into every
// profile's proxy_url. The server is never part of this code. The drawer
// row is there on every native shell before anything is saved, so a link
// can be pasted.
//
// Shell commands: proxy_install, proxy_list, proxy_select, proxy_rename,
// proxy_delete, proxy_link, proxy_status, share_text.
import { escapeHtml } from "./format.js";
import { tauriInvoke } from "./tauri.js";
import { t } from "./i18n.js";
import { ICON } from "./icons.js";

let cached = { installed: false };

function errMsg(e) {
  return e?.message || String(e);
}

/** Returns the link if rawUrl is a velta://proxy setup link, else null. */
export function extractProxyLink(rawUrl) {
  const s = String(rawUrl || "").trim();
  return /^velta:\/\/proxy(?:[?#/]|$)/i.test(s) ? s : null;
}

// Link format (docs/socks5-proxy-link.md):
//   v1: velta://proxy?v=1&h=<host>&p=<port>[&u=<user>][&w=<password>][&n=<label>]
//   v2: velta://proxy/2/<HOST>/<PORT>[/U/<user base32>][/W/<password base32>][/N/<label base32>]
// The host can be a public hostname, a LAN name or IP, or a loopback
// address — wherever the proxy server runs. The page checks links strictly
// first so a malformed or oversized link never reaches the shell and the
// confirmation shows only validated values.
export const PROXY_LINK_MAX = 2048;
export const PROXY_LABEL_MAX = 64;
export const PROXY_CRED_MAX = 128;
const PROXY_PARAMS = new Set(["v", "h", "p", "u", "w", "n"]);

class ProxyLinkError extends Error {}
const bad = msg => { throw new ProxyLinkError(msg); };

function validIPv4(s) {
  const p = s.split(".");
  return p.length === 4 && p.every(x => /^(?:0|[1-9][0-9]{0,2})$/.test(x) && Number(x) <= 255);
}
function validIPv6(s) {
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(s) || (s.match(/::/g) || []).length > 1) return false;
  try { return new URL(`http://[${s}]/`).hostname.length > 2; } catch { return false; }
}
function validPort(p) {
  return /^[1-9][0-9]{0,4}$/.test(p) && Number(p) <= 65535;
}

/** Hostname (public or LAN), IPv4, or [IPv6]; normalized lowercase, no
 * trailing dot, IPv6 without brackets. Null when invalid. */
export function normalizeProxyHost(raw) {
  const h = String(raw ?? "").trim().replace(/\.$/, "");
  if (!h || [...h].length > 253) return null;
  if (validIPv4(h)) return h;
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (validIPv6(bare)) return bare.toLowerCase();
  if (bare.includes(":")) return null;
  const lower = bare.toLowerCase();
  // Four dot-separated numbers that are not a valid IPv4 address are a
  // typo, not a hostname ("10.0.0.999").
  const numeric = lower.split(".").every(p => p && /^[0-9]+$/.test(p));
  if (numeric && (lower.match(/\./g) || []).length >= 3) return null;
  const labelOk = l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l);
  return lower.split(".").every(labelOk) ? lower : null;
}

function cleanCreds(u, w) {
  if ([...u].length > PROXY_CRED_MAX || [...w].length > PROXY_CRED_MAX) bad(t("The username or password is too long"));
  if (!u && w) bad(t("A password without a username is not valid"));
  return { user: u, pass: w };
}

function cleanLabel(n) {
  // Display text only: no control or bidi-override characters.
  const s = n.normalize("NFC").trim();
  if (/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s)) bad(t("The label has invalid characters"));
  if ([...s].length > PROXY_LABEL_MAX) bad(t("The label is too long (max {max})", { max: PROXY_LABEL_MAX }));
  return s;
}

// Base32 (RFC 4648, no padding): uppercase output, either case accepted.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(bytes) {
  let out = "", acc = 0, n = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; n += 8;
    while (n >= 5) { out += B32[(acc >>> (n - 5)) & 31]; n -= 5; }
    acc &= (1 << n) - 1;
  }
  if (n) out += B32[(acc << (5 - n)) & 31];
  return out;
}
/** Strict: canonical length, zero trailing bits. Returns bytes or null. */
export function base32Decode(str) {
  const s = String(str).toUpperCase();
  if (!/^[A-Z2-7]*$/.test(s) || [1, 3, 6].includes(s.length % 8)) return null;
  const out = [];
  let acc = 0, n = 0;
  for (const c of s) {
    acc = (acc << 5) | B32.indexOf(c); n += 5;
    if (n >= 8) { out.push((acc >>> (n - 8)) & 255); n -= 8; }
    acc &= (1 << n) - 1;
  }
  return acc === 0 ? Uint8Array.from(out) : null;
}
const b32ToUtf8 = s => {
  const b = base32Decode(s);
  if (!b) bad(t("The link is not encoded correctly"));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { bad(t("The link is not encoded correctly")); }
};

// v2 (docs/socks5-proxy-link.md): every byte after "velta://" is in the QR
// alphanumeric set (0-9 A-Z space $%*+-./:), so a QR encodes it at 5.5 bits
// a char instead of 8. Scheme and host stay lowercase: Android matches
// intent-filter schemes/hosts case-sensitively.
//   velta://proxy/2/<HOST>/<PORT>[/U/<user base32>][/W/<password base32>][/N/<label base32>]
const V2_RE = /^velta:\/\/proxy\/2\/([^/?#]+)\/([0-9]{1,5})((?:\/[UWN]\/[^/?#]+)*)$/i;
function parseV2(m) {
  const host = normalizeProxyHost(m[1]);
  if (!host) bad(t("The proxy server address is not valid"));
  if (!validPort(m[2])) bad(t("The port is not valid"));
  const port = Number(m[2]);
  const seen = new Map();
  const rest = m[3] ? m[3].slice(1).split("/") : [];
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i].toUpperCase();
    if (seen.has(k)) bad(t("Repeated parameter: {name}", { name: k }));
    seen.set(k, rest[i + 1]);
  }
  const user = seen.has("U") ? b32ToUtf8(seen.get("U")) : "";
  const pass = seen.has("W") ? b32ToUtf8(seen.get("W")) : "";
  cleanCreds(user, pass);
  let label = "";
  if (seen.has("N")) label = cleanLabel(b32ToUtf8(seen.get("N")));
  return { version: 2, host, port, user, pass, label };
}

/**
 * Strictly parses a velta://proxy link (v1 query form or v2 path form).
 * Returns {version, host, port, user, pass, label}; throws on anything off:
 * other schemes/hosts, a path, unknown or repeated parameters, a future
 * version, oversized values.
 */
export function parseProxyLink(raw) {
  const s = String(raw ?? "").trim();
  if (!s) bad(t("Empty link"));
  if (s.length > PROXY_LINK_MAX) bad(t("The link is too long"));
  const m2 = V2_RE.exec(s);
  if (m2) return parseV2(m2);
  const fut = /^velta:\/\/proxy\/([0-9]+)\//i.exec(s);
  if (fut && fut[1] !== "2") bad(t("Unsupported link version {version}: update Velta", { version: fut[1].slice(0, 10) }));
  if (fut) bad(t("The link is not valid"));
  const m = /^velta:\/\/proxy\/?(?:\?([^#]*))?$/i.exec(s);
  if (!m) bad(t("Not a velta://proxy link"));
  const seen = new Map();
  for (const part of (m[1] || "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq < 0 ? part : part.slice(0, eq);
    let v;
    try { v = decodeURIComponent((eq < 0 ? "" : part.slice(eq + 1)).replace(/\+/g, "%20")); } catch { bad(t("The link is not encoded correctly")); }
    if (!PROXY_PARAMS.has(k)) bad(t("Unknown parameter: {name}", { name: k.slice(0, 20) }));
    if (seen.has(k)) bad(t("Repeated parameter: {name}", { name: k }));
    seen.set(k, v);
  }
  const version = seen.has("v") ? seen.get("v") : "1";
  if (version !== "1") bad(t("Unsupported link version {version}: update Velta", { version: version.slice(0, 10) }));
  const host = normalizeProxyHost(seen.get("h") || "");
  if (!host) bad(t("The proxy server address is not valid"));
  const portRaw = (seen.get("p") || "").trim();
  if (!validPort(portRaw)) bad(t("The port is not valid"));
  const { user, pass } = cleanCreds(seen.get("u") || "", seen.get("w") || "");
  const label = seen.has("n") ? cleanLabel(seen.get("n")) : "";
  return { version: 1, host, port: Number(portRaw), user, pass, label };
}

/** v1 query form. Also what the page hands the shell. */
export function buildProxyLinkV1({ host, port, user = "", pass = "", label = "" }) {
  const parts = ["v=1", `h=${encodeURIComponent(host)}`, `p=${port}`];
  if (user) parts.push(`u=${encodeURIComponent(user)}`);
  if (pass) parts.push(`w=${encodeURIComponent(pass)}`);
  if (label) parts.push(`n=${encodeURIComponent(label)}`);
  return `velta://proxy?${parts.join("&")}`;
}

/** Canonical link for sharing (QR, copy): v2, alphanumeric after "velta://". */
export function buildProxyLink({ host, port, user = "", pass = "", label = "" }) {
  const h = normalizeProxyHost(host);
  if (!h) bad(t("The proxy server address is not valid"));
  const b32 = s => base32Encode(new TextEncoder().encode(s.normalize("NFC")));
  let out = `velta://proxy/2/${h.toUpperCase()}/${port}`;
  if (user) out += `/U/${b32(user)}`;
  if (pass) out += `/W/${b32(pass)}`;
  if (label) out += `/N/${b32(label)}`;
  return out;
}

const UNSUPPORTED_MSG = "SOCKS5 proxy links work in the Velta apps, not in the browser app. Open this link in the Velta app.";

/** Last known status (sync, for drawer rendering). */
export function proxyStatus() {
  return cached;
}

/** Drawer row: every native shell, including before any proxy is saved.
 * Hidden in the browser app (no shell to keep the proxy). */
export function proxyOffered(s = cached) {
  return !!s && s.available !== false && !!tauriInvoke();
}

export async function refreshProxyStatus(invoke = tauriInvoke()) {
  if (!invoke) return (cached = { installed: false, available: false });
  try {
    cached = { available: true, ...(await invoke("proxy_status")) };
  } catch (e) {
    cached = { installed: false, available: false, error: errMsg(e) };
  }
  return cached;
}

/** Name shown for a saved proxy: its label, else its server. */
export function proxyName(p) {
  return (p?.label || "").trim() || p?.host || t("unknown server");
}

/** One-line state for the drawer and the settings sheet. */
export function describeProxy(s) {
  if (!s?.installed) return { headline: t("Not set up"), detail: "" };
  if (s.active === null || s.active === undefined) return { headline: t("Off"), detail: t("No proxy is in use. Pick one of your saved proxies to use it.") };
  const name = proxyName({ label: s.active_label, host: s.host });
  return { headline: t("In use"), detail: t("Mail goes through {name}.", { name }) };
}

/** Confirmation text for a parsed link: what it is, where traffic goes, and
 * which proxy "Add and use" switches away from. Exported for tests. */
export function proxyConfirmText(link, { current = null, replacing = null } = {}) {
  const lines = [];
  if (link.label) lines.push(t("Name: {label}", { label: link.label }));
  lines.push(t("Proxy server: {server}", { server: `${link.host}:${link.port}` }));
  if (link.user) lines.push(t("The link includes the proxy's username and password. Anyone with the link can use the proxy."));
  const now = current || replacing;
  if (now) lines.push(t("“Add and use” switches from the proxy in use ({name}); it stays saved.", { name: now }));
  lines.push(
    t("All chat traffic will go through this proxy server while it is in use. Your messages stay end-to-end encrypted, but the proxy operator sees which relays you connect to and when."),
    t("Only accept proxy links from someone you trust."),
  );
  return lines.join("\n\n");
}

/**
 * Dialog with several actions, built on ui.js showModal (focus starts on
 * the primary action; Back/overlay/close = cancel). Resolves the chosen
 * action's id, or null. actions: [{ id, label, primary? }].
 */
export function makeChooser(showModal) {
  return (title, text, actions) => new Promise(resolve => {
    const doc = globalThis.document;
    const body = doc.createElement("div");
    body.innerHTML = `<p style="font-size:15px;line-height:1.45;white-space:pre-line">${escapeHtml(text)}</p>`;
    const foot = doc.createElement("div");
    foot.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end";
    let done = false;
    const finish = (v, close) => { if (done) return; done = true; resolve(v); close?.(); };
    const btns = [...actions, { id: null, label: t("Cancel") }].map(a => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = a.primary ? "btn-text btn-primary" : "btn-text";
      if (a.primary) b.style.width = "auto";
      b.textContent = a.label;
      b.dataset.choice = a.id ?? "cancel";
      return [b, a.id];
    });
    // Cancel first in the row, like confirmModal; actions after it.
    foot.append(btns.at(-1)[0], ...btns.slice(0, -1).map(x => x[0]));
    const { close } = showModal({ title, body, foot, compact: true, onClose: () => finish(null) });
    for (const [b, id] of btns) b.addEventListener("click", () => finish(id, close));
    setTimeout(() => (btns.find(([, id]) => actions.find(a => a.id === id)?.primary) || btns[0])[0].focus?.(), 60);
  });
}

/**
 * A velta://proxy link was opened (deep link, QR, paste). Links can come from
 * any web page or app, so nothing changes without the user's confirmation.
 * New proxy: "Add and use" / "Add" / "Cancel". Already saved (same server
 * and username): offer to switch to it.
 */
export async function acceptProxyLink(link, { confirmModal, choose = null, toast, errToast, onChange, invoke = tauriInvoke() }) {
  let parsed;
  try {
    parsed = parseProxyLink(link);
  } catch (e) {
    errToast(t("This proxy link can't be used: {why}", { why: errMsg(e) }), 6000);
    return false;
  }
  if (!invoke) {
    toast(t(UNSUPPORTED_MSG), 6000);
    return false;
  }
  const current = await refreshProxyStatus(invoke);
  let list;
  try {
    list = await invoke("proxy_list");
  } catch (e) {
    errToast(t("This proxy link can't be used: {why}", { why: errMsg(e) }), 6000);
    return false;
  }
  const existing = (list?.proxies || []).find(p => p.host === parsed.host && p.port === parsed.port && (p.user || "") === parsed.user);
  if (existing) {
    const name = proxyName(existing);
    if (existing.active) {
      toast(t("This SOCKS5 proxy is already saved and in use ({name}).", { name }), 4000);
      return true;
    }
    const ok = await confirmModal(
      t("Use saved proxy?"),
      t("This proxy is already saved as “{name}”. Use it now?", { name }),
      t("Use it"),
      false,
    );
    if (!ok) return false;
    try {
      await invoke("proxy_select", { id: existing.id });
    } catch (e) {
      errToast(t("Couldn't switch the proxy: {why}", { why: errMsg(e) }), 6000);
      return false;
    }
    await refreshProxyStatus(invoke);
    toast(t("Now using {name}", { name }));
    onChange?.();
    return true;
  }
  const inUse = current.installed && current.active
    ? (current.active_label || current.host || t("unknown server")) : null;
  const text = proxyConfirmText(parsed, { current: inUse });
  let activate;
  if (choose) {
    const pick = await choose(t("Add SOCKS5 proxy?"), text, [
      { id: "add", label: t("Add") },
      { id: "use", label: t("Add and use"), primary: true },
    ]);
    if (!pick) return false;
    activate = pick === "use";
  } else {
    if (!(await confirmModal(t("Add SOCKS5 proxy?"), text, t("Add and use"), false))) return false;
    activate = true;
  }
  try {
    await invoke("proxy_install", { host: parsed.host, port: parsed.port, user: parsed.user, password: parsed.pass, label: parsed.label, activate });
  } catch (e) {
    errToast(t("Couldn't enable the proxy: {why}", { why: errMsg(e) }), 6000);
    return false;
  }
  await refreshProxyStatus(invoke);
  toast(activate ? t("SOCKS5 proxy added and in use") : t("SOCKS5 proxy added"));
  onChange?.();
  return true;
}

/** Share sheet for a saved proxy (default: the active one): QR, the link,
 * Copy and Share. */
export async function openProxyShare({ showModal, toast, errToast, renderQr, id = null, invoke = tauriInvoke() }) {
  let link, creds = false;
  try {
    const cfg = await invoke("proxy_link", id ? { id } : {});
    creds = !!cfg.user;
    link = buildProxyLink({ host: cfg.host, port: cfg.port, user: cfg.user || "", pass: cfg.pass || "", label: cfg.label || "" });
    parseProxyLink(link);
  } catch (e) {
    errToast(t("Couldn't build the proxy link: {why}", { why: errMsg(e) }));
    return null;
  }
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="p2p-hint">${escapeHtml(t("Anyone who opens this link in Velta can add this SOCKS5 proxy. Their chat traffic will then go through it. Share it only with people you trust."))}</p>
    ${creds ? `<p class="p2p-hint" style="color:var(--danger)">${escapeHtml(t("The link includes the proxy's username and password. Anyone with the link can use the proxy."))}</p>` : ""}
    <div class="qr-box" role="img" aria-label="${escapeHtml(t("QR code of the proxy link"))}"><div class="qr-loading">${escapeHtml(t("Generating QR…"))}</div></div>
    <p class="invite-link" style="word-break:break-all;font-size:12px" data-proxy-link></p>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:6px">
      <button type="button" class="btn-text" data-proxy-copy>${ICON.copy}<span>${escapeHtml(t("Copy link"))}</span></button>
      <button type="button" class="btn-text" data-proxy-share-link>${ICON.share}<span>${escapeHtml(t("Share…"))}</span></button>
    </div>`;
  body.querySelector("[data-proxy-link]").textContent = link;
  const handle = showModal({ title: t("Share proxy link"), body });
  body.querySelector("[data-proxy-copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast(t("Proxy link copied"));
    } catch (e) {
      errToast(t("Couldn't copy: {why}", { why: errMsg(e) }));
    }
  });
  body.querySelector("[data-proxy-share-link]").addEventListener("click", async () => {
    try {
      await invoke("share_text", { text: link, title: t("Velta SOCKS5 proxy") });
    } catch {
      try { await navigator.clipboard.writeText(link); toast(t("Proxy link copied")); } catch {}
    }
  });
  const svg = renderQr ? await Promise.resolve().then(() => renderQr(link)).catch(() => null) : null;
  const box = body.querySelector(".qr-box");
  if (box?.isConnected !== false) {
    box.innerHTML = svg || `<div class="qr-loading">${escapeHtml(t("QR unavailable — copy the link instead"))}</div>`;
  }
  return { link, ...handle };
}

const DIAG_SEEN_KEY = "velta-proxy-diag-seen";

/**
 * Mirrors proxy events into the Velta Diagnostics chat: polls the status
 * (every 20 s, on resume, and when the shell signals a new line) and appends
 * only events newer than the last one shown. The high-water mark survives UI
 * reloads, so a reconnect does not repeat old lines.
 */
export function initProxyDiagnostics({ append, invoke = tauriInvoke(), listen = globalThis.window?.__TAURI__?.event?.listen, intervalMs = 20000 }) {
  if (!invoke) return null;
  let seen = 0;
  try { seen = Number(globalThis.localStorage?.getItem(DIAG_SEEN_KEY)) || 0; } catch {}
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const s = await refreshProxyStatus(invoke);
      for (const e of s.shell_events || []) {
        if (!Number.isFinite(e.t_ms) || e.t_ms <= seen) continue;
        append(e.level || "info", `SOCKS5 proxy: ${e.msg}`);
        seen = e.t_ms;
      }
      try { globalThis.localStorage?.setItem(DIAG_SEEN_KEY, String(seen)); } catch {}
    } finally {
      busy = false;
    }
  };
  listen?.("velta-proxy-log", () => { poll(); });
  const timer = setInterval(poll, intervalMs);
  globalThis.document?.addEventListener?.("visibilitychange", () => { if (!globalThis.document.hidden) poll(); });
  const ready = poll();
  return { poll, ready, stop: () => clearInterval(timer) };
}

function stateHtml(s) {
  const d = describeProxy(s);
  return `<b>${escapeHtml(d.headline)}</b>${d.detail ? ` — ${escapeHtml(d.detail)}` : ""}`;
}

function addedDate(sec) {
  if (!sec) return "";
  try { return new Date(sec * 1000).toLocaleDateString(); } catch { return ""; }
}

/** Saved-proxy rows for the settings sheet. The active one is marked with
 * a check AND the words "In use" (never by colour alone); every action is a
 * real <button> whose accessible name carries the proxy's name. */
export function proxyListHtml(list) {
  const rows = list?.proxies || [];
  if (!rows.length) return `<li class="tunnel-row"><span class="tunnel-sub">${escapeHtml(t("No saved proxies."))}</span></li>`;
  return rows.map(p => {
    const name = proxyName(p);
    const on = !!p.active;
    const sub = [
      p.label ? `${p.host}:${p.port}` : "",
      p.user ? t("with username and password") : "",
      addedDate(p.added) ? t("Added {date}", { date: addedDate(p.added) }) : "",
    ].filter(Boolean).join(" · ");
    const btn = (act, icon, label, extra = "") =>
      `<button type="button" class="icon-btn" data-act="${act}" aria-label="${escapeHtml(t(label, { name }))}" title="${escapeHtml(t(label, { name }))}"${extra}>${icon}</button>`;
    return `<li class="tunnel-row${on ? " is-active" : ""}" data-id="${escapeHtml(p.id)}"${on ? ' aria-current="true"' : ""}>
      <span class="tunnel-mark" aria-hidden="true">${on ? ICON.check : ""}</span>
      <span class="tunnel-text"><span class="tunnel-name">${escapeHtml(name)}</span>${on ? ` <span class="tunnel-badge">${escapeHtml(t("In use"))}</span>` : ""}${sub ? `<span class="tunnel-sub">${escapeHtml(sub)}</span>` : ""}</span>
      <span class="tunnel-acts">
        ${on
          ? `<button type="button" class="btn-text" data-act="off" aria-label="${escapeHtml(t("Stop using {name}", { name }))}">${escapeHtml(t("Stop"))}</button>`
          : `<button type="button" class="btn-text" data-act="use" aria-label="${escapeHtml(t("Use {name}", { name }))}">${escapeHtml(t("Use"))}</button>`}
        ${btn("rename", ICON.edit, "Rename {name}")}
        ${btn("share", ICON.qr, "Share {name}")}
        ${btn("delete", ICON.trash, "Delete {name}", ' style="color:var(--danger)"')}
      </span>
    </li>`;
  }).join("");
}

/** Settings sheet: saved proxies (use / stop / rename / share / delete) and
 * the add-a-link form. */
export async function openProxySettings(deps) {
  const { showModal, confirmModal, askText, toast, errToast, onChange, renderQr, invoke = tauriInvoke() } = deps;
  if (!invoke) return;
  const s = await refreshProxyStatus(invoke);
  let list;
  try { list = await invoke("proxy_list"); } catch { list = { active: null, proxies: [] }; }
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="bar-opts-hint">${escapeHtml(t("Mail goes through a SOCKS5 proxy instead of connecting to the relays directly — on this device, on your network, or on the internet. Only one of SOCKS5 proxy and WebSocket transport is in use at a time."))}</p>
    <h3 class="tunnel-list-h" id="proxy-list-h">${escapeHtml(t("Saved proxies"))}</h3>
    <ul class="tunnel-list" role="list" aria-labelledby="proxy-list-h" data-proxy-list>${proxyListHtml(list)}</ul>
    <p class="p2p-hint" data-proxy-state aria-live="polite">${stateHtml(s)}</p>
    <form data-proxy-add style="display:flex;flex-direction:column;gap:6px;margin-top:10px">
      <label for="proxy-add-link" class="tunnel-list-h" style="margin:0">${escapeHtml(t("Proxy link"))}</label>
      <input id="proxy-add-link" class="text-field" type="text" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="velta://proxy?…" required aria-describedby="proxy-add-err">
      <p id="proxy-add-err" class="bar-opts-hint" role="alert" aria-live="assertive" style="color:var(--danger)"></p>
      <button type="submit" class="btn-text btn-primary">${escapeHtml(t("Add"))}</button>
    </form>`;
  const { close } = showModal({ title: t("SOCKS5 proxy"), body });
  const reopen = focusId => openProxySettings({ ...deps, focusId });
  // Back from a rename/delete/switch: keyboard focus returns to that row.
  if (deps.focusId) {
    setTimeout(() => body.querySelector(`li[data-id="${String(deps.focusId).replace(/[^a-z0-9]/gi, "")}"] button`)?.focus?.(), 80);
  }
  const ul = body.querySelector("[data-proxy-list]");
  ul?.addEventListener("click", async ev => {
    const b = ev.target?.closest?.("button[data-act]");
    const id = b?.closest?.("li[data-id]")?.dataset.id;
    if (!b || !id) return;
    const p = (list.proxies || []).find(x => x.id === id);
    if (!p) return;
    await proxyAction(b.dataset.act, p, { ...deps, invoke, close, reopen });
  });

  body.querySelector("[data-proxy-add]")?.addEventListener("submit", async ev => {
    ev.preventDefault();
    const input = body.querySelector("#proxy-add-link");
    const err = body.querySelector("#proxy-add-err");
    const link = extractProxyLink(input.value);
    if (!link) {
      err.textContent = t("Not a velta://proxy link");
      input.focus();
      return;
    }
    err.textContent = "";
    close();
    await acceptProxyLink(link, { confirmModal, choose: deps.choose || null, toast, errToast, onChange, invoke });
    await openProxySettings(deps);
  });
  return { body, close };
}

/** One saved-proxy action from the settings sheet. Exported for tests.
 * Dialogs (rename, delete, share) replace the sheet; it reopens after. */
export async function proxyAction(act, p, { invoke, confirmModal, askText, toast, errToast, onChange, showModal, renderQr, close, reopen }) {
  const name = proxyName(p);
  const fail = (what, e) => { errToast(t(what, { why: errMsg(e) }), 6000); };
  switch (act) {
    case "use":
    case "off":
      try {
        await invoke("proxy_select", { id: act === "use" ? p.id : null });
      } catch (e) {
        fail("Couldn't switch the proxy: {why}", e);
        return false;
      }
      await refreshProxyStatus(invoke);
      toast(act === "use" ? t("Now using {name}", { name }) : t("SOCKS5 proxy turned off"));
      onChange?.();
      await reopen?.(p.id);
      return true;
    case "rename": {
      const label = await askText?.(t("Rename proxy"), p.label || "", t("Save"));
      if (label == null) { await reopen?.(p.id); return false; }
      try {
        await invoke("proxy_rename", { id: p.id, label });
      } catch (e) {
        fail("Couldn't rename the proxy: {why}", e);
      }
      await refreshProxyStatus(invoke);
      onChange?.();
      await reopen?.(p.id);
      return true;
    }
    case "share":
      return !!(await openProxyShare({ showModal, toast, errToast, renderQr, id: p.id, invoke }));
    case "delete": {
      const ok = await confirmModal(
        t("Delete SOCKS5 proxy?"),
        p.active
          ? t("“{name}” is in use. Deleting it stops using the proxy and mail connects directly. You need its link to add it again.", { name })
          : t("Delete “{name}”? You need its link to add it again.", { name }),
        t("Delete"),
        true,
      );
      if (!ok) { await reopen?.(p.id); return false; }
      try {
        await invoke("proxy_delete", { id: p.id });
      } catch (e) {
        fail("Couldn't delete the proxy: {why}", e);
        await reopen?.(p.id);
        return false;
      }
      const fresh = await refreshProxyStatus(invoke);
      toast(t("SOCKS5 proxy deleted"));
      onChange?.();
      if (fresh.installed) await reopen?.(); else close?.();
      return true;
    }
  }
  return false;
}
