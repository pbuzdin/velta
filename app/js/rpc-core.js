// Account-scoped RPC, cache persistence, sync, and transfer orchestration.
// Transport frames live in core.js; this module owns account lifetimes and persistence fences.
import { invoke, invokeError, isAndroid, onNativeEvent, postNative, base64FromBytes, clearStoredCache as clearCacheStorage, setBackgroundAudioWanted, claimAndroidWakelock, unclaimAndroidWakelock } from "./runtime.js";
import { freeBytes, fmtFreeBytes } from "./quota.js";
import { bytesToBase64, base64ToBytes, clearKeysCache } from "./crypto.js";
import { e2e } from "./e2e.js";
import { reconnect, send, ev, tabId, connectionState, subscribeTransport, startReceiveLoop, handleFrame, requestServerHello, handleNativeEvent, nativePreconnected } from "./core.js";
import * as store from "./store.js";
import { isE2ee, plainChatId, chatKey, accountStorageKey } from "./ids.js";
import { getCurrentIdentity } from "./runtime.js";
import { emit, on, off, afterOpenTasks, drainAfterOpenTasks, clearAfterOpenTasks } from "./core.js";
import { initP2p, rearmP2p, resetP2p } from "./p2p-core.js";
import { initProfile, closeOwnProfile, stopProfileValidation, addContact, contactOf, onAccountDeleted } from "./profile.js";
import { notify } from "./notify.js";
import { closeGroupPanels } from "./groups.js";
import { storeSecretKey, readSecretKey, clearAccountKeys } from "./keystore.js";
import { clearTorCircuits } from "./tor.js";
import { setMessageScope, loadMessageScope, restoreMessageScope, persistMessageScope } from "./chat-scope.js";
import { t } from "./i18n.js";
import { clearProfileCache } from "./profile-cache.js";
import { clearAvatarCache } from "./avatar-cache.js";

const CALL_BATCH_MS = 60;
let callQueue = [];
let callTimer = null;
let callBatchSeq = 0;
const cacheQueue = new Map();
let cacheTimer = null;
const accountScopedCacheIds = new Set();
let cacheFlushPromise = null;
let cacheFlushRequested = false;
let accountInitId = 0;
let activeAccountCacheScope = null;
let accountCacheFlushId = 0;
let backupBusy = false;
let syncSession = 0;
let listSyncSeq = 0;
let activeListSync = 0;
let pendingListSyncs = [];
let lastListsReq = 0;
let listsRequesting = false;
let listsDirty = false;
let listsDirtyAfter = false;
let listsSyncCooldown = 0;
let lastChatListAt = 0;
let localChatPositions = new Map();
let historySyncTimer = null;
let historySyncQueue = [];
let historySyncing = false;
let historySyncSession = 0;
let historySyncPending = null;
let historySyncCooldown = 0;
let accountSyncCooldown = 0;
const chatSyncAfter = new Map();
let settingsSyncTimer = null;
let settingsSyncInFlight = false;
let settingsSyncQueued = false;
let settingsSyncQueuedAfter = 0;
let settingsSyncAttempt = 0;
let settingsSyncLastReq = 0;
let settingsSyncError = null;
const settingsSyncAfter = new Map();
const SETTINGS_SEND_TIMEOUT_MS = 10_000;
const SETTINGS_SEND_RETRY_MS = 20_000;
let profileSyncSession = 0;
let syncHideBackup = null;
let transferExporting = false;
let transferImporting = false;
let transferHideBackup = null;

export function cacheScope(scope = getCurrentIdentity()) {
  return store.accountCacheScope(scope);
}

export function nextAccountInit() {
  return ++accountInitId;
}

export function accountSyncInFlight() {
  return Boolean(
    syncHideBackup ||
      activeListSync ||
      pendingListSyncs.length ||
      listsRequesting ||
      historySyncing ||
      historySyncPending ||
      settingsSyncInFlight,
  );
}

// Account data leaves on the account's current live transport. Tor is started by boot first; a pooled circuit must never publish the session key of the wrong account.
export function transportReadyForAccount() {
  return e2e.status === "ready";
}

export function accountCacheIsolationError(op) {
  return new Error(`account cache changed during ${op}`);
}

// Capturing the list reference is not enough: the old list must also keep its account cache scope until every merge has committed.
export function isCurrentAccountInit(id, chatsRef = null, cacheScope = null) {
  return id === accountInitId && (!chatsRef || chatsRef === store.chats) && (!cacheScope || cacheScope === activeAccountCacheScope);
}

function requireCurrentAccountInit(id, op, chatsRef = null, cacheScope = null) {
  if (!isCurrentAccountInit(id, chatsRef, cacheScope)) throw accountCacheIsolationError(op);
}

export function activateAccountCacheScope(scope) {
  activeAccountCacheScope = cacheScope(scope);
}

export function snapshotAccountCacheScope() {
  return activeAccountCacheScope;
}

export function resetAccountScopedPersistence() {
  accountCacheFlushId++;
  cacheFlushRequested = false;
  cacheQueue.clear();
  cacheTimer = null;
  clearAccountScopedPersistence();
}

function clearAccountScopedPersistence() {
  for (const id of accountScopedCacheIds) {
    invoke("cache_delete", { id }).catch(() => {});
    if (isAndroid) postNative({ type: "cache_delete", id });
  }
  accountScopedCacheIds.clear();
}

function hasAccountScopedPersistence() {
  return cacheQueue.size > 0 || accountScopedCacheIds.size > 0;
}

// A few generations may retire together. Deleting the newest id first lets an older queued completion win and repopulate a retired account.
function forgetAccountScopedCacheIds(ids) {
  for (let i = ids.length - 1; i >= 0; i--) accountScopedCacheIds.delete(ids[i]);
}

// Newly flushed ids are not committed to the delete set until the caller's account fence passes. Scoped-deletion ids must be retained across a failed fence.
export function collectAccountScopedCacheIds(flushedIds, generation) {
  for (const id of flushedIds) accountScopedCacheIds.add(id);
  return generation;
}

export function settleAccountScopedCacheIds(ids, flushedIds, generation) {
  if (generation !== accountCacheFlushId) {
    forgetAccountScopedCacheIds(ids);
    return false;
  }
  collectAccountScopedCacheIds(flushedIds, generation);
  return true;
}

// Only this switch may clear the previous account's stores. Merge put/delete traffic never clears an old scope as a side effect.
export function clearOtherAccountCaches(currentScope) {
  store.clearOtherAccountCaches(currentScope);
  clearProfileCache(currentScope);
  clearAvatarCache(currentScope);
}

export function accountSwitchSyncInFlight() {
  return accountSyncInFlight() || hasAccountScopedPersistence();
}

export async function flushAccountPersistenceBeforeSwitch() {
  await flushCacheNow();
  cacheTimer = null;
  if (hasAccountScopedPersistence()) throw new Error("account persistence still pending");
  if (accountSyncInFlight()) throw new Error("account sync still pending");
}

export function noteAccountScopedCacheId(id) {
  if (id) accountScopedCacheIds.add(String(id));
}

export function stripAccountScopedCacheId(id) {
  if (id) accountScopedCacheIds.delete(String(id));
}

// Account switches invalidate every old generation, including an await that completed after a newer switch finished.
export function resetAccountSync() {
  syncSession++;
  listSyncSeq++;
  activeListSync = 0;
  pendingListSyncs = [];
  lastListsReq = 0;
  listsRequesting = false;
  listsDirty = false;
  listsDirtyAfter = false;
  listsSyncCooldown = 0;
  lastChatListAt = 0;
  localChatPositions = new Map();
  resetHistorySyncState();
  resetSettingsSyncState();
  profileSyncSession++;
  if (syncHideBackup) {
    clearTimeout(syncHideBackup.timer);
    syncHideBackup.hide.remove();
    syncHideBackup = null;
  }
}

export function resetProfileSync() {
  profileSyncSession++;
}

export function profileSyncCurrent(session) {
  return session === profileSyncSession;
}

export function startSyncOverlay() {
  if (syncHideBackup) return;
  const hide = document.getElementById("syncHide");
  if (!hide) return;
  hide.hidden = false;
  document.getElementById("app")?.setAttribute("inert", "");
  const timer = setTimeout(() => {
    hide.hidden = true;
    document.getElementById("app")?.removeAttribute("inert");
    if (syncHideBackup?.hide === hide) syncHideBackup = null;
  }, 8000);
  syncHideBackup = { hide, timer };
}

export function resetTransferSync() {
  transferExporting = false;
  transferImporting = false;
  if (transferHideBackup) {
    clearTimeout(transferHideBackup.timer);
    transferHideBackup.hide.remove();
    transferHideBackup = null;
  }
}

export function cancelTransferOverlays() {
  transferExporting = false;
  transferImporting = false;
  if (!transferHideBackup) return;
  clearTimeout(transferHideBackup.timer);
  transferHideBackup.hide.remove();
  transferHideBackup = null;
}

function transferOverlay(mode) {
  const hide = document.createElement("div");
  hide.id = "transferSyncHide";
  hide.className = "sync-hide";
  hide.setAttribute("role", "status");
  hide.setAttribute("aria-live", "polite");
  hide.setAttribute("aria-label", t("Transfer in progress"));
  hide.innerHTML = `<div class="empty"><div class="big-spinner" aria-hidden="true"></div><p class="sync-hide-title">${mode === "export" ? t("Preparing your backup…") : t("Importing your backup…")}</p><p class="sync-hide-sub">${t("Keep Velta open until the transfer finishes.")}</p></div>`;
  document.getElementById("app")?.setAttribute("inert", "");
  document.body.appendChild(hide);
  const timer = setTimeout(() => {
    if (transferHideBackup?.hide !== hide) return;
    transferHideBackup = null;
    hide.remove();
    document.getElementById("app")?.removeAttribute("inert");
    // Do not leave an importing account half-applied when the native side stops answering.
    if (mode === "import" && transferImporting) location.reload();
  }, 10 * 60 * 1000);
  transferHideBackup = { hide, timer };
}

// Native backup/transfer screens run without the WebView. Its old connection must be flushed and the account re-opened before a new session key can be derived.
function closeTransferConnection() {
  try {
    send({ op: "close" });
  } catch {}
}

function reopenTransferredAccount(scope, userId = null) {
  const address = store.server || (isAndroid ? "https://api.velta.app" : "");
  if (!address) throw new Error("server address missing");
  setMessageScope(null);
  loadMessageScope();
  const st = store.st;
  const secret = store.secretKey;
  if (!st?.keys || !secret) throw new Error("account keys missing");
  store.save();
  store.saveSt();
  e2e.setKeys(st.keys, secret);
  return e2e.session(address, store.token).then(() => {
    reconnect();
    initP2p();
    initProfile(st, userId, scope);
    return true;
  });
}

// Keep the import overlay until the native response is back. The returned account scope is the only scope the completion may initialize.
export function beginTransferOverlay(mode) {
  if (mode === "export") transferExporting = true;
  else transferImporting = true;
  closeTransferConnection();
  if (!transferHideBackup) transferOverlay(mode);
  if (syncHideBackup) {
    clearTimeout(syncHideBackup.timer);
    syncHideBackup.hide.remove();
    syncHideBackup = null;
  }
}

export async function finishTransferOverlay(result) {
  const mode = transferImporting ? "import" : "export";
  transferExporting = false;
  transferImporting = false;
  if (transferHideBackup) {
    clearTimeout(transferHideBackup.timer);
    transferHideBackup.hide.remove();
    transferHideBackup = null;
  }
  document.getElementById("app")?.removeAttribute("inert");
  if (result?.scope && result?.ok) {
    resetAccountScopedPersistence();
    await reopenTransferredAccount(result.scope, result.userId || null);
  }
  return mode;
}

function enqueueCall(msg) {
  return new Promise((resolve, reject) => {
    callQueue.push({ msg, resolve, reject });
    if (callTimer) return;
    callTimer = setTimeout(flushCalls, CALL_BATCH_MS);
  });
}

function flushCalls() {
  callTimer = null;
  const q = callQueue;
  callQueue = [];
  if (!q.length) return;
  if (!e2e.keyId || !send({ op: "batch_call", id: `bc${++callBatchSeq}`, calls: q.map((c) => c.msg) })) {
    // Keep the account's queue for the next transport retry instead of rejecting one item at a time.
    callQueue = q.concat(callQueue);
    callTimer = setTimeout(flushCalls, 2500);
    return;
  }
  q.forEach((c) => c.resolve(true));
}

// The cache writer is account-scoped. A scope switch invalidates pending deletions as well as queued writes.
function queueCache(id, data) {
  cacheQueue.set(id, data);
  cacheFlushRequested = true;
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    flushCacheNow().catch(() => {});
  }, 400);
}

function nativeCacheWrite(id, data, epoch) {
  if (epoch !== undefined && epoch !== accountCacheFlushId) return Promise.resolve();
  noteAccountScopedCacheId(id);
  if (isAndroid) postNative({ type: "cache_put", id, data });
  // A fire-and-forget native cache write is not a completed durability fence: only the Rust cache_put response has that meaning.
  return invoke("cache_put", { id, data }).then(() => {}).catch((err) => {
    stripAccountScopedCacheId(id);
    throw err;
  });
}

// The delete list is an explicit durable fence, not just a queue of best-effort native calls.
async function deleteCacheIds(ids, epoch) {
  for (const id of ids) {
    if (epoch !== undefined && epoch !== accountCacheFlushId) throw accountCacheIsolationError("cache delete");
    try {
      await invoke("cache_delete", { id });
      if (isAndroid) postNative({ type: "cache_delete", id });
      if (epoch !== undefined && epoch !== accountCacheFlushId) throw accountCacheIsolationError("cache delete");
      stripAccountScopedCacheId(id);
    } catch (err) {
      if (err?.message?.includes("account cache changed")) throw err;
      // Native caches are best-effort, but a failed delete must remain a fence for the account switch.
      throw err;
    }
  }
}

// A second flush requested while native writes are awaited gets a new epoch. Old completions must not delete the new generation's ids.
export async function flushCacheNow() {
  if (cacheFlushPromise) {
    cacheFlushRequested = true;
    await cacheFlushPromise;
    if (cacheQueue.size) await flushCacheNow();
    return;
  }
  cacheFlushRequested = false;
  const epoch = ++accountCacheFlushId;
  const entries = [...cacheQueue.entries()];
  cacheQueue.clear();
  const oldIds = [...accountScopedCacheIds];
  const run = (async () => {
    const flushedIds = [];
    try {
      for (const [id, data] of entries) {
        if (epoch !== accountCacheFlushId) throw accountCacheIsolationError("cache write");
        await nativeCacheWrite(id, data, epoch);
        if (epoch !== accountCacheFlushId) throw accountCacheIsolationError("cache write");
        flushedIds.push(id);
      }
      if (!settleAccountScopedCacheIds(oldIds, flushedIds, epoch)) throw accountCacheIsolationError("cache delete");
      await deleteCacheIds(oldIds, epoch);
    } catch (err) {
      forgetAccountScopedCacheIds(flushedIds);
      // Preserve uncommitted writes for a retry within the same account. A scope switch has already cleared its own queue.
      if (epoch === accountCacheFlushId) {
        for (const [id, data] of entries) if (!cacheQueue.has(id)) cacheQueue.set(id, data);
      }
      throw err;
    }
  })();
  cacheFlushPromise = run;
  try {
    await run;
  } finally {
    if (cacheFlushPromise === run) cacheFlushPromise = null;
  }
  if (cacheQueue.size && epoch === accountCacheFlushId) await flushCacheNow();
}

function syncHide() {
  if (document.getElementById("syncHide")) return;
  const hide = document.createElement("div");
  hide.id = "syncHide";
  hide.className = "sync-hide";
  hide.innerHTML = `<div class="empty"><div class="big-spinner"></div><p>${t("Syncing your messages…")}</p></div>`;
  document.body.appendChild(hide);
  document.getElementById("app")?.setAttribute("inert", "");
  const timer = setTimeout(() => {
    hide.remove();
    document.getElementById("app")?.removeAttribute("inert");
    if (syncHideBackup?.hide === hide) syncHideBackup = null;
  }, 8000);
  syncHideBackup = { hide, timer };
}

function endSyncOverlay() {
  if (!syncHideBackup) return;
  clearTimeout(syncHideBackup.timer);
  syncHideBackup.hide.remove();
  syncHideBackup = null;
  document.getElementById("app")?.removeAttribute("inert");
}

export function syncLists(after = 0, options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && now - lastListsReq < 1000) {
    listsDirty = true;
    listsDirtyAfter = Math.max(listsDirtyAfter, after);
    return;
  }
  if (!e2e.keyId) return;
  lastListsReq = now;
  listsDirty = false;
  listsDirtyAfter = false;
  const id = `l${++listSyncSeq}`;
  const requestAfter = after;
  if (!send({ op: "get_lists", after: requestAfter, id })) {
    listsDirty = true;
    listsDirtyAfter = Math.max(listsDirtyAfter, requestAfter);
    return;
  }
  const session = syncSession;
  const entry = { id, after: requestAfter, session };
  pendingListSyncs.push(entry);
  setTimeout(() => {
    if (!pendingListSyncs.includes(entry)) return;
    pendingListSyncs = pendingListSyncs.filter((x) => x !== entry);
    if (session === syncSession) {
      listsDirty = true;
      listsDirtyAfter = Math.max(listsDirtyAfter, requestAfter);
      listsSyncCooldown = Date.now() + 2500;
    }
  }, 15000);
}

export function syncDirtyLists() {
  if (!listsDirty || Date.now() < listsSyncCooldown) return;
  if (activeListSync || listsRequesting) return;
  if (!e2e.keyId) return;
  syncLists(listsDirtyAfter || 0, { force: true });
}

export function scheduleListsSync(after = 0, delay = 0) {
  listsDirty = true;
  listsDirtyAfter = Math.max(listsDirtyAfter, after);
  if (delay) setTimeout(() => syncDirtyLists(), delay);
  else syncDirtyLists();
}

export function onLists(id, d, settings = false) {
  const entry = pendingListSyncs.find((x) => x.id === id);
  if (!entry || entry.session !== syncSession) return false;
  pendingListSyncs = pendingListSyncs.filter((x) => x !== entry);
  activeListSync++;
  const chatsRef = store.chats;
  const cacheScope = snapshotAccountCacheScope();
  const accountId = accountInitId;
  if (!settings && d.settings) applySettings(d.settings);
  const after = d.after || 0;
  if (settings && d.settings) applySettings(d.settings);
  Promise.all([
    mergeChats(d.chats || [], { init: accountId, chatsRef, cacheScope }),
    mergeContacts(d.contacts || [], { init: accountId, chatsRef, cacheScope }),
    mergeGroups(d.groups || [], { init: accountId, chatsRef, cacheScope }),
  ]).then(() => {
    if (!isCurrentAccountInit(accountId, chatsRef, cacheScope)) return;
    for (const id of d.deleted_chats || []) {
      delete store.st.chats[id];
      store.wipeChat(id);
      const i = store.chats.findIndex((c) => c.id === id);
      if (i >= 0) store.chats.splice(i, 1);
      localChatPositions.delete(id);
    }
    for (const [chatId, messageId] of Object.entries(d.deleted_messages || {})) {
      const c = store.chatOf(chatId);
      if (!c) continue;
      const list = store.msgsOf(chatId);
      const i = list.findIndex((m) => m.id === messageId);
      if (i >= 0) list.splice(i, 1);
      if (c.last?.id === messageId) c.last = list[list.length - 1] || null;
    }
    store.reorderChats();
    store.save();
    store.saveSt();
    store.refreshChatList();
    store.refreshContacts();
    store.emitMessages();
    store.setServerRevision(d.revision || after);
    emit("lists-synced", { after, settings });
    if (d.more) scheduleListsSync(after, 0);
  }).catch((err) => {
    if (err?.message?.includes("account cache changed")) return;
    listsDirty = true;
    listsDirtyAfter = Math.max(listsDirtyAfter, entry.after);
  }).finally(() => {
    activeListSync = Math.max(0, activeListSync - 1);
    if (!activeListSync && !pendingListSyncs.length) endSyncOverlay();
  });
  return true;
}

function normalizeRemoteChat(c) {
  if (!c || !c.id) return null;
  const id = String(c.id);
  return {
    ...c,
    id,
    type: c.type || (isE2ee(id) ? "e2ee" : id.startsWith("@") ? "channel" : "dm"),
    unread: Number(c.unread) || 0,
    readUntil: Number(c.readUntil) || 0,
    localOnly: false,
  };
}

export async function mergeChats(list, fence = {}) {
  const init = fence.init ?? accountInitId;
  const chatsRef = fence.chatsRef || store.chats;
  const cacheScope = fence.cacheScope || snapshotAccountCacheScope();
  requireCurrentAccountInit(init, "chat merge", chatsRef, cacheScope);
  for (const raw of list) {
    requireCurrentAccountInit(init, "chat merge", chatsRef, cacheScope);
    const c = normalizeRemoteChat(raw);
    if (!c) continue;
    const old = store.st.chats[c.id] || {};
    store.st.chats[c.id] = { ...old, ...c };
    if (!store.chats.some((x) => x.id === c.id)) store.chats.push(store.st.chats[c.id]);
    else {
      const i = store.chats.findIndex((x) => x.id === c.id);
      store.chats[i] = store.st.chats[c.id];
    }
    const existing = store.msgsOf(c.id);
    const messages = Array.isArray(raw.messages) ? raw.messages : [];
    for (const msg of messages) {
      requireCurrentAccountInit(init, "message merge", chatsRef, cacheScope);
      if (existing.some((m) => m.id === msg.id)) continue;
      store.st.msgs[c.id] ||= [];
      store.st.msgs[c.id].push(msg);
    }
    if (messages.length) store.st.msgs[c.id].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (raw.last && !store.st.chats[c.id].last) store.st.chats[c.id].last = raw.last;
  }
  requireCurrentAccountInit(init, "chat merge", chatsRef, cacheScope);
  store.reorderChats();
  store.saveSt();
  store.save();
}

export async function mergeContacts(list, fence = {}) {
  const init = fence.init ?? accountInitId;
  const chatsRef = fence.chatsRef || store.chats;
  const cacheScope = fence.cacheScope || snapshotAccountCacheScope();
  requireCurrentAccountInit(init, "contact merge", chatsRef, cacheScope);
  for (const raw of list) {
    if (!raw?.id) continue;
    store.contacts[raw.id] = { ...store.contacts[raw.id], ...raw };
  }
  requireCurrentAccountInit(init, "contact merge", chatsRef, cacheScope);
  store.saveContacts();
}

export async function mergeGroups(list, fence = {}) {
  const init = fence.init ?? accountInitId;
  const chatsRef = fence.chatsRef || store.chats;
  const cacheScope = fence.cacheScope || snapshotAccountCacheScope();
  requireCurrentAccountInit(init, "group merge", chatsRef, cacheScope);
  for (const raw of list) {
    if (!raw?.id) continue;
    store.groups[raw.id] = { ...store.groups[raw.id], ...raw };
  }
  requireCurrentAccountInit(init, "group merge", chatsRef, cacheScope);
  store.saveGroups();
}

function resetHistorySyncState() {
  historySyncSession++;
  if (historySyncTimer) clearTimeout(historySyncTimer);
  historySyncTimer = null;
  historySyncQueue = [];
  historySyncing = false;
  historySyncPending = null;
  historySyncCooldown = 0;
  chatSyncAfter.clear();
}

function resetSettingsSyncState() {
  settingsSyncAttempt++;
  if (settingsSyncTimer) clearTimeout(settingsSyncTimer);
  settingsSyncTimer = null;
  settingsSyncInFlight = false;
  settingsSyncQueued = false;
  settingsSyncQueuedAfter = 0;
  settingsSyncLastReq = 0;
  settingsSyncError = null;
  settingsSyncAfter.clear();
}

export function syncHistory(chatId, after = 0) {
  if (!chatId || !e2e.keyId) return;
  const prior = chatSyncAfter.get(chatId) || 0;
  chatSyncAfter.set(chatId, Math.max(prior, after));
  if (historySyncTimer || historySyncing) return;
  historySyncTimer = setTimeout(() => {
    historySyncTimer = null;
    flushHistorySync();
  }, 50);
}

function flushHistorySync() {
  if (historySyncing || Date.now() < historySyncCooldown || !e2e.keyId) return;
  const entries = [...chatSyncAfter.entries()];
  chatSyncAfter.clear();
  if (!entries.length) return;
  const id = `h${++listSyncSeq}`;
  const session = syncSession;
  const request = { op: "get_history", id, chats: entries.map(([chat, after]) => ({ chat, after })) };
  if (!send(request)) {
    for (const [chat, after] of entries) chatSyncAfter.set(chat, Math.max(chatSyncAfter.get(chat) || 0, after));
    historySyncCooldown = Date.now() + 1500;
    return;
  }
  historySyncing = true;
  historySyncPending = { id, session, entries };
  setTimeout(() => {
    if (historySyncPending?.id !== id) return;
    historySyncPending = null;
    historySyncing = false;
    historySyncCooldown = Date.now() + 2500;
    if (session === syncSession) for (const [chat, after] of entries) chatSyncAfter.set(chat, Math.max(chatSyncAfter.get(chat) || 0, after));
  }, 20000);
}

export function onHistory(id, d) {
  const pending = historySyncPending;
  if (!pending || pending.id !== id || pending.session !== syncSession) return false;
  historySyncPending = null;
  historySyncing = false;
  const accountId = accountInitId;
  const chatsRef = store.chats;
  const cacheScope = snapshotAccountCacheScope();
  const list = Array.isArray(d.chats) ? d.chats : [];
  mergeChats(list, { init: accountId, chatsRef, cacheScope }).then(() => {
    if (!isCurrentAccountInit(accountId, chatsRef, cacheScope)) return;
    store.emitMessages();
    store.refreshChatList();
  }).catch(() => {});
  return true;
}

export function applySettings(settings) {
  if (!settings || typeof settings !== "object") return;
  Object.assign(store.st, settings);
  store.saveSt();
  emit("settings", settings);
}

export function pushSettings(patch = {}, after = 0) {
  Object.assign(store.st, patch);
  store.saveSt();
  for (const [key, value] of Object.entries(patch)) settingsSyncAfter.set(key, value);
  if (settingsSyncInFlight) {
    settingsSyncQueued = true;
    settingsSyncQueuedAfter = Math.max(settingsSyncQueuedAfter, after);
    return;
  }
  if (settingsSyncTimer) return;
  settingsSyncTimer = setTimeout(() => {
    settingsSyncTimer = null;
    flushSettingsSync();
  }, 100);
}

function flushSettingsSync() {
  if (settingsSyncInFlight || !settingsSyncAfter.size || !e2e.keyId) return;
  const values = Object.fromEntries(settingsSyncAfter);
  settingsSyncAfter.clear();
  const attempt = ++settingsSyncAttempt;
  settingsSyncInFlight = true;
  settingsSyncLastReq = Date.now();
  const ok = send({ op: "set_settings", id: `s${attempt}`, values });
  if (!ok) {
    settingsSyncInFlight = false;
    for (const [key, value] of Object.entries(values)) settingsSyncAfter.set(key, value);
    settingsSyncTimer = setTimeout(() => {
      settingsSyncTimer = null;
      flushSettingsSync();
    }, SETTINGS_SEND_RETRY_MS);
    return;
  }
  setTimeout(() => {
    if (settingsSyncAttempt !== attempt || !settingsSyncInFlight) return;
    settingsSyncInFlight = false;
    settingsSyncError = new Error("settings sync timeout");
    for (const [key, value] of Object.entries(values)) settingsSyncAfter.set(key, value);
    settingsSyncTimer = setTimeout(() => {
      settingsSyncTimer = null;
      flushSettingsSync();
    }, SETTINGS_SEND_RETRY_MS);
  }, SETTINGS_SEND_TIMEOUT_MS);
}

export function onSettingsSaved(id) {
  if (!id || !String(id).startsWith("s")) return;
  const attempt = Number(String(id).slice(1));
  if (attempt !== settingsSyncAttempt) return;
  settingsSyncInFlight = false;
  settingsSyncError = null;
  if (settingsSyncQueued) {
    settingsSyncQueued = false;
    settingsSyncTimer = setTimeout(() => {
      settingsSyncTimer = null;
      flushSettingsSync();
    }, 0);
  }
}

export function syncProfile() {
  const session = ++profileSyncSession;
  const identity = getCurrentIdentity();
  const accountId = accountInitId;
  if (!e2e.keyId || !identity) return;
  send({ op: "get_profile", id: `p${session}` });
  setTimeout(() => {
    if (session === profileSyncSession && accountId === accountInitId && identity === getCurrentIdentity()) emit("profile-sync-timeout");
  }, 15000);
}

export function onProfile(d) {
  if (!d?.profile) return;
  emit("profile", d.profile);
}

export function requestServerSync() {
  syncLists(0, { force: true });
  syncProfile();
}

export function noteLocalChatPosition(chatId, position) {
  if (!chatId) return;
  localChatPositions.set(chatId, position);
}

export function localChatPosition(chatId) {
  return localChatPositions.get(chatId);
}

export function forgetLocalChatPosition(chatId) {
  localChatPositions.delete(chatId);
}

export function markChatListActivity() {
  lastChatListAt = Date.now();
}

export function recentChatListActivity(ms = 5000) {
  return Date.now() - lastChatListAt < ms;
}

export function accountCacheStats() {
  return { queued: cacheQueue.size, scopedIds: accountScopedCacheIds.size, flushing: Boolean(cacheFlushPromise), epoch: accountCacheFlushId };
}

export function syncStats() {
  return {
    session: syncSession,
    activeListSync,
    pendingLists: pendingListSyncs.length,
    historySyncing,
    historyPending: historySyncPending?.id || null,
    settingsSyncInFlight,
    settingsQueued: settingsSyncAfter.size,
  };
}

export function clearAccountRuntime() {
  resetAccountSync();
  resetProfileSync();
  clearAfterOpenTasks();
  clearKeysCache();
  clearTorCircuits();
  stopProfileValidation();
  closeOwnProfile();
  closeGroupPanels();
  onAccountDeleted();
  resetP2p();
  setMessageScope(null);
  restoreMessageScope();
  persistMessageScope();
  setBackgroundAudioWanted(false);
  unclaimAndroidWakelock();
}

export async function deleteAccountRemote() {
  if (!e2e.keyId) return false;
  return send({ op: "delete_account", id: `del${Date.now()}` });
}

export async function wipeAccountLocal() {
  const identity = getCurrentIdentity();
  resetAccountScopedPersistence();
  resetAccountSync();
  await clearCacheStorage();
  clearProfileCache(null);
  clearAvatarCache(null);
  await clearAccountKeys(identity);
  store.clearAccountStorage(identity);
  clearAccountRuntime();
}

export async function exportBackup() {
  await flushCacheNow();
  return {
    version: 3,
    scope: getCurrentIdentity(),
    st: store.st,
    chats: store.chats,
    contacts: store.contacts,
    groups: store.groups,
    exportedAt: Date.now(),
  };
}

export async function importBackup(data) {
  if (!data || typeof data !== "object" || !data.st) throw new Error("invalid backup");
  resetAccountScopedPersistence();
  resetAccountSync();
  store.st = data.st;
  store.chats = Array.isArray(data.chats) ? data.chats : [];
  store.contacts = data.contacts || {};
  store.groups = data.groups || {};
  store.saveSt();
  store.save();
  store.saveContacts();
  store.saveGroups();
  store.reorderChats();
  store.refreshChatList();
  store.refreshContacts();
}

export function backgroundSyncNeeded() {
  return Boolean(listsDirty || historySyncQueue.length || settingsSyncAfter.size);
}

export function onAccountOpen() {
  drainAfterOpenTasks();
  requestServerSync();
}

export function queueAfterOpen(fn) {
  afterOpenTasks.push(fn);
}

export function transportSend(msg) {
  return send(msg);
}

export function transportEvent(name, fn) {
  return on(name, fn);
}

export function transportUnsubscribe(name, fn) {
  return off(name, fn);
}

export { reconnect, send, ev, tabId, connectionState, subscribeTransport, startReceiveLoop, handleFrame, requestServerHello, handleNativeEvent, nativePreconnected, invoke, invokeError, notify };
