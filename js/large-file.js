// large-file.js — attach menu "Large file" (#138): pick → choose expiry →
// encrypted Lufi upload with progress/cancel → chat message with the link.
// Protocol + storage live in lufi.js; sockets/file reads in lufi.rs.
// Tauri only: the PWA has no shell to reach the server through the account
// proxy (and its CSP has no connect-src for arbitrary Lufi hosts).

import { showModal, toast, confirmModal } from "./ui.js";
import { escapeHtml, escapeAttr } from "./components.js";
import { formatBytes, formatDateTime } from "./format.js";
import { shellProxy } from "./link-preview.js";
import { tauriInvoke, isAndroid } from "./tauri.js";
import {
  lufiServer, setLufiServer, normalizeLufiServer, lufiDelayChoices, lufiDelayLabel,
  lufiUpload, lufiMessageText, rememberLufiUpload, lufiUploadFor, markLufiDeleted,
  LufiCancelled,
} from "./lufi.js";
import {
  cryptexServer, setCryptexServer, cryptexApiKey, setCryptexApiKey, largeFileProvider, setLargeFileProvider,
  CRYPTEX_RETENTIONS, CRYPTEX_DEFAULT_RETENTION, retentionLabel, retentionMs, cryptexPrecheck, cryptexLink,
  cryptexMessageText, rememberCryptexUpload, cryptexUploadFor, markCryptexDeleted, looksUnreachable, parseCryptexLink,
} from "./cryptex.js";
import { t } from "./i18n.js";

export const largeFileAvailable = () => !!tauriInvoke();

function errText(e) { return String(e?.message || e || "unknown error"); }

async function pickPath(invoke) {
  let picked = await invoke("plugin:dialog|open", { options: { multiple: false } });
  if (Array.isArray(picked)) picked = picked[0];
  if (!picked) return null;
  if (/^content:\/\//.test(picked)) {
    return invoke("resolve_content_uri", { uri: picked, filename: String(Date.now()) });
  }
  await invoke("allow_picked_path", { path: picked }).catch(() => {});
  return picked;
}

// Options dialog. Resolves {server, delay, burn} or null.
function optionsDialog({ name, size, server, config, onServerChange }) {
  return new Promise(resolve => {
    let cfg = config;
    const body = document.createElement("div");
    const render = () => {
      const { choices, dflt } = lufiDelayChoices(cfg, size);
      const forced = Number(cfg?.force_burn_after_reading) === 1;
      body.innerHTML = `
        <p style="font-size:15px;line-height:1.45;margin:0 0 10px"><b>${escapeHtml(name)}</b> · ${escapeHtml(formatBytes(size))}</p>
        <p style="font-size:13.5px;line-height:1.45;color:var(--text-dim);margin:0 0 12px">${escapeHtml(t("The file is encrypted on this device before upload. The key goes only into the link you send (after #); the server stores ciphertext. Anyone with the link can download it until it expires."))}</p>
        <div style="font-size:13px;color:var(--text-dim);margin:8px 0 4px">${escapeHtml(t("Server (Lufi)"))}</div><input class="text-field" type="url" inputmode="url" autocapitalize="none" data-server value="${escapeAttr(server)}" spellcheck="false" autocomplete="off">
        <div data-server-note style="font-size:12.5px;color:var(--text-dim);margin:4px 0 10px">${escapeHtml(cfg?.instance_name || "")}</div>
        <div style="font-size:13px;color:var(--text-dim);margin:8px 0 4px">${escapeHtml(t("Delete after"))}</div><select class="text-field" data-delay>${choices.map(d => `<option value="${d}"${d === dflt ? " selected" : ""}>${escapeHtml(lufiDelayLabel(d))}</option>`).join("")}</select>
        <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:14.5px"><input type="checkbox" data-burn${forced ? " checked disabled" : ""}> ${escapeHtml(t("Delete after the first download"))}</label>`;
      body.querySelector("[data-server]").addEventListener("change", async (e) => {
        const note = body.querySelector("[data-server-note]");
        try {
          const s = normalizeLufiServer(e.target.value);
          note.textContent = t("Checking server…");
          cfg = await onServerChange(s);
          server = s;
          render();
        } catch (err) { note.textContent = errText(err); }
      });
    };
    render();
    const foot = document.createElement("div");
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn-text", textContent: t("Cancel") });
    const ok = Object.assign(document.createElement("button"), { type: "button", className: "btn-text", textContent: t("Upload & send") });
    foot.append(cancel, ok);
    let done = false;
    const { close } = showModal({ title: "Send large file", body, foot, compact: true, onClose: () => { if (!done) resolve(null); } });
    cancel.addEventListener("click", close);
    // Not closed here: the progress modal REPLACES this one (showModal
    // reuses the history entry). Closing first would history.back(), and
    // that async popstate would land on — and cancel — the progress modal.
    ok.addEventListener("click", () => {
      done = true;
      resolve({ server, config: cfg, delay: Number(body.querySelector("[data-delay]").value) || 0, burn: !!body.querySelector("[data-burn]").checked, dismiss: close });
    });
  });
}

function progressDialog(name, onCancel) {
  const body = document.createElement("div");
  body.innerHTML = `<p style="font-size:15px;margin:0 0 6px">${escapeHtml(name)}</p>
    <progress class="mfp-bar" max="1000" value="0" data-bar></progress>
    <p data-status style="font-size:13.5px;color:var(--text-dim);margin:8px 0 0">${escapeHtml(t("Connecting…"))}</p>`;
  const foot = document.createElement("div");
  const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn-text", textContent: t("Cancel upload") });
  foot.append(cancel);
  let finished = false;
  const m = showModal({ title: "Uploading", body, foot, compact: true, onClose: () => { if (!finished) onCancel(); } });
  cancel.addEventListener("click", () => { onCancel(); m.close(); });
  return {
    update({ part, parts, sentBytes, phase }, size) {
      body.querySelector("[data-bar]").value = Math.round(1000 * sentBytes / Math.max(1, size));
      body.querySelector("[data-status]").textContent = phase === "encrypt"
        ? t("Encrypting part {n} of {total}", { n: part + 1, total: parts })
        : phase === "send" ? t("Sending part {n} of {total}", { n: part + 1, total: parts }) + " · " + t("{n} of {total}", { n: formatBytes(sentBytes), total: formatBytes(size) })
          : t("{n} of {total}", { n: formatBytes(sentBytes), total: formatBytes(size) });
    },
    done() { finished = true; m.close(); },
  };
}

class ProviderDown extends Error {}

// Lufi upload (unchanged flow). Throws ProviderDown when the server cannot be reached.
async function lufiFlow({ invoke, file, handle, proxy, accountId, send, isCurrent, setDismiss }) {
  let dismiss = null;
  try {
      let server = lufiServer();
      const loadConfig = (s) => invoke("lufi_config", { server: s, proxy });
      let config;
      try { config = await loadConfig(server); } catch (e) { throw new ProviderDown(`${server}: ${errText(e)}`); }
      if (!isCurrent()) return null;
      const opts = await optionsDialog({ name: file.name, size: file.size, server, config, onServerChange: loadConfig });
      if (!opts) return null;
      dismiss = opts.dismiss; setDismiss(dismiss);
      if (!isCurrent()) return null;
      server = setLufiServer(opts.server);
      config = opts.config;
      if (config?.stop_upload) throw new Error("This server does not accept uploads right now");
      if (Number(config?.need_authentication)) throw new Error("This server requires a login — pick another one");
      const max = Number(config?.max_file_size) || 0;
      if (max && file.size > max) throw new Error(`Too large for this server (max ${formatBytes(max)})`);

      const ctrl = new AbortController();
      const prog = progressDialog(file.name, () => ctrl.abort());
      dismiss = null; setDismiss(null);
      let sock = null;
      let res;
      try {
        sock = await invoke("lufi_ws_open", { server, proxy });
        if (ctrl.signal.aborted) throw new LufiCancelled();
        res = await lufiUpload({
          server, file: { name: file.name, size: file.size, type: "" },
          readSlice: (j) => invoke("lufi_read_slice", { handle, index: j }),
          transport: {
            send: (text) => invoke("lufi_ws_send", { id: sock, text }),
            close: () => invoke("lufi_ws_close", { id: sock }),
          },
          delay: opts.delay, delAtFirstView: opts.burn, signal: ctrl.signal,
          onProgress: (p) => prog.update(p, file.size),
        });
      } catch (e) {
        if (sock != null) invoke("lufi_ws_close", { id: sock }).catch(() => {});
        prog.done();
        throw e;
      }
      prog.done();
      const text = lufiMessageText({ name: file.name, size: file.size, url: res.url, expiresAt: res.expiresAt },
        formatBytes, (ms) => formatDateTime(ms));
      const msg = await send(text);
      if (msg?.id != null) rememberLufiUpload(accountId, msg.id, { ...res, server, name: file.name, size: file.size });
      return msg;

  } catch (e) {
    if (e instanceof LufiCancelled || e?.name === "LufiCancelled") throw e;
    if (/not reachable|timed out|connection/i.test(errText(e)) && !(e instanceof ProviderDown)) throw new ProviderDown(errText(e));
    throw e;
  }
}

// Cryptex options: server, API key (private-mode servers), retention, burn.
function cryptexDialog({ name, size }) {
  return new Promise(resolve => {
    const body = document.createElement("div");
    body.innerHTML = `
      <p style="font-size:15px;line-height:1.45;margin:0 0 10px"><b>${escapeHtml(name)}</b> · ${escapeHtml(formatBytes(size))}</p>
      <p style="font-size:13.5px;line-height:1.45;color:var(--text-dim);margin:0 0 12px">${escapeHtml(t("Cryptex keeps the file behind a random password that goes only into the link you send (after #). The server sees the file while storing it. Anyone with the link can download it until it expires."))}</p>
      <div style="font-size:13px;color:var(--text-dim);margin:8px 0 4px">${escapeHtml(t("Server (Cryptex)"))}</div><input class="text-field" type="url" inputmode="url" autocapitalize="none" data-server value="${escapeAttr(cryptexServer())}" spellcheck="false" autocomplete="off">
      <div style="font-size:13px;color:var(--text-dim);margin:8px 0 4px">${escapeHtml(t("API key (only for private servers)"))}</div><input class="text-field" type="password" autocapitalize="none" data-key value="${escapeAttr(cryptexApiKey())}" spellcheck="false" autocomplete="off">
      <div style="font-size:12.5px;color:var(--text-dim);margin:4px 0 10px">${escapeHtml(t("Stored on this device only, never exported."))}</div>
      <div style="font-size:13px;color:var(--text-dim);margin:8px 0 4px">${escapeHtml(t("Delete after"))}</div><select class="text-field" data-ret>${CRYPTEX_RETENTIONS.map(r => `<option value="${r}"${r === CRYPTEX_DEFAULT_RETENTION ? " selected" : ""}>${escapeHtml(retentionLabel(r, t))}</option>`).join("")}</select>
      <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:14.5px"><input type="checkbox" data-burn> ${escapeHtml(t("Delete after the first download"))}</label>`;
    const foot = document.createElement("div");
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn-text", textContent: t("Cancel") });
    const ok = Object.assign(document.createElement("button"), { type: "button", className: "btn-text", textContent: t("Upload & send") });
    foot.append(cancel, ok);
    let done = false;
    const { close } = showModal({ title: "Send large file", body, foot, compact: true, onClose: () => { if (!done) resolve(null); } });
    cancel.addEventListener("click", close);
    ok.addEventListener("click", () => {
      let server;
      try { server = setCryptexServer(body.querySelector("[data-server]").value); } catch (e) { toast(errText(e), 3000, { danger: true }); return; }
      setCryptexApiKey(body.querySelector("[data-key]").value);
      done = true;
      resolve({ server, key: cryptexApiKey(), retention: body.querySelector("[data-ret]").value, burn: !!body.querySelector("[data-burn]").checked, dismiss: close });
    });
  });
}

async function cryptexFlow({ invoke, file, handle, proxy, accountId, send, isCurrent, setDismiss }) {
  const bad = cryptexPrecheck(file.size);
  if (bad) throw new Error(t(bad));
  const opts = await cryptexDialog({ name: file.name, size: file.size });
  if (!opts || !isCurrent()) return null;
  setDismiss(opts.dismiss);
  const upload = Date.now();
  let cancelled = false;
  const prog = progressDialog(file.name, () => { cancelled = true; invoke("cryptex_cancel", { upload }).catch(() => {}); });
  setDismiss(null);
  const timer = setInterval(async () => {
    const [sent] = await invoke("cryptex_progress", { upload }).catch(() => [0, 0]);
    prog.update({ sentBytes: Math.min(sent, file.size) }, file.size);
  }, 500);
  const password = await invoke("cryptex_new_password");
  let res;
  try {
    res = await invoke("cryptex_create", { server: opts.server, key: opts.key || null, handle, upload, password, retention: opts.retention, autodestroy: opts.burn, proxy });
  } catch (e) {
    if (cancelled) throw new LufiCancelled();
    throw looksUnreachable(e) ? new ProviderDown(`${opts.server}: ${errText(e)}`) : new Error(errText(e));
  } finally {
    clearInterval(timer);
    prog.done();
  }
  if (!res?.id) throw new Error("unexpected reply from the Cryptex server");
  const expiresAt = Date.now() + retentionMs(opts.retention);
  const url = cryptexLink(opts.server, res.id, password);
  const text = cryptexMessageText({ name: file.name, size: file.size, url, expiresAt }, formatBytes, (ms) => formatDateTime(ms));
  const msg = await send(text);
  if (msg?.id != null) rememberCryptexUpload(accountId, msg.id, { server: opts.server, id: res.id, password, name: file.name, size: file.size, expiresAt });
  return msg;
}

// The whole flow. `send(text)` posts the chat message and returns it.
// Provider: Lufi or Cryptex (remembered); if one is unreachable, offer the other.
export async function sendLargeFile({ accountId, send, isCurrent = () => true }) {
  const invoke = tauriInvoke();
  if (!invoke) { toast(t("Large file upload runs in the Velta app"), 3000); return null; }
  let handle = null;
  let dismiss = null; // options modal still open until the progress one replaces it
  try {
    const path = await pickPath(invoke);
    if (!path || !isCurrent()) return null;
    const file = await invoke("lufi_open_file", { path });
    handle = file.handle;
    const proxy = await shellProxy(); // throws while unknown: no direct fallback
    let provider = await chooseProvider();
    if (!provider) return null;
    const ctx = { invoke, file, handle, proxy, accountId, send, isCurrent, setDismiss: (d) => { dismiss = d; } };
    for (let tries = 0; tries < 2; tries++) {
      try {
        return await (provider === "cryptex" ? cryptexFlow(ctx) : lufiFlow(ctx));
      } catch (e) {
        if (!(e instanceof ProviderDown) || tries) throw e;
        dismiss?.(); dismiss = null;
        const other = provider === "cryptex" ? "lufi" : "cryptex";
        const name = other === "cryptex" ? "Cryptex" : "Lufi";
        if (!await confirmModal("Server not reachable", t("{error}\n\nUpload with {name} instead?", { error: errText(e), name }), t("Use {name}", { name }))) return null;
        provider = other;
        setLargeFileProvider(provider);
      }
    }
    return null;
  } catch (e) {
    if (e instanceof LufiCancelled || e?.name === "LufiCancelled") { toast(t("Upload cancelled"), 2000); return null; }
    toast(t("Large file: ") + errText(e), 5000, { danger: true });
    return null;
  } finally {
    dismiss?.();
    if (handle != null) invoke("lufi_close_file", { handle }).catch(() => {});
  }
}

// Provider picker (remembers the last choice as the default).
function chooseProvider() {
  return new Promise(resolve => {
    const cur = largeFileProvider();
    const body = document.createElement("div");
    body.innerHTML = `<div role="radiogroup" aria-label="${escapeAttr(t("Upload with"))}" style="display:flex;flex-direction:column;gap:10px">
      ${[["lufi", "Lufi", t("End-to-end encrypted on this device; any Lufi server")], ["cryptex", "Cryptex", t("Password-protected link, up to 1 GB, up to 7 days")]].map(([v, n, d]) => `
      <label style="display:flex;gap:10px;align-items:flex-start;font-size:14.5px"><input type="radio" name="lfp" value="${v}"${v === cur ? " checked" : ""}><span><b>${n}</b><br><span style="font-size:13px;color:var(--text-dim)">${escapeHtml(d)}</span></span></label>`).join("")}</div>`;
    const foot = document.createElement("div");
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn-text", textContent: t("Cancel") });
    const ok = Object.assign(document.createElement("button"), { type: "button", className: "btn-text", textContent: t("Continue") });
    foot.append(cancel, ok);
    let done = false;
    const { close } = showModal({ title: "Upload with", body, foot, compact: true, onClose: () => { if (!done) resolve(null); } });
    cancel.addEventListener("click", close);
    ok.addEventListener("click", () => {
      const v = body.querySelector("input[name=lfp]:checked")?.value || "lufi";
      setLargeFileProvider(v);
      done = true;
      close();
      resolve(v);
    });
  });
}

// Message-info rows for a message that carries one of our uploads.
export function largeFileInfoHtml(rec) {
  if (!rec) return "";
  const exp = rec.expiresAt ? formatDateTime(rec.expiresAt * 1000) : "never";
  return `<div class="info-row"><span class="k">${escapeHtml(t("Large file"))}</span><span class="v">${escapeHtml(rec.name)} · ${escapeHtml(formatBytes(rec.size))}</span></div>
    <div class="info-row"><span class="k">${escapeHtml(t("Expires"))}</span><span class="v">${escapeHtml(rec.deleted ? t("deleted from server") : exp)}</span></div>
    <div class="info-row wrap"><span class="k">${escapeHtml(t("Deletion link"))}</span><span class="v">${escapeHtml(rec.deleteUrl || "—")}${rec.deleted ? "" : ` <button type="button" class="btn-text" data-lufi-delete style="color:var(--danger)">${escapeHtml(t("Delete from server"))}</button>`}</span></div>`;
}

export function wireLargeFileInfo(modal, accountId, msgId) {
  const btn = modal.querySelector("[data-lufi-delete]");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const rec = lufiUploadFor(accountId, msgId);
    const invoke = tauriInvoke();
    if (!rec || !invoke) return;
    if (!await confirmModal("Delete from server", t("Delete \"{name}\" from {server}? The link in the chat stops working.", { name: rec.name, server: rec.server }), t("Delete"))) return;
    try {
      const proxy = await shellProxy();
      const r = await invoke("lufi_delete", { server: rec.server, short: rec.short, token: rec.token, proxy });
      if (!r?.success) throw new Error(String(r?.msg || "server refused").replace(/<[^>]*>/g, ""));
      markLufiDeleted(accountId, msgId);
      toast(t("Deleted from the server"), 2200);
    } catch (e) { toast(t("Could not delete: ") + errText(e), 4000, { danger: true }); }
  });
}

// Receiver: one tap on a Cryptex card. open -> (save dialog on Android) ->
// cryptex_fetch (token + GET in Rust). Returns where it was saved.
export async function fetchCryptexLink(link) {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error(t("Open the link in a browser to download"));
  const proxy = await shellProxy();
  // Our own key only for our own server (private-mode servers may want it).
  const key = link.server === cryptexServer() ? (cryptexApiKey() || null) : null;
  const info = await invoke("cryptex_open", { server: link.server, key, id: link.id, password: link.password, proxy });
  const f = info?.files?.[0];
  if (!f?.filename) throw new Error(t("This link has no file"));
  let dest = null;
  if (isAndroid()) {
    const picked = await invoke("plugin:dialog|save", { options: { title: t("Save file"), defaultPath: f.filename } });
    if (!picked) throw new Error("cancelled");
    dest = String(picked);
  }
  toast(t("Downloading {name} ({size})…", { name: f.filename, size: formatBytes(f.size || 0) }), 2500);
  return invoke("cryptex_fetch", { server: link.server, key, id: link.id, password: link.password, filename: f.filename, dest, proxy });
}

export function cryptexInfoHtml(rec) {
  if (!rec) return "";
  const exp = rec.expiresAt ? formatDateTime(rec.expiresAt) : "—";
  return `<div class="info-row"><span class="k">${escapeHtml(t("Large file"))}</span><span class="v">${escapeHtml(rec.name)} · ${escapeHtml(formatBytes(rec.size))} · Cryptex</span></div>
    <div class="info-row"><span class="k">${escapeHtml(t("Expires"))}</span><span class="v">${escapeHtml(rec.deleted ? t("deleted from server") : exp)}</span></div>
    ${rec.deleted ? "" : `<div class="info-row"><span class="k"></span><span class="v"><button type="button" class="btn-text" data-cryptex-delete style="color:var(--danger)">${escapeHtml(t("Delete from server"))}</button></span></div>`}`;
}

export function wireCryptexInfo(modal, accountId, msgId) {
  const btn = modal.querySelector("[data-cryptex-delete]");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const rec = cryptexUploadFor(accountId, msgId);
    const invoke = tauriInvoke();
    if (!rec || !invoke) return;
    if (!await confirmModal("Delete from server", t("Delete \"{name}\" from {server}? The link in the chat stops working.", { name: rec.name, server: rec.server }), t("Delete"))) return;
    try {
      const proxy = await shellProxy();
      const key = rec.server === cryptexServer() ? (cryptexApiKey() || null) : null;
      await invoke("cryptex_destroy", { server: rec.server, key, id: rec.id, password: rec.password, proxy });
      markCryptexDeleted(accountId, msgId);
      toast(t("Deleted from the server"), 2200);
    } catch (e) {
      // Already gone (expired / burned) counts as deleted.
      if (/does not exist|expired/i.test(errText(e))) { markCryptexDeleted(accountId, msgId); toast(t("Deleted from the server"), 2200); return; }
      toast(t("Could not delete: ") + errText(e), 4000, { danger: true });
    }
  });
}
