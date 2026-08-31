// app.js — Delta Web bootstrap: chat list, navigation, modals, PWA
import { createCore, probeService } from "./transport.js";
import "./components.js";
import { escapeHtml, escapeAttr } from "./components.js";
import { ChatView } from "./chat-view.js";
import { DiagnosticsStore, DIAGNOSTICS_CHAT_ID } from "./diagnostics.js";
import { buildDrawer, showModal, showContextMenu, toast, closeAllPopups, confirmModal, showInvite } from "./ui.js";

const diagnostics = new DiagnosticsStore();
window.__veltaDiagnostics = diagnostics;
let core = null;
let diagnosticsOpen = false;
let chatView = null;
let coreStartupPromise = null;
// Declared at the top: scheduleChatListRefresh() is reachable from the
// diagnostics "changed" listener while the module is still evaluating (the
// top-level await below yields to events), so these must not live further
// down — `let` declarations would still be in their temporal dead zone.
let chatListRefreshTimer = null;
let chatListInFlight = false;
const state = {
  account: null,
  chats: [],
  activeChatId: null,
  query: "",
  theme: localStorage.getItem("dw-theme") || "dark",
};

function appLog(msg) {
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) invoke("js_log", { msg }).catch(() => {});
  } catch {}
  console.log("[velta]", msg);
  diagnostics.append("info", msg);
}

window.addEventListener("error", e => appLog(`JS error: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", e => appLog(`JS unhandled rejection: ${e.reason?.stack || e.reason}`));

// Show what we're doing from the very first paint — createCore() below can
// take a moment while it probes for the background service.
const $ = (id) => document.getElementById(id);

function renderDiagnosticsMessages() {
  if (!diagnosticsOpen) return;
  const history = $("history");
  if (!history) return;
  history.replaceChildren();
  for (const message of diagnostics.messages) {
    const row = document.createElement("div");
    row.className = "msg-row service";
    row.dataset.msgid = message.id;
    const bubble = document.createElement("div");
    bubble.className = "service-msg";
    bubble.textContent = `${new Date(message.ts).toLocaleTimeString()}  ${message.text}`;
    row.appendChild(bubble);
    history.appendChild(row);
  }
  requestAnimationFrame(() => {
    const scroll = $("history-scroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  });
}

function renderInitialDiagnosticsChat() {
  const list = $("chat-list");
  if (!list) return;
  // createChatItem routes the diagnostics id to openDiagnosticsChat and
  // tracks the chat data so a later renderChatList can reuse the element.
  list.replaceChildren(createChatItem(diagnostics.getChat(), false));
}

function bindEarlyRecoveryActions() {
  $("btn-restart-core")?.addEventListener("click", async () => {
    diagnostics.append("info", "Restart core I/O requested during startup");
    if (!core) {
      diagnostics.append("warning", "Core is still starting; reloading the UI to retry initialization");
      setTimeout(() => location.reload(), 150);
      return;
    }
    try {
      if (!core.restartIo) throw new Error("Core I/O restart is unavailable for this backend");
      await core.restartIo();
      diagnostics.append("info", "Core I/O restarted successfully");
      toast("Core I/O restarted");
    } catch (error) {
      diagnostics.append("error", `Core restart failed: ${error?.message || error}`);
      toast(`Core restart failed: ${error?.message || error}`, 5000);
    }
  }, { once: true });

  $("btn-reconnect-ui")?.addEventListener("click", async () => {
    diagnostics.append("info", "UI reconnect requested during startup");
    if (!core) {
      diagnostics.append("info", "Core has not completed initialization; retrying the UI");
      if (coreStartupPromise) {
        try { await coreStartupPromise; } catch {}
      }
      if (!core) location.reload();
      return;
    }
    try {
      const ok = await core.reconnect?.();
      if (!ok) throw new Error("Transport reconnect is unavailable");
      core.backend.connected = true;
      updateConnStatus(true);
      await refreshChatList();
      diagnostics.append("info", "UI reconnected successfully");
      toast("UI reconnected to core");
    } catch (error) {
      diagnostics.append("error", `UI reconnect failed: ${error?.message || error}`);
      toast(`Reconnect failed: ${error?.message || error}`, 5000);
    }
  }, { once: true });
}

function openDiagnosticsChat() {
  diagnosticsOpen = true;
  // The Diagnostics chat writes its rows into #history directly, so the chat
  // view must fully release the area first — otherwise its scroller still
  // believes the previous chat is open and interleaves old rows (the
  // "two chats merged" bug), and switching back skipped re-rendering.
  chatView?.close();
  state.activeChatId = DIAGNOSTICS_CHAT_ID;
  $("no-chat").hidden = true;
  $("chat-view").hidden = false;
  document.querySelector(".app").classList.add("chat-open");
  const head = document.createElement("dc-chat-head");
  head.setData(diagnostics.getChat());
  $("chat-head-info").replaceChildren(head);
  $("chat-head-actions").style.visibility = "hidden";
  $("main-composer").hidden = true;
  $("diagnostic-actions").hidden = false;
  $("reply-preview").hidden = true;
  renderDiagnosticsMessages();
  renderChatList();
}

diagnostics.addEventListener("changed", () => {
  renderDiagnosticsMessages();
  // Debounced: diagnostics appends fire per core event (several per second
  // during sync) — a direct refresh here would multiply the churn.
  if (core) scheduleChatListRefresh();
  else renderInitialDiagnosticsChat();
});

renderInitialDiagnosticsChat();
bindEarlyRecoveryActions();
{
  const el = $("conn-status");
  if (el) {
    el.dataset.state = "connecting";
    $("conn-label").textContent = window.__TAURI__
      ? "Starting embedded core…"
      : "Checking for background service…";
  }
}

// In the Tauri shell, show sidecar startup progress while the core is being located.
let lastSidecarStatus = null;
if (window.__TAURI__) {
  const tauri = window.__TAURI__;
  const invoke = tauri.core?.invoke || tauri.invoke;
  const event = tauri.event || tauri;
  const listen = event.listen ? event.listen.bind(event) : tauri.listen.bind(tauri);

  function applySidecarStatus(status) {
    lastSidecarStatus = status;
    diagnostics.append(status.error ? "error" : "info", `Embedded core: ${status.stage || (status.running ? "running" : "stopped")}${status.error ? ` — ${status.error}` : ""}`);
    const el = $("conn-status"), label = $("conn-label");
    if (!el || !label) return;
    if (core?.backend?.connected) return;
    if (status.running) {
      label.textContent = status.stage === "ready" ? "Core ready · connecting…" : "Starting local core…";
      el.title = `Delta Chat sidecar is ${status.stage || "starting"}`;
    } else {
      el.dataset.state = "mock";
      label.textContent = status.error ? `Sidecar failed: ${status.error}` : `Sidecar: ${status.stage || "stopped"}`;
      el.title = status.error ? `Delta Chat sidecar failed: ${status.error}` : "Delta Chat sidecar is not running";
    }
  }

  try {
    listen("dc-sidecar-status", ev => applySidecarStatus(ev.payload));
    invoke("get_sidecar_status").then(applySidecarStatus).catch(() => {});
  } catch (e) {
    console.warn("[delta-web] sidecar status setup failed:", e);
  }
}

coreStartupPromise = createCore({ onDiagnostic: (level, message) => diagnostics.append(level, message) });
try {
  core = await coreStartupPromise;
} catch (error) {
  diagnostics.append("error", `Core startup crashed: ${error?.message || error}`);
  diagnostics.append("warning", "Continuing in demo mode so diagnostics and recovery controls remain available");
  const { MockCore } = await import("./mock-core.js");
  core = new MockCore();
  core.backend = { kind: "mock", label: "demo mode (startup failure)", connected: false };
}
// createCore has a bounded handshake, but keep the UI honest if a future
// backend violates that contract. A startup failure must never leave the
// initial "connecting…" pill spinning indefinitely.
if (!core) {
  diagnostics.append("error", "Core startup returned no backend");
  const { MockCore } = await import("./mock-core.js");
  core = new MockCore();
  core.backend = { kind: "mock", label: "demo mode (no local core)", connected: false };
}
// The core's per-transport Info events (IMAP/DNS/quota/idle chatter) flood
// the Diagnostics chat within seconds and bury everything useful. Keep
// warnings/errors plus the Info lines that actually describe message
// arrival and downloads.
const DIAGNOSTIC_INFO_KEEP = /receive_imf|download|secure|pre-message|post-message|Receiving message/i;
const DIAGNOSTIC_INFO_SKIP = /ConnectivityChanged|ImapInboxIdle|ImapConnected|SmtpConnected|SmtpMessageSent|imap\.rs|dns\.rs|scheduler\.rs|quota\.rs|select_folder\.rs|idle\.rs|key\.rs/i;
core.addEventListener?.("diagnostic", e => {
  const level = e.detail?.level || "info";
  const message = e.detail?.message || "Core event";
  if (level === "info") {
    if (DIAGNOSTIC_INFO_SKIP.test(message) && !DIAGNOSTIC_INFO_KEEP.test(message)) return;
  }
  diagnostics.append(level, message);
});

// Tell the frontend where blobs live so media URLs can be resolved absolutely.
if (window.__TAURI__) {
  try {
    const tauri = window.__TAURI__;
    const accountsDir = await tauri.core.invoke("get_accounts_dir");
    window.veltaAccountsDir = accountsDir;
    appLog(`accounts dir: ${accountsDir}`);
  } catch (err) {
    appLog(`get_accounts_dir failed: ${err?.message || err}`);
  }
}

updateConnStatus();

/* ---------------- connection status pill ---------------- */
function updateConnStatus(connectedOverride) {
  const el = $("conn-status"), label = $("conn-label");
  if (!el || !core.backend) return;
  const connected = connectedOverride ?? core.backend.connected;
  const stateName = core.backend.kind === "mock" ? "mock" : connected ? "online" : "offline";
  el.dataset.state = stateName;

  if (core.backend.kind === "mock" && lastSidecarStatus) {
    const s = lastSidecarStatus;
    if (s.running) {
      label.textContent = s.stage === "ready" ? "Core ready but not responding" : "Starting local core…";
      el.title = "The Delta Chat sidecar started, but the frontend could not handshake with it. Check velta.log for details.";
    } else {
      label.textContent = s.error ? `Sidecar failed: ${s.error}` : `Sidecar: ${s.stage || "stopped"}`;
      el.title = s.error ? `Delta Chat sidecar failed: ${s.error}` : "Delta Chat sidecar is not running";
    }
    return;
  }

  label.textContent =
    core.backend.kind === "mock" ? "Demo mode — no local core"
    : connected ? `Connected · ${core.backend.label}`
    : `Disconnected · ${core.backend.label}`;
  el.title = core.backend.kind === "mock"
    ? "No background deltachat core found. Tap to check again, or install the Delta Core service app."
    : connected ? "PWA is connected to the background deltachat core"
    : "Lost connection to the background core. Tap to reconnect.";
}

addEventListener("dc-core-status", e => {
  if (core.backend) core.backend.connected = !!e.detail.connected;
  updateConnStatus();
});

// Socket opened but the core never answered RPC → almost always an old or
// crashed service build. Say so explicitly instead of silently demo-ing.
addEventListener("dc-core-init-failed", e => {
  if (e.detail.backend === "websocket") {
    toast("Found the background service, but it didn't answer — restart the Delta Core service (or update it if it's an older build)", 6000);
  }
});

// Tap the pill while in demo mode or disconnected to re-check for the service.
let rechecking = false;
async function recheckService() {
  if (rechecking) return;
  const el = $("conn-status");
  if (!el || (el.dataset.state !== "mock" && el.dataset.state !== "offline")) return;
  rechecking = true;
  el.dataset.state = "connecting";
  $("conn-label").textContent = "Checking for background service…";
  try {
    if (core.backend?.kind === "mock") {
      if (lastSidecarStatus) {
        // Tauri desktop: explain why the local sidecar is not being used
        const s = lastSidecarStatus;
        if (s.error) {
          toast(`Local core sidecar failed: ${s.error}`, 6000);
        } else if (s.running) {
          toast("Sidecar started but the core handshake timed out — the sidecar may still be initializing. Try restarting Velta.", 6000);
        } else {
          toast(`Local core sidecar is ${s.stage || "not running"}. Try reinstalling Velta.`, 6000);
        }
      } else {
        // PWA / no Tauri sidecar: probe the background service APK
        const found = await probeService();
        if (found) {
          toast("Background service found — switching to the real core…", 2000);
          setTimeout(() => location.reload(), 900);
        } else {
          toast("No background service reachable — is the Delta Core service app running?", 4000);
        }
      }
    } else {
      // websocket backend that lost its connection → reconnect in place
      const ok = await core.reconnect?.();
      if (ok) {
        core.backend.connected = true;
        toast("Reconnected to the local Delta Chat core", 2500);
        refreshChatList();
      } else {
        toast("Still can't reach the background service — is it running?", 4000);
      }
    }
  } finally {
    rechecking = false;
    updateConnStatus();
  }
}

/* ---------------- theme ---------------- */
applyTheme();
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]').content = state.theme === "dark" ? "#0f0f14" : "#ffffff";
  localStorage.setItem("dw-theme", state.theme);
}
function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme();
  rebuildDrawer();
}

/* ---------------- chat list ---------------- */
// Event-driven refresh. refreshChatList() refetches the list from the core and
// re-renders it in place (renderChatList reuses existing <dc-chat-item>
// elements), so it is cheap — but bursts of core events (IMAP sync, markseen
// cascades) would still fire dozens of RPC round trips per second, so
// event-driven callers go through scheduleChatListRefresh() which collapses a
// burst into one trailing refresh.

function scheduleChatListRefresh(delay = 400) {
  if (chatListRefreshTimer) return; // a trailing refresh is already pending
  chatListRefreshTimer = setTimeout(async () => {
    chatListRefreshTimer = null;
    await refreshChatList();
  }, delay);
}

async function refreshChatList() {
  if (chatListInFlight) {
    scheduleChatListRefresh();
    return;
  }
  chatListInFlight = true;
  try {
    const chats = await core.getChatList({ query: state.query });
    state.chats = [diagnostics.getChat(), ...chats.filter(chat => chat.id !== DIAGNOSTICS_CHAT_ID)];
    renderChatList();
  } catch (err) {
    // Never funnel refresh errors into the Diagnostics store: the store emits
    // "changed", a listener of which triggers another refresh — an error here
    // would spin an undebounced rerender loop (and leak renderer memory fast).
    console.warn("[velta] refreshChatList error:", err?.message || err);
    try {
      const tauri = window.__TAURI__;
      const invoke = tauri?.core?.invoke || tauri?.invoke;
      if (invoke) invoke("js_log", { msg: `refreshChatList error: ${err?.message || err}` }).catch(() => {});
    } catch {}
  } finally {
    chatListInFlight = false;
  }
}

function renderChatList() {
  const list = $("chat-list");
  // Reuse row elements only while their display data is unchanged; recreate
  // an element when its data or active state changes. Recreating runs the
  // Elena first-render path (safe); updating data on a hydrated element is
  // NOT safe: Elena's re-render diff compares live children against a fresh
  // template clone, and custom elements like <dc-avatar> exist only in the
  // live tree (innerHTML templates contain the bare, unhydrated tag), so the
  // diff deletes the avatar's rendered children — blank avatars. With
  // change-gated recreation, an idle list does zero DOM work and a burst
  // touches only the chats whose data actually changed.
  const existing = new Map();
  for (const child of [...list.children]) {
    if (child.tagName === "DC-CHAT-ITEM") {
      const id = Number(child.getAttribute("chat-id"));
      if (state.chats.some(c => c.id === id)) existing.set(id, child);
      else child.remove();
    } else {
      child.remove(); // stale empty-state placeholder
    }
  }
  const items = [];
  for (const chat of state.chats) {
    const active = chat.id === state.activeChatId;
    let item = existing.get(chat.id);
    if (!item || !chatItemUpToDate(item, chat, active)) {
      const fresh = createChatItem(chat, active);
      item?.replaceWith(fresh);
      item = fresh;
    }
    items.push(item);
  }
  // Only touch the DOM when the row set/order actually changed; moving
  // existing nodes preserves them (no custom-element re-init).
  const sameOrder = items.length === list.children.length &&
    items.every((el, i) => list.children[i] === el);
  if (!sameOrder) list.replaceChildren(...items);
  if (!state.chats.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "text-align:center;color:var(--text-dim);padding:30px 16px;font-size:14.5px";
    empty.textContent = state.query ? "No chats found" : "No chats yet — start a new one";
    list.appendChild(empty);
  }
}

function createChatItem(chat, active) {
  const chatId = chat.id;
  const item = document.createElement("dc-chat-item");
  item.addEventListener("click", () => openChat(chatId));
  item.addEventListener("contextmenu", e => {
    if (e.altKey) return; // Alt+right-click → WebView devtools menu
    e.preventDefault();
    const current = state.chats.find(c => c.id === chatId);
    if (current) chatContextMenu(current, e.clientX, e.clientY);
  });
  item._veltaActive = active;
  item.setData(chat); // sets item.chat — used by chatItemUpToDate
  if (active) item.setAttribute("active", "");
  return item;
}

function chatItemUpToDate(item, chat, active) {
  if (item._veltaActive !== active) return false;
  const prev = item.chat;
  if (!prev) return false;
  return prev.name === chat.name
    && prev.kind === chat.kind
    && prev.avatarColor === chat.avatarColor
    && prev.lastMsg === chat.lastMsg
    && prev.lastTs === chat.lastTs
    && prev.unread === chat.unread
    && prev.pinned === chat.pinned
    && prev.muted === chat.muted
    && prev.archived === chat.archived
    && prev.verified === chat.verified
    && prev.encrypted === chat.encrypted
    && prev.draft === chat.draft
    && prev.lastFrom === chat.lastFrom
    && prev.lastState === chat.lastState;
}

function chatContextMenu(chat, x, y) {
  if (chat.id === DIAGNOSTICS_CHAT_ID) return;
  const icons = {
    pin: `<svg viewBox="0 0 24 24"><path d="M9 4h6l1 7 3 3v2h-6v5l-1 1-1-1v-5H5v-2l3-3z" fill="currentColor"/></svg>`,
    mute: `<svg viewBox="0 0 24 24"><path d="M12 3a5 5 0 00-5 5v3l-2 4h14l-2-4V8a5 5 0 00-5-5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
    archive: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 9v11h14V9M10 13h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    read: `<svg viewBox="0 0 24 24"><path d="M3 13l4 4L17 7M10 15l2 2 8-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };
  showContextMenu([
    { label: chat.pinned ? "Unpin" : "Pin to top", icon: icons.pin, onClick: () => core.setChatFlags(chat.id, { pinned: !chat.pinned }) },
    { label: chat.muted ? "Unmute" : "Mute notifications", icon: icons.mute, onClick: () => core.setChatFlags(chat.id, { muted: !chat.muted }) },
    chat.unread > 0 ? { label: "Mark as read", icon: icons.read, onClick: () => core.markRead(chat.id) } : null,
    "-",
    { label: chat.archived ? "Unarchive" : "Archive", icon: icons.archive, onClick: () => core.setChatFlags(chat.id, { archived: !chat.archived }) },
    { label: "Delete chat", icon: icons.trash, danger: true, onClick: async () => {
      if (await confirmModal("Delete chat", `Delete "${chat.name}" and all its messages?`)) {
        await core.deleteMessages(chat.id, (await core.getMessages(chat.id, { limit: 100000 })).messages.map(m => m.id));
        if (state.activeChatId === chat.id) closeChat();
        refreshChatList();
      }
    } },
  ].filter(Boolean), x, y);
}

// Fresh <dc-chat-head> for the open chat. Always build a new element instead
// of setData() on an existing one: Elena's re-render diff strips the hydrated
// children of the nested <dc-avatar> (see renderChatList).
function renderChatHead(chat) {
  const head = document.createElement("dc-chat-head");
  head.setData(chat);
  head.addEventListener("click", () => showChatInfo(chat));
  return head;
}

/* ---------------- chat open/close ---------------- */
async function openChat(chatId) {
  if (chatId === DIAGNOSTICS_CHAT_ID) {
    openDiagnosticsChat();
    return;
  }
  // Already showing this chat → keep the live view (and its <video> elements)
  // instead of tearing everything down and rebuilding media from scratch.
  if (state.activeChatId === chatId) return;
  diagnosticsOpen = false;
  $("diagnostic-actions").hidden = true;
  $("main-composer").hidden = false;
  $("chat-head-actions").style.visibility = "";
  const chat = await core.getChat(chatId);
  if (chat.kind === "deaddrop") {
    const ok = await confirmModal("Contact request", `"${chat.name}" wants to start a conversation with you. Accept it to read the messages and reply.`, "Accept", false);
    if (ok) {
      await core.acceptChat(chatId);
      toast("Contact request accepted");
      await refreshChatList();
      return openChat(chatId); // now a normal chat — open it
    }
    return;
  }
  state.activeChatId = chatId;
  $("no-chat").hidden = true;
  $("chat-view").hidden = false;
  document.querySelector(".app").classList.add("chat-open");
  const head = document.createElement("dc-chat-head");
  head.setData(chat);
  $("chat-head-info").replaceChildren(head);
  state.activeChatHead = head;
  head.addEventListener("click", () => showChatInfo(chat));
  // Real member count for groups (the chatlist item doesn't carry it)
  if ((chat.kind === "group" || chat.kind === "channel") && core.getChatMembers) {
    core.getChatMembers(chatId).then(members => {
      if (state.activeChatId !== chatId) return;
      chat.memberCount = members.length;
      const fresh = renderChatHead(chat);
      state.activeChatHead?.replaceWith(fresh);
      state.activeChatHead = fresh;
    }).catch(() => {});
  }
  await chatView.open(chatId);
  renderChatList();
}

function closeChat() {
  diagnosticsOpen = false;
  chatView?.close();
  state.activeChatId = null;
  state.activeChatHead = null;
  $("chat-view").hidden = true;
  $("no-chat").hidden = false;
  document.querySelector(".app").classList.remove("chat-open");
  $("diagnostic-actions").hidden = true;
  $("main-composer").hidden = false;
  $("chat-head-actions").style.visibility = "";
  renderChatList();
}

// The header paints before the async member fetch resolves, and group
// membership changes (members added/removed) arrive later as core events.
// Re-fetch the count whenever the open group chat is signalled as updated,
// so the header never goes stale until reopen.
async function refreshActiveChatHeader(chatId) {
  const head = state.activeChatHead;
  const chat = head?.chat;
  if (!head || !chat || chat.id !== state.activeChatId) return;
  if (chat.kind !== "group" && chat.kind !== "channel") return;
  if (chatId && chatId !== chat.id) return;
  if (!core.getChatMembers) return;
  try {
    const members = await core.getChatMembers(chat.id);
    if (state.activeChatId !== chat.id || chat.memberCount === members.length) return;
    chat.memberCount = members.length;
    const fresh = renderChatHead(chat);
    state.activeChatHead?.replaceWith(fresh);
    state.activeChatHead = fresh;
  } catch { /* keep the last known count */ }
}

function showChatInfo(chat) {
  const encNote = chat.encrypted
    ? `<div class="enc-note"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>Messages in this chat are end-to-end encrypted automatically.</span></div>` : "";
  const contactRows = chat.contact ? `
    <div class="info-row"><span class="k">Address</span><span class="v">${escapeHtml(chat.contact.addr)}</span></div>
    <div class="info-row"><span class="k">Verified</span><span class="v">${chat.contact.verified ? "Yes ✓" : "No"}</span></div>` : "";
  const isGroup = chat.kind === "group" || chat.kind === "channel";
  const body = document.createElement("div");
  body.innerHTML = `
    <div style="display:flex;justify-content:center;padding:8px 0 14px">
      <dc-avatar name="${escapeHtml(chat.name)}" color="${chat.avatarColor || "#777"}" kind="${chat.kind}" size="84"></dc-avatar>
    </div>
    ${encNote}
    ${isGroup ? `<div class="info-row"><span class="k">Members</span><span class="v" data-member-count>…</span></div>
      <div class="modal-list" data-member-list style="max-height:240px;overflow:auto"></div>` : ""}
    ${contactRows}
    <div class="info-row"><span class="k">Notifications</span><span class="v">${chat.muted ? "Muted" : "On"}</span></div>
    <div class="info-row"><span class="k">Transport</span><span class="v">chatmail relay · ${escapeHtml(state.account.relay)}</span></div>`;
  showModal({ title: chat.name, body });

  if (isGroup && core.getChatMembers) {
    core.getChatMembers(chat.id).then(members => {
      const count = body.querySelector("[data-member-count]");
      const list = body.querySelector("[data-member-list]");
      if (count) count.textContent = members.length.toLocaleString();
      if (list) {
        for (const m of members) {
          const row = document.createElement("div");
          row.className = "info-row";
          row.innerHTML = `<span class="k" style="color:${escapeAttr(m.color || "#888")}">${escapeHtml(m.name)}</span><span class="v">${escapeHtml(m.addr || "")}</span>`;
          list.appendChild(row);
        }
      }
    }).catch(() => {
      const count = body.querySelector("[data-member-count]");
      if (count) count.textContent = "unavailable";
    });
  }
}

/* ---------------- chat head menu ---------------- */
function bindChatHeadMenu() {
  $("btn-chat-menu").addEventListener("click", e => {
    const chat = state.chats.find(c => c.id === state.activeChatId);
    if (!chat) return;
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu([
      { label: "Chat info", onClick: () => showChatInfo(chat) },
      ...(chat.kind === "group" ? [{ label: "Group invite QR", onClick: () =>
        showInvite(inviteQrProvider(chat.id), { title: chat.name, group: true }) }] : []),
      { label: chat.muted ? "Unmute" : "Mute", onClick: () => core.setChatFlags(chat.id, { muted: !chat.muted }) },
      { label: chat.pinned ? "Unpin" : "Pin", onClick: () => core.setChatFlags(chat.id, { pinned: !chat.pinned }) },
      "-",
      { label: "Clear history", danger: true, onClick: async () => {
        if (await confirmModal("Clear history", "Delete all messages in this chat?")) {
          const { messages } = await core.getMessages(chat.id, { limit: 100000 });
          await core.deleteMessages(chat.id, messages.map(m => m.id));
        }
      } },
    ], r.right - 220, r.bottom + 6);
  });
  $("btn-back").addEventListener("click", closeChat);
  $("btn-chat-search").addEventListener("click", () => {
    const input = document.createElement("input");
    input.className = "text-field";
    input.placeholder = "Search in loaded messages…";
    const results = document.createElement("div");
    results.className = "modal-list";
    const wrap = document.createElement("div");
    wrap.append(input, results);
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      results.replaceChildren();
      if (q.length < 2) return;
      const hits = chatView.items.filter(i => i.type === "msg" && i.msg.text?.toLowerCase().includes(q)).slice(-12);
      for (const h of hits) {
        const b = document.createElement("button");
        b.className = "ctx-item";
        b.innerHTML = `<span><b>${escapeHtml(h.msg.fromContact?.name || "")}</b>: ${escapeHtml(h.msg.text.slice(0, 80))}</span>`;
        b.addEventListener("click", () => { closeAllPopups(); chatView._jumpToMessage(h.msg.id); });
        results.appendChild(b);
      }
      if (!hits.length) results.innerHTML = `<p style="color:var(--text-dim);font-size:14px;padding:8px 0">Nothing found in loaded history.</p>`;
    });
    showModal({ title: "Search in chat", body: wrap });
    setTimeout(() => input.focus(), 50);
  });
}

/* ---------------- new chat / forward ---------------- */
async function pickContactModal(title, multi = false) {
  const contacts = await core.getContacts();
  return new Promise(resolve => {
    const list = document.createElement("div");
    list.className = "modal-list";
    const selected = new Set();
    for (const c of contacts) {
      const item = document.createElement("dc-chat-item");
      item.setData({
        id: "c" + c.id, name: c.name, kind: "single", avatarColor: c.color,
        verified: c.verified, encrypted: true, lastMsg: c.addr, lastTs: 0,
        unread: 0, pinned: false, muted: false,
      });
      item.addEventListener("click", () => {
        if (!multi) { close(); resolve([c]); return; }
        if (selected.has(c.id)) selected.delete(c.id); else selected.add(c.id);
        item.style.background = selected.has(c.id) ? "var(--bg-active)" : "";
        ok.disabled = !selected.size;
      });
      list.appendChild(item);
    }
    const foot = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn-text"; ok.textContent = multi ? "Create" : "OK";
    ok.disabled = true;
    foot.append(cancel, ok);
    const { close } = showModal({ title, body: list, foot, onClose: () => resolve(null) });
    cancel.addEventListener("click", () => { close(); resolve(null); });
    ok.addEventListener("click", () => { close(); resolve(contacts.filter(c => selected.has(c.id))); });
  });
}

async function newChatFlow() {
  const r = document.getElementById("btn-new-chat").getBoundingClientRect();
  showContextMenu([
    { label: "New chat", onClick: async () => {
      const picked = await pickContactModal("New chat");
      if (picked) {
        const id = await core.createChat(picked[0].name, [picked[0].id], "single");
        await refreshChatList();
        openChat(id);
      }
    } },
    { label: "New group", onClick: async () => {
      const picked = await pickContactModal("Add group members", true);
      if (picked) {
        const name = prompt("Group name:", "New group") || "New group";
        const id = await core.createChat(name, picked.map(c => c.id), "group");
        await refreshChatList();
        openChat(id);
      }
    } },
    { label: "Join chat via invite link", onClick: joinFlow },
    { label: "Add account via invite link", onClick: addAccountFlow },
  ], r.left, r.top - 170);
}

function addAccountFlow() {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:4px">Paste a chatmail invite link (<code>dcaccount:</code>) or scan a QR code in the Delta Chat app to add another profile.</p>
    <input class="text-field" placeholder="dcaccount:https://nine.testrun.org/new" id="invite-input">`;
  const foot = document.createElement("div");
  const cancel = document.createElement("button");
  cancel.className = "btn-text"; cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "btn-text"; ok.textContent = "Add account";
  foot.append(cancel, ok);
  const { close } = showModal({ title: "Add account", body, foot });
  cancel.addEventListener("click", close);
  ok.addEventListener("click", async () => {
    const v = body.querySelector("#invite-input").value.trim();
    if (!v.startsWith("dcaccount:")) { toast("That doesn't look like a dcaccount: link"); return; }
    close();
    await addAccountFromInvite(v);
  });
}

// Configure a profile from a dcaccount: relay invite link (deeplink or manual).
async function addAccountFromInvite(link) {
  if (!core.addAccountWithQr) {
    toast("No background service available — install the Delta Core service app to add relay accounts", 5000);
    return;
  }
  toast("Creating account on relay…", 2500);
  try {
    await core.addAccountWithQr(link);
    state.account = await core.getAccount();
    rebuildDrawer();
    await refreshChatList();
    toast(`Account ready: ${state.account.addr || "chatmail profile"}`, 3500);
  } catch (err) {
    toast("Invite failed: " + err.message, 4500);
  }
}

/* ---------------- deeplinks ----------------
   Supported entry points:
     • web+dcaccount: protocol handler → index.html?qr=dcaccount:…
     • ?dcaccount=dcaccount:…  or  #dcaccount=dcaccount:…
     • #/addrelay/<urlencoded dcaccount link>
     • velta://invite?url=<url-encoded i.delta.chat link>  (Windows custom scheme)
   Only acts when a real background core is available; in demo mode it
   tells the user to install the service instead. */
function extractInviteLink(rawUrl = location.href) {
  let url;
  try { url = new URL(rawUrl, location.href); } catch { return null; }
  let link = url.searchParams.get("qr") || url.searchParams.get("dcaccount");
  if (!link && url.hash) {
    const h = url.hash.slice(1);
    if (h.startsWith("dcaccount=")) link = decodeURIComponent(h.slice(10));
    else if (h.startsWith("/addrelay/")) link = decodeURIComponent(h.slice(10));
    else if (h.startsWith("dcaccount:")) link = h;
  }
  if (link && !link.startsWith("dcaccount:") && /^https?:\/\//.test(link)) link = "dcaccount:" + link;
  return link && link.startsWith("dcaccount:") ? link : null;
}

// i.delta.chat securejoin invite (1:1 or group), passed via
// ?invite= / #invite= — or as the raw fragment on a real i.delta.chat URL.
function extractJoinLink(rawUrl = location.href) {
  let url;
  try { url = new URL(rawUrl, location.href); } catch { return null; }
  let link = url.searchParams.get("invite");
  if (!link && url.hash) {
    const h = url.hash.slice(1);
    if (h.startsWith("invite=")) {
      link = decodeURIComponent(h.slice(7));
    } else if (/^https:\/\/i\.delta\.chat\//.test(rawUrl) && /^[0-9A-Fa-f]{40}/.test(h)) {
      // Raw fragment from an OS-level deep link: #FINGERPRINT&v=3&...
      link = `https://i.delta.chat/#${h}`;
    }
  }
  return link && /^https:\/\/i\.delta\.chat\//.test(link) ? link : null;
}

// Windows custom-scheme wrapper: velta://invite?url=<encoded https://i.delta.chat/…>
// or velta://account?url=<encoded dcaccount:…>.
function extractVeltaLink(rawUrl) {
  let url;
  try { url = new URL(rawUrl, location.href); } catch { return null; }
  if (url.protocol !== "velta:") return null;
  const inner = url.searchParams.get("url");
  if (!inner) return null;
  try { return decodeURIComponent(inner); } catch { return inner; }
}

async function handleDeeplinkFromUrl(rawUrl, { clearUrl = false } = {}) {
  const velta = extractVeltaLink(rawUrl);
  if (velta) rawUrl = velta;
  const joinLink = extractJoinLink(rawUrl);
  const link = extractInviteLink(rawUrl);
  if (!joinLink && !link) return;
  // clean the URL so a reload doesn't re-run the invite
  if (clearUrl) history.replaceState(null, "", location.pathname);
  if (joinLink) await joinFromInvite(joinLink);
  if (link) await addAccountFromInvite(link);
}

async function handleDeeplink() {
  await handleDeeplinkFromUrl(location.href, { clearUrl: true });
}

// Runtime URL changes (e.g. user navigates to an invite link in the webview)
addEventListener("hashchange", () => handleDeeplink());

async function forwardFlow(msgIds) {
  const list = document.createElement("div");
  list.className = "modal-list";
  const targets = state.chats.filter(c => !["deaddrop", "device"].includes(c.kind));
  for (const chat of targets) {
    const item = document.createElement("dc-chat-item");
    item.setData(chat);
    item.addEventListener("click", async () => {
      close();
      await core.forwardMessages(state.activeChatId, msgIds, chat.id);
      chatView.exitSelection();
      toast(`Forwarded to ${chat.name}`);
      refreshChatList();
    });
    list.appendChild(item);
  }
  const { close } = showModal({ title: "Forward to…", body: list });
}

/* ---------------- drawer ---------------- */
let drawer;
function rebuildDrawer() {
  drawer?.el.remove();
  drawer?.overlayEl?.remove();
  drawer = buildDrawer({
    account: state.account,
    backend: core.backend?.label || "unknown backend",
    theme: state.theme,
    onToggleTheme: toggleTheme,
    onAddAccount: addAccountFlow,
    onInvite: () => showInvite(inviteQrProvider(null)),
    onToggleMock: () => {
      const on = localStorage.getItem("velta-mock") === "1";
      localStorage.setItem("velta-mock", on ? "0" : "1");
      toast(on ? "Mock mode off — reloading" : "Mock mode on — reloading");
      setTimeout(() => location.reload(), 600);
    },
    onOpenChat: async kind => {
      if (kind === "saved") {
        const chats = await core.getChatList({ query: "" });
        const saved = chats.find(c => c.kind === "saved");
        if (saved) openChat(saved.id);
      }
    },
  });
}

// QR invite provider: real SecureJoin QR rendered by the core
// (chatId=null → self contact invite; group id → verified group invite).
function inviteQrProvider(chatId) {
  return async () => {
    if (!core.getInviteQr) throw new Error("invites need the real core — not available in demo mode");
    const { svg, text } = await core.getInviteQr(chatId);
    return { svg, link: text };
  };
}

// Show a non-blocking progress modal for long-running join/configure operations.
function showProgressModal(title, initialMessage) {
  const body = document.createElement("div");
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;padding:8px 0">
      <div style="width:26px;height:26px;border:3px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:ob-spin .8s linear infinite"></div>
      <div style="font-size:15px;line-height:1.45" id="progress-text"></div>
    </div>`;
  body.querySelector("#progress-text").textContent = initialMessage;
  const { close } = showModal({ title, body });
  return {
    close,
    update: (msg) => {
      const el = body.querySelector("#progress-text");
      if (el) el.textContent = msg;
    }
  };
}

// Join a 1:1 or group chat from an i.delta.chat invite link / QR text.
async function joinFromInvite(link) {
  if (!core.secureJoin) {
    toast("Joining chats needs the background core — not available in demo mode", 4500);
    return;
  }
  const { update, close } = showProgressModal("Joining chat", "Parsing invite link…");
  try {
    update("Starting SecureJoin handshake…");
    const chatId = await core.secureJoin(link);
    update("Opening chat…");
    await refreshChatList();
    openChat(chatId);
    update("Joined successfully");
    setTimeout(close, 700);
  } catch (err) {
    close();
    toast("Join failed: " + err.message, 4500);
  }
}

function joinFlow() {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:4px">Paste an invite link (<code>https://i.delta.chat/#…</code>) — works for both 1:1 contacts and group chats.</p>
    <input class="text-field" placeholder="https://i.delta.chat/#DD1F…" id="join-input">`;
  const foot = document.createElement("div");
  const cancel = document.createElement("button");
  cancel.className = "btn-text"; cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "btn-text"; ok.textContent = "Join";
  foot.append(cancel, ok);
  const { close } = showModal({ title: "Join chat via invite link", body, foot });
  cancel.addEventListener("click", close);
  ok.addEventListener("click", () => {
    const v = body.querySelector("#join-input").value.trim();
    if (!/^https:\/\/i\.delta\.chat\//.test(v) && !/^OPENPGP4FPR:/i.test(v)) {
      toast("That doesn't look like an i.delta.chat invite link"); return;
    }
    close();
    joinFromInvite(v);
  });
}

/* ---------------- onboarding (real core only) ---------------- */
// Accepts "example.com", "https://example.com", "example.com/new" or a full
// dcaccount: link and normalizes to dcaccount:https://<host>/new.
function normalizeRelayLink(raw) {
  let s = (raw || "").trim();
  if (!s) return null;
  if (/^dcaccount:/i.test(s)) return s; // full invite link pasted as-is
  s = s.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?$/i.test(s)) return null;
  return `dcaccount:https://${s}/new`;
}

function showOnboarding() {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5">Enter a <b>chatmail</b> relay address — an instant end-to-end encrypted profile will be created for you. No email or password needed.</p>
    <input class="text-field" id="ob-relay" placeholder="Relay address — e.g. nine.testrun.org" autocomplete="off" inputmode="url" autocapitalize="none">
    <ul class="ob-steps" id="ob-steps"></ul>`;
  const foot = document.createElement("div");
  const ok = document.createElement("button");
  ok.className = "btn-text"; ok.textContent = "Create account";
  foot.appendChild(ok);
  showModal({ title: "Welcome to Velta", body, foot });

  const input = body.querySelector("#ob-relay");
  const stepsEl = body.querySelector("#ob-steps");

  const addStep = (text) => {
    stepsEl.querySelectorAll("li.active").forEach(li => { li.classList.remove("active"); li.classList.add("done"); });
    const li = document.createElement("li");
    li.className = "active";
    li.innerHTML = `<span class="step-ico"></span><span>${escapeHtml(text)}</span>`;
    stepsEl.appendChild(li);
  };
  const finishSteps = (ok_) => {
    stepsEl.querySelectorAll("li.active").forEach(li => { li.classList.remove("active"); li.classList.add(ok_ ? "done" : "failed"); });
  };

  ok.addEventListener("click", async () => {
    const raw = input.value;
    const link = normalizeRelayLink(raw);
    if (!link) { toast(raw.trim() ? "That doesn't look like a relay address" : "Enter a relay address"); return; }
    const host = link.replace(/^dcaccount:https:\/\//i, "").replace(/\/new.*$/, "");

    ok.disabled = true; ok.classList.add("btn-loading"); ok.textContent = "Creating…";
    input.disabled = true;
    stepsEl.replaceChildren();
    addStep(`Attempting to connect to relay at ${host}`);

    // Friendly phase lines driven by the core's ConfigureProgress (0..1000).
    const phases = [
      [1,   `Relay found at ${host}`],
      [200, "Requesting new account credentials"],
      [450, "Generating encryption keys"],
      [750, "Finalizing account"],
    ];
    let phaseIdx = 0;
    const onProg = (e) => {
      const p = e.detail?.progress || 0;
      while (phaseIdx < phases.length && p >= phases[phaseIdx][0]) {
        addStep(phases[phaseIdx][1]);
        phaseIdx++;
      }
    };
    core.addEventListener("configure-progress", onProg);
    try {
      await core.configureWithQr(link);
      addStep("Account created — welcome!");
      finishSteps(true);
      state.account = await core.getAccount();
      setTimeout(() => {
        closeAllPopups();
        rebuildDrawer();
        refreshChatList();
        toast(`Account created on ${host}`, 3000);
      }, 900);
    } catch (err) {
      finishSteps(false);
      addStep("Setup failed: " + (err.message || err));
      finishSteps(false);
      ok.disabled = false; ok.classList.remove("btn-loading"); ok.textContent = "Retry";
      input.disabled = false;
    } finally {
      core.removeEventListener("configure-progress", onProg);
    }
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    appLog("boot: getAccount");
    state.account = await core.getAccount();
    appLog(`boot: account ${state.account.addr} configured=${state.account.configured}`);

    // Onboarding: real core without configured account → ask for credentials
    if (core.configureWithCredentials && state.account.configured === false) {
      appLog("boot: showing onboarding");
      showOnboarding();
    }

    try {
      const tauri = window.__TAURI__;
      const mediaInvoke = tauri?.core?.invoke || tauri?.invoke;
      if (mediaInvoke) window.veltaMediaBase = await mediaInvoke("media_base_url");
      appLog(`media base: ${window.veltaMediaBase}`);
    } catch (e) {
      appLog(`media base unavailable: ${e?.message || e}`);
    }

    appLog("boot: init chatView");
    chatView = new ChatView(core, {
      onChatsChanged: refreshChatList,
      onForward: forwardFlow,
    });

    appLog("boot: refreshChatList");
    await refreshChatList();
    appLog("boot: rebuildDrawer");
    rebuildDrawer();

    appLog("boot: bind ui");
    $("btn-menu").addEventListener("click", () => drawer.open());
    $("btn-new-chat").addEventListener("click", newChatFlow);
    bindChatHeadMenu();

    let searchTimer;
    $("search").addEventListener("input", e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = e.target.value; refreshChatList(); }, 160);
    });

    core.addEventListener("incoming-msg", () => scheduleChatListRefresh());
    core.addEventListener("msgs-changed", () => scheduleChatListRefresh());
    core.addEventListener("chat-updated", ev => {
      scheduleChatListRefresh();
      refreshActiveChatHeader(ev?.detail?.chatId);
    });
    // Safety net only: contact requests and new chats normally arrive via
    // core events (handled above with a debounced refresh). With in-place
    // chat-list updates a refresh is cheap, but each one still costs two RPC
    // round trips, so don't run it more often than needed.
    setInterval(() => { scheduleChatListRefresh(); }, 30000);

    addEventListener("dc-core-disconnected", () => {
      toast("Lost connection to local Delta Chat core — is the service running?", 4500);
    });

    appLog("boot: updateConnStatus");
    updateConnStatus();
    $("conn-status").addEventListener("click", recheckService);
    appLog("boot: handleDeeplink");
    await handleDeeplink();

    // Tauri runtime deep links (OS-level invite links and second-instance args)
    try {
      const tauri = window.__TAURI__;
      if (tauri?.core?.invoke) {
        const initial = await tauri.core.invoke("get_initial_deeplink");
        if (initial) await handleDeeplinkFromUrl(initial);
      }
      if (tauri?.event?.listen) {
        // Mobile custom event emitted by our Rust layer.
        tauri.event.listen("deeplink", ev => { if (ev.payload) handleDeeplinkFromUrl(ev.payload); });
        // Desktop event emitted by tauri-plugin-deep-link (Windows / Linux / macOS).
        tauri.event.listen("deep-link://new-url", ev => {
          const urls = Array.isArray(ev.payload) ? ev.payload : [ev.payload];
          for (const url of urls) {
            if (url) handleDeeplinkFromUrl(url);
          }
        });
      }
    } catch (err) {
      console.warn("Tauri deep-link setup failed:", err);
    }

    // diagnostic hook: ?openchat=<id> opens a chat directly after boot
    const autoOpen = new URLSearchParams(location.search).get("openchat");
    if (autoOpen && !isNaN(+autoOpen)) openChat(+autoOpen);

    // PWA: service worker + install prompt
    // The service worker was removed: native shells (Tauri/Android) serve
    // bundled assets fresh on every launch, and the SW's cache-first fetch
    // kept serving STALE js across upgrades — devices kept running old code
    // with a new Rust shell, which is un-debuggable. Unregister leftovers.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
      if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage("unregister");
    }
    let deferredPrompt;
    addEventListener("beforeinstallprompt", e => {
      e.preventDefault();
      deferredPrompt = e;
      toast("Velta can be installed — use your browser's install option", 4000);
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { chatView.exitSelection(); closeAllPopups(); }
    });
    appLog("boot: done");
  } catch (err) {
    appLog(`boot FAILED: ${err?.message || err}\n${err?.stack || ""}`);
    toast(`Startup error: ${err?.message || err}`, 8000);
    throw err;
  }
}

boot();
