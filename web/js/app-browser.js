// #137: recent webxdc apps + commands in the attach menu, and a catalog
// browser. Apps the account sent or opened are localStorage
// "velta-recent-apps" = { accId: [{ name, file, filename }] }, most recent
// first, capped at 10, deduped by filename. Commands reuse recent-commands.js.
//
// Catalogs are xdcget indexes: GET {mirror}/xdcget-lock.json (a JSON array).
// The page CSP blocks https fetch, so the caller passes getBytes backed by
// core get_http_response. The built-in mirror is always listed. Extra mirrors
// (≤8) live in "velta-xdc-mirrors". "velta-xdc-mirror-ok" is tried first;
// a throw or an empty index skips to the next. Downloads use that mirror's
// cache_relname, not the entry's absolute url (often a different host).

import { isValidXdc } from "./builtin-xdc.js";
import { base64ToBytes } from "./identity-backup.js";
import { t } from "./i18n.js";

export const APPS_KEY = "velta-recent-apps";
export const MIRRORS_KEY = "velta-xdc-mirrors";
export const MIRROR_OK_KEY = "velta-xdc-mirror-ok";
export const DEFAULT_MIRROR = "https://apps.testrun.org";
export const MAX_APPS = 10;
export const MAX_MIRRORS = 8;
export const MAX_APP_BYTES = 32 * 1024 * 1024;
// ponytail: one timeout per index probe. Parallel races if lists get long.
export const INDEX_TIMEOUT_MS = 8000;
export const APP_TIMEOUT_MS = 60000;

function readJson(key) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeJson(key, val) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(val)); } catch { /* full / private */ }
}
function readMap(key) {
  const v = readJson(key);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export function bytesFromBase64(b64) {
  const s = String(b64 ?? "").replace(/\s/g, "");
  if (!s) return new Uint8Array();
  const pad = s.length % 4 === 0 ? s : s + "=".repeat(4 - (s.length % 4));
  return base64ToBytes(pad);
}

// http(s) origin + path, no credentials, no hash. A pasted index URL loses
// its trailing /xdcget-lock.json so the mirror base is what gets stored.
export function normalizeMirror(raw) {
  try {
    const u = new URL(String(raw ?? "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    const path = u.pathname.replace(/\/+$/, "").replace(/\/xdcget-lock\.json$/i, "").replace(/\/+$/, "");
    return u.origin + path + u.search;
  } catch { return null; }
}

function readExtras() {
  const v = readJson(MIRRORS_KEY);
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const m of v) {
    const n = normalizeMirror(m);
    if (n && n !== DEFAULT_MIRROR && !out.includes(n)) out.push(n);
  }
  return out.slice(0, MAX_MIRRORS);
}
function readOk() {
  try { return globalThis.localStorage?.getItem(MIRROR_OK_KEY) || ""; } catch { return ""; }
}
function writeOk(v) {
  try {
    if (v) globalThis.localStorage?.setItem(MIRROR_OK_KEY, v);
    else globalThis.localStorage?.removeItem(MIRROR_OK_KEY);
  } catch { /* unavailable */ }
}

export function extraMirrors() { return readExtras(); }

export function mirrorList() {
  const all = [DEFAULT_MIRROR];
  for (const m of readExtras()) if (!all.includes(m)) all.push(m);
  const ok = normalizeMirror(readOk());
  if (ok && all.includes(ok)) return [ok, ...all.filter(m => m !== ok)];
  return all;
}

export function addMirror(raw) {
  const n = normalizeMirror(raw);
  if (!n) return null;
  if (n === DEFAULT_MIRROR) return n;
  const cur = readExtras();
  if (cur.includes(n)) return n;
  if (cur.length >= MAX_MIRRORS) return null;
  writeJson(MIRRORS_KEY, [...cur, n]);
  return n;
}

export function removeMirror(raw) {
  const n = normalizeMirror(raw);
  if (!n || n === DEFAULT_MIRROR) return;
  writeJson(MIRRORS_KEY, readExtras().filter(m => m !== n));
  if (normalizeMirror(readOk()) === n) writeOk("");
}

export function rememberMirror(raw) {
  const n = normalizeMirror(raw);
  if (n) writeOk(n);
}

export function recordApp(accountId, app) {
  const file = String(app?.file || "").trim().slice(0, 1024);
  const filename = String(app?.filename || file.split(/[/\\]/).pop() || "app.xdc").trim().slice(0, 120);
  const name = String(app?.name || filename).trim().slice(0, 80);
  if (!file || !name) return null;
  const all = readMap(APPS_KEY);
  const id = String(accountId);
  const prev = Array.isArray(all[id]) ? all[id] : [];
  const fn = filename.toLowerCase();
  // ponytail: filename is the identity. Two different apps sharing a name collapse.
  const next = [{ name, file, filename }, ...prev.filter(a => a && a.file !== file && String(a.filename || "").toLowerCase() !== fn)].slice(0, MAX_APPS);
  all[id] = next;
  writeJson(APPS_KEY, all);
  return next[0];
}

export function recentApps(accountId) {
  const list = readMap(APPS_KEY)[String(accountId)];
  if (!Array.isArray(list)) return [];
  return list.filter(a => a && typeof a.file === "string" && a.file && typeof a.name === "string").slice(0, MAX_APPS);
}

function cacheUrl(base, rel) {
  const r = String(rel || "").trim();
  if (!r || /[\s%\\?#]/.test(r) || r.split("/").includes("..") || /^[a-z][a-z0-9+.-]*:/i.test(r)) return null;
  return base.replace(/\/+$/, "") + "/" + r.replace(/^\/+/, "");
}
function xdcName(appId, relOrUrl) {
  const seg = String(relOrUrl).split(/[/\\?#]/).pop() || "";
  if (/^[A-Za-z0-9._-]{1,120}\.xdc$/i.test(seg)) return seg;
  const id = String(appId || "app").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 60) || "app";
  return id.toLowerCase().endsWith(".xdc") ? id : `${id}.xdc`;
}
function absoluteUrl(raw) {
  try {
    const u = new URL(String(raw ?? "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch { return null; }
}

export function parseCatalog(text, base) {
  const b = normalizeMirror(base);
  if (!b) return [];
  let arr;
  try { arr = JSON.parse(String(text ?? "").replace(/^\uFEFF/, "")); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const name = String(e.name || e.app_id || "").trim().slice(0, 80);
    if (!name) continue;
    const rel = typeof e.cache_relname === "string" ? e.cache_relname : "";
    const fileUrl = cacheUrl(b, rel) || absoluteUrl(e.url);
    if (!fileUrl) continue;
    out.push({
      name,
      appId: String(e.app_id || "").slice(0, 80),
      description: String(e.description || "").replace(/\s+/g, " ").trim().slice(0, 240),
      fileUrl,
      filename: xdcName(e.app_id, fileUrl),
    });
  }
  return out;
}

// First mirror whose index parses to a non-empty list. Others are skipped.
export async function loadCatalog(mirrors, getText) {
  let last = new Error("No catalog mirror answered");
  const seen = [];
  for (const raw of mirrors) {
    const base = normalizeMirror(raw);
    if (!base || seen.includes(base)) continue;
    seen.push(base);
    try {
      const text = await getText(base + "/xdcget-lock.json");
      const apps = parseCatalog(text, base);
      if (apps.length) return { base, apps };
      last = new Error("Empty catalog");
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw last;
}

function menuButton(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ctx-item";
  const span = document.createElement("span");
  span.textContent = label;
  b.append(span);
  b.addEventListener("click", () => onClick());
  return b;
}
function emptyRow(text) {
  const p = document.createElement("div");
  p.className = "attach-empty";
  p.textContent = text;
  return p;
}

// Two <details> under the attach actions. Summary clicks stay inside the
// menu; row clicks are the caller's (they close it).
export function appendAttachLists(menu, { apps = [], commands = [], onApp, onCommand, onBrowse } = {}) {
  const details = (title, nodes) => {
    const d = document.createElement("details");
    d.className = "drawer-details attach-details";
    const s = document.createElement("summary");
    s.textContent = title;
    const box = document.createElement("div");
    box.className = "attach-sub";
    for (const n of nodes) box.append(n);
    d.append(s, box);
    return d;
  };
  const appNodes = apps.length ? apps.map(a => menuButton(a.name, () => onApp?.(a))) : [emptyRow(t("No apps yet"))];
  appNodes.push(menuButton(t("Browse apps…"), () => onBrowse?.()));
  const cmdNodes = commands.length ? commands.map(c => menuButton(c, () => onCommand?.(c))) : [emptyRow(t("No commands yet"))];
  menu.append(details(t("Apps"), appNodes), details(t("Commands"), cmdNodes));
}

export function openAppBrowser({ showModal, toast, alive, getBytes, sendApp }) {
  const body = document.createElement("div");
  body.className = "app-browser";
  const search = document.createElement("input");
  search.className = "text-field share-search";
  search.type = "search";
  search.placeholder = t("Search apps");
  search.setAttribute("aria-label", t("Search apps"));
  const status = document.createElement("p");
  status.className = "pm-hint";
  const list = document.createElement("div");
  const mirrors = document.createElement("details");
  mirrors.className = "drawer-details";
  const sum = document.createElement("summary");
  sum.textContent = t("Catalog mirrors");
  const hint = document.createElement("p");
  hint.className = "pm-hint";
  hint.textContent = t("Tried in this order. A mirror that does not answer is skipped.");
  const box = document.createElement("div");
  const form = document.createElement("form");
  form.className = "mirror-add";
  const input = document.createElement("input");
  input.className = "text-field";
  input.type = "url";
  input.placeholder = "https://mirror.example";
  input.setAttribute("aria-label", t("Mirror URL"));
  const add = document.createElement("button");
  add.type = "submit";
  add.className = "btn-text";
  add.textContent = t("Add");
  form.append(input, add);
  mirrors.append(sum, hint, box, form);
  body.append(search, status, list, mirrors);

  let catalog = [];
  let busy = false;
  let gen = 0;
  const { close } = showModal({ title: "Apps", body });

  function paint() {
    const q = search.value.trim().toLowerCase();
    const rows = catalog.filter(a => !q || `${a.name} ${a.description} ${a.appId}`.toLowerCase().includes(q));
    list.replaceChildren();
    if (!rows.length) {
      if (catalog.length) {
        const p = document.createElement("p");
        p.className = "pm-hint";
        p.textContent = t("No matching apps");
        list.append(p);
      }
      return;
    }
    for (const app of rows) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "app-row";
      b.append(document.createTextNode(app.name));
      if (app.description) {
        const s = document.createElement("small");
        s.textContent = app.description;
        b.append(s);
      }
      b.addEventListener("click", () => pick(app));
      list.append(b);
    }
  }
  function paintMirrors() {
    box.replaceChildren();
    for (const m of mirrorList()) {
      const row = document.createElement("div");
      row.className = "mirror-row";
      const span = document.createElement("span");
      span.textContent = m;
      row.append(span);
      if (m !== DEFAULT_MIRROR) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "btn-text";
        rm.textContent = t("Remove");
        rm.addEventListener("click", () => { removeMirror(m); reload(); });
        row.append(rm);
      }
      box.append(row);
    }
  }
  async function reload() {
    const g = ++gen;
    catalog = [];
    status.textContent = t("Loading catalog…");
    list.replaceChildren();
    paintMirrors();
    try {
      const { base, apps } = await loadCatalog(mirrorList(), async (url) => {
        const bytes = await getBytes(url, INDEX_TIMEOUT_MS);
        return new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array());
      });
      if (g !== gen) return;
      if (!alive()) { close(); return; }
      rememberMirror(base);
      catalog = apps;
      status.textContent = "";
      paint();
      paintMirrors();
    } catch {
      if (g !== gen) return;
      if (!alive()) { close(); return; }
      catalog = [];
      status.textContent = t("No catalog reachable");
    }
  }
  async function pick(app) {
    if (busy) return;
    busy = true;
    status.textContent = t("Downloading…");
    try {
      // ponytail: the whole .xdc returns as base64. Stream to a file if catalogs ship huge apps.
      const bytes = await getBytes(app.fileUrl, APP_TIMEOUT_MS);
      if (!alive()) { close(); return; }
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_APP_BYTES || !isValidXdc(bytes)) {
        throw new Error(t("That download is not a webxdc app"));
      }
      await sendApp(app, bytes);
      close();
    } catch (e) {
      if (alive()) {
        toast(t("Could not add app") + ": " + (e?.message || e), 4000, { danger: true });
        status.textContent = "";
      }
    } finally { busy = false; }
  }
  search.addEventListener("input", paint);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const n = normalizeMirror(input.value);
    if (!n) { toast(t("Enter an http(s) mirror URL"), 3000, { danger: true }); return; }
    if (n !== DEFAULT_MIRROR && !extraMirrors().includes(n) && extraMirrors().length >= MAX_MIRRORS) {
      toast(t("Mirror list is full"), 3000, { danger: true });
      return;
    }
    addMirror(n);
    input.value = "";
    reload();
  });
  setTimeout(() => search.focus(), 60);
  reload();
  return { close };
}
