// app.js — Delta Web bootstrap: chat list, navigation, modals, PWA
import { createCore } from "./transport.js";
import "./components.js";
import { escapeHtml, escapeAttr } from "./components.js";
import { fileUrl } from "./media.js";
import { buildAvatarSvg, setFingerprintSource, fingerprintFor, fingerprintGroups } from "./avatar.js";
import { ChatView, setAvatarProfileOpener } from "./chat-view.js";
import { diagnosticsSink, DiagnosticsStore, DIAGNOSTICS_CHAT_ID, diagnosticRow } from "./diagnostics.js";
import { parseInviteLink, inviteLabel, bindInviteInterception, showInviteDomainsModal } from "./invites.js";
import { buildDrawer, showModal, showContextMenu, toast, closeAllPopups, confirmModal, showInvite, showEditProfile, notifyIncoming } from "./ui.js";
import { p2pAvailable, p2pEnabled, setP2pEnabled, openP2p as openP2pScreen } from "./p2p.js";
import { timeAgo } from "./mock-core.js";
import { acquireCode } from "./qr-scan.js";

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
  history.replaceChildren(...diagnostics.messages.map(diagnosticRow));
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
      await refreshChatList();
      diagnostics.append("info", "UI reconnected successfully");
      toast("UI reconnected to core");
    } catch (error) {
      diagnostics.append("error", `UI reconnect failed: ${error?.message || error}`);
      toast(`Reconnect failed: ${error?.message || error}`, 5000);
    }
  }, { once: true });

  $("btn-p2p-toggle")?.addEventListener("click", async () => {
    const enable = !p2pEnabled();
    try {
      await setP2pEnabled(enable);
      toast(enable ? "Local chat enabled" : "Local chat disabled");
    } catch (error) {
      diagnostics.append("error", `Local chat toggle failed: ${error?.message || error}`);
      toast(`Local chat toggle failed: ${error?.message || error}`, 5000);
    } finally {
      updateP2pToggle();
      rebuildDrawer();
    }
  });
}

function updateP2pToggle() {
  const btn = $("btn-p2p-toggle");
  if (btn) btn.textContent = `Local chat: ${p2pEnabled() ? "on" : "off"}`;
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
  updateP2pToggle();
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

// In the Tauri shell, record sidecar startup progress in diagnostics while the core is being located.
if (window.__TAURI__) {
  const tauri = window.__TAURI__;
  const invoke = tauri.core?.invoke || tauri.invoke;
  const event = tauri.event || tauri;
  const listen = event.listen ? event.listen.bind(event) : tauri.listen.bind(tauri);

  function applySidecarStatus(status) {
    diagnostics.append(status.error ? "error" : "info", `Embedded core: ${status.stage || (status.running ? "running" : "stopped")}${status.error ? ` — ${status.error}` : ""}`);
  }

  try {
    listen("dc-sidecar-status", ev => applySidecarStatus(ev.payload));
    invoke("get_sidecar_status").then(applySidecarStatus).catch(() => {});
  } catch (e) {
    console.warn("[delta-web] sidecar status setup failed:", e);
  }
}

// The splash is the boot surface: it shows immediately (with the live app
// log) so any startup hang or failure is visible and copyable, and boot()
// later decides whether it becomes the setup screen or disappears.
let splashSession = null;

// Mirror diagnostics into velta.log (js_log): the in-app store is only
// visible on the phone's splash footer, while velta.log is pullable via
// adb (run-as) — every core/transport diagnostic must land in both.
coreStartupPromise = createCore({
  onDiagnostic: (level, message) => {
    diagnostics.append(level, message);
    try {
      const tauri = window.__TAURI__;
      const invoke = tauri?.core?.invoke || tauri?.invoke;
      if (invoke) invoke("js_log", { msg: `[diag:${level}] ${message}` }).catch(() => {});
    } catch {}
  },
});
splashSession = showSplash();
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

addEventListener("dc-core-status", e => {
  if (core.backend) core.backend.connected = !!e.detail.connected;
});

/* ---------------- relay status line ---------------- */
// Thin strip at the top of the chat list reflecting the chatmail relay:
// green connected, yellow connecting/retrying, red unreachable,
// blue local-chat mode (no relay in play). Animated dashes while a
// message is on its way to the relay.
let relayConnectivity = null;  // last get_connectivity value (1000/2000/3000/4000)
let relayDownSince = 0;        // first NotConnected observation — red after a grace period
let relaySending = false;      // any message queued/sending through the relay
let relayUpgradeTimer = null;
let relaySegments = [];        // per-relay [{ domain, text, state }] — [] falls back to the combined view
const RELAY_DOWN_AFTER_MS = 45000;

// The core exposes per-transport status only inside its connectivity HTML
// page: one <li class="transport[ unpublished]"> per relay, each folder
// rendered as `<span class="(green|red|yellow|grey) dot"></span> <b>domain:</b>
// text`. Worst dot color wins per relay.
// 🐴 ceiling: parsing the core's HTML page — upgrade path is a dedicated
// per-transport connectivity JSON-RPC in the core.
function parseConnectivityHtml(html) {
  const out = [];
  const weight = { red: 3, yellow: 2, grey: 1, green: 0 };
  const stateFor = { green: "ok", yellow: "connecting", grey: "connecting", red: "down" };
  for (const m of html.matchAll(/<li class="transport( unpublished)?">([\s\S]*?)<\/li>/g)) {
    if (m[1]) continue; // unpublished relay — phasing out, not a live transport
    const colors = [...m[2].matchAll(/class="(red|green|yellow|grey) dot"/g)].map(c => c[1]);
    if (!colors.length) continue;
    const domain = (m[2].match(/<b>([^<]+)<\/b>/) || [])[1] || "relay";
    const text = (m[2].split(/<\/b>/i)[1] || "").replace(/<[^>]*>/g, "").split("\n")[0].trim();
    colors.sort((a, b) => weight[b] - weight[a]);
    out.push({ domain, text, state: stateFor[colors[0]] || "connecting" });
  }
  return out;
}

async function refreshRelayStatus() {
  if (!core.getConnectivity || core.backend?.kind === "mock") return;
  const epoch = core.accountEpoch;
  try {
    const value = await core.getConnectivity();
    if (!accountIsCurrent(epoch)) return;
    relayConnectivity = value;
    clearTimeout(relayUpgradeTimer);
    if (value >= 4000) {
      relayDownSince = 0;
    } else if (value <= 1000) {
      if (!relayDownSince) relayDownSince = Date.now();
      // The core stays silent while offline — schedule the yellow -> red flip.
      const wait = relayDownSince + RELAY_DOWN_AFTER_MS - Date.now() + 250;
      relayUpgradeTimer = setTimeout(renderRelayLine, Math.max(wait, 250));
    } else {
      relayDownSince = 0;
    }
    renderRelayLine();
  } catch { /* old cores without get_connectivity */ }
  // Per-relay segments (best effort — an old core or a stopped scheduler
  // leaves relaySegments empty and the line falls back to the combined view).
  try {
    if (core.getConnectivityHtml) {
      const html = await core.getConnectivityHtml();
      if (!accountIsCurrent(epoch)) return;
      relaySegments = parseConnectivityHtml(html);
      renderRelayLine();
    }
  } catch { /* per-relay view unavailable */ }
}

function renderRelayLine() {
  const el = $("relay-line");
  if (!el) return;
  let relayState, title;
  if (core.backend?.kind === "mock") {
    relayState = "local"; title = "Demo mode — everything stays on this device";
  } else if (state.account && state.account.configured === false && p2pAvailable()) {
    relayState = "local"; title = "Local chat mode — no relay configured";
  } else if (relayConnectivity == null) {
    relayState = "connecting"; title = "Checking relay…";
  } else if (relayConnectivity >= 4000) {
    relayState = "ok"; title = "Relay connected";
  } else if (relayConnectivity >= 2000) {
    relayState = "connecting"; title = "Connecting to relay…";
  } else if (relayDownSince && Date.now() - relayDownSince > RELAY_DOWN_AFTER_MS) {
    relayState = "down"; title = "Relay unreachable — retrying";
  } else {
    relayState = "connecting"; title = "Relay problems — retrying…";
  }
  // One segment per relay (equal widths); a single relay fills the whole
  // line. Without a parsed per-relay view, one segment carries the combined
  // state — visually identical to the old bar. The sending animation applies
  // only to the sending (primary) relay's segment — messages always go out
  // through the transport matching `configured_addr` (= state.account.addr).
  const sendDomain = (state.account?.addr || "").split("@")[1]?.toLowerCase();
  const segs = relaySegments.length ? relaySegments : [{ state: relayState, text: title }];
  if (relaySending && relayState !== "local") {
    const segDomains = segs.map(s => s.domain || "—");
    const matched = segs.some(s => s.domain && s.domain.toLowerCase() === sendDomain);
    diagnosticsSink.append("info", `relay: sending via ${sendDomain || "?"}; segments [${segDomains.join(", ")}]${matched ? "" : " — NO domain match"}`);
  }
  el.replaceChildren(...segs.map((s, i) => {
    const seg = document.createElement("span");
    seg.className = "relay-seg";
    seg.dataset.state = s.state;
    const isSendSeg = relaySending && relayState !== "local" && (
      (s.domain && s.domain.toLowerCase() === sendDomain) ||
      // A single relay is always the sending relay, even if its domain
      // couldn't be matched against the account address.
      (segs.length === 1 && !sendDomain));
    if (isSendSeg) seg.setAttribute("data-sending", "");
    seg.title = s.domain ? `${s.domain}: ${s.text}` : (s.text || title);
    return seg;
  }));
  el.dataset.state = relayState;
  if (relaySending && relayState !== "local") el.setAttribute("data-sending", "");
  else el.removeAttribute("data-sending");
  el.title = title;
  el.setAttribute("aria-label", title);
}

core.addEventListener?.("connectivity-changed", refreshRelayStatus);
core.addEventListener?.("send-activity", e => {
  relaySending = !!e.detail?.sending;
  renderRelayLine();
});
renderRelayLine();
refreshRelayStatus();

// Socket opened but the core never answered RPC → almost always an old or
// crashed service build. Say so explicitly instead of silently demo-ing.
addEventListener("dc-core-init-failed", e => {
  if (e.detail.backend === "websocket") {
    toast("Found the background service, but it didn't answer — restart the Delta Core service (or update it if it's an older build)", 6000);
  }
});

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
  if (chatListInFlight?.epoch === epoch && chatListInFlight?.query === query) {
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
      <button class="btn-text" data-pa="rename">Edit name</button>
      <button class="btn-text" data-pa="block" style="color:var(--danger)">Block</button>
    </div>` : ""}
    ${isGroup ? `<div class="info-row"><span class="k">Members</span><span class="v" data-member-count>…</span></div>
      <div class="modal-list" data-member-list style="max-height:240px;overflow:auto"></div>` : ""}
    ${contactRows}
    <div class="info-row"><span class="k">Notifications</span><span class="v">${chat.muted ? "Muted" : "On"}</span></div>
    <div class="info-row" data-relays style="cursor:pointer"><span class="k">Transport</span><span class="v">chatmail relay · ${escapeHtml(state.account.relay)} ›</span></div>
    ${!isGroup && chat.contactId ? `<div class="info-row" data-common-head style="display:none"><span class="k" style="color:var(--text);font-weight:600">Chats in common</span></div>
    <div class="modal-list" data-common-list style="display:none;max-height:180px;overflow:auto"></div>` : ""}`;
  const modal = showModal({ title: chat.name, body });

  // Relay transports (multi-relay) — tapping the Transport row opens the
  // relays manager for the current account.
  body.querySelector("[data-relays]")?.addEventListener("click", () => openRelaysModal());

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

async function addAccountFlow() {
  const code = await acquireCode({
    title: "Add account",
    hint: "Paste a chatmail invite link (<code>dcaccount:…</code>), just a relay domain like <code>nine.testrun.org</code>, or scan a QR code in the Delta Chat app to add another profile.",
    validate: c => (normalizeRelayLink(c) ? null : "That doesn't look like a chatmail relay or dcaccount: link"),
  });
  if (!code) return;
  await addAccountFromInvite(normalizeRelayLink(code));
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
   A dcaccount: invite asks whether to add the relay to the current profile
   or create a new profile on it. Relay-adding needs a real core; in demo
   mode it tells the user instead. */
function extractInviteLink(rawUrl = location.href) {
  // Raw scheme deep links (dcaccount:https://host/new, dclogin:…) arrive as
  // opaque URLs — URL parsing gives protocol "dcaccount:" and pathname as
  // the rest; rebuild the original link text from it.
  const schemeMatch = /^(dcaccount|dclogin):(.*)$/i.exec(rawUrl.trim());
  if (schemeMatch) return schemeMatch[0];
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

// dcbackup<version>: transfer code received as an OS deep link — route it
// into the second-device receive flow.
function extractBackupLink(rawUrl = location.href) {
  const m = /^dcbackup\d*:.*$/i.exec((rawUrl || "").trim());
  return m ? m[0] : null;
}

async function handleDeeplinkFromUrl(rawUrl, { clearUrl = false } = {}) {
  const velta = extractVeltaLink(rawUrl);
  if (velta) rawUrl = velta;
  const backupLink = extractBackupLink(rawUrl);
  if (backupLink) {
    if (clearUrl) history.replaceState(null, "", location.pathname);
    receiveSecondDeviceProfile(core.accountEpoch, null, backupLink);
    return;
  }
  const joinLink = extractJoinLink(rawUrl);
  const link = extractInviteLink(rawUrl);
  if (!joinLink && !link) return;
  // clean the URL so a reload doesn't re-run the invite
  if (clearUrl) history.replaceState(null, "", location.pathname);
  if (joinLink) await joinFromInvite(joinLink);
  if (!link) return;
  // A dcaccount: link is ambiguous once a profile exists — it can become a
  // second relay on the current profile or create a new profile on that relay.
  const epoch = core.accountEpoch;
  const choice = await chooseRelayOrNewProfile(link);
  if (choice === "relay") await addRelayFlow(epoch, null, link);
  else if (choice === "new") await addAccountFromInvite(link);
}

// Ask what a clicked/pasted dcaccount: invite should do. Resolve "relay",
// "new", or null (dismissed).
function chooseRelayOrNewProfile(link) {
  return new Promise(resolve => {
    const host = link.replace(/^dc(account|login):https?:\/\//i, "").replace(/\/.*$/, "");
    const body = document.createElement("div");
    body.innerHTML = `
      <p class="p2p-hint">Use the <b>${escapeHtml(host)}</b> invite to…</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
        <button class="btn-text btn-primary" data-relay>Add the relay to this profile</button>
        ${/^dclogin:/i.test(link) ? "" : `<button class="btn-text" data-new>Create a new profile on it</button>`}
      </div>`;
    let settled = false;
    const pick = v => { if (settled) return; settled = true; close(); resolve(v); };
    body.querySelector("[data-relay]").addEventListener("click", () => pick("relay"));
    body.querySelector("[data-new]").addEventListener("click", () => pick("new"));
    const { close } = showModal({ title: "Relay invite", body, onClose: () => resolve(null) });
  });
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
  // Relay status is account-scoped — re-check whenever the profile picture
  // refreshes (startup and every account switch).
  refreshRelayStatus();
  renderRelayLine();
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
    p2p: p2pAvailable() && p2pEnabled(),
    onP2p: () => openP2pScreen({ renderQr: text => core.createQrSvg(text) }),
    accounts: state.accounts,
    currentAccountId: core.accountId,
    onAccountTap: accountTapFlow,
    onRelays: () => openRelaysModal(),
    onToggleTheme: toggleTheme,
    onAddAccount: addAccountFlow,
    onSecondDevice: secondDeviceFlow,
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

// The "Welcome to Velta" splash. Shown full-screen whenever the current
// account is unconfigured (first boot): large Velta logo, tagline, the three
// setup paths (create an account / add as a second device / restore from a
// backup) and a collapsed app-log footer for errors and debug messages.
// Removes itself once a profile is ready — the create flow hides it
// directly, the second-device receive resolves, restore reloads the app.
function showSplash() {
  if (state.accountChanging) return;
  // The splash shows before the core exists (boot surface); capture the
  // account epoch lazily — handlers run only after boot, when core is live.
  let epoch = null;
  const el = document.createElement("div");
  el.className = "splash"; el.id = "splash";
  el.innerHTML = `
    <div class="splash-main">
      <img class="splash-logo" src="./icons/v-logo.svg" alt="Velta logo">
      <h1 class="splash-title">Welcome to Velta</h1>
      <p class="splash-tag">End-to-end encrypted messaging built on Delta Chat — no phone number, no central server. Pick how to set up your profile:</p>
      <div class="splash-actions" data-actions>
        <button class="btn-primary splash-btn" data-create type="button">Create an account</button>
        <button class="btn-text splash-btn" data-second type="button">Add as a second device…</button>
        <button class="btn-text splash-btn" data-restore type="button">Restore from a backup…</button>
      </div>
      <div class="splash-form" data-form hidden>
        <p class="splash-hint">Enter a <b>chatmail</b> relay address — an instant end-to-end encrypted profile will be created for you. No email or password needed.</p>
        <input class="text-field" data-relay placeholder="Relay address — e.g. nine.testrun.org" autocomplete="off" inputmode="url" autocapitalize="none">
        ${navigator.mediaDevices?.getUserMedia ? `<div style="margin-top:10px"><button class="btn-text" data-scan type="button">Scan a QR code</button></div>` : ""}
        <div style="margin-top:12px"><button class="btn-primary splash-btn" data-ok type="button">Create account</button></div>
      </div>
      <ul class="ob-steps" data-steps></ul>
    </div>
    <details class="splash-log">
      <summary>App log — errors &amp; debug</summary>
      <div class="splash-log-bar"><button class="btn-text" data-copylog type="button">Copy log</button></div>
      <pre data-logpre></pre>
    </details>`;
  document.body.appendChild(el);

  const actionsEl = el.querySelector("[data-actions]");
  const formEl = el.querySelector("[data-form]");
  const stepsEl = el.querySelector("[data-steps]");
  const input = el.querySelector("[data-relay]");
  const ok = el.querySelector("[data-ok]");
  const logPre = el.querySelector("[data-logpre]");

  const hideSplash = () => el.remove();
  const finishOk = () => {
    hideSplash();
    closeAllPopups();
    rebuildDrawer();
    refreshChatList();
  };

  const addStep = (text) => {
    stepsEl.querySelectorAll("li.active").forEach(li => { li.classList.remove("active"); li.classList.add("done"); });
    const li = document.createElement("li");
    li.className = "active";
    li.innerHTML = `<span class="step-ico"></span><span>${escapeHtml(text)}</span>`;
    stepsEl.appendChild(li);
    return li;
  };
  const finishSteps = (ok_) => {
    stepsEl.querySelectorAll("li.active").forEach(li => { li.classList.remove("active"); li.classList.add(ok_ ? "done" : "failed"); });
  };

  const showActions = () => {
    epoch = core?.accountEpoch;
    actionsEl.hidden = false;
    formEl.hidden = true;
    stepsEl.replaceChildren();
  };

  // Loading state until boot knows the account: actions stay hidden and the
  // log footer is the only visible activity.
  actionsEl.hidden = true;
  addStep("Connecting to the encryption core…");

  // --- create an account ---
  el.querySelector("[data-create]").addEventListener("click", () => {
    actionsEl.hidden = true;
    formEl.hidden = false;
    setTimeout(() => input.focus(), 60);
  });

  // Camera permission is requested inside acquireCode — the sheet opens with
  // the camera starting immediately (autoScan), no second tap needed.
  el.querySelector("[data-scan]")?.addEventListener("click", async () => {
    const code = await acquireCode({
      title: "Scan relay QR",
      hint: "Point the camera at the relay's QR code — or paste the code below.",
      validate: c => normalizeRelayLink(c) ? null : "That QR code is not a relay invite",
      autoScan: true,
    });
    if (!code) return;
    if (!accountIsCurrent(epoch)) { diagnosticsSink.append("warning", "scan: relay code arrived after account change — ignored"); return; }
    diagnosticsSink.append("info", `scan: relay code → create flow (${code.length} chars)`);
    input.value = code;
    ok.click();
  });

  // --- add as a second device ---
  el.querySelector("[data-second]").addEventListener("click", async () => {
    actionsEl.hidden = true;
    if (await receiveSecondDeviceProfile(epoch)) finishOk();
    else showActions();
  });

  // --- restore from a backup ---
  el.querySelector("[data-restore]").addEventListener("click", async () => {
    if (!core.importBackup) { toast("Restore is not available on this backend"); return; }
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
    if (!invoke) { toast("Restore from a backup file needs the Velta app — use \"Add as a second device\" instead"); return; }
    let picked = await invoke("plugin:dialog|open", { options: {
      multiple: false,
      filters: [{ name: "Velta backup", extensions: ["tar"] }],
    } });
    if (Array.isArray(picked)) picked = picked[0];
    if (!picked || !accountIsCurrent(epoch)) return;
    if (/^content:\/\//.test(picked)) {
      try {
        picked = await invoke("resolve_content_uri", { uri: picked, filename: `backup-${Date.now()}.tar` });
      } catch (err) {
        toast("Couldn't read the backup file: " + (err?.message || err));
        return;
      }
    }

    actionsEl.hidden = true;
    stepsEl.replaceChildren();
    const prog = addStep("Restoring profile…").querySelector("span:last-child");
    let seenProgress = false;
    const onProg = (e) => {
      const p = e.detail?.progress || 0;
      if (p >= 1000) {
        finishSteps(true);
        addStep("Profile restored — restarting");
        core.removeEventListener("imex-progress", onProg);
        setTimeout(() => location.reload(), 800);
      } else if (p > 0) {
        seenProgress = true;
        prog.textContent = `Restoring profile… ${Math.round(p / 10)}%`;
      } else if (seenProgress) {
        finishSteps(false);
        addStep("Restore failed");
        core.removeEventListener("imex-progress", onProg);
        showActions();
      }
    };
    core.addEventListener("imex-progress", onProg);
    // Fire-and-forget: the import can take minutes and would outrun the RPC
    // timeout — progress and failure arrive via ImexProgress above.
    core.importBackup(picked).catch(() => {
      if (seenProgress) return;
      finishSteps(false);
      addStep("Restore failed: couldn't import the backup");
      core.removeEventListener("imex-progress", onProg);
      showActions();
    });
  });

  ok.addEventListener("click", async () => {
    if (!accountIsCurrent(epoch)) return;
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
      if (!accountIsCurrent(epoch)) return;
      addStep("Account created — welcome!");
      finishSteps(true);
      const account = await core.getAccount();
      if (!accountIsCurrent(epoch)) return;
      state.account = account;
      setTimeout(() => {
        if (!accountIsCurrent(epoch)) return;
        finishOk();
        toast(`Account created on ${host}`, 3000);
      }, 900);
    } catch (err) {
      if (!accountIsCurrent(epoch)) return;
      finishSteps(false);
      addStep("Setup failed: " + (err.message || err));
      ok.disabled = false; ok.classList.remove("btn-loading"); ok.textContent = "Retry";
      input.disabled = false;
    } finally {
      core.removeEventListener("configure-progress", onProg);
    }
  });

  // --- app log footer (collapsed <details>) ---
  const logSummary = el.querySelector(".splash-log summary");
  const renderLog = () => {
    logPre.textContent = diagnostics.messages
      .map(m => {
        const t = new Date(m.ts).toTimeString().slice(0, 8);
        return m.count > 1 ? `${t} ${m.text} (×${m.count})` : `${t} ${m.text}`;
      })
      .join("\n");
    logSummary.textContent = `App log (${diagnostics.messages.length}) — errors & debug`;
    logPre.scrollTop = logPre.scrollHeight;
  };
  diagnostics.addEventListener("changed", renderLog);
  renderLog();
  el.querySelector(".splash-log").addEventListener("toggle", (e) => {
    if (e.target.open) renderLog();
  });
  el.querySelector("[data-copylog]").addEventListener("click", () => {
    navigator.clipboard?.writeText(logPre.textContent)
      .then(() => toast("Log copied"))
      .catch(() => toast("Couldn't copy the log"));
  });

  // All listeners are wired — hand the boot surface back to boot().
  return { hide: hideSplash, showActions: () => showActions() };
}

/* ---------------- relay transports (multi-relay) ---------------- */
// One account can receive on several chatmail relays — what Delta Chat
// desktop 2.47+ manages under "Relays". Removal is soft: the core keeps
// listening on an unpublished relay for ~90 days so contacts that still
// send to the old address don't lose mail, then deletes it automatically.
const RELAYS_WARNING =
  "Messages are received on all relays. ⚠️ If you change anything here, " +
  "make sure all your devices run at least version 2.47.0. " +
  "Otherwise older devices may miss messages.";

async function openRelaysModal() {
  if (state.accountChanging) return;
  if (!core.listTransports) {
    toast("Relay management is not available on this backend");
    return;
  }
  const epoch = core.accountEpoch;
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="p2p-hint">${escapeHtml(RELAYS_WARNING)}</p>
    <div data-list><div class="p2p-hint" style="opacity:.6">Loading…</div></div>
    <div style="margin-top:10px"><button class="btn-text" data-add>Add relay…</button></div>`;
  showModal({ title: "Relays", body });
  const listEl = body.querySelector("[data-list]");

  const refresh = async () => {
    let transports;
    try {
      transports = await core.listTransports();
    } catch (err) {
      if (accountIsCurrent(epoch)) {
        listEl.innerHTML = `<div class="p2p-hint" style="color:var(--danger)">Failed to load relays: ${escapeHtml(String(err?.message || err))}</div>`;
      }
      return;
    }
    if (!accountIsCurrent(epoch)) return;
    listEl.replaceChildren();
    if (!transports.length) {
      const empty = document.createElement("div");
      empty.className = "p2p-hint"; empty.style.opacity = ".6";
      empty.textContent = "No relays configured.";
      listEl.appendChild(empty);
    }
    for (const t of transports) {
      const row = document.createElement("div");
      row.className = "info-row";
      const primary = state.account && t.addr === state.account.addr;
      row.innerHTML = `<span class="k">${escapeHtml(t.addr)}${primary ? " · sending" : ""}</span>
        <span class="v">${primary ? "" : `<button class="btn-text" data-sendvia>Use for sending</button>`}<button class="btn-text" data-remove style="color:var(--danger)">Remove</button></span>`;
      row.querySelector("[data-sendvia]")?.addEventListener("click", async () => {
        const ok = await confirmModal(
          `Send via ${t.addr}?`,
          "New messages will be sent through this relay and it becomes the address new contacts see. Messages currently waiting to be sent are dropped (they carry the old sender address). The change syncs to your other devices.",
          "Use for sending");
        if (!ok || !accountIsCurrent(epoch)) return;
        try {
          await core.setSendRelay(t.addr);
          toast(`Sending via ${t.addr}`);
          state.account = await core.getAccount();
          rebuildDrawer();
          refreshRelayStatus();
          refresh();
        } catch (err) {
          toast(String(err?.message || err));
        }
      });
      row.querySelector("[data-remove]").addEventListener("click", async () => {
        const ok = await confirmModal(
          `Remove ${t.addr}?`,
          "The relay stops being advertised and self-sent messages stop going there right away, but the core keeps listening on it for about 90 days so messages from contacts who still use it are not lost. After that it is deleted automatically.",
          "Remove");
        if (!ok || !accountIsCurrent(epoch)) return;
        try {
          await core.setTransportUnpublished(t.addr, true);
          toast("Relay removed");
        } catch (err) {
          toast(String(err?.message || err));
        }
        refresh();
      });
      listEl.appendChild(row);
    }
  };
  await refresh();
  body.querySelector("[data-add]").addEventListener("click", () => addRelayFlow(epoch, refresh));
}

async function addRelayFlow(epoch, refresh, presetCode) {
  if (!accountIsCurrent(epoch)) return;
  if (!core.checkQr || !core.addTransportFromQr) {
    toast("No background service available — install the Delta Core service app to add relays", 5000);
    return;
  }
  // presetCode comes from a deeplink (already dcaccount:-prefixed by
  // extractInviteLink); without one, ask for a pasted/scanned code.
  const code = presetCode ?? await acquireCode({
    title: "Add relay",
    hint: "Paste the relay's invite code (dcaccount:… or dclogin:…), just its domain (nine.testrun.org), or scan its QR. It becomes a second transport for this profile; messages are received on both relays.",
    validate: c => (/^(dcaccount:|dclogin:)/i.test(c.trim()) || normalizeRelayLink(c) ? null : "That doesn't look like a relay address or invite code"),
  });
  if (!code || !accountIsCurrent(epoch)) return;
  // Bare domains / https links normalize to dcaccount:https://<host>/new;
  // dclogin: (rejected by normalizeRelayLink) passes through for checkQr.
  const qr = normalizeRelayLink(code) ?? code.trim();

  const body = document.createElement("div");
  body.innerHTML = `<ul class="ob-steps" data-steps></ul>`;
  const { close: closeAdding } = showModal({ title: "Adding relay", body });
  const stepsEl = body.querySelector("[data-steps]");
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

  addStep("Checking the code…");
  try {
    const qrInfo = await core.checkQr(qr);
    if (!accountIsCurrent(epoch)) return;
    const kind = qrInfo?.kind;
    if (kind !== "account" && kind !== "login") {
      throw new Error("This code is not a relay invite");
    }
    addStep(`Relay: ${qrInfo.domain || qrInfo.address || qr}`);
    // Friendly phase lines driven by the core's ConfigureProgress (0..1000).
    const phases = [
      [1,   "Connecting to the relay"],
      [400, "Adding relay to this profile"],
      [750, "Finalizing"],
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
      await core.addTransportFromQr(qr);
      if (!accountIsCurrent(epoch)) return;
      finishSteps(true);
      addStep("Relay added — messages are received on both relays");
      toast("Relay added");
      refresh();
      // Success must not leave the steps modal open — close it and, if the
      // flow was started from the Relays modal, show the updated list again.
      setTimeout(() => {
        if (!accountIsCurrent(epoch)) return;
        closeAdding();
        if (refresh) openRelaysModal();
      }, 900);
    } finally {
      core.removeEventListener("configure-progress", onProg);
    }
  } catch (err) {
    if (!accountIsCurrent(epoch)) return;
    finishSteps(false);
    addStep("Adding relay failed: " + (err?.message || err));
  }
}

// Receive a profile on this device from another device's DCBACKUP<n>: code
// (scanned or pasted). Used by the second-device modal and by onboarding.
// Resolves true once the fresh account was created and selected; the transfer
// itself runs fire-and-forget and reports via ImexProgress.
async function receiveSecondDeviceProfile(epoch, onStart, presetCode) {
  if (!core.addAccountWithBackup) {
    toast("Second-device setup is not available on this backend");
    return false;
  }
  const code = presetCode?.trim() || await acquireCode({
    title: "Receive a profile",
    hint: "Scan or paste the code shown on the other device (DCBACKUP2:…). A copy of that profile is created here; the other device stays signed in.",
    // Core backup QRs are "DCBACKUP" + version digits + ":" (qr.rs:455) —
    // e.g. DCBACKUP2:<token>&<addr>. Don't require a bare "dcbackup:".
    validate: c => (/^dcbackup\d*:/i.test(c.trim()) ? null : "That doesn't look like a second-device code"),
  });
  if (!code || !accountIsCurrent(epoch)) return false;
  onStart?.();

  const stepsBody = document.createElement("div");
  stepsBody.innerHTML = `<ul class="ob-steps" data-steps></ul>`;
  showModal({ title: "Receiving profile", body: stepsBody });
  const stepsEl = stepsBody.querySelector("[data-steps]");
  const addStep = (text) => {
    stepsEl.querySelectorAll("li.active").forEach(li => { li.classList.remove("active"); li.classList.add("done"); });
    const li = document.createElement("li");
    li.className = "active";
    li.innerHTML = `<span class="step-ico"></span><span>${escapeHtml(text)}</span>`;
    stepsEl.appendChild(li);
    return li;
  };
  const finishSteps = (ok_) => {
    stepsEl.querySelectorAll("li.active").forEach(li => { li.classList.remove("active"); li.classList.add(ok_ ? "done" : "failed"); });
  };

  addStep("Preparing this device…");
  let seenProgress = false;
  const progHandler = (e) => {
    const p = e.detail?.progress || 0;
    if (p >= 1000) {
      finishSteps(true);
      addStep("Profile received — signing in");
      toast("Profile received");
      core.removeEventListener("imex-progress", progHandler);
    } else if (p > 0) {
      seenProgress = true;
      addStep(`Receiving profile… ${Math.round(p / 10)}%`);
    } else if (seenProgress) {
      finishSteps(false);
      addStep("Transfer failed");
      core.removeEventListener("imex-progress", progHandler);
    }
  };
  core.addEventListener("imex-progress", progHandler);
  try {
    const qrInfo = await core.checkQr?.(code)?.catch?.(() => null);
    if (qrInfo?.kind && qrInfo.kind !== "backup2") throw new Error("This code is not a second-device code");
    // Returns once the fresh account is selected; the transfer itself
    // reports via ImexProgress (it can take minutes).
    await core.addAccountWithBackup(code.trim());
  } catch (err) {
    core.removeEventListener("imex-progress", progHandler);
    finishSteps(false);
    addStep("Transfer failed: " + (err?.message || err));
    return false;
  }
  return true;
}

// Second-device setup (backup transfer): this device shows a QR and waits,
// or receives a profile from another device's QR.
async function secondDeviceFlow() {
  if (state.accountChanging) return;
  if (!core.provideBackup || !core.getBackupQrSvg || !core.addAccountWithBackup) {
    toast("Second-device setup is not available on this backend");
    return;
  }
  const epoch = core.accountEpoch;
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="p2p-hint">Move this profile to a new device, or receive a profile from another one. Both devices must be on the same network.</p>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
      <button class="btn-text btn-primary" data-old>Show QR on this device</button>
      <button class="btn-text" data-new>Receive a profile on this device…</button>
    </div>
    <div data-pane></div>`;
  let started = false;
  let progHandler = null;
  const cleanup = () => {
    if (progHandler) { core.removeEventListener("imex-progress", progHandler); progHandler = null; }
    if (started) core.stopOngoingProcess?.().catch?.(() => {});
  };
  const { close } = showModal({ title: "Add a second device", body, onClose: cleanup });
  const pane = body.querySelector("[data-pane]");

  body.querySelector("[data-old]").addEventListener("click", () => {
    if (!accountIsCurrent(epoch)) return;
    started = true;
    pane.innerHTML = `
      <div class="qr-box" style="margin-top:10px"><div class="qr-loading">Preparing QR…</div></div>
      <div class="p2p-hint" style="opacity:.6">On the new device, tap "Receive a profile on this device" and scan or paste this code. Keep both devices on this screen until the transfer finishes.</div>
      <div style="margin-top:8px"><button class="btn-text" data-cancel>Cancel</button></div>`;
    progHandler = (e) => {
      if ((e.detail?.progress || 0) >= 1000) transferDone();
    };
    core.addEventListener("imex-progress", progHandler);
    const transferDone = () => {
      if (!accountIsCurrent(epoch)) return;
      cleanup();
      toast("Profile transferred to the second device");
      close();
    };
    // Blocks server-side until a device retrieves the backup; it can outlive
    // the RPC timeout — completion is detected via ImexProgress above.
    core.provideBackup().then(transferDone).catch(() => {});
    body.querySelector("[data-cancel]").addEventListener("click", () => close());
    core.getBackupQrSvg().then((svg) => {
      if (accountIsCurrent(epoch)) {
        pane.querySelector(".qr-box").innerHTML = svg;
        // The card reserves a clear circle at 50% / 43.65% — same overlay
        // as the invite QR.
        pane.querySelector(".qr-box").insertAdjacentHTML("beforeend",
          `<div class="qr-self"><img src="./icons/v-logo.svg" alt=""></div>`);
      }
    }).catch((err) => {
      if (accountIsCurrent(epoch)) pane.querySelector(".qr-box").innerHTML =
        `<div class="qr-loading">Couldn't prepare the transfer:<br>${escapeHtml(String(err?.message || err))}</div>`;
    });
  });

  body.querySelector("[data-new]").addEventListener("click", () => {
    if (!accountIsCurrent(epoch)) return;
    receiveSecondDeviceProfile(epoch, () => { started = true; });
  });
}

/* ---------------- boot ---------------- */async function boot() {
  try {
    appLog("boot: getAccount");
    // Android 13+ needs a runtime grant for notifications; feature-detected
    // and once-per-boot. Declining is fine — notifications just stay off.
    // The plugin's promise can hang when the dialog was dismissed earlier —
    // never let it block boot.
    try {
      await Promise.race([
        window.__TAURI__?.notification?.requestPermission?.(),
        new Promise(r => setTimeout(r, 2500)),
      ]);
    } catch {}
    // The core may still be warming up right after a restart — retry before
    // giving up: a dead getAccount must not abort boot into a dead UI.
    // Each attempt gets its own 15s ceiling so a wedged RPC cycles the loop
    // (and logs) instead of leaving the splash silent for minutes.
    let account = null;
    for (let attempt = 1; attempt <= 3 && !account; attempt++) {
      try {
        account = await Promise.race([
          core.getAccount(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("getAccount timed out (15s)")), 15000)),
        ]);
      } catch (err) {
        diagnostics.append("error", `getAccount attempt ${attempt} failed: ${err?.message || err}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!account) {
      diagnostics.append("error", "Core is not responding — setup stays on screen, the log above has the details");
      return;
    }
    state.account = account;
    appLog(`boot: account ${state.account.addr} configured=${state.account.configured}`);

    // Splash: setup actions when unconfigured; gone once a profile is ready.
    if (core.configureWithCredentials && state.account.configured === false) splashSession?.showActions();
    else splashSession?.hide();

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
      onOpenChat: id => openChat(Number(id)),
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

    core.addEventListener("incoming-msg", ev => {
      scheduleChatListRefresh();
      const msg = ev?.detail?.msg;
      notifyIncoming(
        msg?.fromContact?.name || msg?.fwdFrom || "New message",
        (msg?.text || "").replace(/\s+/g, " ").slice(0, 120) || "New message",
      );
    });
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
