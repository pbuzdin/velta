// Manual "read up to here" markers: one message id per (account, chat),
// kept in this device's localStorage only — the core has no such concept
// (its read state is per message: fresh/noticed/seen). The chat view draws
// the marker as a line under that message and opens the chat there while
// unread messages remain. Storage failures (private mode, blocked site
// data) degrade to "no marker", never to an error.

const KEY = "velta-read-markers";

function load() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function save(obj) {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(obj)); } catch { /* storage unavailable */ }
}

const slot = (accountId, chatId) => `${accountId}:${chatId}`;

export function getReadMarker(accountId, chatId) {
  const id = load()[slot(accountId, chatId)];
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function setReadMarker(accountId, chatId, msgId) {
  const obj = load();
  obj[slot(accountId, chatId)] = Number(msgId);
  save(obj);
}

export function clearReadMarker(accountId, chatId) {
  const obj = load();
  if (!(slot(accountId, chatId) in obj)) return;
  delete obj[slot(accountId, chatId)];
  save(obj);
}
