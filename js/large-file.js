// large-file.js — attach menu "Large file" (#138): pick → choose expiry →
// encrypted Lufi upload with progress/cancel → chat message with the link.
// Protocol + storage live in lufi.js; sockets/file reads in lufi.rs.
// Tauri only: the PWA has no shell to reach the server through the account
// proxy (and its CSP has no connect-src for arbitrary Lufi hosts).

import { showModal, toast, confirmModal } from "./ui.js";
import { escapeHtml, escapeAttr } from "./components.js";
import { formatBytes, formatDateTime } from "./format.js";
import { shellProxy } from "./link-preview.js";
import { tauriInvoke } from "./tauri.js";
import {
  lufiServer, setLufiServer, normalizeLufiServer, lufiDelayChoices, lufiDelayLabel,
  lufiUpload, lufiMessageText, rememberLufiUpload, lufiUploadFor, markLufiDeleted,
  LufiCancelled,
} from "./lufi.js";

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
        <p style="font-size:13.5px;line-height:1.45;color:var(--text-dim);margin:0 0 12px">The file is encrypted on this device before upload. The key goes only into the link you send (after #); the server stores ciphertext. Anyone with the link can download it until it expires.</p>
        <div style="font-size:13px;color:var(--text-dim);margin:8px 0 4px">Server (Lufi)</div><input class="text-field" type="url" inputmode="url" autocapitalize="none" data-server value="${escapeAttr(server)}" spellcheck="false" autocomplete="off">
        <div data-server-note style="font-size:12.5px;color:var(--text-dim);margin:4px 0 10px">${escapeHtml(cfg?.instance_name || "")}</div>
        <div style="font-size:13px;color:var(--text-dim);margin:8px 0 4px">Delete after</div><select class="text-field" data-delay>${choices.map(d => `<option value="${d}"${d === dflt ? " selected" : ""}>${escapeHtml(lufiDelayLabel(d))}</option>`).join("")}</select>
        <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:14.5px"><input type="checkbox" data-burn${forced ? " checked disabled" : ""}> Delete after the first download</label>`;
      body.querySelector("[data-server]").addEventListener("change", async (e) => {
        const note = body.querySelector("[data-server-note]");
        try {
          const s = normalizeLufiServer(e.target.value);
          note.textContent = "Checking server…";
          cfg = await onServerChange(s);
          server = s;
          render();
        } catch (err) { note.textContent = errText(err); }
      });
    };
    render();
    const foot = document.createElement("div");
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn-text", textContent: "Cancel" });
    const ok = Object.assign(document.createElement("button"), { type: "button", className: "btn-text", textContent: "Upload & send" });
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
    <p data-status style="font-size:13.5px;color:var(--text-dim);margin:8px 0 0">Connecting…</p>`;
  const foot = document.createElement("div");
  const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn-text", textContent: "Cancel upload" });
  foot.append(cancel);
  let finished = false;
  const m = showModal({ title: "Uploading", body, foot, compact: true, onClose: () => { if (!finished) onCancel(); } });
  cancel.addEventListener("click", () => { onCancel(); m.close(); });
  return {
    update({ part, parts, sentBytes, phase }, size) {
      body.querySelector("[data-bar]").value = Math.round(1000 * sentBytes / Math.max(1, size));
      body.querySelector("[data-status]").textContent = phase === "encrypt"
        ? `Encrypting part ${part + 1} of ${parts}`
        : phase === "send" ? `Sending part ${part + 1} of ${parts} · ${formatBytes(sentBytes)} of ${formatBytes(size)}`
          : `${formatBytes(sentBytes)} of ${formatBytes(size)}`;
    },
    done() { finished = true; m.close(); },
  };
}

// The whole flow. `send(text)` posts the chat message and returns it.
export async function sendLargeFile({ accountId, send, isCurrent = () => true }) {
  const invoke = tauriInvoke();
  if (!invoke) { toast("Large file upload runs in the Velta app", 3000); return null; }
  let handle = null;
  let dismiss = null; // options modal still open until the progress one replaces it
  try {
    const path = await pickPath(invoke);
    if (!path || !isCurrent()) return null;
    const file = await invoke("lufi_open_file", { path });
    handle = file.handle;
    const proxy = await shellProxy(); // throws while unknown: no direct fallback
    let server = lufiServer();
    const loadConfig = (s) => invoke("lufi_config", { server: s, proxy });
    let config;
    try { config = await loadConfig(server); } catch (e) { throw new Error(`${server}: ${errText(e)}`); }
    if (!isCurrent()) return null;
    const opts = await optionsDialog({ name: file.name, size: file.size, server, config, onServerChange: loadConfig });
    if (!opts) return null;
    dismiss = opts.dismiss;
    if (!isCurrent()) return null;
    server = setLufiServer(opts.server);
    config = opts.config;
    if (config?.stop_upload) throw new Error("This server does not accept uploads right now");
    if (Number(config?.need_authentication)) throw new Error("This server requires a login — pick another one");
    const max = Number(config?.max_file_size) || 0;
    if (max && file.size > max) throw new Error(`Too large for this server (max ${formatBytes(max)})`);

    const ctrl = new AbortController();
    const prog = progressDialog(file.name, () => ctrl.abort());
    dismiss = null;
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
    if (e instanceof LufiCancelled || e?.name === "LufiCancelled") { toast("Upload cancelled", 2000); return null; }
    toast("Large file: " + errText(e), 5000, { danger: true });
    return null;
  } finally {
    dismiss?.();
    if (handle != null) invoke("lufi_close_file", { handle }).catch(() => {});
  }
}

// Message-info rows for a message that carries one of our uploads.
export function largeFileInfoHtml(rec) {
  if (!rec) return "";
  const exp = rec.expiresAt ? formatDateTime(rec.expiresAt * 1000) : "never";
  return `<div class="info-row"><span class="k">Large file</span><span class="v">${escapeHtml(rec.name)} · ${escapeHtml(formatBytes(rec.size))}</span></div>
    <div class="info-row"><span class="k">Expires</span><span class="v">${escapeHtml(rec.deleted ? "deleted from server" : exp)}</span></div>
    <div class="info-row wrap"><span class="k">Deletion link</span><span class="v">${escapeHtml(rec.deleteUrl || "—")}${rec.deleted ? "" : ` <button type="button" class="btn-text" data-lufi-delete style="color:var(--danger)">Delete from server</button>`}</span></div>`;
}

export function wireLargeFileInfo(modal, accountId, msgId) {
  const btn = modal.querySelector("[data-lufi-delete]");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const rec = lufiUploadFor(accountId, msgId);
    const invoke = tauriInvoke();
    if (!rec || !invoke) return;
    if (!await confirmModal("Delete from server", `Delete "${rec.name}" from ${rec.server}? The link in the chat stops working.`, "Delete")) return;
    try {
      const proxy = await shellProxy();
      const r = await invoke("lufi_delete", { server: rec.server, short: rec.short, token: rec.token, proxy });
      if (!r?.success) throw new Error(String(r?.msg || "server refused").replace(/<[^>]*>/g, ""));
      markLufiDeleted(accountId, msgId);
      toast("Deleted from the server", 2200);
    } catch (e) { toast("Could not delete: " + errText(e), 4000, { danger: true }); }
  });
}
