// lufi.js — "Large file" (#138): upload to a Lufi server (default
// upload.disroot.org), end-to-end encrypted, and share the link.
//
// Wire format = Lufi 0.07 web client (lufi-up.js / lufi-down.js), so a
// recipient without Velta opens the link in any browser and the Lufi page
// decrypts it:
//   - the file is cut into 750 000-byte slices;
//   - each slice is base64'd (btoa of the binary string) and encrypted with
//     sjcl.encrypt(key, b64) — SJCL defaults: AES-128-CCM, PBKDF2-SHA256
//     10 000 iterations, 64-bit tag; the key is a 32-byte random base64
//     string that only ever lives in the URL fragment (#key);
//   - a WebSocket text frame per slice: JSON(meta) + "XXMOJOXX" +
//     JSON.stringify(sjclJsonString) — the payload is double-encoded on
//     purpose, lufi-down.js does JSON.parse then sjcl.decrypt;
//   - the server answers each slice with {success, j, parts, short, token,
//     delay, created_at, ...}; slices 2..n carry id=short.
//   - link: <server>/r/<short>#<key>; delete: POST <server>/d/<short>/<token>
//     with _format=json (the JSON route skips the CSRF check).
// One salt per file (random) lets SJCL's cachedPbkdf2 derive the key once
// instead of per slice; every slice still gets a fresh random IV. The
// download page reads salt/iv from each slice's JSON, so this is invisible
// to it.
//
// Transport is injected (the Tauri shell owns the socket so it can go
// through the account proxy / DNS tunnel — fail closed, like link
// previews). This module is pure logic + storage and runs under node.

import sjcl from "../vendor/sjcl.mjs";

export const LUFI_SLICE = 750000;
export const DEFAULT_LUFI_SERVER = "https://upload.disroot.org";
const SERVER_KEY = "velta-lufi-server";
const FILES_KEY = "velta-lufi-files";

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

// https only, no query/fragment, no trailing slash; sub-path installs keep
// their path ("https://host/lufi"). Throws on anything else.
export function normalizeLufiServer(input) {
  let s = String(input ?? "").trim();
  if (!s) return DEFAULT_LUFI_SERVER;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { throw new Error("Not a valid server URL"); }
  if (u.protocol !== "https:") throw new Error("The Lufi server must use https://");
  if (u.username || u.password) throw new Error("Server URL must not contain credentials");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

export function lufiServer() {
  try { return normalizeLufiServer(store()?.getItem(SERVER_KEY) || ""); } catch { return DEFAULT_LUFI_SERVER; }
}
export function setLufiServer(url) {
  const v = normalizeLufiServer(url);
  if (v === DEFAULT_LUFI_SERVER) store()?.removeItem(SERVER_KEY);
  else store()?.setItem(SERVER_KEY, v);
  return v;
}

export const lufiWsUrl = (server) => server.replace(/^https:/, "wss:") + "/upload";
export const lufiDownloadUrl = (server, short, key) => `${server}/r/${short}#${key}`;
export const lufiDeleteUrl = (server, short, token) => `${server}/d/${short}/${token}`;

export function partCount(size) {
  return Math.max(1, Math.ceil(Number(size) / LUFI_SLICE));
}

function randomBytes(n, rand) {
  const b = new Uint8Array(n);
  (rand || ((a) => globalThis.crypto.getRandomValues(a)))(b);
  return b;
}
// Lufi's SJCL build ships no bytes codec — go through hex.
const bits = (bytes) => sjcl.codec.hex.toBits(Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""));

// Same shape as Lufi's genRandomKey: base64 of 8 random 32-bit words.
export function genLufiKey(rand) {
  return sjcl.codec.base64.fromBits(bits(randomBytes(32, rand)), 0);
}

// Effective expiry cap for a file of `size` bytes, in days (0 = no limit),
// mirroring Lufi's upload(): the largest delay_for_size threshold <= size
// wins, else max_delay.
export function lufiMaxDelay(config, size) {
  const max = Number(config?.max_delay ?? 0) || 0;
  const table = config?.delay_for_size;
  let cap = null;
  if (table && typeof table === "object") {
    const keys = Object.keys(table).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    for (const k of keys) if (Number(size) >= k) cap = Number(table[k]);
  }
  if (cap != null && cap > 0) return max > 0 ? Math.min(cap, max) : cap;
  return max;
}

// Expiry choices (days) for the picker + the default one.
export function lufiDelayChoices(config, size) {
  const max = lufiMaxDelay(config, size);
  let list = [1, 7, 30, 90, 365];
  if (max > 0) list = list.filter(d => d < max).concat([max]);
  else list = list.concat([0]); // 0 = never expires
  list = [...new Set(list)];
  const def = Number(config?.default_delay) || 1;
  const pick = max > 0 ? Math.min(def, max) : def;
  const dflt = list.includes(pick) ? pick : list.filter(d => d > 0 && d <= pick).pop() || list[0];
  return { choices: list, dflt, max };
}

export function lufiDelayLabel(days) {
  if (!days) return "Never";
  if (days === 1) return "1 day";
  if (days % 365 === 0) return days === 365 ? "1 year" : `${days / 365} years`;
  return `${days} days`;
}

// One slice → the text frame Lufi's server expects.
export function encryptSlice(key, b64, { salt, iv }) {
  return sjcl.encrypt(key, b64, { salt: bits(salt), iv: bits(iv) });
}
export function buildPartFrame(meta, encrypted) {
  return `${JSON.stringify(meta)}XXMOJOXX${JSON.stringify(encrypted)}`;
}
// Inverse of a /download frame's payload half (tests + round-trip check).
export function decryptSlice(key, payload) {
  const enc = typeof payload === "string" && payload.startsWith('"') ? JSON.parse(payload) : payload;
  return sjcl.decrypt(key, enc);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class LufiCancelled extends Error {
  constructor() { super("Upload cancelled"); this.name = "LufiCancelled"; }
}

// Upload one file.
//   file: {name, size, type}
//   readSlice(j) -> Promise<base64 string of bytes [j*SLICE, (j+1)*SLICE)>
//   transport: {send(text) -> Promise<reply text>, close()}
//   signal: AbortSignal (cancel); onProgress({part, parts, sentBytes, phase})
// Resolves {short, token, key, url, deleteUrl, delay, createdAt, expiresAt}.
export async function lufiUpload({ server, file, readSlice, transport, delay, delAtFirstView = false, signal, onProgress, rand }) {
  const key = genLufiKey(rand);
  const salt = randomBytes(8, rand);
  const parts = partCount(file.size);
  let short = null;
  let token = null;
  let last = null;
  const cancelOnServer = async () => {
    if (!short || !token) return;
    try { await transport.send(`${JSON.stringify({ id: short, mod_token: token, cancel: true, i: 0 })}XXMOJOXXuseless`); } catch {}
  };
  try {
    for (let j = 0; j < parts; j++) {
      if (signal?.aborted) { await cancelOnServer(); throw new LufiCancelled(); }
      onProgress?.({ part: j, parts, sentBytes: Math.min(file.size, j * LUFI_SLICE), phase: "encrypt" });
      const b64 = await readSlice(j);
      const enc = encryptSlice(key, b64, { salt, iv: randomBytes(16, rand) });
      const meta = {
        total: parts, part: j, size: file.size, name: file.name, type: file.type || "",
        delay, del_at_first_view: !!delAtFirstView, zipped: false, id: short, i: 0,
      };
      if (signal?.aborted) { await cancelOnServer(); throw new LufiCancelled(); }
      onProgress?.({ part: j, parts, sentBytes: Math.min(file.size, j * LUFI_SLICE), phase: "send" });
      const replyText = await transport.send(buildPartFrame(meta, enc));
      let reply;
      try { reply = JSON.parse(replyText); } catch { throw new Error("Unexpected reply from the Lufi server"); }
      if (!reply || !reply.success) throw new Error(reply?.msg ? String(reply.msg).replace(/<[^>]*>/g, "") : "The Lufi server refused the upload");
      if (!/^[A-Za-z0-9_-]+$/.test(String(reply.short || ""))) throw new Error("Lufi server sent no file id");
      short = String(reply.short);
      if (reply.token) token = String(reply.token);
      last = reply;
      onProgress?.({ part: j + 1, parts, sentBytes: Math.min(file.size, (j + 1) * LUFI_SLICE), phase: "sent" });
    }
  } finally {
    try { await transport.close?.(); } catch {}
  }
  const days = Number(last?.delay ?? delay) || 0;
  const createdAt = Number(last?.created_at) || Math.floor(Date.now() / 1000);
  return {
    short, token, key, delay: days, createdAt,
    expiresAt: days ? createdAt + days * 86400 : 0,
    url: lufiDownloadUrl(server, short, key),
    deleteUrl: token ? lufiDeleteUrl(server, short, token) : "",
  };
}

// Chat message text for a finished upload.
export function lufiMessageText({ name, size, url, expiresAt }, formatBytes, formatDate) {
  const exp = expiresAt ? `Available until ${formatDate(expiresAt * 1000)}` : "No expiry";
  return `📦 ${name} (${formatBytes(size)})\n${url}\n${exp} · end-to-end encrypted, the key is the part after #`;
}

// Parse a Lufi link out of a message: {server, short, key} or null.
export function parseLufiLink(text) {
  const m = String(text || "").match(/https:\/\/[^\s/]+(?:\/[^\s#]*?)?\/r\/([A-Za-z0-9_-]+)#([A-Za-z0-9+/=]{20,})/);
  if (!m) return null;
  const server = m[0].slice(0, m[0].indexOf(`/r/${m[1]}#`));
  return { server, short: m[1], key: m[2] };
}

// Deletion tokens stay on this device only (never in the chat message).
// Keyed by account + message id.
function readFiles() {
  try { return JSON.parse(store()?.getItem(FILES_KEY) || "{}") || {}; } catch { return {}; }
}
export function rememberLufiUpload(accountId, msgId, rec) {
  const all = readFiles();
  all[`${accountId}:${msgId}`] = {
    server: rec.server, short: rec.short, token: rec.token, url: rec.url,
    deleteUrl: rec.deleteUrl, name: rec.name, size: rec.size,
    expiresAt: rec.expiresAt || 0, deleted: false,
  };
  store()?.setItem(FILES_KEY, JSON.stringify(all));
}
export function lufiUploadFor(accountId, msgId) {
  return readFiles()[`${accountId}:${msgId}`] || null;
}
export function markLufiDeleted(accountId, msgId) {
  const all = readFiles();
  const k = `${accountId}:${msgId}`;
  if (all[k]) { all[k].deleted = true; store()?.setItem(FILES_KEY, JSON.stringify(all)); }
}
