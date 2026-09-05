// app.js — Delta Web bootstrap: chat list, navigation, modals, PWA
import { createCore, probeService } from "./transport.js";
import "./components.js";
import { escapeHtml, escapeAttr } from "./components.js";
import { fileUrl } from "./media.js";
import { buildAvatarSvg, setFingerprintSource, fingerprintFor, fingerprintGroups } from "./avatar.js";
import { ChatView, setAvatarProfileOpener } from "./chat-view.js";
import { diagnosticsSink, DiagnosticsStore, DIAGNOSTICS_CHAT_ID } from "./diagnostics.js";
import { parseInviteLink, inviteLabel, bindInviteInterception, showInviteDomainsModal } from "./invites.js";
import { buildDrawer, showModal, showContextMenu, toast, closeAllPopups, confirmModal, showInvite, showEditProfile } from "./ui.js";
import { p2pAvailable, openP2p as openP2pScreen } from "./p2p.js";
import { timeAgo } from "./mock-core.js";

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
let chatListInFlight = null;
let searchTimer;
let chatNavigation = 0;
let drawer = null;
let accountRefreshPromise = Promise.resolve();
const state = {
  account: null,
  accountChanging: false,
  accounts: [],  // all core profiles, for the drawer account switcher
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
    bubble.textContent = `${new Date(message.ts).toLocaleTimeString()}  ${message.text}` + (message.count > 1 ? ` ×${message.count}` : "");
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
  if (state.accountChanging) return;
  chatNavigation++;
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
  if (history.state?.velta !== "chat") history.pushState({ velta: "chat", chatId: DIAGNOSTICS_CHAT_ID }, "");
  renderChatList();
}

diagnostics.addEventListener("changed", () => {
  renderDiagnosticsMessages();
  // Debounced: diagnostics appends fire per core event (several per second
  // during sync) — a direct refresh here would multiply the churn.
  if (core) scheduleChatListRefresh();
  else renderInitialDiagnosticsChat();
});

/* ---------------- DOM budget watchdog ---------------- */
// Frontend accumulation detector (rerender loops, unvirtualized growth):
// samples node/row counts once a minute; when the DOM grows past budget
// over a ~10-minute window, dump a per-selector census into Diagnostics
// (rate-limited to one report per 10 minutes).
const domBudgetSamples = [];
let lastDomCensusAt = 0;
setInterval(() => {
  if (document.hidden) return;
  const hist = document.getElementById("history");
  const sample = {
    t: Date.now(),
    nodes: document.getElementsByTagName("*").length,
    rows: hist ? hist.children.length : -1,
  };
  domBudgetSamples.push(sample);
  if (domBudgetSamples.length > 10) domBudgetSamples.shift();
  if (domBudgetSamples.length < 10) return;
  const first = domBudgetSamples[0];
  const growth = sample.nodes - first.nodes;
  if (growth < 400 || sample.t - lastDomCensusAt < 10 * 60000) return;
  lastDomCensusAt = sample.t;
  const census = {};
  for (const el of document.querySelectorAll("*")) {
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const key = el.tagName.toLowerCase() + cls;
    census[key] = (census[key] || 0) + 1;
  }
  const top = Object.entries(census).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, v]) => `${k}:${v}`).join(" ");
  diagnosticsSink.append("warning",
    `DOM budget: +${growth} nodes in 10 min (${sample.nodes} total, history rows ${sample.rows}). Top: ${top}`);
}, 60000);

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
  setFingerprintSource((contactId) => core.getContactEncryptionInfo(contactId));
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

function accountIsCurrent(epoch) {
  return !state.accountChanging && epoch === core.accountEpoch;
}

core.addEventListener("account-changing", () => {
  state.accountChanging = true;
  clearTimeout(chatListRefreshTimer);
  clearTimeout(searchTimer);
  chatListRefreshTimer = null;
  chatListInFlight = null;
  state.chats = [];
  state.query = "";
  $("search").value = "";
  closeChatUI();
  closeAllPopups();
  if (history.state?.velta === "chat") history.replaceState(null, "");
  drawer?.el.remove();
  drawer?.overlayEl?.remove();
  drawer = null;
});
core.addEventListener("account-changed", () => {
  state.accountChanging = false;
  setFingerprintSource(contactId => core.getContactEncryptionInfo(contactId));
  accountRefreshPromise = Promise.all([refreshAccounts(), refreshChatList()]);
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
  document.querySelector('meta[name="theme-color"]').content = state.theme === "dark" ? "#0f0f14" : "#f4f4f4";
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
  if (state.accountChanging) return;
  if (chatListRefreshTimer) return; // a trailing refresh is already pending
  chatListRefreshTimer = setTimeout(async () => {
    chatListRefreshTimer = null;
    await refreshChatList();
  }, delay);
}

async function refreshChatList() {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch, query = state.query;
  if (chatListInFlight?.epoch === epoch && chatListInFlight.query === query) {
    scheduleChatListRefresh();
    return chatListInFlight.promise;
  }
  const request = { epoch, query };
  chatListInFlight = request;
  request.promise = (async () => {
  try {
    const chats = await core.getChatList({ query });
    if (!accountIsCurrent(epoch) || query !== state.query || chatListInFlight !== request) return;
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
    if (chatListInFlight === request) chatListInFlight = null;
  }
  })();
  return request.promise;
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


// Group message sender avatars open the contact's profile modal — the same
// showChatInfo sheet, built around the contact instead of a chat object.
function openContactProfile(contact) {
  showChatInfo({
    contactId: contact.contactId ?? contact.id,
    name: contact.name,
    contact: { addr: contact.addr, online: contact.online, lastSeen: contact.lastSeen },
    kind: "single",
    encrypted: true,
  });
}

function isGroupChat(chat) {
  return chat.kind === "group" || chat.kind === "channel";
}
setAvatarProfileOpener(openContactProfile);

function formatFingerprint(fpr) {
  const groups = fingerprintGroups(fpr) || [];
  const lines = [];
  for (let i = 0; i < groups.length; i += 5) lines.push(groups.slice(i, i + 5).join(" "));
  return lines.join("\n");
}

function chatContextMenu(chat, x, y) {
  const epoch = core.accountEpoch;
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
        if (!accountIsCurrent(epoch)) return;
        const { messages } = await core.getMessages(chat.id, { limit: 100000 });
        if (!accountIsCurrent(epoch)) return;
        await core.deleteMessages(chat.id, messages.map(m => m.id));
        if (!accountIsCurrent(epoch)) return;
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
  if (state.accountChanging) return;
  if (chatId === DIAGNOSTICS_CHAT_ID) {
    openDiagnosticsChat();
    return;
  }
  // Already showing this chat → keep the live view (and its <video> elements)
  // instead of tearing everything down and rebuilding media from scratch.
  if (state.activeChatId === chatId) return;
  closeChatUI();
  const navigation = chatNavigation, epoch = core.accountEpoch;
  const current = () => navigation === chatNavigation && accountIsCurrent(epoch);
  try {
  const chat = await core.getChat(chatId);
  if (!current() || !chat) return;
  if (chat.kind === "deaddrop") {
    const ok = await confirmModal("Contact request", `"${chat.name}" wants to start a conversation with you. Accept it to read the messages and reply.`, "Accept", false);
    if (ok && current()) {
      await core.acceptChat(chatId);
      if (!current()) return;
      toast("Contact request accepted");
      await refreshChatList();
      if (!current()) return;
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
      if (!current() || state.activeChatId !== chatId) return;
      chat.memberCount = members.length;
      const fresh = renderChatHead(chat);
      state.activeChatHead?.replaceWith(fresh);
      state.activeChatHead = fresh;
    }).catch(() => {});
  }
  if (!await chatView.open(chatId) || !current()) return;
  // History entry per open chat: Android BACK pops it (chat -> chat list)
  // via WryActivity's WebView-history navigation instead of exiting.
  if (history.state?.velta !== "chat") history.pushState({ velta: "chat", chatId }, "");
  renderChatList();
  } catch (error) {
    if (!current()) return;
    closeChatUI();
    toast("Couldn't open chat: " + (error.message || error));
  }
}

function closeChat() {
  const popHistory = history.state?.velta === "chat";
  closeChatUI();
  if (popHistory) history.back();
}

function closeChatUI() {
  chatNavigation++;
  diagnosticsOpen = false;
  chatView?.close();
  state.activeChatId = null;
  state.activeChatHead = null;
  $("chat-head-info").replaceChildren();
  $("chat-view").hidden = true;
  $("no-chat").hidden = false;
  document.querySelector(".app").classList.remove("chat-open");
  $("diagnostic-actions").hidden = true;
  $("main-composer").hidden = false;
  $("chat-head-actions").style.visibility = "";
  renderChatList();
}

// Android BACK / gesture pops the entry pushed by openChat; this performs
// the actual teardown. Diagnostics chat uses the same entry shape.
window.addEventListener("popstate", (e) => {
  if (e.state?.velta !== "chat") closeChatUI();
});

// The header paints before the async member fetch resolves, and group
// membership changes (members added/removed) arrive later as core events.
// Re-fetch the count whenever the open group chat is signalled as updated,
// so the header never goes stale until reopen.
async function refreshActiveChatHeader(chatId) {
  const navigation = chatNavigation, epoch = core.accountEpoch;
  const head = state.activeChatHead;
  const chat = head?.chat;
  if (!head || !chat || chat.id !== state.activeChatId) return;
  if (chat.kind !== "group" && chat.kind !== "channel") return;
  if (chatId && chatId !== chat.id) return;
  if (!core.getChatMembers) return;
  try {
    const members = await core.getChatMembers(chat.id);
    if (!accountIsCurrent(epoch) || navigation !== chatNavigation) return;
    if (state.activeChatId !== chat.id || chat.memberCount === members.length) return;
    chat.memberCount = members.length;
    const fresh = renderChatHead(chat);
    state.activeChatHead?.replaceWith(fresh);
    state.activeChatHead = fresh;
  } catch { /* keep the last known count */ }
}

function showChatInfo(chat) {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
  const contactRows = chat.contact ? `
    <div class="info-row"><span class="k">Address</span><span class="v">${escapeHtml(chat.contact.addr)}</span></div>
    ${chat.contactId ? `<div class="info-row"><span class="k">Profile key</span><span class="v"><span class="avatar-profile-fpr" data-profile-key>…</span></span></div>` : ""}
    ${chat.contact && (chat.contact.online || chat.contact.lastSeen) ? `<div class="info-row"><span class="k">Last seen</span><span class="v">${escapeHtml(chat.contact.online ? "online" : timeAgo(chat.contact.lastSeen))}</span></div>` : ""}
    <div class="info-row"><span class="k">Verified</span><span class="v">${chat.contact.verified ? "Yes ✓" : "No"}</span></div>` : "";
  const isGroup = chat.kind === "group" || chat.kind === "channel";
  const body = document.createElement("div");
  body.innerHTML = `
    <div style="display:flex;justify-content:center;align-items:center;gap:16px;padding:8px 0 14px">
      <dc-avatar class="chat-info-avatar" name="${escapeHtml(chat.name)}" color="${chat.avatarColor || "#777"}" kind="${chat.kind}" size="168"${chat.contactId ? ` contact-id="${chat.contactId}"` : ""}${chat.contact && chat.contact.addr ? ` addr="${escapeAttr(chat.contact.addr)}"` : ""}${chat.avatar ? ` avatar="${escapeAttr(fileUrl(chat.avatar))}"` : ""}></dc-avatar>
      ${chat.contactId ? `<span class="chat-info-tile" data-caption-tile></span>` : ""}
    </div>
    ${!isGroup && chat.contactId ? `<div class="profile-actions">
      <button class="btn-text" data-pa="send">Send message</button>
      <button class="btn-text" data-pa="share">Share profile</button>
      <button class="btn-text" data-pa="rename">Edit name</button>
      <button class="btn-text" data-pa="block" style="color:var(--danger)">Block</button>
    </div>` : ""}
    ${isGroup ? `<div class="info-row"><span class="k">Members</span><span class="v" data-member-count>…</span></div>
      <div class="modal-list" data-member-list style="max-height:240px;overflow:auto"></div>` : ""}
    ${contactRows}
    <div class="info-row"><span class="k">Notifications</span><span class="v">${chat.muted ? "Muted" : "On"}</span></div>
    <div class="info-row"><span class="k">Transport</span><span class="v">chatmail relay · ${escapeHtml(state.account.relay)}</span></div>
    ${!isGroup && chat.contactId ? `<div class="info-row" data-common-head style="display:none"><span class="k" style="color:var(--text);font-weight:600">Chats in common</span></div>
    <div class="modal-list" data-common-list style="display:none;max-height:180px;overflow:auto"></div>` : ""}`;
  const modal = showModal({ title: chat.name, body });

  // Profile action buttons (single chats): send, share, rename, block.
  if (!isGroup && chat.contactId) {
    const contactId = chat.contactId;
    const actBtn = (act) => body.querySelector(`[data-pa="${act}"]`);
    actBtn("send")?.addEventListener("click", async () => {
      modal.close();
      const existing = state.chats.find(c => c.contactId === contactId && c.kind === "single");
      if (existing) return openChat(existing.id);
      try {
        const chatId = await core.createChatByContactId(contactId);
        if (!accountIsCurrent(epoch)) return;
        await refreshChatList();
        if (!accountIsCurrent(epoch)) return;
        await openChat(Number(chatId));
      } catch { toast("Couldn't open the chat"); }
    });
    actBtn("share")?.addEventListener("click", async () => {
      // Share the account's personal i.delta.chat invite link (native share
      // API where available; clipboard fallback otherwise).
      let link = null;
      try {
        if (core.getInviteQr) {
          const { text } = await core.getInviteQr(null);
          const parsed = parseInviteLink(text);
          if (parsed) link = parsed.link;
        }
      } catch { /* demo mode falls through to the placeholder link */ }
      if (!accountIsCurrent(epoch)) return;
      if (!link) {
        const fpr = "5DB721C142C0137F9A2E4B66C31D08597EA47594";
        const addr = encodeURIComponent(state.account.addr || "you@example.org");
        const name = encodeURIComponent(state.account.displayName || "");
        link = `https://i.delta.chat/#${fpr}&v=3&a=${addr}&n=${name}`;
      }
      const text = `Contact me on Delta Chat: ${link}`;
      try {
        if (navigator.share) { await navigator.share({ title: chat.name, text, url: link }); return; }
        throw new Error("unavailable");
      } catch (err) {
        if (err && err.name === "AbortError") return; // user closed the share sheet
        if (!accountIsCurrent(epoch)) return;
        try { await navigator.clipboard.writeText(link); toast("Invite link copied"); }
        catch { toast("Sharing isn't available here"); }
      }
    });
    actBtn("rename")?.addEventListener("click", () => {
      const input = document.createElement("input");
      input.className = "text-field"; input.maxLength = 64;
      input.value = (chat.contact && chat.contact.name) || chat.name || "";
      const wrap = document.createElement("div");
      wrap.appendChild(input);
      const renameModal = { close: null };
      const save = document.createElement("button");
      save.className = "btn-text btn-primary"; save.textContent = "Save";
      save.addEventListener("click", async () => {
        const name = input.value.trim();
        if (!name) return;
        save.disabled = true;
        try {
        await core.renameContact(contactId, name);
        if (!accountIsCurrent(epoch)) return;
        if (chat.contact) chat.contact.name = name;
        chat.name = name;
        renameModal.close();
        toast("Name updated");
        refreshChatList();
        if (state.activeChatHead && state.activeChatId === chat.id) {
          const fresh = renderChatHead(chat);
          state.activeChatHead.replaceWith(fresh);
          state.activeChatHead = fresh;
        }
        showChatInfo(chat); // fresh modal with the new name everywhere
        } catch (err) {
          toast("Rename failed: " + (err.message || err));
          save.disabled = false;
        }
      });
      const cancel = document.createElement("button");
      cancel.className = "btn-text"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => renameModal.close());
      const foot = document.createElement("div");
      foot.className = "modal-foot edit-profile-foot";
      foot.append(cancel, save);
      const m = showModal({ title: "Edit name", body: wrap, foot });
      renameModal.close = m.close;
      setTimeout(() => { input.focus(); input.select(); }, 50);
    });
    const blockBtn = actBtn("block");
    if (core.getBlockedContactIds) {
      core.getBlockedContactIds().then(ids => {
        if (blockBtn && ids.includes(contactId)) {
          blockBtn.textContent = "Unblock";
          blockBtn.dataset.blocked = "1";
        }
      }).catch(() => {});
    }
    blockBtn?.addEventListener("click", async () => {
      const blockedNow = blockBtn.dataset.blocked === "1";
      const ok = await confirmModal(
        blockedNow ? "Unblock contact" : "Block contact",
        blockedNow
          ? `${chat.name} will be able to write to you again.`
          : `You will no longer receive messages or requests from ${chat.name}.`,
        blockedNow ? "Unblock" : "Block", false);
      if (!ok || !accountIsCurrent(epoch)) return;
      try {
        await core.blockContact(contactId, !blockedNow);
        if (!accountIsCurrent(epoch)) return;
        toast(blockedNow ? "Contact unblocked" : "Contact blocked");
        blockBtn.textContent = blockedNow ? "Block" : "Unblock";
        blockBtn.dataset.blocked = blockedNow ? "0" : "1";
      } catch (err) { toast("Failed: " + (err.message || err)); }
    });
  }

  // Same formatted key as the Avatar modal (avatar-profile-fpr), filled in
  // once the contact's fingerprint resolves. The captioned identity tile
  // (avatar-profile-img) fills its slot in the same row as the dc-avatar.
  if (chat.contactId) {
    fingerprintFor(chat.contactId, chat.contact && chat.contact.addr)
      .then((fpr) => {
        const groups = fingerprintGroups(fpr);
        const slot = body.querySelector("[data-profile-key]");
        if (slot) slot.textContent = fpr ? formatFingerprint(fpr) : "—";
        const capSlot = body.querySelector("[data-caption-tile]");
        if (capSlot && groups) {
          // radius 0 — the svg element's own border-radius does the rounding.
          capSlot.innerHTML = buildAvatarSvg({ groups, withCaptions: true, size: 168, radius: 0 });
        } else if (capSlot) {
          capSlot.remove();
        }
      })
      .catch(() => {});
  }

  // Chats in common: group chats the contact is also a member of. Each row
  // opens that chat; the section disappears entirely if there are none.
  if (!isGroup && chat.contactId && core.getChatMembers) {
    core.getChatList({}).then(async chats => {
      if (!accountIsCurrent(epoch)) return;
      const common = [];
      for (const c of chats) {
        if (c.kind !== "group" && c.kind !== "channel") continue;
        try {
          const members = await core.getChatMembers(c.id);
          if (!accountIsCurrent(epoch)) return;
          if (members.some(m => m.id === chat.contactId)) common.push(c);
        } catch { /* skip chats whose members can't be listed */ }
      }
      const head = body.querySelector("[data-common-head]");
      const list = body.querySelector("[data-common-list]");
      if (!head || !list || !document.contains(head)) return;
      if (!common.length) { head.remove(); list.remove(); return; }
      head.style.display = "";
      list.style.display = "";
      for (const c of common) {
        const row = document.createElement("div");
        row.className = "info-row clickable";
        row.innerHTML = `<span class="k">${escapeHtml(c.name)}</span><span class="v">${c.unread ? c.unread + " unread" : ""}</span>`;
        row.addEventListener("click", () => { modal.close(); openChat(c.id); });
        list.appendChild(row);
      }
    }).catch(() => {});
  }

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
    const epoch = core.accountEpoch;
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
          if (!accountIsCurrent(epoch)) return;
          const { messages } = await core.getMessages(chat.id, { limit: 100000 });
          if (!accountIsCurrent(epoch)) return;
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
  if (state.accountChanging) return null;
  const epoch = core.accountEpoch;
  const contacts = await core.getContacts();
  if (!accountIsCurrent(epoch)) return null;
  return new Promise(resolve => {
    const list = document.createElement("div");
    list.className = "modal-list";
    const selected = new Set();
    for (const c of contacts) {
      const item = document.createElement("dc-chat-item");
      item.setData({
        id: "c" + c.id, name: c.name, kind: "single", avatarColor: c.color,
        contactId: c.id, avatar: c.avatar || null,
        verified: c.verified, encrypted: true, lastMsg: c.addr, lastTs: 0,
        unread: 0, pinned: false, muted: false,
      });
      item.addEventListener("click", () => {
        if (!multi) { resolve([c]); close(); return; }
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
    ok.addEventListener("click", () => { resolve(contacts.filter(c => selected.has(c.id))); close(); });
  });
}

async function newChatFlow() {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
  const r = document.getElementById("btn-new-chat").getBoundingClientRect();
  showContextMenu([
    { label: "New chat", onClick: async () => {
      const picked = await pickContactModal("New chat");
      if (picked && accountIsCurrent(epoch)) {
        const id = await core.createChat(picked[0].name, [picked[0].id], "single");
        if (!accountIsCurrent(epoch)) return;
        await refreshChatList();
        if (!accountIsCurrent(epoch)) return;
        openChat(id);
      }
    } },
    { label: "New group", onClick: async () => {
      const picked = await pickContactModal("Add group members", true);
      if (picked && accountIsCurrent(epoch)) {
        const name = prompt("Group name:", "New group") || "New group";
        const id = await core.createChat(name, picked.map(c => c.id), "group");
        if (!accountIsCurrent(epoch)) return;
        await refreshChatList();
        if (!accountIsCurrent(epoch)) return;
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
  if (state.accountChanging) return;
  if (!core.addAccountWithQr) {
    toast("No background service available — install the Delta Core service app to add relay accounts", 5000);
    return;
  }
  toast("Creating account on relay…", 2500);
  try {
    const id = await core.addAccountWithQr(link);
    const epoch = core.accountEpoch;
    await accountRefreshPromise;
    if (accountIsCurrent(epoch) && core.accountId === id) toast(`Account ready: ${state.account?.addr || "chatmail profile"}`, 3500);
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
// ?invite= / #invite= — or as the raw fragment on any registered invite
// host (see invites.js / the "Invite link domains" setting).
function extractJoinLink(rawUrl = location.href) {
  let url;
  try { url = new URL(rawUrl, location.href); } catch { return null; }
  let link = url.searchParams.get("invite");
  if (!link && url.hash) {
    const h = url.hash.slice(1);
    if (h.startsWith("invite=")) link = decodeURIComponent(h.slice(7));
  }
  if (link) return parseInviteLink(link)?.raw ?? null;
  // Raw fragment from an OS-level deep link: https://<host>/#FINGERPRINT&v=3&…
  const parsed = parseInviteLink(rawUrl);
  return parsed ? parsed.raw : null;
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
  if (state.accountChanging) return;
  const epoch = core.accountEpoch, fromChatId = state.activeChatId, navigation = chatNavigation;
  const list = document.createElement("div");
  list.className = "modal-list";
  const targets = state.chats.filter(c => !["deaddrop", "device"].includes(c.kind));
  for (const chat of targets) {
    const item = document.createElement("dc-chat-item");
    item.setData(chat);
    item.addEventListener("click", async () => {
      close();
      if (!accountIsCurrent(epoch)) return;
      await core.forwardMessages(fromChatId, msgIds, chat.id);
      if (!accountIsCurrent(epoch)) return;
      if (navigation === chatNavigation) chatView.exitSelection();
      toast(`Forwarded to ${chat.name}`);
      refreshChatList();
    });
    list.appendChild(item);
  }
  const { close } = showModal({ title: "Forward to…", body: list });
}

/* ---------------- drawer ---------------- */

// Pulls the profile list for the account switcher. Feature-detected: demo
// mode and very old cores have no getAllAccounts.
async function refreshAccounts() {
  if (!core.getAllAccounts || state.accountChanging) return;
  const epoch = core.accountEpoch;
  try {
    const [account, accounts] = await Promise.all([core.getAccount(), core.getAllAccounts()]);
    if (!accountIsCurrent(epoch)) return;
    state.account = account;
    state.accounts = accounts;
  } catch (error) {
    if (!accountIsCurrent(epoch)) return;
    state.accounts = [];
    console.warn("[velta] refreshAccounts error:", error);
    return;
  }
  rebuildDrawer();
}

// Tap on a profile in the drawer switcher.
async function accountTapFlow(id) {
  if (state.accountChanging || String(core.accountId) === String(id)) return;
  try {
    toast("Switching account…");
    const account = await core.switchAccount(id);
    const epoch = core.accountEpoch;
    await accountRefreshPromise;
    if (accountIsCurrent(epoch)) toast(`Switched to ${account.displayName || account.addr}`);
  } catch (err) {
    toast("Switch failed: " + (err.message || err));
  }
}
function rebuildDrawer() {
  if (state.accountChanging) return;
  drawer?.el.remove();
  drawer?.overlayEl?.remove();
  drawer = buildDrawer({
    account: state.account,
    backend: core.backend?.label || "unknown backend",
    theme: state.theme,
    p2p: p2pAvailable(),
    onP2p: () => openP2pScreen({ renderQr: text => core.createQrSvg(text) }),
    accounts: state.accounts,
    currentAccountId: core.accountId,
    onAccountTap: accountTapFlow,
    relays: getSavedRelays(),
    onRelayTap: relayTapFlow,
    onAddRelay: relayAddFlow,
    onWelcome: () => showOnboarding({ addNew: true }),
    onToggleTheme: toggleTheme,
    onAddAccount: addAccountFlow,
    onInvite: () => showInvite(inviteQrProvider(null), { account: state.account }),
    onEditProfile: editProfileFlow,
    onInviteDomains: () => showInviteDomainsModal(),
    onToggleMock: () => {
      const on = localStorage.getItem("velta-mock") === "1";
      localStorage.setItem("velta-mock", on ? "0" : "1");
      toast(on ? "Mock mode off — reloading" : "Mock mode on — reloading");
      setTimeout(() => location.reload(), 600);
    },
    onOpenChat: async kind => {
      if (state.accountChanging) return;
      const epoch = core.accountEpoch;
      if (kind === "saved") {
        const chats = await core.getChatList({ query: "" });
        if (!accountIsCurrent(epoch)) return;
        const saved = chats.find(c => c.kind === "saved");
        if (saved) openChat(saved.id);
      }
    },
  });
}

// Profile editor flow: name + avatar picture.
// The core's selfavatar config takes a filesystem path it can read, so the
// picked image goes through the same pipeline as attachments: absolute path
// on desktop, content-URI copy into uploads/ on Android, data URL in demo.
async function pickProfileImage() {
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  if (!invoke) {
    // No Tauri dialog (plain browser / mock) — local file as data URL.
    return new Promise(resolve => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "image/png,image/jpeg,image/webp,image/gif";
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve({ path: String(reader.result), url: String(reader.result) });
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(f);
      };
      inp.click();
    });
  }
  let picked = await invoke("plugin:dialog|open", { options: {
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  } });
  if (Array.isArray(picked)) picked = picked[0];
  if (!picked) return null;
  if (/^content:\/\//.test(picked)) {
    picked = await invoke("resolve_content_uri", { uri: picked, filename: String(Date.now()) });
  }
  return { path: picked, url: null }; // preview resolves via fileUrl()
}

async function editProfileFlow() {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
  const result = await showEditProfile({
    name: state.account?.displayName || "",
    avatarUrl: state.account?.avatar ? fileUrl(state.account.avatar) : "",
    color: state.account?.color,
    pickImage: pickProfileImage,
  });
  if (!result || !accountIsCurrent(epoch)) return;
  try {
    if (!core.setDisplayName || !core.setAvatar) throw new Error("not available with this backend");
    await core.setDisplayName(result.name);
    if (!accountIsCurrent(epoch)) return;
    if (result.avatar === "remove") await core.setAvatar(null);
    else if (result.avatar !== "keep") await core.setAvatar(result.avatar.path);
    if (!accountIsCurrent(epoch)) return;
    const account = await core.getAccount();
    if (!accountIsCurrent(epoch)) return;
    state.account = account;
    rebuildDrawer();
    toast("Profile updated");
  } catch (err) {
    toast("Couldn't update profile: " + (err.message || err), 4500);
  }
}

// QR invite provider: real SecureJoin QR rendered by the core
// (chatId=null → self contact invite; group id → verified group invite).
function inviteQrProvider(chatId) {
  const epoch = core.accountEpoch;
  return async () => {
    if (!accountIsCurrent(epoch)) throw new Error("Account changed; reopen the invite");
    if (!core.getInviteQr) throw new Error("invites need the real core — not available in demo mode");
    const { svg, text } = await core.getInviteQr(chatId);
    if (!accountIsCurrent(epoch)) throw new Error("Account changed; reopen the invite");
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

// Join a 1:1 or group chat from an invite link / QR text. Asks for
// confirmation first (who invites / which group — read from the link's own
// params), like the official client's QR-scan flow.
async function joinFromInvite(link) {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
  if (!core.secureJoin) {
    toast("Joining chats needs the background core — not available in demo mode", 4500);
    return;
  }
  const parsed = parseInviteLink(link);
  const label = parsed ? inviteLabel(parsed) : null;
  let ok;
  if (label?.kind === "group") {
    ok = await confirmModal("Join group",
      `${label.actor} invited you to join the group "${label.group}".`, "Join group", false);
  } else if (label?.kind === "channel") {
    ok = await confirmModal("Subscribe to channel",
      `Subscribe to the channel "${label.group}"?`, "Subscribe", false);
  } else if (label?.kind === "person") {
    ok = await confirmModal("Start chat",
      `Start a chat with ${label.actor}${label.addr ? ` (${label.addr})` : ""}?`, "Start chat", false);
  } else {
    ok = await confirmModal("Join chat", "Open this invite and start the SecureJoin handshake?", "Join", false);
  }
  if (!ok || !accountIsCurrent(epoch)) return;
  const { update, close } = showProgressModal("Joining chat", "Starting SecureJoin handshake…");
  try {
    // Mirror links (i.gluek.info & friends) are normalized onto the canonical
    // i.delta.chat form — the core only parses that scheme, and the payload
    // lives in the URL fragment, so the host is irrelevant to the join.
    const chatId = await core.secureJoin(parsed ? parsed.link : link);
    if (!accountIsCurrent(epoch)) return;
    update("Opening chat…");
    await refreshChatList();
    if (!accountIsCurrent(epoch)) return;
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
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:4px">Paste an invite link (<code>https://i.delta.chat/#…</code> or a mirror domain) — works for both 1:1 contacts and group chats.</p>
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
    if (!parseInviteLink(v)) {
      toast("That doesn't look like an invite link (e.g. https://i.delta.chat/#… or OPENPGP4FPR:…)"); return;
    }
    close();
    joinFromInvite(v);
  });
}

/* ---------------- saved relays ---------------- */
const MAX_SAVED_RELAYS = 3;

function getSavedRelays() {
  try {
    const list = JSON.parse(localStorage.getItem("velta-relays") || "[]");
    return Array.isArray(list) ? list.slice(0, MAX_SAVED_RELAYS) : [];
  } catch { return []; }
}

function saveSavedRelays(list) {
  localStorage.setItem("velta-relays", JSON.stringify(list.slice(0, MAX_SAVED_RELAYS)));
}

function hostFromLink(link) {
  return link.replace(/^dcaccount:https?:\/\//i, "").replace(/\/.*$/, "");
}

// "Add relay…" — save a chatmail host for quick account creation.
function relayAddFlow() {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:4px">Save a chatmail relay for quick account creation — e.g. <code>nine.testrun.org</code>. Up to ${MAX_SAVED_RELAYS} relays are kept.</p>
    <input class="text-field" id="relay-input" placeholder="Relay address — e.g. relay.example.org" autocomplete="off" inputmode="url" autocapitalize="none">`;
  const foot = document.createElement("div");
  const cancel = document.createElement("button");
  cancel.className = "btn-text"; cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "btn-text"; ok.textContent = "Save relay";
  foot.append(cancel, ok);
  const { close } = showModal({ title: "Add relay", body, foot });
  const input = body.querySelector("#relay-input");
  ok.addEventListener("click", () => {
    const link = normalizeRelayLink(input.value);
    if (!link) { toast(input.value.trim() ? "That doesn't look like a relay address" : "Enter a relay address"); return; }
    const host = hostFromLink(link);
    const list = getSavedRelays();
    if (list.includes(host)) { toast("Relay already saved"); close(); rebuildDrawer(); return; }
    if (list.length >= MAX_SAVED_RELAYS) {
      toast(`Relay list is full (${MAX_SAVED_RELAYS}) — delete one first`);
      return;
    }
    list.unshift(host);
    saveSavedRelays(list);
    close();
    rebuildDrawer();
    toast(`Relay saved: ${host}`);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); ok.click(); }
  });
  setTimeout(() => input.focus(), 60);
}

// Tap on a saved relay: create a new account there, or delete it from the
// list (existing accounts are never touched by deletion).
function relayTapFlow(host) {
  const body = document.createElement("div");
  body.innerHTML = `<p style="font-size:14.5px;line-height:1.5">Create a new encrypted profile on <b>${escapeHtml(host)}</b>, or remove the relay from your saved list. Existing accounts are not affected by deletion.</p>`;
  const foot = document.createElement("div");
  const cancel = document.createElement("button");
  cancel.className = "btn-text"; cancel.textContent = "Cancel";
  const del = document.createElement("button");
  del.className = "btn-text"; del.textContent = "Delete";
  del.style.color = "var(--danger)";
  const use = document.createElement("button");
  use.className = "btn-text"; use.textContent = "Create account";
  foot.append(cancel, del, use);
  const { close } = showModal({ title: `Relay ${host}`, body, foot });
  cancel.addEventListener("click", close);
  del.addEventListener("click", () => {
    saveSavedRelays(getSavedRelays().filter(r => r !== host));
    close();
    rebuildDrawer();
    toast(`Relay deleted: ${host}`);
  });
  use.addEventListener("click", () => {
    close();
    addAccountFromInvite(`dcaccount:https://${host}/new`);
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

// The "Welcome to Velta" modal. First boot: configures the current
// (unconfigured) account. From the menu (addNew: true): creates a NEW account
// on the entered relay via addAccountWithQr, which is safe on configured
// accounts — it never overwrites an existing profile.
function showOnboarding({ addNew = false, preset = "" } = {}) {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
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
  input.value = preset;
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
    if (!accountIsCurrent(epoch)) return;
    const raw = input.value;
    const link = normalizeRelayLink(raw);
    if (!link) { toast(raw.trim() ? "That doesn't look like a relay address" : "Enter a relay address"); return; }
    if (addNew) {
      await addAccountFromInvite(link);
      return;
    }
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
      if (!accountIsCurrent(epoch)) return;
      addStep("Account created — welcome!");
      finishSteps(true);
      const account = await core.getAccount();
      if (!accountIsCurrent(epoch)) return;
      state.account = account;
      setTimeout(() => {
        if (!accountIsCurrent(epoch)) return;
        closeAllPopups();
        rebuildDrawer();
        refreshChatList();
        toast(`Account created on ${host}`, 3000);
      }, 900);
    } catch (err) {
      if (!accountIsCurrent(epoch)) return;
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
    refreshAccounts();

    appLog("boot: bind ui");
    $("btn-menu").addEventListener("click", () => drawer?.open());
    $("btn-new-chat").addEventListener("click", newChatFlow);
    bindChatHeadMenu();
    // Invite cards in messages + any invite-host link tap → join flow
    bindInviteInterception(link => joinFromInvite(link));

    $("search").addEventListener("input", e => {
      if (state.accountChanging) return;
      clearTimeout(searchTimer);
      state.query = e.target.value;
      searchTimer = setTimeout(refreshChatList, 160);
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
