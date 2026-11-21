// cryptex.js — second large-file provider (Cryptex, e.g. drop.gluek.info).
// Pure helpers + local storage; the network runs in cryptex.rs (Tauri) so
// the account proxy applies and CORS does not matter (the server rejects
// app origins, so the PWA cannot use it directly and hides it).
//
// Link in the chat: https://<server>/<id>#<password>. The web page at that
// URL auto-fills the id and the #password (fragment: never sent to the
// server by a browser), so it doubles as the web fallback. Velta parses it
// and downloads in one tap: open -> download token -> GET.

export const DEFAULT_CRYPTEX_SERVER = "https://drop.gluek.info";
export const CRYPTEX_MAX_FILE = 1024 * 1024 * 1024; // 1 GB, one file per upload
export const CRYPTEX_RETENTIONS = ["30m", "1h", "6h", "24h", "3d", "7d"];
export const CRYPTEX_DEFAULT_RETENTION = "7d";

const SERVER_KEY = "velta-cryptex-server";
const API_KEY = "velta-cryptex-key"; // local only, never exported (settings-transfer)
const FILES_KEY = "velta-cryptex-files";
const PROVIDER_KEY = "velta-large-provider";

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function normalizeCryptexServer(input) {
  let s = String(input || "").trim();
  if (!s) return DEFAULT_CRYPTEX_SERVER;
  if (!/^[a-z]+:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (u.protocol !== "https:") throw new Error("The Cryptex server must use https://");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}
export function cryptexServer() {
  try { return normalizeCryptexServer(store()?.getItem(SERVER_KEY) || ""); } catch { return DEFAULT_CRYPTEX_SERVER; }
}
export function setCryptexServer(url) {
  const v = normalizeCryptexServer(url);
  if (v === DEFAULT_CRYPTEX_SERVER) store()?.removeItem(SERVER_KEY); else store()?.setItem(SERVER_KEY, v);
  return v;
}
export function cryptexApiKey() { return store()?.getItem(API_KEY) || ""; }
export function setCryptexApiKey(k) {
  const v = String(k || "").trim();
  if (v) store()?.setItem(API_KEY, v); else store()?.removeItem(API_KEY);
}

export function largeFileProvider() { return store()?.getItem(PROVIDER_KEY) === "cryptex" ? "cryptex" : "lufi"; }
export function setLargeFileProvider(p) {
  if (p === "cryptex") store()?.setItem(PROVIDER_KEY, "cryptex"); else store()?.removeItem(PROVIDER_KEY);
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
export const cryptexLink = (server, id, password) => `${server}/${id}#${encodeURIComponent(password)}`;

// {server, id, password} from a message, or null. Only links whose path is a
// bare Cryptex id with a #password fragment.
export function parseCryptexLink(text) {
  const re = /https:\/\/[^\s/#]+(?:\/[^\s#]*)?#[^\s]+/g;
  for (const m of String(text || "").matchAll(re)) {
    let u;
    try { u = new URL(m[0]); } catch { continue; }
    const parts = u.pathname.split("/").filter(Boolean);
    const id = parts.pop() || "";
    if (!ID_RE.test(id) || id.length > 64) continue;
    const password = decodeURIComponent(u.hash.slice(1));
    if (!password) continue;
    const base = (u.origin + (parts.length ? "/" + parts.join("/") : "")).replace(/\/+$/, "");
    return { server: base, id, password };
  }
  return null;
}

export function retentionMs(r) {
  const m = /^(\d+)([mhd])$/.exec(String(r || ""));
  if (!m) return 0;
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}

export function retentionLabel(r, t = (s, v) => s.replace(/\{n\}/, v?.n)) {
  const m = /^(\d+)([mhd])$/.exec(String(r || ""));
  if (!m) return r;
  const n = Number(m[1]);
  return m[2] === "m" ? t("{n} min", { n }) : m[2] === "h" ? t("{n} h", { n }) : t("{n} d", { n });
}

export function cryptexPrecheck(size) {
  if (!(Number(size) > 0)) return "The file is empty";
  if (Number(size) > CRYPTEX_MAX_FILE) return "Too large for Cryptex (max 1 GB)";
  return null;
}

export function cryptexMessageText({ name, size, url, expiresAt }, formatBytes, formatDate) {
  return `📦 ${name} (${formatBytes(size)})\n${url}\nAvailable until ${formatDate(expiresAt)} · password-protected, the password is the part after #`;
}

// Sender-side records (id + password for "Delete from server"), this device only.
function readFiles() {
  try { return JSON.parse(store()?.getItem(FILES_KEY) || "{}") || {}; } catch { return {}; }
}
export function rememberCryptexUpload(accountId, msgId, rec) {
  const all = readFiles();
  all[`${accountId}:${msgId}`] = { server: rec.server, id: rec.id, password: rec.password, name: rec.name, size: rec.size, expiresAt: rec.expiresAt || 0, deleted: false };
  store()?.setItem(FILES_KEY, JSON.stringify(all));
}
export function cryptexUploadFor(accountId, msgId) { return readFiles()[`${accountId}:${msgId}`] || null; }
export function markCryptexDeleted(accountId, msgId) {
  const all = readFiles();
  const k = `${accountId}:${msgId}`;
  if (all[k]) { all[k].deleted = true; store()?.setItem(FILES_KEY, JSON.stringify(all)); }
}

// "server not reachable: …" / HTTP 5xx / connect errors -> offer the other provider.
export function looksUnreachable(err) {
  return /not reachable|timed? ?out|connection|dns|resolve|HTTP 5\d\d|Bad Gateway|Service Unavailable/i.test(String(err?.message || err || ""));
}
