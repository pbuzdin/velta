// Lufi deletion tokens, split out of lufi.js (fix 5) so chat-view can look
// one up for message info without loading the uploader and sjcl at boot.
const FILES_KEY = "velta-lufi-files";

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
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
