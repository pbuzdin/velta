// app.js — Velta bootstrap: chat list, navigation, modals, PWA
import { createCore } from "./transport.js";
import "./components.js";
import { escapeHtml, escapeAttr } from "./components.js";
import { chatCategoryOf, swipeCategoryStep, batteryReactionPlan } from "./rpc-core.js";
import { fileUrl, setWasmBlobReader } from "./media.js";
import { buildAvatarSvg, setFingerprintSource, fingerprintFor, fingerprintGroups } from "./avatar.js";
import { ChatView, setAvatarProfileOpener } from "./chat-view.js";
import { initCalls } from "./calls.js";
import { initWebxdc } from "./webxdc-manager.js";
import { diagnosticsSink, DiagnosticsStore, DIAGNOSTICS_CHAT_ID, diagnosticRow, isSendFailureDiagnostic, createRelaySendErrorState } from "./diagnostics.js";
import { parseInviteLink, inviteLabel, bindInviteInterception, showInviteDomainsModal, isShortInviteLink, expandShortInvite } from "./invites.js";
import { activeWsRelay, addWsRelay, listWsRelays, normalizeHost, probeC3Relay, showWsRelaysModal, useWsRelay } from "./ws-relays.js";
import { buildDrawer, showModal, showContextMenu, toast, closeAllPopups, confirmModal, showInvite, showEditProfile, notifyIncoming, setCoreVersionDisplay, checkForUpdate, popoverSupported } from "./ui.js";
import { p2pAvailable, p2pEnabled, setP2pEnabled, pairNearbyFlow, showInviteModal, addContact, showCreateGroupModal, showAddMembersModal } from "./p2p.js";
import { withLocalChat, hubModel, renameDevice, removePeer, dismissLocalGroup, groupRename, groupRemoveMember, peerGroupImpact, groupActionsModel, groupMemberHint, removePeerImpactText, lcQueueItems, retryQueuedItem, cancelQueuedItem } from "./local-chat.js";
import { timeAgo, formatBytes, timeTag } from "./format.js";
import { acquireCode, mountScanner } from "./qr-scan.js";
import { scanTabAvailable, canShareLink, copyLink, shareLink, classifyScannedCode } from "./qr-actions.js";
import { parseSharePayload, shareTextIfUnconsumed, sharePlan, createShareInbox, buildSharePicker } from "./share-in.js";
import { linkPreviewMode, setLinkPreviewMode, LINK_PREVIEW_LABELS } from "./link-preview.js";
import { wrapIdentityBundle, unwrapIdentityBundle, buildIdentityBundle, bytesToBase64, base64ToBytes, backupDownloadName, gzipBytes } from "./identity-backup.js";

const diagnostics = new DiagnosticsStore();
window.__veltaDiagnostics = diagnostics;

// Error toast that ALSO lands in the Diagnostics chat (see chat-view.js).
function errToast(text, ms = 3000) {
  diagnosticsSink.append("error", text);
  toast(text, ms);
}
let core = null;
let diagnosticsOpen = false;
// Live-update gate for the open Diagnostics chat (pause button in its action
// bar): events keep being recorded into the store while paused, only the
// rendering freezes; resuming re-renders to catch up.
let diagnosticsPaused = false;
const DIAG_ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M9 5.5v13M15 5.5v13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const DIAG_ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.2l11 6.8-11 6.8z" fill="currentColor"/></svg>';
let chatView = null;
let calls = null;
let coreStartupPromise = null;
// Declared at the top: scheduleChatListRefresh() is reachable from the
// diagnostics "changed" listener while the module is still evaluating (the
// top-level await below yields to events), so these must not live further
// down — `let` declarations would still be in their temporal dead zone.
let chatListRefreshTimer = null;
let chatListInFlight = null;
// Incremental chat list (issue #25): what changed since the last refresh,
// fed by the core's ChatlistChanged / ChatlistItemChanged events, and the
// mapped items of the last refresh (per account epoch).
let chatListDirty = { all: true, order: false, ids: new Set() };
let chatItemCache = null; // { epoch, ids: number[], byId: Map<id, chat|null> }
let diagnosticsRowTimer = null;
let chatNavigation = 0;
let drawer = null;
let accountRefreshPromise = Promise.resolve();
// Bottom action bar visibility (menu is always visible) + which side view
// the chat-list container currently shows: chats | contacts | calls | qr.
const BAR_HIDDEN_KEY = "velta-bar-hidden";
let barHidden = (() => {
  try { return JSON.parse(localStorage.getItem(BAR_HIDDEN_KEY)) || []; }
  catch { return []; }
})();
// #75 category bar visibility — "all" is always on, these are the rest.
const CATS_HIDDEN_KEY = "velta-cats-hidden";
let catsHidden = (() => {
  try { return JSON.parse(localStorage.getItem(CATS_HIDDEN_KEY)) || []; }
  catch { return []; }
})();
let listView = "chats";
// Search screen internal tab: "search" (default, what the head button opens)
// or "archived" (the folder folded into the search screen as a second tab).
// QR screen state (#37): active tab and the live camera scanner, if any.
let qrTab = "mine";
let qrScanner = null;
let searchScreenTab = "search";
let archivedCount = 0; // archived-folder button visibility (issue #13)
const CALL_LOG_KEY = "velta-call-log";
const state = {
  account: null,
  accountChanging: false,
  accounts: [],  // all core profiles, for the drawer account switcher
  chats: [],
  activeChatId: null,
  query: "",
  theme: localStorage.getItem("dw-theme") || "auto",
  // #57 category bar: active chip + lazy contact bot flags (P/B split).
  chatCategory: localStorage.getItem("velta-chat-category") || "all",
  contactBots: null, // null = not loaded; Map contactId -> bool once fetched
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
  // Single choke point for every render path (open, live "changed" events,
  // resume): while paused the chat shows a frozen snapshot — the store keeps
  // recording, resuming re-renders to catch up.
  if (!diagnosticsOpen || diagnosticsPaused) return;
  const history = $("history");
  if (!history) return;
  const scroll = $("history-scroll");
  // Preserve the user's scroll position: follow the tail only when they are
  // already at (or near) the bottom — otherwise a burst of events yanks the
  // view away mid-read.
  const pinned = !scroll ||
    scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  history.replaceChildren(...diagnostics.messages.map(diagnosticRow));
  if (pinned) {
    requestAnimationFrame(() => {
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    });
  }
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
    diagnostics.append("info", "Core restart requested during startup");
    if (!core) {
      diagnostics.append("warning", "Core is still starting; reloading the UI to retry initialization");
      setTimeout(() => location.reload(), 150);
      return;
    }
    try {
      if (!core.restartIo) throw new Error("Core restart is unavailable for this backend");
      await core.restartIo();
      diagnostics.append("info", "Core restarted successfully");
      toast("Core restarted");
    } catch (error) {
      diagnostics.append("error", `Core restart failed: ${error?.message || error}`);
      errToast(`Core restart failed: ${error?.message || error}`, 5000);
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
      errToast(`Reconnect failed: ${error?.message || error}`, 5000);
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
  // #98: no chat session is open now, so the back-swipe's _isCurrent() check
  // could never pass — mark the surface as externally owned so swiping left
  // still closes back to the chat list.
  if (chatView) chatView.externalSurface = true;
  state.activeChatId = DIAGNOSTICS_CHAT_ID;
  $("no-chat").hidden = true;
  $("chat-view").hidden = false;
  document.querySelector(".app").classList.add("chat-open");
  const head = document.createElement("velta-chat-head");
  head.setData(diagnostics.getChat());
  $("chat-head-info").replaceChildren(head);
  $("chat-head-actions").style.visibility = "hidden";
  $("main-composer").hidden = true;
  $("diagnostic-actions").hidden = false;
  $("reply-preview").hidden = true;
  // Logging / DevTools switches reflect their runtime state on every open —
  // the persisted flag is the source of truth, the checkbox follows.
  const loggingSw = $("sw-logging");
  const devtoolsSw = $("sw-devtools");
  if (loggingSw) {
    // Default OFF (V-09/#66) on both sides of the gate.
    loggingSw.checked = localStorage.getItem("velta-logging") === "1";
    if (!loggingSw.dataset.bound) {
      loggingSw.dataset.bound = "1";
      loggingSw.addEventListener("change", () => {
        const on = loggingSw.checked;
        localStorage.setItem("velta-logging", on ? "1" : "0");
        const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
        invoke?.("set_logging_enabled", { enabled: on }).catch?.(() => {});
        diagnostics.append("info", `Shell logging ${on ? "enabled" : "disabled"} — velta.log ${on ? "resumes" : "is frozen"} (Diagnostics chat keeps working)`);
      });
    }
  }
  if (devtoolsSw && !devtoolsSw.dataset.bound) {
    devtoolsSw.dataset.bound = "1";
    devtoolsSw.addEventListener("change", async () => {
      const on = devtoolsSw.checked;
      const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
      try {
        await invoke?.("set_devtools", { enabled: on });
        diagnostics.append("info", on
          ? "DevTools enabled — desktop: inspector window; Android: chrome://inspect over USB"
          : "DevTools disabled");
      } catch (err) {
        devtoolsSw.checked = !on;
        diagnostics.append("error", `DevTools toggle failed: ${err?.message || err}`);
      }
    });
  }
  const pauseBtn = $("btn-diag-pause");
  if (pauseBtn && !pauseBtn.dataset.bound) {
    pauseBtn.dataset.bound = "1";
    pauseBtn.addEventListener("click", () => {
      diagnosticsPaused = !diagnosticsPaused;
      pauseBtn.innerHTML = diagnosticsPaused ? DIAG_ICON_PLAY : DIAG_ICON_PAUSE;
      const label = diagnosticsPaused ? "Resume diagnostics" : "Pause diagnostics";
      pauseBtn.title = label;
      pauseBtn.setAttribute("aria-label", label);
      pauseBtn.setAttribute("aria-pressed", String(diagnosticsPaused));
      // The store keeps recording while paused — the marker row below lands
      // in the frozen snapshot and becomes visible on resume.
      diagnostics.append("info", diagnosticsPaused
        ? "Diagnostics updates paused (events keep being recorded)"
        : "Diagnostics updates resumed");
      if (!diagnosticsPaused) renderDiagnosticsMessages();
    });
  }
  renderDiagnosticsMessages();
  if (history.state?.velta !== "chat") history.pushState({ velta: "chat", chatId: DIAGNOSTICS_CHAT_ID }, "");
  renderChatList();
}

diagnostics.addEventListener("changed", () => {
  if (diagnosticsPaused) return; // frozen snapshot; the resume click re-renders
  renderDiagnosticsMessages();
  // Only the Diagnostics row's preview changed: patch it locally (coalesced)
  // — diagnostics appends fire per core event during sync, and a chat-list
  // refetch per append re-read every chat from the core (#25).
  if (core) scheduleDiagnosticsRowUpdate();
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
  // When the growth is the Diagnostics chat refilling its ring, name the
  // actual noise — the last few row texts say WHAT flooded the sink.
  let suffix = "";
  if ((census["div.msg-row.service"] || 0) >= 100) {
    const last = window.__veltaDiagnostics?.messages?.slice(-3).map(m => m.text).join(" | ");
    if (last) suffix = " Last rows: " + last.slice(0, 300);
  }
  diagnosticsSink.append("warning",
    `DOM budget: +${growth} nodes in 10 min (${sample.nodes} total, history rows ${sample.rows}). Top: ${top}${suffix}`);
}, 60000);

renderInitialDiagnosticsChat();
bindEarlyRecoveryActions();

// Apply the persisted Diagnostics logging switch at boot (default OFF,
// V-09/#66). js_log gates itself, so this fires before the core connects
// and there is no window where an early log line escapes the gate.
if (window.__TAURI__) {
  const invoke = window.__TAURI__.core?.invoke || window.__TAURI__.invoke;
  invoke?.("set_logging_enabled", { enabled: localStorage.getItem("velta-logging") === "1" })?.catch?.(() => {});
}

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
    listen("velta-sidecar-status", ev => applySidecarStatus(ev.payload));
    invoke("get_sidecar_status").then(applySidecarStatus).catch(() => {});
    // UnifiedPush: the shell confirms the distributor endpoint was applied to
    // the core. Per-relay acceptance surfaces separately as core Info/Warning
    // events ("Transport N: push notifications registered — …" / "relay did
    // not accept the push token", core patch #13) via onDiagnostic.
    listen("velta-push", () => {
      diagnostics.append("info", "UnifiedPush: push endpoint registered with the distributor");
    });
  } catch (e) {
    console.warn("[velta] sidecar status setup failed:", e);
  }
}

// The splash is created on demand: boot shows it only when the account is
// unconfigured (setup screen) or the core failed to answer (log surface).
// Returning users with a configured profile never see it.
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

try {
  core = withLocalChat(await coreStartupPromise);
  setFingerprintSource((contactId) => core.getContactEncryptionInfo(contactId), core.accountId);
} catch (error) {
  diagnostics.append("error", `Core startup crashed: ${error?.message || error}`);
  diagnostics.append("warning", "Continuing in demo mode so diagnostics and recovery controls remain available");
  const { MockCore } = await import("./mock-core.js");
  core = withLocalChat(new MockCore());
  core.backend = { kind: "mock", label: "demo mode (startup failure)", connected: false };
}
// createCore has a bounded handshake, but keep the UI honest if a future
// backend violates that contract. A startup failure must never leave the
// initial "connecting…" pill spinning indefinitely.
if (!core) {
  diagnostics.append("error", "Core startup returned no backend");
  const { MockCore } = await import("./mock-core.js");
  core = withLocalChat(new MockCore());
  core.backend = { kind: "mock", label: "demo mode (no local core)", connected: false };
}
if (core?.transport?.readCoreFile) setWasmBlobReader((path) => core.transport.readCoreFile(path));
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
  // #102: send failures also raise the relay line's transient "sending
  // delayed" state; the toast is throttled inside (error-level only).
  if (isSendFailureDiagnostic(level, message)) {
    const r = relaySendErrorState.note(level);
    if (r.raised) renderRelayLine();
    if (r.toast) toast("Sending delayed — the relay is retrying in the background", 6000);
  }
});

// #28: pause the core's IMAP/SMTP loops while the device has no network
// (airplane mode / no interface) instead of hammering relays into retry
// storms; resume with a maybe_network nudge when connectivity returns.
// Boot-synced too, so starting Velta offline never arms the loops. Mock
// cores have no setNetworkIo — optional call is a no-op there.
addEventListener("online", () => core?.setNetworkIo?.(true));
addEventListener("offline", () => core?.setNetworkIo?.(false));
if (!navigator.onLine) core?.setNetworkIo?.(false);

// #83: low-battery marker. When the drawer switch is on and the phone is
// under 10% and off the charger, every outgoing message moves the 🪫
// reaction to itself; when the state ends the marker is removed. Best
// effort — a failure here never surfaces as a send error. Battery comes
// from the shell (JNI, Battery.kt); the JS Battery API is dead in modern
// Chromium, so there is no renderer fallback.
const BATTERY_LOW_PCT = 10;
let batteryCache = { at: 0, value: null };
async function queryBattery() {
  const now = Date.now();
  if (now - batteryCache.at < 30000) return batteryCache.value;
  let value = null;
  try {
    const raw = await window.__TAURI__?.core?.invoke?.("get_battery_status");
    if (typeof raw === "string" && raw.includes("|")) {
      const [level, charging] = raw.split("|");
      value = { level: Number(level), charging: charging === "true" };
    }
  } catch { value = null; }
  batteryCache = { at: now, value };
  return value;
}
async function batteryGate(chatId, sentMsgId) {
  const enabled = localStorage.getItem("velta-low-battery-react") === "1";
  const bat = enabled ? await queryBattery() : null;
  const low = !!(bat && !bat.charging && bat.level >= 0 && bat.level <= BATTERY_LOW_PCT);
  const plan = batteryReactionPlan(sentMsgId, core.lowBatteryReactedId || null, low);
  if (plan.clear) await core.clearReaction?.(plan.clear);
  if (plan.add) await core.addReaction?.(chatId, plan.add, "🪫");
  if (plan.add) core.lowBatteryReactedId = plan.add;
  else if (plan.clear) core.lowBatteryReactedId = null;
}
core._batteryGate = (chatId, msgId) => { batteryGate(chatId, msgId).catch(() => {}); };

function accountIsCurrent(epoch) {
  return !state.accountChanging && epoch === core.accountEpoch;
}

core.addEventListener("account-changing", () => {
  state.accountChanging = true;
  clearTimeout(chatListRefreshTimer);
  chatListRefreshTimer = null;
  chatListInFlight = null;
  chatItemCache = null;
  chatListDirty = { all: true, order: false, ids: new Set() };
  state.chats = [];
  state.query = "";
  closeChatUI();
  closeAllPopups();
  // Side views (search, contacts, archived, …) hold the old profile's rows
  // and renderChatList skips them — return to the plain chat list so no stale
  // row stays tappable; account-changed refills it for the new profile.
  if (listView !== "chats") setListView("chats");
  if (history.state?.velta === "chat") history.replaceState(null, "");
  drawer?.el.remove();
  drawer?.overlayEl?.remove();
  drawer = null;
});
core.addEventListener("account-changed", () => {
  state.accountChanging = false;
  setFingerprintSource(contactId => core.getContactEncryptionInfo(contactId), core.accountId);
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

addEventListener("velta-core-status", e => {
  if (core.backend) core.backend.connected = !!e.detail.connected;
  // A reconnect loses whatever events were emitted mid-flight — MsgDelivered
  // among them, leaving the sending dashes stuck. Ask the core what actually
  // happened to the pending sends.
  if (e.detail.connected) core.reconcileSending?.();
});

/* ---------------- relay status line ---------------- */
// Thin strip at the top of the chat list reflecting the chatmail relay:
// green connected, yellow connecting/retrying, red unreachable,
// blue local-chat mode (no relay in play). Animated dashes while a
// message is on its way to the relay.
let relayConnectivity = null;  // last get_connectivity value (1000/2000/3000/4000)
let relayDownSince = 0;        // first NotConnected observation — red after a grace period
let relaySending = false;      // any message queued/sending through the relay
const relaySendErrorState = createRelaySendErrorState(); // #102 "sending delayed" while SMTP retries
let relayUpgradeTimer = null;
let relaySegments = [];        // per-relay [{ domain, text, state }] — [] falls back to the combined view
let relaySmtpState = null;     // "ok"/"connecting"/"down" from the HTML's Outgoing-messages dot (account-global)
let relaySmtpVia = null;       // #79: addr the SMTP loop is bound to (core patch) — the real sending relay
// New-connection reachability per relay domain. The core's dot only reflects
// the LAST session state: while an established IMAP session survives, the
// dot stays green even when the relay refuses new connections (seen live:
// d13.buro.dev dead for new TLS but the core reported "Connected" for hours).
// probe_relay does a real TLS request shell-side — what fails exactly when a
// NEW connection can't be established, which is what the core's dot can't
// tell us. #76
const relayProbeCache = new Map(); // domain(lowercase) -> { ts, ok, pending? }
const RELAY_PROBE_MIN_GAP_MS = 60000;

async function probeRelayReachable(domain) {
  // Shell-side probe (probe_relay): renderer fetch is CSP-bound and a bare
  // TCP connect lies behind a fake-IP VPN. Without the shell (dev rigs) there
  // is no signal — assume reachable rather than paint false alarms.
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  if (!invoke) return true;
  try {
    return !!(await invoke("probe_relay", { domain }));
  } catch {
    return false;
  }
}

function scheduleRelayProbes(segs) {
  if (core.backend?.kind === "mock") return;
  for (const s of segs) {
    const d = String(s.domain || "").toLowerCase();
    if (!d) continue;
    const c = relayProbeCache.get(d);
    if (c?.pending || (c && Date.now() - c.ts < RELAY_PROBE_MIN_GAP_MS)) continue;
    const entry = { pending: true, failedSince: c?.ok === false ? (c.failedSince || c.ts) : undefined };
    relayProbeCache.set(d, entry);
    probeRelayReachable(d).catch(() => false).then(ok => {
      entry.ok = ok;
      entry.ts = Date.now();
      entry.pending = false;
      if (ok) delete entry.failedSince;
      else if (entry.failedSince == null) entry.failedSince = entry.ts;
      if (core.backend?.kind !== "mock") renderRelayLine();
    });
  }
}
const RELAY_DOWN_AFTER_MS = 45000;

// A relay that keeps refusing new connections is "offline", not "connecting"
// — amber for days reads as a live problem. The probe is ground truth (the
// core's dot can stay green off a zombie session for hours, #76); the grace
// period keeps short blips amber and only then drops to the calmer grey.
const RELAY_OFFLINE_AFTER_MS = 10 * 60 * 1000;
function relaySegmentDisplayState(state, probe, now = Date.now()) {
  if (probe?.ok !== false) return state;
  const since = probe.failedSince || probe.ts;
  if (since && now - since >= RELAY_OFFLINE_AFTER_MS) return "offline";
  return state === "ok" ? "unreachable" : state;
}

// The core exposes per-transport status only inside its connectivity HTML
// page: one <li class="transport[ unpublished]"> per relay, each folder
// rendered as `<span class="(green|red|yellow|grey) dot"></span> <b>domain:</b>
// text`. Worst dot color wins per relay.
// 🐴 ceiling: parsing the core's HTML page — upgrade path is a dedicated
// per-transport connectivity/quota JSON-RPC in the core.
function parseConnectivityHtml(html) {
  const out = [];
  const weight = { red: 3, yellow: 2, grey: 1, green: 0 };
  const stateFor = { green: "ok", yellow: "connecting", grey: "connecting", red: "down" };
  // The transport <li>s nest a quota <ul><li>, so match each transport from
  // its opening tag to the next one (or the end of the transports section,
  // i.e. the next <h3> / </body>) instead of the first </li>.
  const start = html.indexOf('<li class="transport');
  if (start < 0) return { segs: out, smtpState: null };
  let end = html.indexOf("<h3>", start + 1);
  if (end < 0) end = html.indexOf("</body>", start);
  const block = html.slice(start, end < 0 ? undefined : end);
  for (const m of block.matchAll(/<li class="transport( unpublished)?">([\s\S]*?)(?=<li class="transport|$)/g)) {
    if (m[1]) continue; // unpublished relay — phasing out, not a live transport
    const colors = [...m[2].matchAll(/class="(red|green|yellow|grey) dot"/g)].map(c => c[1]);
    if (!colors.length) continue;
    // The core writes the colon inside the bold tag ("<b>domain:</b>") — strip it.
    const domain = ((m[2].match(/<b>([^<]+)<\/b>/) || [])[1] || "relay").replace(/:\s*$/, "");
    const text = (m[2].split(/<\/b>/i)[1] || "").split(/<br/i)[0].replace(/<[^>]*>/g, "").trim();
    // Quota section (quota-list): usage/limit line(s) plus the percent from
    // the progress bar, tag-stripped — e.g. "1.3 GiB of 2 GiB used 67%".
    const quotaEl = m[2].match(/<ul class="quota-list">([\s\S]*?)<\/ul>/);
    const quota = quotaEl ? quotaEl[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
    colors.sort((a, b) => weight[b] - weight[a]);
    out.push({ domain, text, state: stateFor[colors[0]] || "connecting", quota });
  }
  // The core renders SMTP ("Outgoing messages") OUTSIDE the transport <li>s,
  // so its dot is invisible to the per-transport loop above — a dead SMTP
  // leg would leave every seg green. It is the last span-dot in the document.
  const dots = [...html.matchAll(/<span class="(red|green|yellow|grey) dot"/g)];
  const smtpState = dots.length ? (stateFor[dots[dots.length - 1][1]] || null) : null;
  // #79: the core (Velta patch) reports the transport the SMTP loop is
  // actually bound to — failover may differ from the "Use for sending" pin.
  const smtpVia = (html.match(/<span class="smtp-via">([^<]+)<\/span>/) || [])[1] || null;
  return { segs: out, smtpState, smtpVia };
}

// Relay-status refresh coalescing. refreshRelayStatus is driven by
// connectivity-changed, but its own get_connectivity RPCs make the core
// recompute connectivity and emit further ConnectivityChanged events, so an
// unguarded handler feeds back into itself and multiplies an event storm
// (observed live: thousands of events/s). Rule: at most one refresh in
// flight, polls at most once per gap, and everything arriving meanwhile
// collapses into a single trailing refresh.
let relayRefreshBusy = false;
let relayRefreshAgain = false;
let relayRefreshLastStart = 0;
const RELAY_REFRESH_MIN_GAP_MS = 1500;

async function refreshRelayStatus() {
  if (relayRefreshBusy) { relayRefreshAgain = true; return; }
  const wait = RELAY_REFRESH_MIN_GAP_MS - (Date.now() - relayRefreshLastStart);
  if (wait > 0) {
    if (!relayRefreshAgain) {
      relayRefreshAgain = true;
      setTimeout(() => { relayRefreshAgain = false; refreshRelayStatus(); }, wait);
    }
    return;
  }
  relayRefreshBusy = true;
  relayRefreshLastStart = Date.now();
  try {
    await refreshRelayStatusInner();
  } finally {
    relayRefreshBusy = false;
    if (relayRefreshAgain) {
      relayRefreshAgain = false;
      refreshRelayStatus();
    }
  }
}

async function refreshRelayStatusInner() {
  if (!core.getConnectivity || core.backend?.kind === "mock") return;
  const epoch = core.accountEpoch;
  try {
    const value = await core.getConnectivity();
    if (!accountIsCurrent(epoch)) return;
    relayConnectivity = value;
    // #102: the core making progress again (IMAP/SMTP working, 3000+)
    // clears the delayed-send state; a fresh failure re-raises it.
    if (value >= 3000) relaySendErrorState.clear();
    // "Updating…" strip (desktop-parity, ConnectivityToast.tsx): sweep while
    // the core is WORKING (3000-3999) — IMAP fetch or SMTP send, the core
    // can't distinguish. Reuses chat-view's bar with its 150 ms min-on and
    // no-flicker off; hidden with #chat-view when no chat is open.
    chatView?._loadBar?.(value >= 3000 && value < 4000);
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
      const parsed = parseConnectivityHtml(html);
      relaySegments = parsed.segs;
      relaySmtpState = parsed.smtpState;
      relaySmtpVia = parsed.smtpVia;
      scheduleRelayProbes(relaySegments);
      renderRelayLine();
    }
  } catch { /* per-relay view unavailable */ }
}

// Envelope marking which relay is SELECTED for sending (the account's
// configured transport, = state.account.addr's domain) — persistent, not an
// activity marker: the relay line's animated dashes stay the "messages in
// flight" signal. Static glyph on purpose; a pulse would read as activity.
const RELAY_SEND_SVG = '<svg viewBox="0 0 24 24"><rect x="2.5" y="9.5" width="19" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 11.5l8 5.5 8-5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 12V2.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M8.7 5.6L12 2.2l3.3 3.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// "cha*.uk" from "chat.example.uk": first 3 chars, one asterisk for the
// rest, TLD visible — enough to recognize the relay without printing it.
function maskRelayDomain(domain) {
  const d = String(domain || "");
  const i = d.lastIndexOf(".");
  if (i <= 0) return d ? `${d.slice(0, 3)}*` : "relay";
  return `${d.slice(0, 3)}*.${d.slice(i + 1)}`;
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
    // #102: relay up but SMTP keeps retrying — distinct "delayed" state,
    // not the red relay-down look.
    relayState = relaySendErrorState.active ? "delayed" : "ok";
    title = relaySendErrorState.active ? "Sending delayed — the relay is retrying" : "Relay connected";
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
  // only to the sending relay's segment (see effectiveSendDomain below).
  const rawSegs = relaySegments.length ? relaySegments : [{ state: relayState, text: title }];
  // Display state per segment: the core's per-session state, downgraded when
  // the reachability probe says the relay refuses NEW connections (an
  // established session can keep the core's dot green for hours), and the
  // sending relay also inherits the account-global SMTP dot (the core renders
  // SMTP outside the per-transport sections it parses).
  const SEVERITY = { ok: 0, connecting: 1, unreachable: 2, offline: 2, down: 3 };
  // #79: the SMTP loop's ACTUALLY bound transport (core patch reports it in
  // the connectivity HTML) outranks the pinned sending addr for the envelope/dashes —
  // on failover the marker follows the messages. Old cores report nothing
  // and the configured fallback stays.
  const smtpViaDomain = (relaySmtpVia || "").split("@")[1]?.toLowerCase() || null;
  const sendDomain = (state.account?.addr || "").split("@")[1]?.toLowerCase();
  const effectiveSendDomain = smtpViaDomain || sendDomain;
  const isSendRelay = s => relayState !== "local" && (
    (s.domain && s.domain.toLowerCase() === effectiveSendDomain) ||
    // A single relay is always the sending relay, even if its domain
    // couldn't be matched against the account address.
    (rawSegs.length === 1 && !effectiveSendDomain));
  const segs = rawSegs.map(s => {
    const probe = s.domain ? relayProbeCache.get(String(s.domain).toLowerCase()) : null;
    let segState = relaySegmentDisplayState(s.state, probe);
    if (isSendRelay(s) && relaySmtpState && (SEVERITY[relaySmtpState] ?? 0) > (SEVERITY[segState] ?? 0)) {
      segState = relaySmtpState;
    }
    // #102: delayed-send marker rides the sending relay's green segment only
    // — never masks connecting/down/unreachable.
    if (isSendRelay(s) && relaySendErrorState.active && (SEVERITY[segState] ?? 0) === 0) {
      segState = "delayed";
    }
    return { ...s, state: segState };
  });
  if (relaySending && relayState !== "local") {
    const segDomains = segs.map(s => s.domain || "—");
    const matched = segs.some(s => s.domain && s.domain.toLowerCase() === effectiveSendDomain);
    diagnosticsSink.append("info", `relay: sending via ${effectiveSendDomain || "?"}${smtpViaDomain && smtpViaDomain !== sendDomain ? " (failover)" : ""}; segments [${segDomains.join(", ")}]${matched ? "" : " — NO domain match"}`);
  }
  const segTitle = s => {
    const base = s.domain ? `${s.domain}: ${s.text}` : (s.text || title);
    if (s.state === "unreachable") return `${base} — not accepting new connections (web check failed)`;
    if (s.state === "offline") return `${base} — offline (not accepting connections for a while)`;
    return base;
  };
  el.replaceChildren(...segs.map((s, i) => {
    const seg = document.createElement("span");
    seg.className = "relay-seg";
    seg.dataset.state = s.state;
    if (relaySending && isSendRelay(s)) seg.setAttribute("data-sending", "");
    seg.title = segTitle(s);
    return seg;
  }));
  el.dataset.state = relayState;
  if (relaySending && relayState !== "local") el.setAttribute("data-sending", "");
  else el.removeAttribute("data-sending");
  el.title = title;
  el.setAttribute("aria-label", title);

  // Detail chips (hover / pull-down reveal): one chip per relay-line segment,
  // equal widths so each chip sits above its own segment — masked domain plus
  // the quota percent ("cha*.uk · 55%"). The send relay carries an envelope
  // colored by SMTP-loop health (green ok, amber retrying, red broken, grey
  // = old core without the #79 patch). The unmasked domain, status and full
  // quota line ride the title tooltip.
  const detail = document.getElementById("relay-detail");
  if (detail) {
    detail.replaceChildren(...segs.map(s => {
      const chip = document.createElement("span");
      chip.className = "relay-detail-chip";
      chip.dataset.state = s.state;
      if (isSendRelay(s)) {
        chip.setAttribute("data-sending", "");
        const ico = document.createElement("span");
        ico.className = "relay-detail-send";
        ico.innerHTML = RELAY_SEND_SVG; // static constant, no data
        ico.dataset.smtp = relaySmtpState === "ok" ? "ok"
          : relaySmtpState === "down" ? "down"
          : relaySmtpState === "connecting" || relaySendErrorState.active ? "retrying"
          : "unknown";
        chip.append(ico);
      }
      const label = document.createElement("span");
      label.className = "relay-detail-label";
      label.append(maskRelayDomain(s.domain));
      const pct = Number((String(s.quota || "").match(/(\d+)\s*%/) || [])[1]);
      if (Number.isFinite(pct)) {
        // The <meter> went away — the % text carries the warning color itself
        // (same thresholds the meter's low/high had).
        const p = document.createElement("span");
        p.className = "relay-pct";
        p.dataset.level = pct > 90 ? "full" : pct >= 70 ? "high" : "ok";
        p.textContent = ` · ${pct}%`;
        label.append(p);
      } else if (s.text) {
        label.append(` · ${s.text}`);
      }
      chip.append(label);
      chip.title = `${segTitle(s)}${s.quota ? ` · ${s.quota}` : ""}${isSendRelay(s) && relaySendErrorState.active ? " · sending delayed — retrying" : ""}`;
      return chip;
    }));
  }
}

// Mobile: pulling down at the top of the chat list reveals the detail bar
// (pull-to-refresh gesture); it hides itself again after a few seconds.
const chatListEl = document.getElementById("chat-list");
const relayDetailEl = document.getElementById("relay-detail");

// #57 (mobile only): swipe left/right on the list steps through the category
// chips. Axis-locked — a gesture only counts when it is clearly horizontal,
// so vertical scrolling and the pull-to-refresh zone are untouched. On a
// recognized swipe the follow-up click is swallowed: switching re-renders the
// list, and at either end of the chip row a swipe must not open a chat.
if (chatListEl && typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) {
  let swipeX0 = null, swipeY0 = null, swipeId = null;
  let swipeMoved = false;
  chatListEl.addEventListener("click", e => {
    if (swipeMoved) { e.stopPropagation(); e.preventDefault(); swipeMoved = false; }
  }, true);
  chatListEl.addEventListener("touchstart", e => {
    swipeMoved = false;
    if (e.touches.length !== 1) { swipeX0 = null; return; }
    swipeX0 = e.touches[0].clientX;
    swipeY0 = e.touches[0].clientY;
    swipeId = e.touches[0].identifier;
  }, { passive: true });
  chatListEl.addEventListener("touchmove", e => {
    if (swipeX0 == null || e.touches.length !== 1 || listView !== "chats") return;
    const t = [...e.touches].find(t => t.identifier === swipeId);
    if (!t) return;
    const step = swipeCategoryStep(t.clientX - swipeX0, t.clientY - swipeY0);
    if (swipeMoved || !step) return;
    swipeMoved = true;
    const cats = [...(chatCatsEl?.children || [])].filter(b => !b.hidden).map(b => b.dataset.cat).filter(Boolean);
    const next = cats[cats.indexOf(state.chatCategory) + step];
    if (next) setChatCategory(next);
  }, { passive: true });
  chatListEl.addEventListener("touchend", () => { swipeX0 = null; }, { passive: true });
  chatListEl.addEventListener("touchcancel", () => { swipeX0 = null; }, { passive: true });
}

let relayPullY = null;
let relayPullTimer = null;
if (chatListEl && relayDetailEl) {
  chatListEl.addEventListener("touchstart", e => {
    relayPullY = chatListEl.scrollTop <= 0 ? e.touches[0].clientY : null;
  }, { passive: true });
  chatListEl.addEventListener("touchmove", e => {
    if (relayPullY == null || chatListEl.scrollTop > 0) return;
    if (e.touches[0].clientY - relayPullY > 32) {
      relayDetailEl.classList.add("pull-open");
      clearTimeout(relayPullTimer);
      relayPullTimer = setTimeout(() => relayDetailEl.classList.remove("pull-open"), 4000);
    }
  }, { passive: true });
  chatListEl.addEventListener("touchend", () => { relayPullY = null; }, { passive: true });
}

core.addEventListener?.("connectivity-changed", refreshRelayStatus);
// The core only emits connectivity-changed when ITS state flips; while an
// established session silently outlives a dead relay nothing fires. The slow
// poll drives the reachability probes and re-renders on their results.
setInterval(refreshRelayStatus, 60000);
core.addEventListener?.("transports-modified", () => {
  // Relay set changed — locally (2.60.0+ emits on the modifying device too)
  // or synced from another device. refreshRelayStatus is coalesced.
  refreshRelayStatus();
  document.querySelector("[data-relays-modal]")?.dispatchEvent(new CustomEvent("relays-refresh"));
});
core.addEventListener?.("send-activity", e => {
  relaySending = !!e.detail?.sending;
  renderRelayLine();
});
core.addEventListener?.("smtp-message-sent", () => {
  // #102: a send got through — the delayed state did its job.
  if (relaySendErrorState.clear()) renderRelayLine();
});
renderRelayLine();
refreshRelayStatus();

// Socket opened but the core never answered RPC → almost always an old or
// crashed service build. Say so explicitly instead of silently demo-ing.
addEventListener("velta-core-init-failed", e => {
  if (e.detail.backend === "websocket") {
    toast("Found the background service, but it didn't answer — restart the Velta Core service (or update it if it's an older build)", 6000);
  }
});

/* ---------------- theme ---------------- */
// theme: "auto" (follow the system, default) | "dark" | "light".
const themeQuery = matchMedia("(prefers-color-scheme: light)");
applyTheme();
themeQuery.addEventListener?.("change", () => {
  if (state.theme === "auto") applyTheme();
});
function applyTheme() {
  const effective = state.theme === "auto" ? (themeQuery.matches ? "light" : "dark") : state.theme;
  document.documentElement.dataset.theme = effective;
  const themeColors = { dark: "#0f0f14", brutal: "#22222b" };
  document.querySelector('meta[name="theme-color"]').content = themeColors[effective] || "#f4f4f4";
  localStorage.setItem("dw-theme", state.theme);
}

/* ---------------- chat list ---------------- */
// Event-driven refresh. refreshChatList() refetches the list from the core and
// re-renders it in place (renderChatList reuses existing <velta-chat-item>
// elements), so it is cheap — but bursts of core events (IMAP sync, markseen
// cascades) would still fire dozens of RPC round trips per second, so
// event-driven callers go through scheduleChatListRefresh() which collapses a
// burst into one trailing refresh.

function scheduleChatListRefresh(delay = 400) {
  chatListDirty.all = true;
  scheduleChatListWork(delay);
}

// Per-chat signals: only the named chat's item (chatId) or only the order
// (order: true) is stale. Falls back to a full refresh on cores that don't
// emit the fine-grained chat-list events, and while local chat is on (its
// peers are merged in by the getChatList proxy only).
function scheduleChatListUpdate({ chatId = 0, order = false } = {}, delay = 400) {
  if (!incrementalChatList()) { scheduleChatListRefresh(delay); return; }
  if (order) chatListDirty.order = true;
  else if (chatId) chatListDirty.ids.add(chatId);
  else chatListDirty.all = true; // ChatlistItemChanged without a chat: every item
  scheduleChatListWork(delay);
}

function incrementalChatList() {
  return !!core?.chatlistEvents && typeof core.getChatListIds === "function"
    && typeof core.getChatListItems === "function" && !p2pEnabled();
}

// Collapses a burst of refresh requests into one trailing refresh.
function scheduleChatListWork(delay = 400) {
  if (state.accountChanging) return;
  if (chatListRefreshTimer) return; // a trailing refresh is already pending
  chatListRefreshTimer = setTimeout(async () => {
    chatListRefreshTimer = null;
    await refreshChatList({ fromDirty: true });
  }, delay);
}

// Diagnostics appends only change the pinned Diagnostics row's preview:
// patch that row locally (coalesced) instead of refetching every chat.
function scheduleDiagnosticsRowUpdate() {
  if (diagnosticsRowTimer) return;
  diagnosticsRowTimer = setTimeout(() => {
    diagnosticsRowTimer = null;
    const i = state.chats.findIndex(c => c.id === DIAGNOSTICS_CHAT_ID);
    if (i < 0) return;
    state.chats[i] = diagnostics.getChat();
    renderChatList();
  }, 250);
}

// Report UI visibility to the Rust shell. The Android background poller
// drains core events while the page is hidden or the activity is stopped
// (Home often leaves document.hidden false and freezes the WebView). Events
// it consumed never reached the frontend, so becoming visible refetches.
function refreshAfterBackground() {
  if (!core) return;
  scheduleChatListRefresh();
  // Delivery events the background poller consumed while hidden never
  // reached the JS side — reconcile the sending-dash bookkeeping too.
  core.reconcileSending?.();
  if (state.activeChatId) chatView?.onMsgsChanged(state.activeChatId);
}
function reportUiVisible() {
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    invoke?.("set_ui_visible", { visible: !document.hidden })?.catch?.(() => {});
  } catch {}
  if (!document.hidden) refreshAfterBackground();
}
document.addEventListener("visibilitychange", reportUiVisible);
// MainActivity.onStart. visibilitychange does not fire on every resume.
try {
  const listen = window.__TAURI__?.event?.listen;
  listen?.("velta-foreground", () => refreshAfterBackground());
} catch {}

// Offline media queue tray: a chip inside the composer input wrap listing
// media that will send as soon as the peer is reachable. Rendered only for
// local chats with queued items.
function renderLcQueueTray() {
  const wrap = document.querySelector("#main-composer .composer-input-wrap");
  if (!wrap) return;
  const chatId = state.activeChatId;
  const items = chatId && String(chatId).startsWith("p2p:") ? lcQueueItems(chatId) : [];
  let chip = document.getElementById("lc-queue-chip");
  if (!items.length) { chip?.remove(); return; }
  if (!chip) {
    chip = document.createElement("button");
    chip.id = "lc-queue-chip";
    chip.type = "button";
    wrap.appendChild(chip);
    chip.addEventListener("click", e => {
      e.stopPropagation();
      toggleLcQueuePop(state.activeChatId); // read live: chip survives chat switches
    });
  }
  chip.textContent = `⏳ ${items.length}`;
  chip.title = "Offline media queued — tap to manage";
}

let lcQueueJustClosed = false;
function toggleLcQueuePop(chatId) {
  const existing = document.getElementById("lc-queue-pop");
  if (existing) { existing.remove(); return; }
  // Light-dismiss fires before the chip's click. Skip the reopen.
  if (lcQueueJustClosed) return;
  const items = lcQueueItems(chatId);
  const pop = document.createElement("div");
  pop.id = "lc-queue-pop";
  pop.innerHTML = `<div class="lq-head">Queued — sends when the device is reachable</div>` + items.map(it => `
    <div class="lq-row" data-id="${escapeAttr(it.id)}">
      <span class="lq-name">${escapeHtml(it.name || "file")}${it.size ? ` · ${formatBytes(it.size)}` : ""}</span>
      <button type="button" class="btn-text" data-lq-retry="${escapeAttr(it.id)}">Send now</button>
      <button type="button" class="btn-text" data-lq-cancel="${escapeAttr(it.id)}" aria-label="Remove from queue">✕</button>
    </div>`).join("");
  document.body.appendChild(pop);
  pop.addEventListener("click", async e => {
    const retryId = e.target.closest("[data-lq-retry]")?.dataset.lqRetry;
    const cancelId = e.target.closest("[data-lq-cancel]")?.dataset.lqCancel;
    if (retryId) {
      try { await retryQueuedItem(chatId, retryId); toast("Sending…"); }
      catch (err) { toast(String(err?.message || err)); }
      toggleLcQueuePop(chatId);
    }
    if (cancelId) { cancelQueuedItem(chatId, cancelId); toggleLcQueuePop(chatId); }
  });
  const place = () => {
    const a = document.getElementById("lc-queue-chip");
    if (!a) return;
    pop.style.right = Math.max(8, innerWidth - a.getBoundingClientRect().right) + "px";
    pop.style.bottom = Math.round(innerHeight - a.getBoundingClientRect().top + 10) + "px";
  };
  let popped = false;
  if (popoverSupported()) {
    pop.popover = "auto";
    pop.addEventListener("toggle", (e) => {
      if (e.newState !== "closed") return;
      lcQueueJustClosed = true;
      pop.remove();
      setTimeout(() => { lcQueueJustClosed = false; }, 0);
    });
    try { pop.showPopover(); popped = true; }
    catch { pop.removeAttribute("popover"); }
  }
  place();
  if (popped) return;
  const outside = ev => { if (!pop.contains(ev.target) && ev.target !== document.getElementById("lc-queue-chip")) { pop.remove(); document.removeEventListener("pointerdown", outside, true); } };
  document.addEventListener("pointerdown", outside, true);
}

// Refetches the chat list. Direct calls (after user actions) are always
// full; the debounced event path (fromDirty) refetches only what the core
// reported as changed — the order (get_chatlist_entries, cheap) and/or the
// dirty items — when the core emits fine-grained chat-list events (#25).
async function refreshChatList({ fromDirty = false } = {}) {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch, query = state.query;
  if (chatListInFlight?.epoch === epoch && chatListInFlight?.query === query) {
    // Event-driven: the dirty flags are still pending — retry after it.
    if (fromDirty) scheduleChatListWork();
    return chatListInFlight.promise;
  }
  const dirty = chatListDirty;
  chatListDirty = { all: false, order: false, ids: new Set() };
  const incremental = incrementalChatList() && !query;
  const partial = incremental && fromDirty && !dirty.all && chatItemCache?.epoch === epoch;
  const request = { epoch, query };
  chatListInFlight = request;
  request.promise = (async () => {
  try {
    let chats;
    if (partial) {
      const cache = chatItemCache;
      const ids = dirty.order ? await core.getChatListIds({}) : cache.ids;
      if (!accountIsCurrent(epoch) || chatListInFlight !== request) return;
      const need = ids.filter(id => dirty.ids.has(id) || !cache.byId.has(id));
      const fetched = need.length ? await core.getChatListItems(need) : new Map();
      if (!accountIsCurrent(epoch) || query !== state.query || chatListInFlight !== request) return;
      for (const [id, chat] of fetched) cache.byId.set(id, chat);
      if (dirty.order) {
        const listed = new Set(ids);
        for (const id of cache.byId.keys()) if (!listed.has(id)) cache.byId.delete(id);
      }
      cache.ids = ids;
      chats = ids.map(id => cache.byId.get(id)).filter(Boolean);
    } else if (incremental) {
      const ids = await core.getChatListIds({});
      const byId = ids.length ? await core.getChatListItems(ids) : new Map();
      if (!accountIsCurrent(epoch) || query !== state.query || chatListInFlight !== request) return;
      chatItemCache = { epoch, ids, byId };
      chats = ids.map(id => byId.get(id)).filter(Boolean);
    } else {
      chats = await core.getChatList({ query });
      if (!accountIsCurrent(epoch) || query !== state.query || chatListInFlight !== request) return;
      chatItemCache = null;
    }
    state.chats = [diagnostics.getChat(), ...chats.filter(chat => chat.id !== DIAGNOSTICS_CHAT_ID)];
    renderChatList();
    renderLocalChatCard();
    // Archived-folder button visibility (issue #13) — fire-and-forget count.
    // Only the number of entries is needed, not their items; and it can only
    // change together with the list order.
    if (!partial || dirty.order) {
      const count = typeof core.getChatListIds === "function"
        ? core.getChatListIds({ archived: true }).then(ids => ids.length)
        : core.getChatList({ archived: true }).then(archived => archived.length);
      count.then(n => {
        if (!accountIsCurrent(epoch)) return;
        archivedCount = n;
        syncHeaderButtons();
      }).catch(() => {});
    }
  } catch (err) {
    // A failed refresh leaves the cache unknown — the next one is full.
    chatListDirty.all = true;
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

// Local chat hub card: lives at the top of the chat list while local chat
// is on. Replaces the old hub modal — pairing/invite stay as small modals.
let lcCardSeq = 0;
let lcCardOpen = true;
let lcCardSig = null; // last rendered model — skip DOM writes when unchanged
async function renderLocalChatCard() {
  const el = $("lc-card");
  if (!el) return;
  const seq = ++lcCardSeq;
  const model = await hubModel().catch(() => null);
  if (seq !== lcCardSeq) return; // superseded by a newer render
  if (!model) { el.hidden = true; lcCardSig = null; return; }
  // Rebuild only when the model changed — chat-list refreshes fire on every
  // msg-state event and a DOM rewrite eats taps on the card's buttons.
  const sig = JSON.stringify(model);
  if (sig === lcCardSig) { el.hidden = false; return; }
  lcCardSig = sig;
  el.hidden = false;
  const wifiSvg = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M2.5 9.5a14 14 0 0119 0M5.5 13a9.5 9.5 0 0113 0M8.5 16.5a5 5 0 017 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="19.5" r="1.4" fill="currentColor"/></svg>`;
  const short = (model.device.nodeId || "").slice(0, 8);
  const peerRows = model.peers.map(p => `
    <div class="lc-row" data-open="${escapeAttr(p.id)}">
      <span class="lc-dot ${p.online ? "on" : ""}"></span>
      <span class="lc-row-name">${escapeHtml(p.name)}</span>
      ${p.queued ? `<span class="lc-row-queued">${p.queued} queued</span>` : ""}
      <button type="button" class="btn-text lc-chat" data-chat="${escapeAttr(p.id)}" title="Open chat" aria-label="Open chat with ${escapeAttr(p.name)}">Chat</button>
      <button type="button" class="btn-text lc-remove" data-remove="${escapeAttr(p.rawId || p.id)}" title="Remove device" aria-label="Remove ${escapeAttr(p.name)}">✕</button>
    </div>`).join("");
  const nearbyRows = model.nearby.map(n => `
    <div class="lc-row" data-pair="${escapeAttr(n.id)}">
      <span class="lc-dot on"></span>
      <span class="lc-row-name">${escapeHtml(n.name || n.id.slice(0, 12))}</span>
      <button type="button" class="btn-text" data-pair="${escapeAttr(n.id)}">Pair</button>
    </div>`).join("");
  const groupRows = (model.groups || []).map(g => `
    <div class="lc-row" data-open="${escapeAttr(g.id)}">
      <span class="lc-dot ${g.removed ? "" : g.online > 1 ? "on" : ""}"></span>
      <span class="lc-row-name">${escapeHtml(g.name)}</span>
      <span class="lc-row-queued">${g.removed ? "closed" : `${g.members} members · ${g.online} online`}</span>
      <button type="button" class="btn-text lc-chat" data-chat="${escapeAttr(g.id)}" title="Open group" aria-label="Open group ${escapeAttr(g.name)}">Chat</button>
    </div>`).join("");
  el.innerHTML = `
    <div class="lc-card-head${lcCardOpen ? " open" : ""}" data-toggle>
      ${wifiSvg}
      <span class="lc-card-title">Local chat</span>
      <span class="lc-card-chevron"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </div>
    <div class="lc-card-body">
      <div class="lc-device">This device: <b>${escapeHtml(model.device.name)}</b>${short ? ` <span class="lc-nodeid">(${escapeHtml(short)})</span>` : ""} <button type="button" class="btn-text" data-rename>Edit name</button></div>
      <div class="lc-actions">
        <button type="button" class="btn-text" data-invite>Show invite</button>
        <button type="button" class="btn-text" data-add>Add contact</button>
        <button type="button" class="btn-text" data-new-group>New group</button>
      </div>
      ${nearbyRows ? `<div class="lc-sec">Nearby — discovered on this network</div>${nearbyRows}` : ""}
      ${peerRows ? `<div class="lc-sec">Paired devices</div>${peerRows}` : ""}
      ${groupRows ? `<div class="lc-sec">Groups</div>${groupRows}` : ""}
    </div>`;
  if (lcCardOpen) el.classList.add("open");
  el.querySelector("[data-toggle]").addEventListener("click", () => { lcCardOpen = !lcCardOpen; el.classList.toggle("open"); });
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  const renderQr = text => core.createQrSvg(text);
  el.querySelector("[data-invite]").addEventListener("click", () => {
    if (!invoke) return toast("Pairing needs the Velta app shell");
    showInviteModal(invoke, renderQr).catch(err => toast(String(err?.message || err)));
  });
  el.querySelector("[data-add]").addEventListener("click", () => {
    if (!invoke) return toast("Pairing needs the Velta app shell");
    addContact(invoke).catch(err => toast(String(err?.message || err)));
  });
  el.querySelector("[data-new-group]").addEventListener("click", () => newLocalGroupFlow());
  el.querySelector("[data-rename]").addEventListener("click", async () => {
    const name = await askText("Device name", model.device.name, "Save");
    if (!name || !name.trim()) return;
    try {
      await renameDevice(name.trim());
      toast("Device renamed");
      renderLocalChatCard();
    } catch (err) { toast(String(err?.message || err)); }
  });
  el.querySelectorAll("[data-remove]").forEach(btn => btn.addEventListener("click", async e => {
    e.stopPropagation();
    const peerId = btn.dataset.remove;
    const name = btn.closest(".lc-row")?.querySelector(".lc-row-name")?.textContent || "this device";
    if (!(await confirmRemovePeer(peerId, name))) return;
    try {
      await removePeer(peerId);
      toast("Device removed");
      renderLocalChatCard();
      refreshChatList();
      closeVanishedGroupChat();
    } catch (err) { toast(String(err?.message || err)); }
  }));
  el.querySelectorAll("[data-pair]").forEach(btn => btn.addEventListener("click", e => {
    e.stopPropagation();
    pairNearbyFlow(invoke, btn.dataset.pair).catch(err => toast(String(err?.message || err)));
  }));
  el.querySelectorAll("[data-chat]").forEach(btn => btn.addEventListener("click", e => {
    e.stopPropagation(); // row click opens too — don't open twice
    openChat(btn.dataset.chat);
  }));
  el.querySelectorAll("[data-open]").forEach(row => row.addEventListener("click", () =>
    openChat(row.dataset.open)));
}

// "New group" for local (P2P) chat: name + up to 4 paired devices, then open
// the new group chat. Only reachable with local chat on (the hub card and the
// new-chat menu entry are both gated on it).
async function newLocalGroupFlow() {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (!invoke || !p2pEnabled()) return toast("Local groups need the Velta app with local chat on");
  const epoch = core.accountEpoch;
  try {
    const id = await showCreateGroupModal(invoke);
    if (!id || !accountIsCurrent(epoch)) return;
    await refreshChatList();
    renderLocalChatCard();
    if (!accountIsCurrent(epoch)) return;
    openChat(id);
  } catch (err) {
    errToast("Couldn't create the group: " + (err?.message || err));
  }
}

// Side views rendered into #chat-list instead of the chats list. Contacts
// come from the core (get_contacts); calls have NO core call-log API — calls
// are plain messages (msgId-based RPC), so Velta records its own ended-call
// log locally (capped, localStorage). QR view renders the profile invite
// code in place of the modal.
function applyBarVisibility() {
  const bar = document.querySelector(".list-bar");
  let any = false;
  for (const key of ["chats", "contacts", "calls", "qr"]) {
    const btn = document.getElementById(`bar-${key}`);
    if (!btn) continue;
    const show = !barHidden.includes(key);
    btn.hidden = !show;
    any = any || show;
  }
  // Menu button can't be hidden; with everything else hidden the bar loses
  // its background and becomes a floating menu button.
  bar.classList.toggle("bar-bare", !any);
}

function recordCallEnded(chatId) {
  if (!chatId) return;
  try {
    const log = JSON.parse(localStorage.getItem(CALL_LOG_KEY)) || [];
    log.unshift({ chatId, ts: Date.now() });
    localStorage.setItem(CALL_LOG_KEY, JSON.stringify(log.slice(0, 30)));
  } catch { /* storage unavailable — calls view just stays empty */ }
}

// The contacts view mounts its rows through a virtual scroller — real
// accounts have hundreds of contacts and each fingerprint avatar is a
// ~35-node SVG, which blew the WebView DOM budget when rendered flat.
let sideScroller = null;
function stopSideScroller() {
  sideScroller?.stop?.();
  sideScroller = null;
}

function setListView(view) {
  stopSideScroller();
  stopQrScanner();
  const wasQr = listView === "qr";
  listView = listView === view ? "chats" : view;
  if (listView === "qr" && !wasQr) qrTab = "mine"; // a fresh visit starts on the code
  for (const b of document.querySelectorAll(".list-bar .bar-btn[data-view]")) {
    b.classList.toggle("active", b.dataset.view === listView);
  }
  syncHeaderButtons();
  syncChatCategoryBar();
  if (listView === "chats") { renderChatList(); return; }
  if (listView === "contacts") { renderContactsView(); return; }
  if (listView === "calls") { renderCallsView(); return; }
  if (listView === "qr") { renderQrView(); return; }
  if (listView === "search") { renderSearchView(); return; }
  if (listView === "new") { renderNewChatView(); return; }
}

// The header search button doubles as the search view toggle: magnifier
// opens it, the cross closes. "+" highlights while the new-chat view shows.
function syncHeaderButtons() {
  const searchOn = listView === "search";
  const btn = document.getElementById("btn-search");
  if (btn) {
    btn.innerHTML = searchOn
      ? `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`
      : `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    btn.title = searchOn ? "Close search" : "Search chats";
  }
  const plus = document.getElementById("btn-new-chat");
  plus?.classList.toggle("active", listView === "new");
}

function sideViewShell(title, subtitle) {
  const list = document.getElementById("chat-list");
  list.innerHTML = `
    <div class="side-view">
      <div class="side-view-title">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="side-view-sub">${escapeHtml(subtitle)}</div>` : ""}
      <div class="side-view-rows"></div>`;
  return list.querySelector(".side-view-rows");
}

async function renderContactsView() {
  stopSideScroller();
  const rows = sideViewShell("Contacts", "Tap a contact to open the chat");
  let contacts = [];
  try { contacts = await core.getContacts(); } catch { /* demo mode */ }
  if (listView !== "contacts") return; // user switched away mid-fetch
  if (!contacts.length) {
    rows.innerHTML = `<div class="side-view-empty">No contacts yet</div>`;
    return;
  }
  const renderRow = (c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-item contact-row";
    b.innerHTML = `
      <velta-avatar name="${escapeAttr(c.name)}" color="${escapeAttr(c.color || "#777")}" size="42" contact-id="${c.id}"${c.avatar ? ` avatar="${escapeAttr(fileUrl(c.avatar))}"` : ""}></velta-avatar>
      <div class="ci-name">${escapeHtml(c.name)}</div>`;
    b.addEventListener("click", async () => {
      try {
        const id = await core.createChat(c.name, [c.id], "single");
        setListView("chats");
        await refreshChatList();
        openChat(id);
      } catch (err) { errToast(`Could not open chat: ${err?.message || err}`); }
    });
    return b;
  };
  // Virtualized: only the visible window of rows exists in the DOM.
  sideScroller = new VirtualScroller(rows, contacts, renderRow, {
    getScrollableContainer: () => document.getElementById("chat-list"),
    getItemId: (c) => String(c.id),
    getEstimatedItemHeight: () => 58,
  });
}

// Archived chats folder (issue #13): a header button instead of the
// official client's pinned row. Plain side view — archived lists are small.
// The Archived tab body of the search screen (replaces the standalone
// archived side view — the folder folded into search, #77 follow-up).
async function renderArchivedTab(rows) {
  let chats = [];
  try { chats = await core.getChatList({ archived: true }); } catch { /* backend offline */ }
  if (listView !== "search" || searchScreenTab !== "archived") return; // switched away mid-fetch
  if (!chats.length) {
    rows.innerHTML = `<div class="side-view-empty">No archived chats</div>`;
    return;
  }
  for (const c of chats) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-item contact-row";
    b.innerHTML = `
      <velta-avatar name="${escapeAttr(c.name)}" color="${escapeAttr(c.avatarColor || "#777")}" kind="${escapeAttr(c.kind)}" size="42"${c.avatar ? ` avatar="${escapeAttr(fileUrl(c.avatar))}"` : ""}></velta-avatar>
      <div style="min-width:0">
        <div class="ci-name">${escapeHtml(c.name)}</div>
        ${c.lastMsg ? `<div class="archived-sub">${escapeHtml(c.lastMsg)}</div>` : ""}
      </div>`;
    b.addEventListener("click", () => openChat(c.id)); // writing unarchives (_sendArchivedAware)
    rows.appendChild(b);
  }
}

function renderCallsView() {
  const rows = sideViewShell("Calls", "Calls you ended on this device (kept locally — the core stores no call log)");
  let log = [];
  try { log = JSON.parse(localStorage.getItem(CALL_LOG_KEY)) || []; } catch { }
  if (!log.length) {
    rows.innerHTML = `<div class="side-view-empty">No calls yet</div>`;
    return;
  }
  for (const e of log) {
    const chat = state.chats.find(c => c.id === e.chatId);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-item call-row";
    b.innerHTML = `
      <span class="call-row-ico"><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 006.6 6.6l2.2-2.2a1 1 0 011-.24 11.4 11.4 0 003.6.58 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.4 11.4 0 00.57 3.6 1 1 0 01-.25 1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></span>
      <div class="ci-name">${escapeHtml(chat ? chat.name : "Unknown chat")}</div>
      <div class="ci-time">${timeTag(e.ts, timeAgo(e.ts))}</div>`;
    b.addEventListener("click", () => { setListView("chats"); openChat(e.chatId); });
    rows.append(b);
  }
}

// "Your QR code" (#37). Tab 1 "My code": the invite QR, the link under it, and
// Copy a link / Share a link. Tab 2 "Scan a QR code" (phones with a camera
// only): an in-page scanner for other people's codes. The camera runs only
// while that tab is open; leaving the view, switching tabs or accepting a code
// stops it (stopQrScanner, also called from setListView).
function stopQrScanner() {
  qrScanner?.destroy();
  qrScanner = null;
}

function renderQrView() {
  stopQrScanner();
  const hasCamera = !!navigator.mediaDevices?.getUserMedia;
  const scanTab = scanTabAvailable({ ua: navigator.userAgent, hasCamera });
  if (!scanTab) qrTab = "mine";
  const rows = sideViewShell("Your QR code", qrTab === "scan"
    ? "Point the camera at someone's QR code to start a chat or join a group"
    : "Others scan this to reach you with verified encryption");
  const wrap = document.createElement("div");
  wrap.className = "qr-view";
  const tabs = scanTab ? `
    <div class="chat-cats side-tabs" role="tablist">
      <button type="button" role="tab" data-qr-tab="mine" class="${qrTab === "mine" ? "active" : ""}">My code</button>
      <button type="button" role="tab" data-qr-tab="scan" class="${qrTab === "scan" ? "active" : ""}">Scan a QR code</button>
    </div>` : "";
  if (qrTab === "scan") {
    wrap.innerHTML = `${tabs}
      <div class="qr-scan"><video muted playsinline></video></div>
      <div class="qr-scan-status" data-scan-status>Starting camera…</div>
      <button type="button" class="btn-text" data-scan-retry hidden>Try again</button>`;
  } else {
    const canShare = canShareLink({
      ua: navigator.userAgent,
      hasInvoke: !!(window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke),
      hasWebShare: typeof navigator.share === "function",
    });
    wrap.innerHTML = `${tabs}
      <div class="qr-box"><div class="qr-loading">Generating QR code…</div></div>
      <div class="invite-link" style="word-break:break-all"></div>
      <div class="qr-actions">
        <button type="button" class="btn-text" data-copy-link disabled>Copy a link</button>
        ${canShare ? `<button type="button" class="btn-text" data-share-link disabled>Share a link</button>` : ""}
      </div>`;
  }
  rows.append(wrap);
  for (const b of wrap.querySelectorAll("[data-qr-tab]")) {
    b.addEventListener("click", () => {
      if (qrTab === b.dataset.qrTab) return;
      qrTab = b.dataset.qrTab;
      renderQrView();
    });
  }

  if (qrTab === "scan") {
    const video = wrap.querySelector("video");
    const status = wrap.querySelector("[data-scan-status]");
    const retry = wrap.querySelector("[data-scan-retry]");
    const epoch = core.accountEpoch;
    qrScanner = mountScanner({
      video,
      onState: (st, msg) => {
        if (listView !== "qr" || qrTab !== "scan") return;
        retry.hidden = st !== "error" && st !== "stopped";
        status.textContent = st === "starting" ? "Starting camera…"
          : st === "scanning" ? "Hold the QR code inside the frame"
          : st === "error" ? (msg || "The camera could not be started")
          : "Camera stopped";
      },
      onCode: raw => {
        if (!accountIsCurrent(epoch)) return false;
        const kind = classifyScannedCode(raw, { parseInviteLink, isShortInviteLink });
        if (!kind) { toast("That QR code isn't a Velta or Delta Chat invite"); return false; }
        setListView("chats"); // stops the camera and leaves the screen; the confirmation modal takes over
        if (kind === "invite" || kind === "short") joinFromInvite(raw.trim());
        else handleDeeplinkFromUrl(raw.trim());
        return true;
      },
    });
    retry.addEventListener("click", () => qrScanner?.start());
    qrScanner.start(); // the user opened this tab on purpose: that is the camera consent moment
    return;
  }

  const copyBtn = wrap.querySelector("[data-copy-link]");
  const shareBtn = wrap.querySelector("[data-share-link]");
  let inviteText = "";
  copyBtn.addEventListener("click", async () => {
    try {
      await copyLink(inviteText, { clipboard: navigator.clipboard });
      toast("Link copied");
    } catch (err) { errToast("Couldn't copy the link: " + (err?.message || err)); }
  });
  shareBtn?.addEventListener("click", async () => {
    try {
      const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
      await shareLink(inviteText, {
        ua: navigator.userAgent, invoke,
        webShare: typeof navigator.share === "function" ? o => navigator.share(o) : null,
      });
    } catch (err) { errToast("Couldn't share the link: " + (err?.message || err)); }
  });
  inviteQrProvider(null)()
    .then(({ svg, link }) => {
      const box = wrap.querySelector(".qr-box");
      if (listView !== "qr" || qrTab !== "mine") return;
      box.innerHTML = svg || "<div class='qr-loading'>QR unavailable</div>";
      wrap.querySelector(".invite-link").textContent = link;
      inviteText = link || "";
      copyBtn.disabled = !inviteText;
      if (shareBtn) shareBtn.disabled = !inviteText;
    })
    .catch(err => {
      if (listView !== "qr") return;
      wrap.querySelector(".qr-box").innerHTML =
        `<div class='qr-loading'>Couldn't create the invite:<br>${escapeHtml(String(err?.message || err))}</div>`;
    });
}

// #57 category bar. Bot flags come from one get_contacts call, fetched the
// first time a People/Bots filter actually needs them — no boot RPC cost.
const chatCatsEl = document.getElementById("chat-categories");
async function ensureContactBots() {
  if (state.contactBots || !core?.getContacts) return;
  try {
    const contacts = await core.getContacts();
    state.contactBots = new Map(contacts.map(c => [c.id, !!c.bot]));
    if (state.chatCategory === "people" || state.chatCategory === "bots") renderChatList();
  } catch { state.contactBots = new Map(); }
}
const chatIsBot = (contactId) => state.contactBots?.get(contactId) === true;
function visibleChats() {
  const cat = state.chatCategory;
  if (cat === "all") return state.chats;
  // #77: a boot-restored People/Bots view renders before any chip click,
  // so it must kick the bot-flag fetch itself — otherwise contact bots
  // classify as "people" until the next chip interaction.
  if (!state.contactBots && (cat === "people" || cat === "bots")) ensureContactBots();
  return state.chats.filter(c => chatCategoryOf(c, chatIsBot) === cat);
}
// One entry point for every category change (chip click, swipe): renderChatList
// re-syncs the chip active states via syncChatCategoryBar.
function setChatCategory(cat) {
  state.chatCategory = cat;
  localStorage.setItem("velta-chat-category", cat);
  if (cat === "people" || cat === "bots") ensureContactBots();
  renderChatList();
}
if (chatCatsEl) {
  chatCatsEl.addEventListener("click", e => {
    const btn = e.target.closest("button[data-cat]");
    if (btn) setChatCategory(btn.dataset.cat);
  });
}
function syncChatCategoryBar() {
  if (!chatCatsEl) return;
  chatCatsEl.hidden = listView !== "chats" ||
    // #80: every special category disabled -> a lone "All" chip is noise;
    // hide the whole bar.
    ![...chatCatsEl.children].some(b => b.dataset.cat !== "all" && !catsHidden.includes(b.dataset.cat));
  // #75: hidden categories drop their chips; "all" always stays. A persisted
  // active category that has since been disabled falls back to "all".
  if (catsHidden.includes(state.chatCategory)) state.chatCategory = "all";
  for (const b of chatCatsEl.children) {
    b.hidden = b.dataset.cat !== "all" && catsHidden.includes(b.dataset.cat);
    b.classList.toggle("active", b.dataset.cat === state.chatCategory);
  }
}

function renderChatList() {
  if (listView !== "chats") return; // another side view owns the container
  syncChatCategoryBar();
  const list = $("chat-list");
  const chats = visibleChats(); // #57: category-filtered, source stays state.chats
  // Reuse row elements only while their display data is unchanged; recreate
  // an element when its data or active state changes. Recreating runs the
  // Elena first-render path (safe); updating data on a hydrated element is
  // NOT safe: Elena's re-render diff compares live children against a fresh
  // template clone, and custom elements like <velta-avatar> exist only in the
  // live tree (innerHTML templates contain the bare, unhydrated tag), so the
  // diff deletes the avatar's rendered children — blank avatars. With
  // change-gated recreation, an idle list does zero DOM work and a burst
  // touches only the chats whose data actually changed.
  const existing = new Map();
  const ghosts = new Map();
  for (const child of [...list.children]) {
    if (child.tagName === "VELTA-CHAT-ITEM") {
      const id = Number(child.getAttribute("chat-id"));
      if (chats.some(c => c.id === id)) existing.set(id, child);
      else child.remove();
    } else if (child.classList?.contains?.("chat-item-ghost")) {
      const id = Number(child.getAttribute("chat-id"));
      if (chats.some(c => c.id === id)) ghosts.set(id, child);
      else child.remove();
    } else {
      child.remove(); // stale empty-state placeholder
    }
  }
  const items = [];
  // #44: a full row is a custom element with an avatar subtree — the review
  // measured ~85 ms / 210 KiB for 301 chats against ~8 ms for one screen.
  // The first CHAT_ITEM_FULL_ROWS mount fully (the list opens at the top);
  // the rest stay as fixed-height placeholder divs that the Intersection-
  // Observer upgrades as they approach the viewport. Item DATA for every
  // row is already in state.chats (one bulk RPC), so an upgrade is pure
  // DOM work. Environments without IntersectionObserver (headless harness)
  // keep mounting everything, as before.
  for (const [index, chat] of chats.entries()) {
    const active = chat.id === state.activeChatId;
    let item = existing.get(chat.id);
    if (item) {
      if (!chatItemUpToDate(item, chat, active)) {
        const fresh = createChatItem(chat, active);
        item?.replaceWith(fresh);
        item = fresh;
      }
    } else if (index < CHAT_ITEM_FULL_ROWS || typeof IntersectionObserver !== "function") {
      item = createChatItem(chat, active);
    } else {
      item = ghosts.get(chat.id) || createChatItemGhost(chat);
    }
    items.push(item);
  }
  // Only touch the DOM when the row set/order actually changed; moving
  // existing nodes preserves them (no custom-element re-init).
  const sameOrder = items.length === list.children.length &&
    items.every((el, i) => list.children[i] === el);
  if (!sameOrder) list.replaceChildren(...items);
  if (!chats.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "text-align:center;color:var(--text-dim);padding:30px 16px;font-size:14.5px";
    empty.textContent = state.query ? "No chats found"
      : state.chatCategory !== "all" ? "No chats in this category"
      : "No chats yet — start a new one";
    list.appendChild(empty);
  }
  watchChatItemGhosts(list);
}

// Fixed-height stand-in for an off-screen chat row: matches one real row
// (48px avatar + 2×9px padding). Ceiling: a future two-line row layout
// would need this height (or an IO-driven resize) to keep up.
function createChatItemGhost(chat) {
  const el = document.createElement("div");
  el.classList.add("chat-item-ghost");
  el.setAttribute("chat-id", chat.id);
  el.setAttribute("aria-hidden", "true");
  return el;
}

// Upgrades ghost rows to full <velta-chat-item>s once they come within
// 600px of the viewport. Never downgrades again — scrolling back shows the
// already-mounted row (cheap enough at chat-list sizes).
let chatItemGhostIO = null;
function watchChatItemGhosts(list) {
  if (typeof IntersectionObserver !== "function") return;
  chatItemGhostIO?.disconnect();
  const ghosts = list.querySelectorAll?.(".chat-item-ghost");
  if (!ghosts?.length) return;
  chatItemGhostIO = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const ghost = entry.target;
      chatItemGhostIO.unobserve(ghost);
      const chat = state.chats.find(c => c.id === Number(ghost.getAttribute("chat-id")));
      if (!chat) { ghost.remove(); continue; }
      ghost.replaceWith(createChatItem(chat, chat.id === state.activeChatId));
    }
  }, { rootMargin: "600px 0px" });
  for (const ghost of ghosts) chatItemGhostIO.observe(ghost);
}
const CHAT_ITEM_FULL_ROWS = 40;

function createChatItem(chat, active) {
  const chatId = chat.id;
  const item = document.createElement("velta-chat-item");
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
    && prev.encrypted === chat.encrypted
    && prev.draft === chat.draft
    && prev.lastFrom === chat.lastFrom
    && prev.lastState === chat.lastState
    && prev.typingText === chat.typingText;
}


// Group message sender avatars open the contact's profile modal — the same
// showChatInfo sheet, built around the contact instead of a chat object.
// No partial contact stub here: showChatInfo hydrates the full contact
// (real avatar, bot flag, presence) whenever chat.contact is absent — a stub
// would block that and the sheet would keep the matrix initials.
function openContactProfile(contact) {
  showChatInfo({
    contactId: contact.contactId ?? contact.id,
    name: contact.name,
    kind: "single",
    encrypted: true,
  });
}

function isGroupChat(chat) {
  return chat.kind === "group" || chat.kind === "channel";
}
setAvatarProfileOpener(openContactProfile);

// Drawer avatar tap: the user's own profile sheet. Contact 1 is the self
// contact (ContactId::SELF); showChatInfo skips the contact action buttons
// for it.
function openSelfProfile() {
  showChatInfo({
    contactId: 1,
    name: state.account.displayName,
    contact: { addr: state.account.addr },
    kind: "single",
    encrypted: true,
    // getAccount() already resolved the self contact's photo (rpc-core) —
    // without it the sheet renders the bare fingerprint tile.
    avatar: state.account?.avatar,
  });
}

function formatFingerprint(fpr) {
  const groups = fingerprintGroups(fpr) || [];
  const lines = [];
  for (let i = 0; i < groups.length; i += 5) lines.push(groups.slice(i, i + 5).join(" "));
  return lines.join("\n");
}

// Age spans shared by the chat-list menu and the info-sheet "Old messages"
// cleanup (label + cutoff offset in ms).
const OLD_MESSAGE_SPANS = [
  ["1 hour", 3600e3],
  ["1 day", 86400e3],
  ["1 week", 7 * 86400e3],
  ["5 weeks", 35 * 86400e3],
  ["6 months", 182 * 86400e3],
  ["1 year", 365 * 86400e3],
];

function chatContextMenu(chat, x, y) {
  const epoch = core.accountEpoch;
  if (chat.id === DIAGNOSTICS_CHAT_ID) return;
  const icons = {
    pin: `<svg viewBox="0 0 24 24"><path d="M9 4h6l1 7 3 3v2h-6v5l-1 1-1-1v-5H5v-2l3-3z" fill="currentColor"/></svg>`,
    mute: `<svg viewBox="0 0 24 24"><path d="M12 3a5 5 0 00-5 5v3l-2 4h14l-2-4V8a5 5 0 00-5-5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
    archive: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 9v11h14V9M10 13h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    read: `<svg viewBox="0 0 24 24"><path d="M3 13l4 4L17 7M10 15l2 2 8-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    link: `<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };
  // Local P2P groups: only read state, link previews and delete (leave /
  // disband) apply — pin, mute, archive and old-message cleanup are relay-core.
  const grp = !!chat.isP2pGroup;
  showContextMenu([
    grp ? null : { label: chat.pinned ? "Unpin" : "Pin to top", icon: icons.pin, onClick: () => core.setChatFlags(chat.id, { pinned: !chat.pinned }) },
    grp ? null : { label: chat.muted ? "Unmute" : "Mute notifications", icon: icons.mute, onClick: () => core.setChatFlags(chat.id, { muted: !chat.muted }) },
    { label: `Link previews: ${LINK_PREVIEW_LABELS[linkPreviewMode(chat.id)]}`, icon: icons.link, onClick: () => {
      if (!accountIsCurrent(epoch)) return;
      const apply = (mode) => {
        if (!accountIsCurrent(epoch)) return;
        setLinkPreviewMode(mode, chat.id);
        toast(`Link previews: ${LINK_PREVIEW_LABELS[mode]} for this chat`);
        if (state.activeChatId === chat.id && chatView?.open) {
          chatView.close();
          openChat(chat.id);
        }
      };
      showContextMenu([["off", "Off"], ["picture", "Send a picture"], ["fetch", "Load on this device"]].map(([mode, label]) => ({
        label, onClick: () => apply(mode),
      })), x, y);
    } },
    chat.unread > 0 ? { label: "Mark as read", icon: icons.read, onClick: () => core.markRead(chat.id) } : null,
    grp ? null : {
      label: "Delete old messages…",
      icon: icons.trash,
      onClick: () => {
        showContextMenu(OLD_MESSAGE_SPANS.map(([label, ms]) => ({
          label: `Older than ${label}`,
          onClick: async () => {
            const ok = await confirmModal(
              "Delete old messages",
              `Delete every message in "${chat.name}" older than ${label}? Pinned messages are kept. This cannot be undone.`,
              "Delete",
              true,
            );
            if (!ok || !accountIsCurrent(epoch)) return;
            try {
              const deleted = await core.deleteMessagesOlderThan(chat.id, Date.now() - ms);
              if (!accountIsCurrent(epoch)) return;
              toast(deleted ? `Deleted ${deleted} message${deleted === 1 ? "" : "s"}` : "Nothing older than that");
              refreshChatList();
            } catch (err) {
              errToast("Couldn't delete: " + (err?.message || err));
            }
          },
        })), x, y);
      },
    },
    grp ? null : "-",
    grp ? null : { label: chat.archived ? "Unarchive" : "Archive", icon: icons.archive, onClick: () => core.setChatFlags(chat.id, { archived: !chat.archived }) },
    grp ? { label: chat.readOnly ? "Delete chat" : chat.canManage ? "Disband and delete" : "Leave and delete", icon: icons.trash, danger: true, onClick: () => deleteLocalGroupChat(chat, epoch) }
    : { label: "Delete chat", icon: icons.trash, danger: true, onClick: async () => {
      // deleteMessages only clears history and leaves the chat in the list (#34).
      const p2p = chat.isP2p || String(chat.id).startsWith("p2p:");
      const ok = p2p
        ? await confirmRemovePeer(String(chat.id).slice("p2p:".length), chat.name, "Delete chat")
        : await confirmModal("Delete chat", `Delete "${chat.name}" and all its messages?`);
      if (!ok || !accountIsCurrent(epoch)) return;
      try {
        if (p2p) await removePeer(String(chat.id).slice("p2p:".length));
        else await core.deleteChat(chat.id);
        if (!accountIsCurrent(epoch)) return;
        if (state.activeChatId === chat.id) closeChat();
        if (p2p) { renderLocalChatCard(); closeVanishedGroupChat(); }
        refreshChatList();
      } catch (err) {
        errToast("Couldn't delete chat: " + (err.message || err));
      }
    } },
  ].filter(Boolean), x, y);
}

// Unpairing a device, with the group consequences spelled out: groups it
// created go away here (a creator we forgot can't re-sign anything for us),
// groups it is merely in keep it as a member we can't message directly.
async function confirmRemovePeer(peerId, name, title = "Remove device") {
  const text = removePeerImpactText(name, await peerGroupImpact(peerId));
  return confirmModal(title, text, title === "Delete chat" ? "Delete" : "Remove", true);
}

// An open local-group chat whose group was deleted underneath it (its creator
// was unpaired) has nothing to show: close it.
async function closeVanishedGroupChat() {
  const id = state.activeChatId;
  if (!id || !String(id).startsWith("p2pg:")) return;
  const gone = !(await core.getChat(id).catch(() => null));
  if (gone && state.activeChatId === id) closeChat();
}

// The action buttons of a local group's info sheet (see groupActionsModel).
function p2pGroupActionsHtml(chat) {
  const btns = groupActionsModel(chat).map(a =>
    `<button type="button" class="btn-text" data-pg="${a.key}"${a.danger ? ` style="color:var(--danger)"` : ""}${a.disabled ? " disabled" : ""}>${escapeHtml(a.label)}</button>`);
  return `<div class="profile-actions">${btns.join("")}</div>`;
}

// Leave a local group (a member) or disband it (the creator). The chat stays,
// read-only, with its history.
async function leaveLocalGroupFlow(chat, epoch) {
  const disband = !!chat.canManage;
  const ok = await confirmModal(
    disband ? "Disband group" : "Leave group",
    disband
      ? "You created this group. Disbanding closes it for everyone — nobody can write in it any more. The history stays on each device."
      : "You will leave this group and no longer receive its messages. The history stays on this device.",
    disband ? "Disband" : "Leave", true);
  if (!ok || !accountIsCurrent(epoch)) return;
  try {
    await core.leaveGroup(chat.id);
    if (!accountIsCurrent(epoch)) return;
    refreshChatList();
    if (state.activeChatId === chat.id) {
      chat.readOnly = true;
      $("main-composer").hidden = true;
      chatView.readOnly = true;
      refreshActiveChatHeader(chat.id);
    }
  } catch (err) {
    errToast("Couldn't leave: " + (err?.message || err));
  }
}

// Local P2P group chat "delete": leave (or, for the creator, disband) the group
// if it is still active, then hide it from the list. The log stays on disk —
// the engine has no delete-group command before member management lands.
async function deleteLocalGroupChat(chat, epoch) {
  const active = !chat.readOnly;
  const disband = active && chat.canManage;
  const ok = await confirmModal(
    "Delete chat",
    !active
      ? `Remove "${chat.name}" from your chat list?`
      : disband
        ? `Disband "${chat.name}" and remove it from your list? You created this group: disbanding closes it for everyone.`
        : `Leave "${chat.name}" and remove it from your list? You will no longer receive its messages.`,
    disband ? "Disband" : active ? "Leave" : "Delete", true);
  if (!ok || !accountIsCurrent(epoch)) return;
  try {
    await dismissLocalGroup(String(chat.id).slice("p2pg:".length));
    if (!accountIsCurrent(epoch)) return;
    if (state.activeChatId === chat.id) closeChat();
    renderLocalChatCard();
    refreshChatList();
  } catch (err) {
    errToast("Couldn't delete chat: " + (err.message || err));
  }
}

// Fresh <velta-chat-head> for the open chat. Always build a new element instead
// of setData() on an existing one: Elena's re-render diff strips the hydrated
// children of the nested <velta-avatar> (see renderChatList).
function renderChatHead(chat) {
  const head = document.createElement("velta-chat-head");
  head.setData(chat);
  head.addEventListener("click", () => showChatInfo(chat));
  return head;
}

// Presence: fetch the contact's online/last-seen (the core tracks it from
// incoming messages) and re-render the active chat head subtitle. The chat
// object from getChatList lacks the contact — hydrated here on open, on
// chat-updated for the active chat, and on the 30s list refresh tick.
async function refreshChatHeadPresence(chatId) {
  const chat = state.chats.find(c => c.id === chatId) || state.activeChatHead?.chat;
  if (!chat || chat.kind !== "single" || !chat.contactId || !core.getContact) return;
  try {
    const contact = await core.getContact(chat.contactId);
    if (state.activeChatId !== chat.id) return;
    chat.contact = { ...contact, name: contact.name || chat.name, contactId };
    if (state.activeChatHead) {
      const fresh = renderChatHead(chat);
      state.activeChatHead?.replaceWith(fresh);
      state.activeChatHead = fresh;
    }
  } catch {}
}

/* ---------------- chat open/close ---------------- */
async function openChat(chatId) {
  if (state.accountChanging) return;
  if (listView !== "chats") setListView("chats");
  if (chatId === DIAGNOSTICS_CHAT_ID) {
    openDiagnosticsChat();
    return;
  }
  // The ChatView boot stage failed — nothing to open into.
  if (!chatView) return;
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
  const head = document.createElement("velta-chat-head");
  head.setData(chat);
  $("chat-head-info").replaceChildren(head);
  state.activeChatHead = head;
  head.addEventListener("click", () => showChatInfo(chat));
  const callBtn = $("btn-call");
  // Local (P2P) chats have no call signaling — the p2p engine carries no call
  // frames, so the dial button would only end in "Call failed".
  callBtn.hidden = chat.kind !== "single" || chat.isP2p;
  callBtn.onclick = chat.kind === "single" && !chat.isP2p ? () => startCallIfMicOk(chat) : null;
  // Device messages are read-only system posts — no composer. Every open
  // sets it explicitly (closeChatUI restores it to visible). Channels need a
  // rights check: members without posting rights get no composer either.
  $("main-composer").hidden = chat.kind === "device" || !!chat.readOnly;
  // Read-only chats hide every reply affordance too. Channels start assumed
  // read-only until the rights check resolves; the pill is re-added by row
  // re-renders / CSS on flip.
  chatView.readOnly = chat.kind === "device" || chat.kind === "channel" || !!chat.readOnly;
  if (chat.kind === "channel" && core.canSend) {
    core.canSend(chatId).then(can => {
      if (!current() || state.activeChatId !== chatId) return;
      $("main-composer").hidden = !can;
      chatView.readOnly = !can;
    }).catch(() => {});
  }
  refreshChatHeadPresence(chatId);
  // Real member count for groups (the chatlist item doesn't carry it)
  // (local P2P groups carry memberCount/onlineCount on the chat itself)
  if ((chat.kind === "group" || chat.kind === "channel") && !chat.isP2pGroup && core.getChatMembers) {
    core.getChatMembers(chatId).then(members => {
      if (!current() || state.activeChatId !== chatId) return;
      chat.memberCount = members.length;
      const fresh = renderChatHead(chat);
      state.activeChatHead?.replaceWith(fresh);
      state.activeChatHead = fresh;
    }).catch(() => {});
  }
  // Hand over the chat fetched above: the view used to fetch it again.
  if (!await chatView.open(chatId, chat) || !current()) return;
  // History entry per open chat: Android BACK pops it (chat -> chat list)
  // via WryActivity's WebView-history navigation instead of exiting.
  if (history.state?.velta !== "chat") history.pushState({ velta: "chat", chatId }, "");
  renderChatList();
  renderLcQueueTray();
  } catch (error) {
    if (!current()) return;
    closeChatUI();
    errToast("Couldn't open chat: " + (error.message || error));
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
  // A throw inside the view's teardown must not skip the UI teardown below —
  // the swipe-back parks the column off-screen and relies on .chat-open being
  // dropped, otherwise the screen stays blank (#86).
  try { chatView?.close(); } catch (err) { diagnostics.append("error", `closeChat: view teardown failed: ${err?.message || err}`); }
  state.activeChatId = null;
  state.activeChatHead = null;
  $("chat-head-info").replaceChildren();
  $("chat-view").hidden = true;
  $("no-chat").hidden = false;
  document.querySelector(".app").classList.remove("chat-open");
  $("diagnostic-actions").hidden = true;
  $("main-composer").hidden = false;
  chatView.readOnly = false;
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
  if (chat.kind !== "group" && chat.kind !== "channel" && !chat.isP2p) return;
  if (chatId && chatId !== chat.id) return;
  if (chat.isP2p) return refreshLocalGroupHeader(chat, navigation, epoch);
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

// Local P2P group: counts, online count and the read-only flag all live on the
// chat object the adapter builds, so re-read it and apply what changed
// (composer and reply affordances flip live when the group is disbanded or the
// user is removed).
async function refreshLocalGroupHeader(chat, navigation, epoch) {
  try {
    const fresh = await core.getChat(chat.id);
    if (!fresh || !accountIsCurrent(epoch) || navigation !== chatNavigation || state.activeChatId !== chat.id) return;
    const changed = ["name", "memberCount", "onlineCount", "readOnly", "typingText"].some(k => chat[k] !== fresh[k]);
    if (!changed) return;
    Object.assign(chat, { name: fresh.name, memberCount: fresh.memberCount, onlineCount: fresh.onlineCount, readOnly: fresh.readOnly, canManage: fresh.canManage, typingText: fresh.typingText });
    $("main-composer").hidden = !!chat.readOnly;
    chatView.readOnly = !!chat.readOnly;
    const head = renderChatHead(chat);
    state.activeChatHead?.replaceWith(head);
    state.activeChatHead = head;
  } catch { /* keep the last known state */ }
}

// A modal's close() schedules history.back() to consume its entry; the
// popstate lands async and tears down a sheet reopened in between (the
// reopen sees state "modal" and reuses the dying entry). Wait for the pop
// (capped) before reopening a modal right after one closed itself.
async function modalHistorySettled() {
  if (history.state?.velta !== "modal") return;
  await Promise.race([
    new Promise(r => window.addEventListener("popstate", r, { once: true })),
    new Promise(r => setTimeout(r, 300)),
  ]);
}

// Disappearing messages: the official client's option list (seconds).
const EPHEMERAL_OPTIONS = [
  { label: "Off", secs: 0 },
  { label: "After 5 minutes", secs: 5 * 60 },
  { label: "After 1 hour", secs: 60 * 60 },
  { label: "After 1 day", secs: 24 * 60 * 60 },
  { label: "After 1 week", secs: 7 * 24 * 60 * 60 },
  { label: "After 5 weeks", secs: 5 * 7 * 24 * 60 * 60 },
  { label: "After 1 year", secs: 365 * 24 * 60 * 60 },
];

function formatEphemeralTimer(secs) {
  const s = secs | 0;
  return EPHEMERAL_OPTIONS.find(o => o.secs === s)?.label ?? (s ? `On (${s} s)` : "Off");
}

// The disappearing-messages editor (chat info sheet → the row). Radios in
// the official client's shape; OK applies via the core, which posts its own
// system notice into the chat so members learn about the change.
async function openEphemeralDialog(chat, valEl, epoch) {
  let current = 0;
  try { current = (await core.getChatEphemeralTimer(chat.id)) || 0; } catch { /* offline — default Off */ }
  const list = document.createElement("fieldset");
  list.className = "eph-set";
  const legend = document.createElement("legend");
  legend.className = "vh";
  legend.textContent = "Disappearing messages";
  list.append(legend);
  for (const o of EPHEMERAL_OPTIONS) {
    const label = document.createElement("label");
    label.className = "eph-row";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "eph-option";
    input.value = o.secs;
    input.checked = o.secs === (current | 0);
    label.append(input, Object.assign(document.createElement("span"), { textContent: o.label }));
    list.appendChild(label);
  }
  const note = document.createElement("div");
  note.className = "eph-note";
  note.textContent = "Applies to all members of this chat; they can still copy, save, and forward messages.";
  const body = document.createElement("div");
  body.append(list, note);
  const foot = document.createDocumentFragment(); // direct child of .modal-foot -> one-row flex
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn-text";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn-text";
  ok.textContent = "OK";
  foot.append(cancel, ok);
  // The dialog replaces the sheet's modal history entry, so every close
  // path (OK, Cancel, X, BACK) tears the sheet down with it — reopen a
  // fresh sheet, same contract as the profile editor.
  const { close } = showModal({
    title: "Disappearing messages", body, foot,
    onClose: async () => { await modalHistorySettled(); if (accountIsCurrent(epoch)) showChatInfo(chat); },
  });
  cancel.addEventListener("click", () => close());
  ok.addEventListener("click", async () => {
    const secs = Number(list.querySelector("input[name=eph-option]:checked")?.value || 0);
    try {
      await core.setChatEphemeralTimer(chat.id, secs);
      if (accountIsCurrent(epoch)) valEl.textContent = formatEphemeralTimer(secs);
      close();
    } catch (err) {
      errToast("Couldn't set disappearing messages: " + (err.message || err));
    }
  });
}

// Timed mute: the official client's action-sheet options (seconds; -1 =
// forever). 0 = unmute.
const MUTE_OPTIONS = [
  { label: "Mute for 1 hour", secs: 60 * 60 },
  { label: "Mute for 8 hours", secs: 8 * 60 * 60 },
  { label: "Mute for 1 day", secs: 24 * 60 * 60 },
  { label: "Mute for 7 days", secs: 7 * 24 * 60 * 60 },
  { label: "Mute forever", secs: -1 },
];

// The mute editor (chat info sheet → Notifications row). Applied per row
// tap; Cancel dismisses. The sheet's muted flag is kept in sync so a second
// open offers Unmute.
function openMuteDialog(chat, valEl, epoch) {
  const list = document.createElement("fieldset");
  list.className = "eph-set";
  const legend = document.createElement("legend");
  legend.className = "vh";
  legend.textContent = "Mute notifications";
  list.append(legend);
  const rows = (chat.muted ? [{ label: "Unmute", secs: 0 }] : []).concat(MUTE_OPTIONS);
  for (const o of rows) {
    const label = document.createElement("label");
    label.className = "eph-row";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "mute-option";
    input.addEventListener("change", () => {
      const muted = o.secs !== 0;
      chat.muted = muted;
      core.setChatMuted(chat.id, o.secs)
        .then(() => { if (accountIsCurrent(epoch)) valEl.textContent = muted ? "Muted" : "On"; })
        .catch((err) => errToast("Couldn't update notifications: " + (err.message || err)));
      close();
    });
    label.append(input, Object.assign(document.createElement("span"), { textContent: o.label }));
    list.appendChild(label);
  }
  const foot = document.createDocumentFragment(); // direct child of .modal-foot -> one-row flex
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn-text";
  cancel.textContent = "Cancel";
  foot.append(cancel);
  const { close } = showModal({
    title: "Mute notifications", body: list, foot,
    onClose: async () => { await modalHistorySettled(); if (accountIsCurrent(epoch)) showChatInfo(chat); },
  });
  cancel.addEventListener("click", () => close());
}

async function showChatInfo(chat) {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
  // Local group: the roster, counts and rights change under the sheet — start
  // from the adapter's current view of the group.
  if (chat.isP2pGroup) {
    try {
      const fresh = await core.getChat(chat.id);
      if (fresh) Object.assign(chat, fresh);
    } catch { /* keep what we have */ }
    if (!accountIsCurrent(epoch)) return;
  }
  // Hydrate presence for 1:1 profiles opened without it (the core tracks
  // last-seen from incoming messages; the self contact has none).
  if (!chat.contact && chat.kind === "single" && chat.contactId && chat.contactId !== 1 && core.getContact) {
    try { chat.contact = { ...(await core.getContact(chat.contactId)), contactId: chat.contactId }; } catch {}
  }
  const contactRows = chat.contact ? `
    <div class="info-row"><span class="k">Address</span><span class="v">${escapeHtml(chat.contact.addr)}</span></div>
    ${chat.contactId ? `<div class="info-row"><span class="k">Profile key</span><span class="v"><span class="avatar-profile-fpr" data-profile-key>…</span></span></div>` : ""}
    ${chat.contact && (chat.contact.online || chat.contact.lastSeen) ? `<div class="info-row"><span class="k">Last seen</span><span class="v">${chat.contact.online ? "online" : timeTag(chat.contact.lastSeen, timeAgo(chat.contact.lastSeen))}</span></div>` : ""}` : "";
  const isGroup = chat.kind === "group" || chat.kind === "channel";
  const isSelf = chat.contactId === 1;
  const isContactProfile = !isGroup && chat.contactId && !isSelf;

  // Relay rows. For 1:1 profiles: the contact's relay, derived from their
  // address (🐴 the core exposes no per-contact relay list — a multi-relay
  // contact's full address set lives in keyupdate internals; upgrade path is
  // an upstream contact-relay API, a details list like ours below would take
  // it directly). For the self profile: one relay row, or a collapsed
  // details list with a count when the account has more than one transport.
  // GROUPS show no relay rows: the account transports are identical on every
  // group sheet (relay management is account-scoped — the drawer's "Relays
  // of this profile…" is the single entry point).
  let relayRows = "";
  if (!chat.isP2p) {
    const contactAddr = isContactProfile ? chat.contact?.addr : null;
    if (contactAddr) {
      relayRows = `<div class="info-row"><span class="k">Relay</span><span class="v">${escapeHtml(String(contactAddr).split("@")[1] || contactAddr)}</span></div>`;
    } else if (!isGroup) {
      let transports = [];
      try { transports = await core.listTransports(); } catch { /* offline — fall back below */ }
      if (!transports.length && state.account.relay) transports = [{ addr: state.account.addr }];
      const row = t => `<div class="info-row" data-relays style="cursor:pointer"><span class="k">Relay</span><span class="v">${escapeHtml(t.addr || "")} ›</span></div>`;
      if (transports.length > 1) {
        relayRows = `<details class="info-details" data-relays-details>
          <summary class="info-row"><span class="k">Relays</span><span class="v" data-relays-count>(${transports.length})</span></summary>
          ${transports.map(row).join("")}
        </details>`;
      } else if (transports.length === 1) {
        relayRows = row(transports[0]);
      }
    }
  }

  const body = document.createElement("div");
  body.innerHTML = `
    <div style="display:flex;justify-content:center;align-items:center;gap:16px;padding:8px 0 0">
      <velta-avatar class="chat-info-avatar" name="${escapeHtml(chat.name)}" color="${chat.avatarColor || "#777"}" kind="${chat.kind}" size="168"${chat.contactId ? ` contact-id="${chat.contactId}"` : ""}${chat.contact && chat.contact.addr ? ` addr="${escapeAttr(chat.contact.addr)}"` : ""}${(chat.avatar || chat.contact?.avatar) ? ` avatar="${escapeAttr(fileUrl(chat.avatar || chat.contact.avatar))}"` : ""}></velta-avatar>
      ${chat.contactId ? `<span class="chat-info-tile" data-caption-tile></span>` : ""}
    </div>
    <div class="profile-name">${escapeHtml(chat.name)}</div>
    <div class="profile-description" data-desc hidden></div>
    ${(isSelf || (isGroup && !chat.isP2pGroup)) ? `<div class="profile-actions"><button type="button" class="btn-text" data-pa="ep"${chat.kind === "channel" ? " hidden" : ""}>${isSelf ? "Edit profile" : chat.kind === "channel" ? "Edit channel" : "Edit group"}</button></div>` : ""}
    ${chat.kind === "group" && !chat.isP2pGroup ? `<div class="profile-actions"><button type="button" class="btn-text" data-pa="add-members">Add members</button><button type="button" class="btn-text" data-pa="invite">Invite via link/QR</button></div>` : ""}
    ${chat.kind === "channel" ? `<div class="profile-actions"><button type="button" class="btn-text" data-pa="invite">Invite via link/QR</button></div>` : ""}
    ${chat.isP2pGroup ? p2pGroupActionsHtml(chat) : ""}
    ${!isGroup && chat.contactId && chat.contactId !== 1 ? `<div class="profile-actions">
      <button type="button" class="btn-text" data-pa="send">Send message</button>
      <button type="button" class="btn-text" data-pa="rename">Edit name</button>
      <button type="button" class="btn-text" data-pa="block" style="color:var(--danger)">Block</button>
    </div>` : ""}
    ${isGroup ? `<details class="info-details" data-members-details${chat.isP2pGroup ? " open" : ""}>
      <summary class="info-row"><span class="k">Members</span><span class="v" data-member-count>…</span></summary>
      <div class="modal-list" data-member-list style="max-height:240px;overflow:auto"></div>
    </details>` : ""}
    ${chat.isP2pGroup ? `<div class="profile-description" data-pg-hint style="font-size:13px;opacity:.75;padding:6px 2px" hidden></div>` : ""}
    ${contactRows}
    ${!chat.isP2p && !isSelf && (chat.kind === "group" || chat.kind === "channel" || chat.kind === "single") ? `<div class="info-row" data-muted style="cursor:pointer"><span class="k">Notifications</span><span class="v" data-muted-val>${chat.muted ? "Muted" : "On"}</span></div>` : `<div class="info-row"><span class="k">Notifications</span><span class="v">${chat.muted ? "Muted" : "On"}</span></div>`}
    ${!chat.isP2p && !isSelf && (chat.kind === "group" || chat.kind === "single") ? `<div class="info-row" data-ephemeral style="cursor:pointer"><span class="k">Disappearing messages</span><span class="v" data-ephemeral-val>…</span></div>` : ""}
    ${!chat.isP2p ? `<div class="info-row"><span class="k">Storage</span><span class="v" data-storage-val>…</span></div>
    <details class="info-details" data-old-messages>
      <summary class="info-row"><span class="k">Old messages</span><span class="v">Clean up ›</span></summary>
      ${OLD_MESSAGE_SPANS.map(([label, ms]) => `<div class="info-row" data-old-age="${ms}" style="cursor:pointer"><span class="k">Delete older than ${label}</span><span class="v">›</span></div>`).join("")}
    </details>` : ""}
    ${relayRows}
    ${!isGroup && chat.contactId ? `<details class="info-details" data-common hidden>
      <summary class="info-row"><span class="k">Chats in common</span><span class="v" data-common-count></span></summary>
      <div class="modal-list" data-common-list style="max-height:180px;overflow:auto"></div>
    </details>` : ""}`;
  // Name sits below the avatar now, so the head bar carries only the close.
  const modal = showModal({ title: "", body });

  // Disappearing messages row: hydrate the current timer, open the editor.
  const ephRow = body.querySelector("[data-ephemeral]");
  if (ephRow && core.getChatEphemeralTimer) {
    const ephVal = ephRow.querySelector("[data-ephemeral-val]");
    (async () => {
      try {
        const t = await core.getChatEphemeralTimer(chat.id);
        if (!accountIsCurrent(epoch)) return;
        ephVal.textContent = formatEphemeralTimer(t);
      } catch { ephVal.textContent = "Off"; }
    })();
    ephRow.addEventListener("click", () => openEphemeralDialog(chat, ephVal, epoch));
  }
  // Storage row: sum attachment bytes across the whole chat (paged newest→
  // oldest; text is negligible). Computed on sheet open — lazy by design,
  // the core has no per-chat size API (see VENDORISSUES #10 sibling idea).
  const storageVal = body.querySelector("[data-storage-val]");
  const runStorageSum = async () => {
    if (!storageVal) return;
    try {
      let total = 0;
      let beforeId = null;
      let hasMore = true;
      while (hasMore) {
        // Sheet closed (or chat switched) → stop burning RPCs on a row
        // nobody is watching.
        if (!storageVal.isConnected || !accountIsCurrent(epoch)) return;
        const page = await core.getMessages(chat.id, { beforeId, limit: 500 });
        if (!storageVal.isConnected || !accountIsCurrent(epoch)) return;
        const msgs = page.messages || [];
        // fileSize (not the core's raw fileBytes): rpc-core._mapMessage
        // renames it, and the row consumes mapped messages.
        for (const m of msgs) total += m.fileSize || 0;
        // Huge groups walk for a while — show the count-up instead of a
        // frozen "…".
        storageVal.textContent = formatBytes(total) + "…";
        hasMore = !!page.hasMore && msgs.length > 0;
        // Pages are oldest→newest: chain from the SMALLEST id. Chaining
        // the last (newest) id re-returns the same window forever —
        // that was the 73 GB double-count.
        beforeId = msgs.length ? Math.min(...msgs.map(m => m.id)) : null;
        if (beforeId == null) break;
      }
      storageVal.textContent = formatBytes(total);
    } catch {
      storageVal.textContent = "—";
    }
  };
  if (storageVal) runStorageSum();
  // "Old messages" cleanup (same helper as the chat-list menu): after a
  // delete the Storage row recomputes so the number reflects reality.
  for (const row of body.querySelectorAll("[data-old-age]")) {
    row.addEventListener("click", async () => {
      const ms = Number(row.dataset.oldAge);
      const span = OLD_MESSAGE_SPANS.find(([, v]) => v === ms);
      const ok = await confirmModal(
        "Delete old messages",
        `Delete every message in "${chat.name}" older than ${span ? span[0] : ""}? Pinned messages are kept. This cannot be undone.`,
        "Delete",
        true,
      );
      // The confirm modal replaced this sheet (showModal is one-at-a-time);
      // restore the sheet the same way the mute/ephemeral dialogs do.
      const reopen = async () => {
        await modalHistorySettled();
        if (accountIsCurrent(epoch)) showChatInfo(chat);
      };
      if (!ok) { await reopen(); return; }
      if (!accountIsCurrent(epoch)) return;
      try {
        const deleted = await core.deleteMessagesOlderThan(chat.id, Date.now() - ms);
        if (!accountIsCurrent(epoch)) return;
        toast(deleted ? `Deleted ${deleted} message${deleted === 1 ? "" : "s"}` : "Nothing older than that");
        if (deleted) {
          // The open chat view refreshes itself via msgs-changed; the sheet
          // reopens below and the Storage row recomputes.
          refreshChatList();
        }
      } catch (err) {
        errToast("Couldn't delete: " + (err?.message || err));
      }
      await reopen();
    });
  }
  // Notifications row: the mute dialog (official client's action sheet).
  const muteRow = body.querySelector("[data-muted]");
  if (muteRow && core.setChatMuted) {
    muteRow.addEventListener("click", () => openMuteDialog(chat, muteRow.querySelector("[data-muted-val]"), epoch));
  }
  // Channel members without posting rights can't edit the channel info:
  // the Edit button starts hidden and appears only when the core's can_send
  // grants it — the same rights source that gates the composer (§5.1
  // read-only rule). Groups keep the button for every member (DC semantics:
  // any member may rename/re-icon).
  if (chat.kind === "channel") {
    core.canSend?.(chat.id).then(can => {
      if (!accountIsCurrent(epoch) || !can) return;
      body.querySelector('[data-pa="ep"]').hidden = false;
    }).catch(() => {});
  }
  // Groups: add members via the shared contact picker. Channels: link/QR
  // only (subscribe flows run through the core's secure-join invite).
  body.querySelector('[data-pa="add-members"]')?.addEventListener("click", async () => {
    const picked = await pickContactModal("Add members", true);
    if (!picked?.length || !accountIsCurrent(epoch)) return;
    try {
      await core.addChatMembers(chat.id, picked.map(c => c.id));
      if (!accountIsCurrent(epoch)) return;
      refreshChatList();
      toast(picked.length === 1 ? "Member added" : `${picked.length} members added`);
      await modalHistorySettled();
      showChatInfo(chat); // fresh sheet: member count and list updated
    } catch (err) {
      errToast("Couldn't add members: " + (err.message || err));
    }
  });
  body.querySelector('[data-pa="invite"]')?.addEventListener("click", () => {
    showInvite(inviteQrProvider(chat.id), { title: chat.name, group: true });
  });

  // Description block below the name: contact bio/status for profiles, chat
  // description for groups/channels. Stays hidden when empty; the value also
  // prefills the merged profile editor (issue #16).
  const descEl = body.querySelector("[data-desc]");
  let currentDesc = "";
  (async () => {
    try {
      let desc = "";
      let photo = null;
      if (chat.contactId) {
        const c = await core.getContact(chat.contactId);
        desc = c?.status || "";
        photo = c?.avatar || null;
      } else if (core.getChatDescription) {
        desc = (await core.getChatDescription(chat.id)) || "";
      }
      currentDesc = desc.trim();
      if (accountIsCurrent(epoch)) {
        if (currentDesc) {
          descEl.textContent = currentDesc;
          descEl.hidden = false;
        }
        // The self contact's photo: the sheet stub may predate it (or the
        // photo may have been set on another device) — hydrate it late.
        const ava = body.querySelector(".chat-info-avatar");
        if (photo && ava && !ava.getAttribute("avatar")) {
          ava.setAttribute("avatar", fileUrl(photo));
        }
      }
    } catch {}
  })();

  // Edit name & picture: the own profile reuses the drawer's flow; groups and
  // channels apply the same editor to set_chat_name / set_chat_profile_image.
  const epBtn = body.querySelector('[data-pa="ep"]');
  if (epBtn) {
    epBtn.addEventListener("click", async () => {
      if (isSelf) {
        await editProfileFlow();
        if (!accountIsCurrent(epoch)) return;
        // the sheet stub carries the old name/avatar — refresh from the account
        chat.name = state.account?.displayName || chat.name;
        chat.avatar = state.account?.avatar || null;
        await modalHistorySettled();
        showChatInfo(chat);
        return;
      }
      const result = await showEditProfile({
        name: chat.name,
        avatarUrl: chat.avatar ? fileUrl(chat.avatar) : "",
        color: chat.avatarColor,
        description: currentDesc,
        pickImage: pickProfileImage,
        contactId: 0,
        kind: "group",
        title: chat.kind === "channel" ? "Edit channel" : "Edit group",
      });
      if (!result || !accountIsCurrent(epoch)) return;
      try {
        const name = result.name.trim();
        if (name && name !== chat.name) await core.renameChat(chat.id, name);
        if (result.description !== currentDesc) await core.setChatDescription(chat.id, result.description);
        if (result.avatar === "remove") await core.setChatImage(chat.id, null);
        else if (result.avatar !== "keep") await core.setChatImage(chat.id, result.avatar.path);
        if (!accountIsCurrent(epoch)) return;
        if (name) chat.name = name;
        chat.avatar = result.avatar === "remove" ? null
          : (result.avatar !== "keep" ? result.avatar.path : chat.avatar);
        refreshChatList();
        if (state.activeChatHead && state.activeChatId === chat.id) {
          const fresh = renderChatHead(chat);
          state.activeChatHead?.replaceWith(fresh);
          state.activeChatHead = fresh;
        }
        await modalHistorySettled();
        showChatInfo(chat); // fresh sheet — the editor's pop has landed by now
      } catch (err) {
        errToast("Couldn't update the chat: " + (err.message || err));
      }
    });
  }

  // Relay transports (multi-relay) — tapping a relay row opens the relays
  // manager for the current account.
  body.querySelectorAll("[data-relays]").forEach(el => el.addEventListener("click", () => openRelaysModal()));

  // Profile action buttons (single chats, not the self contact): send, share, rename, block.
  if (!isGroup && chat.contactId && chat.contactId !== 1) {
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
      } catch { errToast("Couldn't open the chat"); }
    });
    actBtn("rename")?.addEventListener("click", () => {
      const input = document.createElement("input");
      input.className = "text-field"; input.maxLength = 64; input.required = true;
      input.value = (chat.contact && chat.contact.name) || chat.name || "";
      const wrap = document.createElement("div");
      wrap.appendChild(input);
      const renameModal = { close: null };
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "btn-text btn-primary"; save.textContent = "Save";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn-text"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => renameModal.close());
      const foot = document.createElement("div");
      foot.className = "modal-foot edit-profile-foot";
      foot.append(cancel, save);
      const m = showModal({ title: "Edit name", body: wrap, foot, form: true });
      renameModal.close = m.close;
      m.form.addEventListener("submit", async () => {
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
          errToast("Rename failed: " + (err.message || err));
          save.disabled = false;
        }
      });
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
      } catch (err) { errToast("Failed: " + (err.message || err)); }
    });
  }

  // Same formatted key as the Avatar modal (avatar-profile-fpr), filled in
  // once the contact's fingerprint resolves. The captioned identity tile
  // (avatar-profile-img) fills its slot in the same row as the velta-avatar.
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
      const details = body.querySelector("[data-common]");
      const list = body.querySelector("[data-common-list]");
      if (!details || !list || !document.contains(details)) return;
      if (!common.length) return; // no chats in common — details stays hidden
      const count = details.querySelector("[data-common-count]");
      if (count) count.textContent = `(${common.length})`;
      for (const c of common) {
        const row = document.createElement("div");
        row.className = "info-row clickable";
        row.innerHTML = `<span class="k">${escapeHtml(c.name)}</span><span class="v">${c.unread ? c.unread + " unread" : ""}</span>`;
        row.addEventListener("click", () => { modal.close(); openChat(c.id); });
        list.appendChild(row);
      }
      details.hidden = false;
    }).catch(() => {});
  }

  if (chat.isP2pGroup) {
    const gid = String(chat.id).slice("p2pg:".length);
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
    // The management dialogs replace the sheet (showModal swaps popups in
    // place): always come back to a fresh one.
    const reopen = async () => {
      if (!accountIsCurrent(epoch)) return;
      await modalHistorySettled();
      showChatInfo(chat);
    };
    const act = (name, fn) => body.querySelector(`[data-pg="${name}"]`)?.addEventListener("click", async () => {
      try { await fn(); } catch (err) { errToast(String(err?.message || err)); }
    });
    act("rename", async () => {
      const name = await askText("Group name", chat.name, "Save");
      if (name && name.trim() && name.trim() !== chat.name) {
        await groupRename(gid, name.trim());
        toast("Group renamed");
        refreshChatList();
      }
      await reopen();
    });
    act("add", async () => {
      if (!invoke) return;
      let n = null;
      try { n = await showAddMembersModal(invoke, gid); } catch (err) { errToast(String(err?.message || err)); }
      if (n) { toast(n === 1 ? "Member added" : `${n} members added`); refreshChatList(); }
      await reopen();
    });
    act("leave", async () => { await leaveLocalGroupFlow(chat, epoch); });
    act("delete", async () => { await deleteLocalGroupChat(chat, epoch); });
    body.addEventListener("click", async e => {
      const btn = e.target.closest?.("[data-pg-remove]");
      if (!btn) return;
      e.preventDefault();
      const id = btn.dataset.pgRemove;
      const name = btn.getAttribute("aria-label")?.replace(/^Remove /, "") || "this member";
      const ok = await confirmModal("Remove member",
        `Remove ${name} from "${chat.name}"? They stop receiving new messages and keep what they already have.`, "Remove", true);
      if (ok && accountIsCurrent(epoch)) {
        try { await groupRemoveMember(gid, id); toast("Member removed"); refreshChatList(); }
        catch (err) { errToast("Couldn't remove: " + (err?.message || err)); }
      }
      await reopen();
    });
  }

  if (isGroup && core.getChatMembers) {
    core.getChatMembers(chat.id).then(members => {
      const count = body.querySelector("[data-member-count]");
      const list = body.querySelector("[data-member-list]");
      if (count) count.textContent = members.length.toLocaleString();
      const hint = body.querySelector("[data-pg-hint]");
      if (hint) {
        hint.hidden = false;
        hint.textContent = groupMemberHint(chat, members);
      }
      if (list) {
        for (const m of members) {
          // #72: the subtitle is the member's RELAY (address domain) — the
          // "which relay is everyone on" read; the full address rides the
          // title tooltip.
          // Local P2P group: the subtitle is the member's reachability
          // (members the user has not paired with are only known through
          // the group — they're reached via the mesh).
          const domain = chat.isP2pGroup
            ? (m.self ? "you" : (m.online ? "online" : "offline") + (m.introduced ? " · not paired" : "")) + (m.isCreator ? " · admin" : "")
            : (m.addr || "").split("@")[1] || "";
          const row = document.createElement("div");
          row.className = "info-row";
          const dot = chat.isP2pGroup ? `<span style="color:${m.online ? "#2ecc71" : "#7a7a85"}" aria-hidden="true">●</span> ` : "";
          const canRemove = chat.isP2pGroup && chat.canManage && !chat.readOnly && !m.self && !m.isCreator;
          row.innerHTML = `<span class="k" style="color:${escapeAttr(m.color || "#888")}">${dot}${escapeHtml(m.name)}</span><span class="v"${domain && !chat.isP2pGroup ? ` title="${escapeAttr(m.addr)}"` : ""}>${escapeHtml(domain)}${canRemove ? ` <button type="button" class="btn-text" data-pg-remove="${escapeAttr(m.id)}" aria-label="Remove ${escapeAttr(m.name)}">Remove</button>` : ""}</span>`;
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
      ...(chat.kind === "group" && !chat.isP2pGroup ? [{ label: "Group invite QR", onClick: () =>
        showInvite(inviteQrProvider(chat.id), { title: chat.name, group: true }) }] : []),
      // Local P2P chats have no per-chat mute / pin (flags are relay-core state).
      ...(chat.isP2p ? [] : [
        { label: chat.muted ? "Unmute" : "Mute", onClick: () => core.setChatFlags(chat.id, { muted: !chat.muted }) },
        { label: chat.pinned ? "Unpin" : "Pin", onClick: () => core.setChatFlags(chat.id, { pinned: !chat.pinned }) },
      ]),
      ...(chat.isP2pGroup && chat.readOnly ? [{
        label: "Delete chat", danger: true,
        onClick: () => deleteLocalGroupChat(chat, epoch),
      }] : []),
      ...((chat.kind === "group" || chat.kind === "channel") && !(chat.isP2pGroup && chat.readOnly) ? [{
        label: chat.kind === "channel" ? "Leave channel" : chat.isP2pGroup && chat.canManage ? "Disband group" : "Leave group",
        onClick: async () => {
          if (chat.isP2pGroup) return leaveLocalGroupFlow(chat, epoch);
          const ok = await confirmModal(
            chat.kind === "channel" ? "Leave channel" : "Leave group",
            chat.kind === "channel"
              ? "You will no longer receive messages from this channel. Re-subscribe via its invite link/QR."
              : "You will leave this chat and no longer receive its messages.",
            "Leave", true);
          if (!ok || !accountIsCurrent(epoch)) return;
          try {
            await core.leaveGroup(chat.id);
            if (!accountIsCurrent(epoch)) return;
            refreshChatList();
            // The left chat turns read-only in place — no composer, same as
            // channels; reopening shows the history until the user leaves it
            // out of the list themselves.
            $("main-composer").hidden = true;
            chatView.readOnly = true;
          } catch (err) {
            errToast("Couldn't leave: " + (err.message || err));
          }
        },
      }] : []),
      ...(chat.isP2pGroup ? [] : [
      "-",
      { label: "Clear history", danger: true, onClick: async () => {
        if (await confirmModal("Clear history", "Delete all messages in this chat?")) {
          if (!accountIsCurrent(epoch)) return;
          // Ids only (#47): loading every full message just to map ids
          // made clearing a large chat pay for all of them.
          await core.deleteMessages(chat.id, await core.getMessageIds(chat.id));
        }
      } },
      ]),
    ], r.right - 220, r.bottom + 6);
  });
  $("btn-back").addEventListener("click", closeChat);
  $("btn-chat-search").addEventListener("click", () => {
    const epoch = core.accountEpoch;
    const chat = state.chats.find(c => c.id === state.activeChatId);
    if (!chat) return;
    const chatId = chat.id;
    const p2p = chat.isP2p || String(chatId).startsWith("p2p:");
    const input = document.createElement("input");
    input.type = "search";
    input.enterKeyHint = "search";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Search in chat");
    input.className = "text-field";
    input.placeholder = p2p ? "Search in loaded messages…" : "Search in chat…";
    const results = document.createElement("div");
    results.className = "modal-list";
    const wrap = document.createElement("div");
    wrap.append(input, results);
    const emptyHint = p2p
      ? `Nothing found in loaded history.`
      : `Nothing found.`;
    // Core-backed fulltext search (FTS, all history — groups included).
    // P2P/local chats live in their own id space: filter loaded rows only.
    const runSearch = async (q) => {
      if (q.length < 2) return [];
      if (p2p) {
        return chatView.items
          .filter(i => i.type === "msg" && i.msg.text?.toLowerCase().includes(q))
          .slice(-12).map(i => i.msg);
      }
      return await core.searchMessages(q, chatId);
    };
    let timer = 0;
    let seq = 0;
    const search = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim().toLowerCase();
        const mySeq = ++seq;
        results.replaceChildren();
        if (q.length < 2) return;
        let hits = [];
        try {
          hits = await runSearch(q);
        } catch (e) {
          results.innerHTML = `<p style="color:var(--text-dim);font-size:14px;padding:8px 0">Search failed: ${escapeHtml(String(e?.message || e))}</p>`;
          return;
        }
        if (mySeq !== seq || !accountIsCurrent(epoch)) return;
        for (const m of hits) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ctx-item";
          b.innerHTML = `<span><b>${escapeHtml(m.fromContact?.name || "")}</b>: ${escapeHtml((m.text || "").slice(0, 80))}</span>`;
          b.addEventListener("click", () => { closeAllPopups(); chatView._jumpToMessage(m.id); });
          results.appendChild(b);
        }
        if (!hits.length) results.innerHTML = `<p style="color:var(--text-dim);font-size:14px;padding:8px 0">${emptyHint}</p>`;
      }, 250);
    };
    input.addEventListener("input", search);
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
      const item = document.createElement("velta-chat-item");
      item.setData({
        id: "c" + c.id, name: c.name, kind: "single", avatarColor: c.color,
        contactId: c.id, avatar: c.avatar || null,
        encrypted: true, lastMsg: c.addr, lastTs: 0,
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
    const foot = document.createDocumentFragment(); // direct child of .modal-foot -> one-row flex
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn-text"; ok.textContent = multi ? "Create" : "OK";
    ok.disabled = true;
    foot.append(cancel, ok);
    const { close } = showModal({ title, body: list, foot, onClose: () => resolve(null) });
    cancel.addEventListener("click", () => { close(); resolve(null); });
    ok.addEventListener("click", () => { resolve(contacts.filter(c => selected.has(c.id))); close(); });
  });
}

// New-chat actions, rendered as rows of the "+" side view (they used to be
// a floating context menu anchored to the FAB). Each action closes the view
// first; flows that the user cancels land back on the chats list.
function newChatOptions() {
  return [
    { label: "New chat", onClick: async () => {
      const epoch = core.accountEpoch;
      const picked = await pickContactModal("New chat");
      if (picked && accountIsCurrent(epoch)) {
        const id = await core.createChat(picked[0].name, [picked[0].id], "single");
        if (!accountIsCurrent(epoch)) return;
        await refreshChatList();
        if (!accountIsCurrent(epoch)) return;
        openChat(id);
      }
    } },
    { label: p2pEnabled() && p2pAvailable() ? "New group (via relay)" : "New group", onClick: async () => {
      const epoch = core.accountEpoch;
      const picked = await pickContactModal("Add group members", true);
      if (!picked || !accountIsCurrent(epoch)) return;
      const name = await askGroupName();
      if (!name || !accountIsCurrent(epoch)) return;
      {
        const id = await core.createChat(name, picked.map(c => c.id), "group");
        if (!accountIsCurrent(epoch)) return;
        await refreshChatList();
        if (!accountIsCurrent(epoch)) return;
        openChat(id);
      }
    } },
    ...(p2pEnabled() && p2pAvailable() ? [{ label: "New local group (no relay)", onClick: newLocalGroupFlow }] : []),
    { label: "Join chat via invite link", onClick: joinFlow },
    { label: "Add account via invite link", onClick: () => openProfileManagement() },
  ];
}

function renderNewChatView() {
  const rows = sideViewShell("Start something", "Pick what to create");
  for (const opt of newChatOptions()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-item side-option";
    b.innerHTML = `<span class="side-option-label">${escapeHtml(opt.label)}</span>
      <svg viewBox="0 0 24 24" class="side-option-arrow"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    b.addEventListener("click", () => { setListView("chats"); opt.onClick(); });
    rows.append(b);
  }
}

// Search screen: two tabs — Search (live chat-name filter, the default the
// head button opens) and Archived (the folder folded in here; the standalone
// archived side view and its head button are gone). The head X closes the
// whole screen from either tab.
function renderSearchView() {
  const shell = document.getElementById("chat-list");
  shell.innerHTML = `
    <div class="side-view">
      <div class="chat-cats side-tabs" role="tablist">
        <button type="button" role="tab" data-tab="search">Search</button>
        <button type="button" role="tab" data-tab="archived">Archived${archivedCount ? ` (${archivedCount})` : ""}</button>
      </div>
      <div class="side-view-rows" data-tab-body></div>`;
  const body = shell.querySelector("[data-tab-body]");
  const syncTabs = () => {
    for (const b of shell.querySelectorAll("[data-tab]")) b.classList.toggle("active", b.dataset.tab === searchScreenTab);
  };
  for (const b of shell.querySelectorAll("[data-tab]")) {
    b.addEventListener("click", () => {
      if (searchScreenTab === b.dataset.tab) return;
      searchScreenTab = b.dataset.tab;
      renderSearchView();
    });
  }
  syncTabs();
  const rows = body;
  if (searchScreenTab === "archived") {
    renderArchivedTab(rows);
    return;
  }
  const input = document.createElement("input");
  input.type = "search";
  input.enterKeyHint = "search";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Search chats");
  input.className = "text-field side-search-input";
  input.placeholder = "Search chats…";
  const results = document.createElement("div");
  rows.append(input, results);
  const render = () => {
    if (listView !== "search") return;
    const q = input.value.trim().toLowerCase();
    results.replaceChildren();
    if (q.length < 2) {
      results.innerHTML = `<div class="side-view-empty">Type to search chats.</div>`;
      return;
    }
    const hits = state.chats.filter(c => (c.name || "").toLowerCase().includes(q)).slice(0, 30);
    if (!hits.length) {
      results.innerHTML = `<div class="side-view-empty">No chats found.</div>`;
      return;
    }
    for (const c of hits) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chat-item side-option";
      b.innerHTML = `<span class="side-option-label">${escapeHtml(c.name)}</span>
        <svg viewBox="0 0 24 24" class="side-option-arrow"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      b.addEventListener("click", () => openChat(c.id));
      results.appendChild(b);
    }
  };
  input.addEventListener("input", render);
  render();
  setTimeout(() => input.focus(), 60);
}

// Group-name modal — the native prompt() renders as an OS dialog and is
// disabled outright in some WebViews. Same shape as p2p's promptName.
// One-input modal for the drawer/hub flows (returns the trimmed value or null).
function askText(title, value, okLabel) {
  return new Promise(resolve => {
    const body = document.createElement("div");
    body.innerHTML = `<input class="text-field" maxlength="64" placeholder="${escapeAttr(title)}">`;
    const input = body.querySelector("input");
    input.value = value || "";
    const foot = document.createDocumentFragment();
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "btn-text btn-primary";
    ok.style.width = "auto";
    ok.textContent = okLabel || "Save";
    foot.append(cancel, ok);
    const done = v => { resolve(v); close(); };
    const { close, form } = showModal({ title, body, foot, form: true, onClose: () => resolve(null) });
    form.addEventListener("submit", () => done(input.value.trim()));
    cancel.addEventListener("click", () => done(null));
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

function askGroupName() {
  return new Promise(resolve => {
    const body = document.createElement("div");
    body.innerHTML = `<input class="text-field" maxlength="60" placeholder="Group name" value="New group">`;
    const input = body.querySelector("input");
    // Fragment, not a wrapping div: the buttons land as direct children of
    // .modal-foot and inherit its one-row flex layout.
    const foot = document.createDocumentFragment();
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "btn-text btn-primary";
    ok.style.width = "auto"; // btn-primary defaults to the full-width onboarding bar
    ok.textContent = "Create group";
    foot.append(cancel, ok);
    const done = value => { resolve(value); close(); };
    const { close, form } = showModal({ title: "New group", body, foot, form: true, onClose: () => resolve(null) });
    form.addEventListener("submit", () => done(input.value.trim() || "New group"));
    cancel.addEventListener("click", () => done(null));
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

// Profile management: one tabbed modal for the profile lifecycle — add a
// profile, second-device transfer, backup export. Tabs lock while a flow
// runs inside one (camera capture and transfers are stateful). The second
// device "receive" branch hands over to its own full-screen steps, which
// replaces this modal by design.
function openProfileManagement() {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="pm-tabs" data-tabs>
      <button type="button" class="pm-tab active" data-tab="add">Add profile</button>
      <button type="button" class="pm-tab" data-tab="device">Second device</button>
      <button type="button" class="pm-tab" data-tab="export">Export backup</button>
      <button type="button" class="pm-tab" data-tab="delete" style="color:var(--danger)">Delete profile</button>
    </div>
    <label class="scale-opt" style="margin:2px 2px 10px" title="Only the selected profile runs mail sync; background profiles are fully paused.">
      <input type="checkbox" role="switch" data-sync-only>
      <span>Sync only active profile — other profiles won't receive messages until you switch to them</span>
    </label>
    <div class="pm-pane" data-pane="add">
      <p class="pm-hint">Paste a <b>chatmail</b> invite link (<span>dcaccount:…</span>) or a relay domain — a new end-to-end encrypted profile is created on it.</p>
      <form data-add-form>
        <input class="text-field" data-relay required placeholder="Relay address — e.g. nine.testrun.org" autocomplete="off" inputmode="url" autocapitalize="none" spellcheck="false">
        <div class="pm-actions">
          <button type="button" class="btn-text" data-scan>Scan a QR code</button>
          <button type="submit" class="btn-primary" data-add>Add profile</button>
        </div>
      </form>
    </div>
    <div class="pm-pane" data-pane="device" hidden>
      <p class="p2p-hint">Move this profile to a new device, or receive a profile from another one. Both devices must be on the same network.</p>
      <div class="pm-actions pm-col">
        <button type="button" class="btn-text btn-primary" data-old>Show QR on this device</button>
        <button type="button" class="btn-text" data-new>Receive a profile on this device…</button>
      </div>
      <div data-transfer-pane></div>
    </div>
    <div class="pm-pane" data-pane="export" hidden>
      <p class="pm-hint">Write this profile — messages, contacts and keys — into a backup file. The profile stays signed in.</p>
      <input class="text-field" data-dest placeholder="Choose a folder…" readonly>
      <input class="text-field" data-pass type="password" minlength="6" placeholder="Passphrase (optional, min 6 chars)" autocomplete="new-password">
      <div class="pm-actions"><button type="button" class="btn-primary" data-export disabled>Export backup</button></div>
      <div class="pm-progress" data-progress hidden></div>
    </div>
    <div class="pm-pane" data-pane="delete" hidden>
      <p class="pm-hint">Removes <b data-del-name></b> for good: the account, its keys, the message database and all blobs on this device. This cannot be undone.</p>
      <p class="pm-hint">Tip: write an <b>Export backup</b> first — it is the only copy that survives this.</p>
      <p class="pm-hint" data-del-last hidden style="color:var(--danger)">This is the last remaining profile — it cannot be deleted here.</p>
      <div data-del-form>
        <p class="pm-hint">Type the profile's address (<b data-del-addr></b>) to confirm.</p>
        <input class="text-field" data-del-confirm autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Type the profile address to confirm deletion">
        <div class="pm-actions"><button type="button" class="btn-text" data-delete disabled style="color:var(--danger)">Delete this profile</button></div>
        <div class="pm-progress" data-del-progress hidden></div>
      </div>
    </div>`;

  const tabsBox = body.querySelector("[data-tabs]");
  const panes = {
    add: body.querySelector('[data-pane="add"]'),
    device: body.querySelector('[data-pane="device"]'),
    export: body.querySelector('[data-pane="export"]'),
    delete: body.querySelector('[data-pane="delete"]'),
  };
  const lock = (on) => tabsBox.classList.toggle("locked", on);
  tabsBox.addEventListener("click", e => {
    const tab = e.target.closest("[data-tab]");
    if (!tab || tabsBox.classList.contains("locked")) return;
    tabsBox.querySelectorAll(".pm-tab").forEach(t => t.classList.toggle("active", t === tab));
    for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== tab.dataset.tab;
  });

  /* -- sync only active profile (#101) -- */
  const syncOnly = body.querySelector("[data-sync-only]");
  syncOnly.checked = core.syncOnlyActive === true ||
    localStorage.getItem("velta-sync-only-active") === "1";
  syncOnly.addEventListener("change", async () => {
    const on = syncOnly.checked;
    localStorage.setItem("velta-sync-only-active", on ? "1" : "0");
    core.syncOnlyActive = on;
    try {
      await core.applySyncMode();
    } catch (err) {
      errToast("Couldn't apply the sync mode: " + (err?.message || err));
    }
  });

  /* -- add profile -- */
  const relayInput = panes.add.querySelector("[data-relay]");
  const submitAdd = async () => {
    const link = normalizeRelayLink(relayInput.value);
    const invite = parseRelayInvite(relayInput.value);
    if (!link && !invite) {
      toast(relayInput.value.trim() ? "That doesn't look like a chatmail relay, invite link, or dcaccount: link" : "Enter a relay address");
      return;
    }
    if (invite) {
      lock(true);
      await createAccountFromRelayInvite(invite.host, invite.token);
      lock(false);
      if (accountIsCurrent(epoch) && state.accounts.length > 1) close();
      return;
    }
    if (!(await ensureMailTunnelForLink(link))) return;
    lock(true);
    await addAccountFromInvite(link);
    lock(false);
    // A successful add switches the active account; drop the modal so the
    // refreshed drawer/UI takes over.
    if (accountIsCurrent(epoch) && state.accounts.length > 1) close();
  };
  panes.add.querySelector("[data-add-form]").addEventListener("submit", e => { e.preventDefault(); submitAdd(); });
  panes.add.querySelector("[data-scan]").addEventListener("click", async () => {
    const code = await acquireCode({
      title: "Add account",
      hint: "Paste a chatmail invite link (<code>dcaccount:…</code>), just a relay domain like <code>nine.testrun.org</code>, or scan a QR code in the Delta Chat app to add another profile.",
      validate: c => (normalizeRelayLink(c) ? null : "That doesn't look like a chatmail relay or dcaccount: link"),
    });
    if (!code) return;
    relayInput.value = code;
    submitAdd();
  });

  /* -- second device -- */
  let transferStarted = false;
  let progHandler = null;
  const transferPane = panes.device.querySelector("[data-transfer-pane]");
  const cleanupTransfer = () => {
    if (progHandler) { core.removeEventListener("imex-progress", progHandler); progHandler = null; }
    if (transferStarted) core.stopOngoingProcess?.().catch?.(() => {});
  };
  panes.device.querySelector("[data-old]").addEventListener("click", () => {
    if (!accountIsCurrent(epoch)) return;
    transferStarted = true;
    lock(true);
    transferPane.innerHTML = `
      <div class="qr-box" style="margin-top:10px"><div class="qr-loading">Preparing QR…</div></div>
      <div class="p2p-hint" style="opacity:.6">On the new device, tap "Receive a profile on this device" and scan or paste this code. Keep both devices on this screen until the transfer finishes.</div>
      <div style="margin-top:8px"><button type="button" class="btn-text" data-cancel>Cancel</button></div>`;
    const transferDone = () => {
      if (!accountIsCurrent(epoch)) return;
      cleanupTransfer();
      toast("Profile transferred to the second device");
      close();
    };
    progHandler = (e) => {
      if ((e.detail?.progress || 0) >= 1000) transferDone();
    };
    core.addEventListener("imex-progress", progHandler);
    // Blocks server-side until a device retrieves the backup; it can outlive
    // the RPC timeout — completion is detected via ImexProgress above.
    core.provideBackup().then(transferDone).catch(() => {});
    transferPane.querySelector("[data-cancel]").addEventListener("click", () => {
      cleanupTransfer();
      transferPane.innerHTML = "";
      lock(false);
    });
    core.getBackupQrSvg().then((svg) => {
      if (accountIsCurrent(epoch)) {
        transferPane.querySelector(".qr-box").innerHTML = svg;
        // The card reserves a clear circle at 50% / 43.65% — same overlay
        // as the invite QR.
        transferPane.querySelector(".qr-box").insertAdjacentHTML("beforeend",
          `<div class="qr-self"><img src="./icons/v-logo.svg" alt=""></div>`);
      }
    }).catch((err) => {
      if (accountIsCurrent(epoch)) transferPane.querySelector(".qr-box").innerHTML =
        `<div class="qr-loading">Couldn't prepare the transfer:<br>${escapeHtml(String(err?.message || err))}</div>`;
    });
  });
  panes.device.querySelector("[data-new]").addEventListener("click", () => {
    if (!accountIsCurrent(epoch)) return;
    // Hands over to its own full-screen code sheet + steps, replacing this
    // modal (closeAllPopups inside) — nothing to clean up here.
    receiveSecondDeviceProfile(epoch, () => { transferStarted = true; });
  });

  /* -- export backup -- */
  const destInput = panes.export.querySelector("[data-dest]");
  const passInput = panes.export.querySelector("[data-pass]");
  const exportBtn = panes.export.querySelector("[data-export]");
  const progressBox = panes.export.querySelector("[data-progress]");
  const isAndroid = /Android/.test(navigator.userAgent);
  // #104: wasm core (PWA) has no folder picker — the backup tar is written
  // into memfs and downloaded by the browser; desktop/Android paths unchanged.
  const pwaExport = core.backend?.kind === "worker-wasm" && !!core.transport?.readCoreFileList;
  if (pwaExport) {
    panes.export.querySelector(".pm-hint").textContent =
      "Writes this profile — messages, contacts and keys — into a backup archive and downloads it. The profile stays signed in.";
    destInput.value = "/backup/export";
    exportBtn.disabled = false;
  } else if (isAndroid) {
    // No directory picker on Android — export into a fixed folder next to
    // the accounts directory and surface the path in the field.
    destInput.value = (window.veltaAccountsDir || "").replace(/\/accounts\/?$/, "") + "/exports";
    exportBtn.disabled = false;
  } else {
    const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
    if (!tauriInvoke) {
      // #104: no export path in this backend — say so instead of a dead field.
      destInput.placeholder = "Backup export needs the desktop app or the Velta PWA";
      destInput.readOnly = true;
    } else {
      destInput.addEventListener("click", async () => {
        try {
          const picked = await tauriInvoke("plugin:dialog|open", { options: { directory: true, multiple: false, title: "Choose backup folder" } });
          if (typeof picked === "string" && picked) {
            destInput.value = picked;
            exportBtn.disabled = false;
          }
        } catch (err) {
          errToast("Couldn't open the folder picker: " + (err?.message || err));
        }
      });
    }
  }
  exportBtn.addEventListener("click", async () => {
    const dest = destInput.value.trim();
    if (!dest) { toast("Choose a destination folder first"); return; }
    const pass = passInput.value;
    if (pass && !passInput.reportValidity()) return;
    lock(true);
    exportBtn.disabled = true;
    progressBox.hidden = false;
    progressBox.textContent = "Exporting…";
    const onProg = (e) => {
      const p = e.detail?.progress || 0;
      progressBox.textContent = p >= 1000 ? "Backup written." : `Exporting… ${Math.round(p / 10)}%`;
    };
    core.addEventListener("imex-progress", onProg);
  try {
    if (pwaExport) {
      await runBackupExport(pass || null);
      progressBox.textContent = "Backup downloaded — check your browser downloads.";
    } else {
      await core.exportBackup(dest, pass || null);
    }
  } catch (err) {
      errToast("Export failed: " + (err?.message || err));
      progressBox.hidden = true;
    } finally {
      core.removeEventListener("imex-progress", onProg);
      exportBtn.disabled = false;
      lock(false);
    }
  });

  /* -- delete profile (#100) -- */
  const delForm = panes.delete.querySelector("[data-del-form]");
  const delLast = panes.delete.querySelector("[data-del-last]");
  const delInput = panes.delete.querySelector("[data-del-confirm]");
  const delBtn = panes.delete.querySelector("[data-delete]");
  const delProgress = panes.delete.querySelector("[data-del-progress]");
  panes.delete.querySelector("[data-del-name]").textContent =
    state.account?.displayName || state.account?.addr || "this profile";
  const delAddr = String(state.account?.addr || "");
  panes.delete.querySelector("[data-del-addr]").textContent = delAddr || "(no address)";
  if (state.accounts.length <= 1) {
    delForm.hidden = true;
    delLast.hidden = false;
  }
  delInput.addEventListener("input", () => {
    delBtn.disabled = !delAddr || delInput.value.trim().toLowerCase() !== delAddr.toLowerCase();
  });
  delBtn.addEventListener("click", async () => {
    if (state.accountChanging || core._accountTransitionBusy) {
      errToast("Another account operation is running — try again in a moment");
      return;
    }
    lock(true);
    delBtn.disabled = true;
    delProgress.hidden = false;
    delProgress.textContent = "Deleting profile…";
    try {
      const moved = await core.deleteAccount(core.accountId);
      // account-changed refreshes chats and drawer for the reconciled
      // selection; the modal has nothing left to show either way.
      toast(moved ? `Profile deleted — switched to ${moved.displayName || moved.addr}` : "Profile deleted");
      close();
    } catch (err) {
      errToast("Delete failed: " + (err?.message || err));
      delProgress.hidden = true;
      lock(false);
    }
  });

  const { close } = showModal({ title: "Profile management", body, onClose: cleanupTransfer });
}

// Ask for notification permission once the user has a working account —
// never at plain boot (a startup prompt with no context is how prompts get
// denied forever). The plugin's promise can hang when the dialog was
// dismissed earlier — never let it block the flow (AGENTS §11).
async function askNotificationPermission() {
  try {
    await Promise.race([
      window.__TAURI__?.notification?.requestPermission?.(),
      new Promise(r => setTimeout(r, 2500)),
    ]);
  } catch {}
  // PWA: same "never at plain boot" rule, but a Notification prompt fired
  // without user activation is silently dropped by browsers, so piggyback
  // on the next tap when this ran outside a gesture.
  if (!window.__TAURI__ && "Notification" in window && Notification.permission === "default") {
    const ask = () => Notification.requestPermission().catch(() => {});
    if (navigator.userActivation?.isActive) ask();
    else addEventListener("pointerdown", ask, { once: true, capture: true });
  }
  await askBatteryExemption();
}

// SW notificationclick handover (PWA): the service worker focuses a client
// and posts the tapped notification's chat target; a cold-started window
// asks for a stashed click once a controller exists. openChatFromLink fails
// safe (unknown chat/account just toasts) if this races the boot.
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener("message", (ev) => {
    const d = ev.data;
    if (d?.type === "velta-notification-click" && Number(d.chatId) > 0) {
      openChatFromLink({ accountId: d.accountId != null ? Number(d.accountId) : null, chatId: Number(d.chatId) });
    }
  });
  navigator.serviceWorker.controller?.postMessage({ type: "velta-pending-notification" });
}

// Doze and OEM battery managers freeze the in-process core while the
// activity is stopped, so mail waits until the next open. Asked again each
// cold start until the exemption is granted; sessionStorage blocks a second
// dialog in the same process (account create and boot can both reach here).
async function askBatteryExemption() {
  if (!/Android/i.test(navigator.userAgent || "")) return;
  if (sessionStorage.getItem("velta-battery-opt-asked")) return;
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (!invoke) return;
  let exempt = true;
  try {
    exempt = await invoke("battery_optimization_exempt");
  } catch {
    return;
  }
  if (exempt) return;
  sessionStorage.setItem("velta-battery-opt-asked", "1");
  const ok = await confirmModal(
    "Keep messages arriving",
    "Android stops Velta from syncing after you leave the app, so new messages wait until you open it. Allow unrestricted battery use so mail keeps arriving in the background.",
    "Allow",
    false,
  );
  if (!ok) return;
  try {
    await invoke("request_battery_exemption");
  } catch (err) {
    diagnostics.append("warning", `battery exemption: ${err?.message || err}`);
  }
}

// Configure a profile from a dcaccount: relay invite link (deeplink or manual).
async function addAccountFromInvite(link) {
  if (state.accountChanging) return;
  if (!core.addAccountWithQr) {
    toast("No background service available — install the Velta Core service app to add relay accounts", 5000);
    return;
  }
  toast("Creating account on relay…", 2500);
  try {
    const id = await core.addAccountWithQr(link);
    const epoch = core.accountEpoch;
    await accountRefreshPromise;
    if (accountIsCurrent(epoch)) await askNotificationPermission();
    if (accountIsCurrent(epoch) && core.accountId === id) toast(`Account ready: ${state.account?.addr || "chatmail profile"}`, 3500);
  } catch (err) {
    errToast("Invite failed: " + err.message, 4500);
  }
}

// PWA: browser mail rides the active WS relay's C3 tunnel, and the wasm
// worker reads that proxy once at boot. Before creating an account on a
// relay, probe its /dns/<host> WebSocket — a capable relay answers its own
// name with a JSON IP array, anything else means the PWA could never reach
// it (the misleading "Could not find DNS resolutions" came from routing a
// capable relay through a stale non-capable one). When the account's relay
// IS capable but not the active tunnel, switch and stash the link: the page
// reloads so the worker boots on the new proxy, and boot resumes the create.
async function ensureMailTunnelForLink(link) {
  if (!window.VELTA_PWA?.wasmCore) return true;
  const host = normalizeHost(/^dcaccount:https:\/\/([^/]+)\/new/i.exec(link || "")?.[1] || "");
  if (!host || activeWsRelay() === host) return true;
  toast(`Checking ${host}…`);
  if (!(await probeC3Relay(host))) {
    errToast(`${host} doesn't answer browser mail (no WebSocket endpoints) — use the Velta app for it, or a relay that supports the PWA, e.g. the one serving this app.`, 7000);
    return false;
  }
  if (!listWsRelays().includes(host)) addWsRelay(host);
  useWsRelay(host);
  sessionStorage.setItem("velta-pending-add", link);
  toast(`Routing mail through ${host} — reloading…`);
  location.reload();
  return new Promise(() => {}); // the reload never lets this resolve
}

// Relay signup invites (PLAN-PWA-WEBSOCKET R1/V2): https://<host>/i/<token> —
// distinct from the contact/group invites in invites.js. The token is the
// bearer secret; the relay's /i/claim endpoint swaps it for one-time
// credentials. PWA-only for now (native clients use dclogin: links).
function parseRelayInvite(raw) {
  const m = /^(?:https?:\/\/)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\/i\/([A-Za-z0-9_-]{8,})\/?$/i.exec((raw || "").trim());
  if (!m) return null;
  const host = normalizeHost(m[1]);
  return host ? { host, token: m[2] } : null;
}

function extractRelayInviteJoin(rawUrl = location.href) {
  let h;
  try { h = new URL(rawUrl, location.href).hash; } catch { return null; }
  if (!h.startsWith("#/join")) return null;
  const q = new URLSearchParams(h.slice("#/join".length));
  const host = normalizeHost(q.get("r") || location.hostname);
  const token = (q.get("t") || "").trim();
  return host && token ? { host, token } : null;
}

async function claimAndConfigure(host, token) {
  const parkKey = "velta-invite-creds";
  let creds = null;
  try {
    const parked = JSON.parse(sessionStorage.getItem(parkKey) || "null");
    if (parked?.host === host && parked?.token === token && parked.exp > Date.now()) creds = parked.creds;
  } catch {}
  if (!creds) {
    toast("Claiming invite…");
    let res;
    try {
      // GET, not POST — fcgiwrap on the relay 502s request bodies; the
      // token already rides URLs by design, credentials never do.
      res = await fetch(`https://${host}/i/claim?t=${encodeURIComponent(token)}`, { cache: "no-store" });
    } catch (err) {
      throw new Error(`Invite claim failed: ${err.message || err}`);
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Invite rejected (${res.status})`);
    }
    creds = await res.json();
    if (!creds?.email || !creds?.password) throw new Error("Invite answer was missing credentials");
    // The invite is consumed at claim time — park the credentials so a
    // configure failure can retry without burning a second invite.
    sessionStorage.setItem(parkKey, JSON.stringify({ host, token, creds, exp: Date.now() + 30 * 60_000 }));
  }
  toast("Setting up your profile…");
  await core.configureWithCredentials(creds.email, creds.password);
  if (core.startIo) await core.startIo();
  sessionStorage.removeItem(parkKey);
  const epoch = core.accountEpoch;
  await accountRefreshPromise;
  if (accountIsCurrent(epoch)) await askNotificationPermission();
  if (accountIsCurrent(epoch)) toast(`Account ready: ${state.account?.addr || creds.email}`, 3500);
}

async function createAccountFromRelayInvite(host, token) {
  if (state.accountChanging) return;
  if (!window.VELTA_PWA?.wasmCore) { toast("Invite links work in the Velta PWA — use the app or a dclogin link", 5000); return; }
  if (!core.configureWithCredentials) { toast("This backend cannot create relay accounts"); return; }
  // A tunnel switch reloads the page — park the invite so boot resumes it.
  if (activeWsRelay() !== host) sessionStorage.setItem("velta-pending-invite", JSON.stringify({ host, token }));
  if (!(await ensureMailTunnelForLink(`dcaccount:https://${host}/new`))) return;
  sessionStorage.removeItem("velta-pending-invite");
  try {
    await claimAndConfigure(host, token);
  } catch (err) {
    errToast(err.message || String(err), 6000);
  }
}

/* ---------------- deeplinks ----------------
   Supported entry points:
     • web+dcaccount: protocol handler → index.html?qr=dcaccount:…
     • ?dcaccount=dcaccount:…  or  #dcaccount=dcaccount:…
     • #/addrelay/<urlencoded dcaccount link>
     • velta://invite?url=<url-encoded i.delta.chat link>  (Windows custom scheme)
     • velta://chat?account=<id>&chat=<id>&t=<token>  (notification tap, issues #20/#23)
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

// Persistent token the shell mints for notification chat links (issue #23).
// Loaded before any deeplink is handled. Empty in a plain browser, which
// makes velta://chat fail closed. Keep this above extractVeltaLink: the
// deeplink test slices from that function and supplies the token itself.
let chatLinkToken = "";

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

// Notification tap (issue #20): velta://chat?account=<id>&chat=<id>&t=<token>,
// built by the Android notification intent (Notifications.kt) and the Windows
// toast activation (notify_incoming in lib.rs). account is optional; 0 means
// unknown. t is checked by handleDeeplinkFromUrl (issue #23).
function extractChatLink(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "velta:" || url.hostname !== "chat") return null;
  const chatId = Number(url.searchParams.get("chat"));
  if (!Number.isInteger(chatId) || chatId <= 0) return null;
  const accountId = Number(url.searchParams.get("account"));
  const token = url.searchParams.get("t");
  return {
    accountId: Number.isInteger(accountId) && accountId > 0 ? accountId : null,
    chatId,
    token: token || null,
  };
}

// Select the notified profile first, then open the chat. A profile or chat
// that no longer exists leaves the app focused where it was.
async function openChatFromLink({ accountId, chatId }) {
  if (state.accountChanging) return;
  if (accountId != null && String(core.accountId) !== String(accountId)) {
    if (!core.switchAccount || !core.getAllAccounts) return;
    const accounts = await core.getAllAccounts().catch(() => null);
    if (!accounts?.some(a => String(a.id) === String(accountId))) return;
    try {
      await core.switchAccount(accountId);
    } catch (err) {
      errToast("Switch failed: " + (err.message || err));
      return;
    }
    await accountRefreshPromise;
  }
  const epoch = core.accountEpoch;
  const chat = await core.getChat(chatId).catch(() => null);
  if (!accountIsCurrent(epoch)) return;
  if (!chat) {
    toast("That chat is no longer available", 2500);
    return;
  }
  await openChat(chatId);
}

async function handleDeeplinkFromUrl(rawUrl, { clearUrl = false } = {}) {
  // Relay signup invite (R1/V2): https://<relay>/i/<token> interstitials
  // land here as <pwa>/#/join?t=<token>. Only meaningful without a profile —
  // an existing user follows invites through the Add-profile pane instead.
  const relayInvite = extractRelayInviteJoin(rawUrl);
  if (relayInvite) {
    if (clearUrl) history.replaceState(null, "", location.pathname + location.search);
    if (state.account?.configured) toast("You already have a profile — paste the invite into Add profile", 5000);
    else await createAccountFromRelayInvite(relayInvite.host, relayInvite.token);
    return true;
  }
  const chatLink = extractChatLink(rawUrl);
  if (chatLink) {
    // A web page can fire velta://chat. Only notifications minted by this
    // install carry the token, so a missing or wrong t is ignored.
    if (chatLinkToken && chatLink.token === chatLinkToken) await openChatFromLink(chatLink);
    return true;
  }
  const velta = extractVeltaLink(rawUrl);
  if (velta) rawUrl = velta;
  const backupLink = extractBackupLink(rawUrl);
  if (backupLink) {
    if (clearUrl) history.replaceState(null, "", location.pathname);
    // A deep link can come from any web page or app: never import a profile
    // (and switch to it) without the user confirming first.
    const epoch = core.accountEpoch;
    const ok = await confirmModal("Receive a profile",
      "A second-device code was opened. Receive that profile on this device and switch to it? Only continue if you started the transfer on your other device.",
      "Receive", false);
    if (ok && accountIsCurrent(epoch)) receiveSecondDeviceProfile(epoch, null, backupLink);
    return true;
  }
  const joinLink = extractJoinLink(rawUrl);
  const link = extractInviteLink(rawUrl);
  if (!joinLink && !link) return false;
  // clean the URL so a reload doesn't re-run the invite
  if (clearUrl) history.replaceState(null, "", location.pathname);
  if (joinLink) await joinFromInvite(joinLink);
  if (!link) return true;
  // A dcaccount: link is ambiguous once a profile exists — it can become a
  // second relay on the current profile or create a new profile on that relay.
  const epoch = core.accountEpoch;
  const choice = await chooseRelayOrNewProfile(link);
  if (choice === "relay") await addRelayFlow(epoch, null, link);
  else if (choice === "new") {
    if (!(await ensureMailTunnelForLink(link))) return true;
    await addAccountFromInvite(link);
  }
  return true;
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
        <button type="button" class="btn-text btn-primary" data-relay>Add the relay to this profile</button>
        ${/^dclogin:/i.test(link) ? "" : `<button type="button" class="btn-text" data-new>Create a new profile on it</button>`}
      </div>`;
    let settled = false;
    const pick = v => { if (settled) return; settled = true; close(); resolve(v); };
    body.querySelector("[data-relay]").addEventListener("click", () => pick("relay"));
    // dclogin: links render no "new profile" button — guard the lookup, or
    // the TypeError aborts the flow before the modal ever opens.
    body.querySelector("[data-new]")?.addEventListener("click", () => pick("new"));
    const { close } = showModal({ title: "Relay invite", body, onClose: () => resolve(null) });
  });
}

async function handleDeeplink() {
  await handleDeeplinkFromUrl(location.href, { clearUrl: true });
}

// Runtime URL changes (e.g. user navigates to an invite link in the webview)
addEventListener("hashchange", () => handleDeeplink());

// #97 share-in. Android hands over ACTION_SEND/SEND_MULTIPLE as opened urls
// (tao: text -> data:text/plain or a URL, files -> content://); Windows Send
// to passes file paths. One picker per burst (several photos arrive as one
// url each, drained together). A cold start from the share sheet drains
// during boot: the inbox holds the share until boot marks it ready, so the
// picker never opens before the chat list exists.
let openedTimer = 0;
const shareInbox = createShareInbox(items => offerShareNow(items), err => {
  errToast("Couldn't share: " + (err?.message || err));
});

async function routeOpenedBatch(urls) {
  const shares = [];
  for (const raw of urls) {
    if (!raw || typeof raw !== "string") continue;
    const share = parseSharePayload(raw);
    if (share) { shares.push(share); continue; }
    const consumed = await handleDeeplinkFromUrl(raw);
    const leftover = shareTextIfUnconsumed(raw, consumed);
    if (leftover) shares.push(leftover);
  }
  if (shares.length) offerShare(shares);
}

function offerShare(items) {
  shareInbox.push(items);
}

// An account switch (ours from the picker, or one already running) must
// finish before the picker lists chats — mid-switch state.chats is empty.
async function shareAccountSettled(ms = 20000) {
  const until = Date.now() + ms;
  while (state.accountChanging && Date.now() < until) await new Promise(r => setTimeout(r, 100));
  try { await accountRefreshPromise; } catch { /* list whatever loaded */ }
  return !state.accountChanging;
}

// The full chat list of the current profile. state.chats is it unless the
// chat-list search narrowed it or it has not loaded (only the diagnostics
// row) — then ask the core directly.
async function shareChatList(epoch) {
  const loaded = state.chats.filter(c => c.id !== DIAGNOSTICS_CHAT_ID);
  if (loaded.length && !state.query) return state.chats;
  try {
    if (!state.query) {
      await refreshChatList();
      if (state.chats.some(c => c.id !== DIAGNOSTICS_CHAT_ID)) return state.chats;
    }
    const chats = await core.getChatList({});
    return accountIsCurrent(epoch) ? chats : [];
  } catch (err) {
    console.warn("share: chat list failed:", err);
    return state.chats;
  }
}

// Resolves { chat }, { accountId } (switch profile and pick again) or null.
function pickShareChat(chats) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    const picker = buildSharePicker(document, {
      chats,
      accounts: state.accounts || [],
      currentAccountId: core.accountId,
      makeItem: chat => {
        const item = document.createElement("velta-chat-item");
        item.setData(chat);
        return item;
      },
      onPick: value => { done(value); close(); },
    });
    const { close } = showModal({ title: "Share to…", body: picker.el, onClose: () => done(null) });
    // Phones: no keyboard over the list until the user taps the field.
    if (!/Android|iPhone|iPad/i.test(navigator.userAgent || "")) picker.search.focus?.();
  });
}

async function offerShareNow(items) {
  // A picker switch, or a switch someone else started, re-lists the new
  // profile's chats; bounded so a flapping profile cannot loop forever.
  for (let round = 0; round < 4; round++) {
    if (!core) return;
    if (!await shareAccountSettled()) { errToast("Couldn't share: the profile is still switching"); return; }
    const epoch = core.accountEpoch;
    const chats = await shareChatList(epoch);
    if (!accountIsCurrent(epoch)) continue;
    // A modal that just closed (battery prompt, invite) still owns a
    // pending history.back(); the picker must not ride that entry (#103).
    await modalHistorySettled();
    if (!accountIsCurrent(epoch)) continue;
    const pick = await pickShareChat(chats);
    if (!pick) return;
    if (pick.accountId != null) {
      await modalHistorySettled();
      try {
        await core.switchAccount(pick.accountId);
      } catch (err) {
        errToast("Switch failed: " + (err?.message || err));
      }
      continue;
    }
    if (!accountIsCurrent(epoch)) continue;
    await deliverShare(pick.chat, items, epoch);
    return;
  }
}

// Open the picked chat and hand the share to its composer (text, one
// photo/video) or send it (documents, several files): ChatView.receiveShare.
async function deliverShare(chat, items, epoch) {
  const { text, files } = sharePlan(items);
  await modalHistorySettled(); // the picker's history.back() lands first
  if (!accountIsCurrent(epoch)) return;
  await openChat(chat.id);
  if (!accountIsCurrent(epoch)) return;
  if (state.activeChatId !== chat.id || !chatView) {
    errToast(`Couldn't open ${chat.name}`);
    return;
  }
  const result = await chatView.receiveShare({ text, files });
  if (result === "sent" && accountIsCurrent(epoch)) {
    toast(`Sent to ${chat.name}`);
    refreshChatList();
  }
}

async function drainOpened() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  const urls = await invoke("take_opened_urls");
  if (Array.isArray(urls) && urls.length) await routeOpenedBatch(urls);
}

function scheduleDrainOpened() {
  clearTimeout(openedTimer);
  openedTimer = setTimeout(() => { drainOpened().catch(err => console.warn("share in:", err)); }, 0);
}

async function forwardFlow(msgIds) {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch, fromChatId = state.activeChatId, navigation = chatNavigation;
  const list = document.createElement("div");
  list.className = "modal-list";
  const targets = state.chats.filter(c => !["deaddrop", "device"].includes(c.kind) && !c.isP2pGroup);
  for (const chat of targets) {
    const item = document.createElement("velta-chat-item");
    item.setData(chat);
    item.addEventListener("click", async () => {
      close();
      if (!accountIsCurrent(epoch)) return;
      await core.forwardMessages(fromChatId, msgIds, chat.id);
      if (!accountIsCurrent(epoch)) return;
      if (navigation === chatNavigation) chatView?.exitSelection();
      toast(`Forwarded to ${chat.name}`);
      refreshChatList();
    });
    list.appendChild(item);
  }
  const { close } = showModal({ title: "Forward to…", body: list });
}

/* ---------------- drawer ---------------- */

// Pulls the profile list for the account switcher. Feature-detected: demo
// mode and very old cores have no getAllAccounts. knownAccount: an account
// object already fetched this boot (#46) — boot resolves getAccount with a
// retry loop before calling this, and the duplicate RPC only doubled the
// startup chain.
async function refreshAccounts(knownAccount = null) {
  if (!core.getAllAccounts || state.accountChanging) return;
  const epoch = core.accountEpoch;
  try {
    const [account, accounts] = await Promise.all([knownAccount || core.getAccount(), core.getAllAccounts()]);
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
    errToast("Switch failed: " + (err.message || err));
  }
}

/* ---------------- identity backup (V2.5, wasm core only) ---------------- */
// The wasm core keeps accounts in OPFS, which the browser may evict; the
// identity backup is the way out — one passphrase-protected file holding the
// relay credentials + the self-keys. Export reads the armored key files the
// core wrote (imex paths are DIRECTORIES); restore replays them into a fresh
// account — configure BEFORE import_self_keys, which would otherwise mark
// the account configured and short-circuit the login proof (spike day 18).
function identityBackupAvailable() {
  return !!(core?.transport?.readCoreFile && core?.backend?.kind === "worker-wasm");
}

function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// #104: full-account backup as a browser download (wasm core). The core's
// imex wrote a .tar into memfs — shipped gzip-compressed when the platform
// offers CompressionStream (the shells' prep path decompresses before
// import); byte-identical .tar where it doesn't.
async function runBackupExport(pass) {
  const dir = "/backup/export";
  await core.exportBackup(dir, pass || null);
  const entries = (await core.transport.readCoreFileList(dir)).filter(e => !e.endsWith("/"));
  if (!entries.length) throw new Error("The core produced no backup file");
  const name = entries[entries.length - 1];
  const bytes = await core.transport.readCoreFile(name);
  const gz = await gzipBytes(bytes);
  const base = backupDownloadName(state.account?.addr, new Date().toISOString().slice(0, 10));
  downloadBytes(gz, gz === bytes ? base : base + ".gz");
  return name;
}

async function runIdentityExport(pass) {
  if (!pass || pass.length < 8) throw new Error("Use a passphrase of at least 8 characters — this file IS your account");
  // core 2.63.0 removed the legacy addr/mail_pw configs — credentials now
  // live in the transports list (imap.password). Prefer the sending address.
  const transports = await core.listTransports();
  const byAddr = state.account?.addr
    ? transports.find(t => String(t.addr || "").toLowerCase() === String(state.account.addr).toLowerCase())
    : null;
  const transport = byAddr || transports.find(t => t.imap?.password) || transports[0];
  const addr = transport?.addr;
  const mailPw = transport?.imap?.password;
  if (!addr || !mailPw) throw new Error("This profile is not configured yet — nothing to back up");
  const dir = "/identity/export";
  await core.exportSelfKeys(core.accountId, dir, pass);
  const entries = (await core.transport.readCoreFileList(dir)).filter(e => !e.endsWith("/"));
  const keys = {};
  for (const entry of entries) {
    keys[entry.split("/").pop()] = bytesToBase64(await core.transport.readCoreFile(entry));
  }
  if (!Object.keys(keys).length) throw new Error("The core produced no key files — nothing to back up");
  const wrapped = await wrapIdentityBundle(buildIdentityBundle({ addr, mail_pw: mailPw, keys }), pass);
  downloadBytes(wrapped, `velta-identity-${String(addr).replace(/[^a-z0-9._-]/gi, "_")}.velta-identity`);
  return addr;
}

async function runIdentityRestore(file, pass, onPhase) {
  onPhase("Reading backup…");
  // Wrong passphrase / corrupt file throw here — BEFORE any account is
  // created, so a bad file can never leave a stray behind.
  const bundle = await unwrapIdentityBundle(new Uint8Array(await file.arrayBuffer()), pass);
  onPhase(`Adding account for ${bundle.addr}…`);
  const id = await core.addAccount();
  try {
    // core 2.63.0: legacy addr/mail_pw configs are gone — configure via
    // add_transport (it runs the full configure + start_io internally).
    onPhase("Logging in to the relay…");
    await core.configureWithCredentials(bundle.addr, bundle.mail_pw, id);
  } catch (err) {
    // #99 family: add_account selected the fresh, empty account — a dead
    // relay here would strand the user on it. Remove the stray (the wrapper
    // reconciles selection back); on a fresh PWA nothing else exists and the
    // splash stays the usable retry surface.
    onPhase("Restore failed — removing the half-created profile…");
    await core.deleteAccount(id).catch(() => {});
    throw err;
  }
  onPhase("Importing encryption keys…");
  const dir = "/identity/import";
  for (const [name, b64] of Object.entries(bundle.keys)) {
    await core.transport.writeCoreFile(`${dir}/${name}`, base64ToBytes(b64));
  }
  await core.importSelfKeys(id, dir, pass);
  onPhase("Done — reloading…");
  setTimeout(() => location.reload(), 800);
}

function openIdentityBackup({ restoreOnly = false } = {}) {
  if (!identityBackupAvailable()) {
    toast("Identity backup needs the wasm core (the Velta PWA)");
    return;
  }
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="modal-hint">Your identity is the relay address, its password and your encryption keys — one file keeps all three. The passphrase protects it; losing the passphrase means losing the account. It holds <b>no message history</b> — a full copy including messages is Profile management → Export backup.</p>
    ${restoreOnly ? "" : `
    <details class="backup-export" open>
      <summary>Export this profile</summary>
      <label class="modal-field">Passphrase <input class="text-field" data-pass type="password" autocomplete="new-password" placeholder="at least 8 characters"></label>
      <label class="modal-field">Repeat <input class="text-field" data-pass2 type="password" autocomplete="new-password"></label>
      <button class="btn-primary" data-export type="button">Export identity backup</button>
    </details>`}
    <details class="backup-restore"${restoreOnly ? " open" : ""}>
      <summary>Restore from a backup file</summary>
      <label class="modal-field">Backup file <input class="text-field" data-file type="file" accept=".velta-identity,application/octet-stream"></label>
      <label class="modal-field">Passphrase <input class="text-field" data-pass-r type="password" autocomplete="off"></label>
      <button class="btn-primary" data-restore type="button">Restore</button>
    </details>
    <p class="modal-status" data-status hidden></p>`;
  const status = body.querySelector("[data-status]");
  const phase = (text) => { status.hidden = false; status.textContent = text; };
  const busy = (btn, on) => { btn.disabled = on; btn.classList.toggle("btn-loading", on); };
  const exportBtn = body.querySelector("[data-export]");
  exportBtn?.addEventListener("click", async () => {
    const pass = body.querySelector("[data-pass]").value;
    if (pass !== body.querySelector("[data-pass2]").value) { toast("Passphrases don't match"); return; }
    busy(exportBtn, true);
    try {
      const addr = await runIdentityExport(pass);
      phase(`Backup saved — keep the file somewhere safe (${addr})`);
    } catch (err) {
      phase(err?.message || String(err));
    } finally { busy(exportBtn, false); }
  });
  const restoreBtn = body.querySelector("[data-restore]");
  restoreBtn?.addEventListener("click", async () => {
    const file = body.querySelector("[data-file]").files[0];
    if (!file) { toast("Pick a backup file first"); return; }
    busy(restoreBtn, true);
    try {
      await runIdentityRestore(file, body.querySelector("[data-pass-r]").value, phase);
    } catch (err) {
      phase(err?.message || String(err));
      busy(restoreBtn, false);
    }
  });
  showModal({
    title: "Identity backup",
    body,
  });
}

function rebuildDrawer() {
  if (state.accountChanging) return;
  drawer?.el.remove();
  drawer?.overlayEl?.remove();
  // Boot/account-change sync: mirror persisted preferences into the core's
  // per-account config (the drawer's change handlers push on every change
  // too). localStorage is the source of truth for the UI; the core copies
  // keep the account config honest for other consumers.
  const savedMq = localStorage.getItem("velta-media-quality") || "0";
  const savedDl = localStorage.getItem("velta-download-limit") || "0";
  const savedMdns = localStorage.getItem("velta-mdns") ?? "1";
  core.setConfig?.("media_quality", savedMq)
    .then(() => core.setConfig?.("download_limit", savedDl))
    .then(() => core.setConfig?.("mdns_enabled", savedMdns))
    .catch(err => diagnostics.append("warning", `settings boot sync failed: ${err?.message || err}`));
  drawer = buildDrawer({
    account: state.account,
    theme: state.theme,
    identityBackupAvailable: identityBackupAvailable(),
    onIdentityBackup: () => openIdentityBackup(),
    barHidden,
    onBarToggle: (key, visible) => {
      barHidden = visible ? barHidden.filter(k => k !== key) : [...new Set([...barHidden, key])];
      localStorage.setItem(BAR_HIDDEN_KEY, JSON.stringify(barHidden));
      applyBarVisibility();
    },
    catsHidden,
    onCatToggle: (key, visible) => {
      catsHidden = visible ? catsHidden.filter(k => k !== key) : [...new Set([...catsHidden, key])];
      localStorage.setItem(CATS_HIDDEN_KEY, JSON.stringify(catsHidden));
      syncChatCategoryBar();
      renderChatList();
    },
    mediaQuality: localStorage.getItem("velta-media-quality") || "0",
    onMediaQuality: (value) => {
      // Mirror in localStorage for the sync drawer render; the authoritative
      // copy is the core's per-account `media_quality` config. Also pushed
      // to the core at boot (see the boot sync below).
      localStorage.setItem("velta-media-quality", value);
      core.setConfig?.("media_quality", value).catch(err =>
        errToast("Couldn't save image quality: " + (err?.message || err)));
      toast(value === "1" ? "Image quality: Compact" : "Image quality: Standard");
    },
    downloadLimit: localStorage.getItem("velta-download-limit") || "0",
    onDownloadLimit: (value) => {
      localStorage.setItem("velta-download-limit", value);
      core.setConfig?.("download_limit", value).catch(err =>
        errToast("Couldn't save download limit: " + (err?.message || err)));
      toast(value === "0" ? "Auto-download limit: none" : "Auto-download limit set");
    },
    onReadReceipts: (on) => {
      // localStorage mirror + per-account core config (same pattern as
      // media quality); pushed from rebuildDrawer on boot/account switch.
      localStorage.setItem("velta-mdns", on ? "1" : "0");
      core.setConfig?.("mdns_enabled", on ? "1" : "0").catch(err =>
        errToast("Couldn't save read receipts: " + (err?.message || err)));
    },
    onLowBatteryToggle: (on) => {
      // Turning the marker off removes the current 🪫 immediately instead of
      // waiting for the next send to clean it up.
      if (!on && core?.lowBatteryReactedId) {
        const id = core.lowBatteryReactedId;
        core.lowBatteryReactedId = null;
        core.clearReaction?.(id).catch(() => {});
      }
    },
    p2pAvailable: p2pAvailable(),
    p2pOn: p2pEnabled(),
    onP2pToggle: async () => {
      const enable = !p2pEnabled();
      try {
        await setP2pEnabled(enable);
        toast(enable ? "Local chat enabled" : "Local chat disabled");
      } catch (error) {
        diagnostics.append("error", `Local chat toggle failed: ${error?.message || error}`);
        errToast(`Local chat toggle failed: ${error?.message || error}`, 5000);
      }
      rebuildDrawer();
    },
    accounts: state.accounts,
    currentAccountId: core.accountId,
    onAccountTap: accountTapFlow,
    onRelays: () => openRelaysModal(),
    onWsRelays: (!window.__TAURI__ && !window.VeltaBridge && (window.VELTA_PWA?.wasmCore || localStorage.getItem("velta-wasm") === "1"))
      ? () => showWsRelaysModal()
      : undefined,
    onSetTheme: (mode) => { state.theme = mode; applyTheme(); },
    onProfileManagement: () => openProfileManagement(),
    onInvite: () => showInvite(inviteQrProvider(null), { account: state.account }),
    onProfile: openSelfProfile,
    onEditProfile: editProfileFlow,
    onInviteDomains: () => showInviteDomainsModal(),
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
  // Prefill the description from the self contact (the account object does
  // not carry the status text).
  let status = "";
  try { status = (await core.getContact?.(1))?.status || ""; } catch { /* backend offline */ }
  const result = await showEditProfile({
    name: state.account?.displayName || "",
    avatarUrl: state.account?.avatar ? fileUrl(state.account.avatar) : "",
    color: state.account?.color,
    description: status,
    pickImage: pickProfileImage,
  });
  if (!result || !accountIsCurrent(epoch)) return;
  try {
    if (!core.setDisplayName || !core.setAvatar) throw new Error("not available with this backend");
    await core.setDisplayName(result.name);
    if (!accountIsCurrent(epoch)) return;
    if (result.avatar === "remove") await core.setAvatar(null);
    else if (result.avatar !== "keep") await core.setAvatar(result.avatar.path);
    if (core.setSelfStatus && result.description !== status) await core.setSelfStatus(result.description);
    if (!accountIsCurrent(epoch)) return;
    const account = await core.getAccount();
    if (!accountIsCurrent(epoch)) return;
    state.account = account;
    rebuildDrawer();
    toast("Profile updated");
  } catch (err) {
    errToast("Couldn't update profile: " + (err.message || err), 4500);
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
  let parsed = parseInviteLink(link);
  if (!parsed && isShortInviteLink(link)) {
    parsed = await expandShortInvite(link);
    if (!parsed) { errToast("Could not expand this short invite link", 4500); return; }
  }
  const label = parsed ? inviteLabel(parsed) : null;
  // joinFlow closed its modal right before calling us: its history.back()
  // lands async, and a confirm opened before the pop shares the dying entry
  // and is torn down by it — resolve(false), Join silently does nothing (#103).
  await modalHistorySettled();
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
    errToast("Join failed: " + err.message, 4500);
  }
}

function joinFlow() {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:4px">Paste an invite link (<code>https://i.delta.chat/#…</code>, a mirror domain, or a short link like <code>deltachat.id/&lt;name&gt;</code>) — works for both 1:1 contacts and group chats.</p>
    <input class="text-field" placeholder="https://i.delta.chat/#DD1F…" id="join-input" required inputmode="url" autocapitalize="none" autocomplete="off" spellcheck="false" aria-label="Invite link">`;
  const foot = document.createDocumentFragment(); // direct child of .modal-foot -> one-row flex
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn-text"; cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.className = "btn-text"; ok.textContent = "Join";
  foot.append(cancel, ok);
  const { close, form } = showModal({ title: "Join chat via invite link", body, foot, form: true });
  cancel.addEventListener("click", close);
  form.addEventListener("submit", () => {
    const v = body.querySelector("#join-input").value.trim();
    if (!parseInviteLink(v) && !isShortInviteLink(v)) {
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
        ${identityBackupAvailable() ? `<button class="btn-text splash-btn" data-identity-restore type="button">Restore an identity backup…</button>` : ""}
        <button class="btn-text splash-btn" data-local type="button">Enter local chat…</button>
        ${(!window.__TAURI__ && !window.VeltaBridge && (window.VELTA_PWA?.wasmCore || localStorage.getItem("velta-wasm") === "1")) ? `<button class="btn-text splash-btn" data-ws-relays type="button">WebSocket relays</button>` : ""}
      </div>
      <form class="splash-form" data-form hidden>
        <p class="splash-hint">Enter a <b>chatmail</b> relay address — an instant end-to-end encrypted profile will be created for you. No email or password needed.</p>
        <input class="text-field" data-relay required placeholder="Relay address — e.g. nine.testrun.org" autocomplete="off" inputmode="url" autocapitalize="none" spellcheck="false">
        ${navigator.mediaDevices?.getUserMedia ? `<div style="margin-top:10px"><button class="btn-text" data-scan type="button">Scan a QR code</button></div>` : ""}
        <div style="margin-top:12px"><button class="btn-primary splash-btn" data-ok type="submit">Create account</button></div>
        ${core?.initTransports ? `<div style="margin-top:4px"><button class="btn-text" data-auto type="button">Autopick the fastest relay</button></div>` : ""}
      </form>
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
    if (!input.value && activeWsRelay()) input.value = activeWsRelay();
    setTimeout(() => input.focus(), 60);
  });
  el.querySelector("[data-ws-relays]")?.addEventListener("click", () => showWsRelaysModal());

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
    if (await receiveSecondDeviceProfile(epoch)) {
      await askNotificationPermission();
      finishOk();
    }
    else showActions();
  });

  // --- enter local chat ---
  // No relay account needed: switch local chat on and drop into the app.
  // The relay bar then reads "Local chat mode — no relay configured"; a
  // relay profile can still be created later via the drawer's Add profile.
  el.querySelector("[data-local]").addEventListener("click", async () => {
    if (!accountIsCurrent(epoch)) return;
    actionsEl.hidden = true;
    stepsEl.replaceChildren();
    addStep("Starting local chat…");
    try {
      await setP2pEnabled(true);
      finishSteps(true);
      finishOk();
    } catch (err) {
      finishSteps(false);
      diagnosticsSink.append("error", `local chat: ${err?.message || err}`);
      showActions();
    }
  });

  // V2.5 identity restore (wasm dist): the splash stays open underneath the
  // modal — a failed restore (e.g. relay unreachable) leaves the user on the
  // splash, a successful one reloads the app into the restored profile.
  el.querySelector("[data-identity-restore]")?.addEventListener("click", () => {
    openIdentityBackup({ restoreOnly: true });
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
        errToast("Couldn't read the backup file: " + (err?.message || err));
        return;
      }
    }
    // PWA exports arrive gzip-compressed; the shell sniffs the magic and
    // hands back a decompressed temp path the core can import.
    try {
      picked = await invoke("prep_backup", { path: picked });
    } catch {}

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
        localStorage.setItem("velta-ask-notifications", "1");
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

  // Shared scaffolding for both create paths (named relay / auto-discovery):
  // trigger+input disabling, the intro step, ConfigureProgress phase lines
  // (0..1000), success (notification ask + nickname ask + splash teardown +
  // toast) and failure (Retry) handling. `run()` performs the configure and
  // returns the fresh account; `hostOf` names the relay in the success toast.
  const hostOf = (a) => (a?.addr || "").split("@")[1] || a?.relay || "your new relay";
  // Issue #6: right after the account exists, politely offer a nickname —
  // once, skippable, never holding onboarding hostage.
  const askNickname = () => new Promise((resolve) => {
    const input = document.createElement("input");
    input.className = "text-field"; input.maxLength = 64;
    input.placeholder = "How should we call you?";
    input.value = state.account?.displayName || "";
    const wrap = document.createElement("div");
    wrap.appendChild(input);
    const nm = { close: null };
    const settle = async (apply) => {
      if (apply) {
        const name = input.value.trim();
        try { if (name) await core.setDisplayName(name); } catch { /* cosmetic */ }
        state.account = await core.getAccount().catch(() => state.account);
        rebuildDrawer();
      }
      nm.close();
      resolve();
    };
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "btn-text"; skip.textContent = "Skip";
    skip.addEventListener("click", () => settle(false));
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "btn-text btn-primary"; save.textContent = "Save name";
    const foot = document.createElement("div");
    foot.className = "modal-foot edit-profile-foot";
    foot.append(skip, save);
    const m = showModal({ title: "Welcome to Velta", body: wrap, foot, compact: true, form: true,
      onClose: () => resolve() });
    nm.close = m.close;
    m.form.addEventListener("submit", () => settle(true));
    setTimeout(() => input.focus(), 50);
  });
  const runCreate = async ({ trigger, intro, phases, run }) => {
    trigger.disabled = true; trigger.classList.add("btn-loading"); trigger.textContent = "Creating…";
    input.disabled = true;
    stepsEl.replaceChildren();
    addStep(intro);
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
      const account = await run();
      if (!accountIsCurrent(epoch)) return;
      addStep("Account created — welcome!");
      finishSteps(true);
      if (!accountIsCurrent(epoch)) return;
      state.account = account;
      await askNotificationPermission();
      await askNickname();
      setTimeout(() => {
        if (!accountIsCurrent(epoch)) return;
        finishOk();
        toast(`Account created on ${hostOf(account)}`, 3000);
      }, 900);
    } catch (err) {
      if (!accountIsCurrent(epoch)) return;
      finishSteps(false);
      addStep("Setup failed: " + (err.message || err));
      trigger.disabled = false; trigger.classList.remove("btn-loading"); trigger.textContent = "Retry";
      input.disabled = false;
    } finally {
      core.removeEventListener("configure-progress", onProg);
    }
  };

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!accountIsCurrent(epoch)) return;
    const raw = input.value;
    const invite = parseRelayInvite(raw);
    const link = invite ? null : normalizeRelayLink(raw);
    if (!link && !invite) { toast(raw.trim() ? "That doesn't look like a relay or invite address" : "Enter a relay address"); return; }
    if (invite) {
      if (activeWsRelay() !== invite.host) sessionStorage.setItem("velta-pending-invite", JSON.stringify(invite));
      if (!(await ensureMailTunnelForLink(`dcaccount:https://${invite.host}/new`))) return;
      sessionStorage.removeItem("velta-pending-invite");
      await runCreate({
        trigger: ok,
        intro: `Claiming your invite on ${invite.host}`,
        phases: [
          [1,   `Invite accepted at ${invite.host}`],
          [200, "Setting up your profile"],
          [750, "Finalizing account"],
        ],
        run: async () => {
          await claimAndConfigure(invite.host, invite.token);
          return core.getAccount();
        },
      });
      return;
    }
    if (!(await ensureMailTunnelForLink(link))) return;
    const host = link.replace(/^dcaccount:https:\/\//i, "").replace(/\/new.*$/, "");
    await runCreate({
      trigger: ok,
      intro: `Attempting to connect to relay at ${host}`,
      phases: [
        [1,   `Relay found at ${host}`],
        [200, "Requesting new account credentials"],
        [450, "Generating encryption keys"],
        [750, "Finalizing account"],
      ],
      run: async () => {
        await core.configureWithQr(link);
        return core.getAccount();
      },
    });
  });

  // Auto-discovery: the core probes its built-in relay candidate pool and
  // configures the fastest-answering one (no relay name needed); the profile
  // grows to ~3 relays in the background afterwards.
  el.querySelector("[data-auto]")?.addEventListener("click", async () => {
    if (!accountIsCurrent(epoch) || !core.initTransports) return;
    await runCreate({
      trigger: el.querySelector("[data-auto]"),
      intro: "Looking for a fast relay…",
      phases: [
        [1,   "Found a relay that answers fast"],
        [200, "Requesting new account credentials"],
        [450, "Generating encryption keys"],
        [750, "Finalizing account"],
      ],
      run: async () => {
        await core.initTransports();
        return core.getAccount();
      },
    });
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
// desktop 2.47+ manages under "Relays". Removal (core 2.60.0+) is immediate:
// the core stops using the relay right away, refuses only to remove the last
// one (re-electing the sending transport as needed) and sends keyupdate
// messages so contacts converge on the new address set.
async function openRelaysModal() {
  if (state.accountChanging) return;
  if (!core.listTransports) {
    toast("Relay management is not available on this backend");
    return;
  }
  const epoch = core.accountEpoch;
  const body = document.createElement("div");
  body.innerHTML = `
    <div data-list><div class="p2p-hint" style="opacity:.6">Loading…</div></div>
    <div style="margin-top:10px"><button type="button" class="btn-text" data-add>Add relay…</button></div>`;
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
    // Per-relay live status for the stale-transport hint (issue #11 slice 3):
    // parseConnectivityHtml gives one state per relay domain — best effort,
    // the modal stays useful without it.
    let statusByDomain = null;
    try {
      if (core.getConnectivityHtml) {
        statusByDomain = new Map(parseConnectivityHtml(await core.getConnectivityHtml()).map(s => [s.domain, s]));
      }
    } catch { /* best effort */ }
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
      const other = transports.find(x => x.addr !== t.addr);
      const st = statusByDomain?.get((t.addr || "").split("@").pop());
      const hint = !st || st.state === "ok" ? "" : ` <span class="relay-row-status">${st.state === "down" ? "unreachable — messages queue until it's back" : "connecting…"}</span>`;
      const demote = primary && other ? `<button type="button" class="btn-text" data-demote>Stop using for sending</button>` : "";
      row.innerHTML = `<span class="k">${escapeHtml(t.addr)}${primary ? " · sending" : ""}${hint}</span>
        <span class="v">${primary ? demote : `<button type="button" class="btn-text" data-sendvia>Use for sending</button>`}<button type="button" class="btn-text" data-remove style="color:var(--danger)">Remove</button></span>`;
      row.querySelector("[data-sendvia]")?.addEventListener("click", async () => {
        const ok = await confirmModal(
          `Send via ${t.addr}?`,
          "New messages go out through this relay first and carry its address. If it is unreachable, Velta falls back to your other relays and retries this one every few minutes. This choice applies to this device.",
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
      // Demotion: sending stays pinned to one relay (the ui.velta.send_transport
      // pin, VENDORISSUES #11) — failover is automatic but temporary — so
      // "Stop using for sending" on the sending row is the user-facing way to
      // move the pin to another configured relay.
      row.querySelector("[data-demote]")?.addEventListener("click", async () => {
        const ok = await confirmModal(
          `Stop using ${t.addr} for sending?`,
          `Sending moves to ${other.addr}: new messages go out through it first and carry its address. This choice applies to this device.`,
          "Stop using for sending");
        if (!ok || !accountIsCurrent(epoch)) return;
        try {
          await core.setSendRelay(other.addr);
          toast(`Sending via ${other.addr}`);
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
          "The relay stops being used right away and your contacts are informed automatically, but messages still on their way to the old address may arrive for a short while. Your last relay cannot be removed.",
          "Remove");
        if (!ok || !accountIsCurrent(epoch)) return;
        try {
          await core.deleteTransport(t.addr);
          toast("Relay removed");
        } catch (err) {
          toast(String(err?.message || err));
        }
        refresh();
      });
      listEl.appendChild(row);
    }
  };
  // Live refresh when the core reports a transport change (local or synced
  // from another device); the [data-relays-modal] hook is dispatched from
  // the transports-modified listener. Closing the modal detaches the body,
  // which makes further dispatches no-ops.
  body.dataset.relaysModal = "true";
  body.addEventListener("relays-refresh", refresh);
  await refresh();
  body.querySelector("[data-add]").addEventListener("click", () => addRelayFlow(epoch, refresh));
}

async function addRelayFlow(epoch, refresh, presetCode) {
  if (!accountIsCurrent(epoch)) return;
  if (!core.checkQr || !core.addTransportFromQr) {
    toast("No background service available — install the Velta Core service app to add relays", 5000);
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
  // acquireCode closed its modal right before this: its history.back() lands
  // async, and an "Adding relay" modal opened before the pop shares the dying
  // entry and is torn down by it — the whole flow runs invisibly (the same
  // contract as #103).
  await modalHistorySettled();
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
      setTimeout(async () => {
        if (!accountIsCurrent(epoch)) return;
        closeAdding();
        if (refresh) {
          await modalHistorySettled(); // close-then-reopen: #103 contract
          openRelaysModal();
        }
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

/* ---------------- boot ---------------- */
let uiLive = false; // set once the drawer + menu are wired and usable
// Don't dial into a guaranteed failure: when the OS/browser has already
// denied microphone access (macOS TCC resets after every ad-hoc update are
// the recurring case — issue #10), say so in a dialog instead of failing
// inside the call overlay. 'prompt'/'granted'/unsupported API proceed as
// before — the first getUserMedia still triggers the OS prompt when needed.
async function startCallIfMicOk(chat) {
  try {
    if (navigator.permissions?.query) {
      const st = await navigator.permissions.query({ name: "microphone" });
      if (st?.state === "denied") {
        await confirmModal("Microphone blocked", "Velta can't place calls because microphone access is denied. Enable it in system settings (Windows: Settings → Privacy → Microphone; macOS: System Settings → Privacy → Microphone; Android: App settings → Permissions), then call again.");
        return;
      }
    }
  } catch { /* permissions API or name unsupported — let getUserMedia decide */ }
  calls?.startOutgoing(chat.id, chat.name);
}

async function boot() {
  try {
    // Calls first: the incoming-call listener must exist as early as the
    // event stream is available, or a call arriving during boot is missed.
    calls = initCalls(core, { notify: (msg) => toast(msg, 4500) });
    initWebxdc(core);
    reportUiVisible(); // visibilitychange won't fire for the initial load

    // Live core version for the drawer footer / about modal — the running
    // core (sidecar or in-process) is the source of truth, not the constant.
    core.getSystemInfo?.().then((info) => {
      if (info?.deltachat_core_version) setCoreVersionDisplay(info.deltachat_core_version);
    }).catch(() => {});

    appLog("boot: getAccount");
    // Flush anything the pre-app.js safety net (boot-net.js) caught while
    // modules loaded, then retire its banner — the errors live here now.
    try {
      for (const msg of window.__veltaBootErrors || []) {
        diagnostics.append("error", `pre-boot: ${msg}`);
      }
      const banner = document.getElementById("boot-error");
      if (banner) banner.hidden = true;
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
      // No splash so far (returning users boot straight in); the log surface
      // is only needed now that the core failed to answer.
      splashSession = showSplash();
      return;
    }
    state.account = account;
    appLog(`boot: account ${state.account.addr} configured=${state.account.configured}`);

    // Splash: setup screen only when there is no configured profile —
    // returning users never see it. Local-chat-only users skip it too: they
    // deliberately skipped relay setup (the drawer's Add profile still
    // reaches it); disabling local chat puts the splash back.
    if (core.configureWithCredentials && state.account.configured === false && !p2pEnabled()) {
      splashSession = showSplash();
      splashSession?.showActions();
    }

    // Notifications: asked once, right after the user finishes creating or
    // restoring an account (those flows set the flag) — never at plain boot.
    try {
      if (localStorage.getItem("velta-ask-notifications") === "1") {
        localStorage.removeItem("velta-ask-notifications");
        await askNotificationPermission();
      } else if (state.account?.configured) {
        await askBatteryExemption();
      }
    } catch {}

    // PWA relay auto-switch resume: the create-account gate reloaded the
    // page to point the worker's mail tunnel at the account's own relay;
    // finish the interrupted create now that the core is up on the right
    // tunnel. Removed from storage before use — a failure here must not loop.
    if (window.VELTA_PWA?.wasmCore && sessionStorage.getItem("velta-pending-add")) {
      const pending = sessionStorage.getItem("velta-pending-add");
      sessionStorage.removeItem("velta-pending-add");
      addAccountFromInvite(pending);
    }
    if (window.VELTA_PWA?.wasmCore && sessionStorage.getItem("velta-pending-invite")) {
      let pendingInvite = null;
      try { pendingInvite = JSON.parse(sessionStorage.getItem("velta-pending-invite")); } catch {}
      sessionStorage.removeItem("velta-pending-invite");
      if (pendingInvite?.host && pendingInvite?.token) createAccountFromRelayInvite(pendingInvite.host, pendingInvite.token);
    }

    try {
      const tauri = window.__TAURI__;
      const mediaInvoke = tauri?.core?.invoke || tauri?.invoke;
      if (mediaInvoke) window.veltaMediaBase = await mediaInvoke("media_base_url");
      appLog(`media base: ${window.veltaMediaBase}`);
    } catch (e) {
      appLog(`media base unavailable: ${e?.message || e}`);
    }

    // Drawer + menu first: the profile/account recovery paths must stay
    // usable even when a later boot stage fails. uiLive marks the point
    // after which a boot failure keeps the (partially working) UI instead
    // of falling back to the splash.
    appLog("boot: rebuildDrawer");
    try {
      rebuildDrawer();
      refreshAccounts(state.account); // no second getAccount on the startup chain (#46)
      uiLive = true;
    } catch (err) {
      diagnostics.append("error", `boot: drawer failed: ${err?.message || err}`);
    }

    // Update banner (drawer bottom) + menu-button nudge. Fire-and-forget:
    // offline or a blocked fetch just means no banner this session.
    appLog("boot: check for update");
    checkForUpdate().catch(err => appLog(`update check failed: ${err?.message || err}`));

    appLog("boot: init chatView");
    try {
      chatView = new ChatView(core, {
        onChatsChanged: refreshChatList,
        onForward: forwardFlow,
        onOpenChat: id => openChat(Number(id)),
        onBack: () => closeChat(),
      });
    } catch (err) {
      diagnostics.append("error", `boot: ChatView failed: ${err?.message || err}`);
    }

    if (chatView) {
      appLog("boot: refreshChatList");
      try {
        await refreshChatList();
      } catch (err) {
        diagnostics.append("error", `boot: chat list failed: ${err?.message || err}`);
      }
    }

    appLog("boot: bind ui");
    try {
      // Chat-list bottom action bar: the "+" opens the same new-chat/group
      // context menu as before (anchored to its button), QR shows this
      // profile's invite code, scan opens the camera join flow.
      $("bar-menu").addEventListener("click", () => {
        if (drawer?.el?.classList.contains("open")) drawer.close();
        else drawer?.open();
      });
      // The Menu button doubles as the drawer toggle: cross while open.
      const BAR_MENU_ICONS = {
        open: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
        closed: `<svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
      };
      document.addEventListener("velta-drawer", e => {
        const btn = document.getElementById("bar-menu");
        if (!btn) return;
        btn.innerHTML = e.detail.open ? BAR_MENU_ICONS.open : BAR_MENU_ICONS.closed;
        btn.title = e.detail.open ? "Close menu" : "Menu";
      });
      for (const view of ["chats", "contacts", "calls", "qr"]) {
        $(`bar-${view}`).addEventListener("click", () => setListView(view));
      }
      // Boot lands on the chats view without going through setListView —
      // paint the initial active state so the default is marked.
      for (const b of document.querySelectorAll(".list-bar .bar-btn[data-view]")) {
        b.classList.toggle("active", b.dataset.view === listView);
      }
      applyBarVisibility();
      bindChatHeadMenu();
      // Invite cards in messages + any invite-host link tap → join flow
      bindInviteInterception(link => joinFromInvite(link));

      $("btn-search").addEventListener("click", () => {
        if (listView === "search") setListView("chats");
        else { searchScreenTab = "search"; setListView("search"); }
      });
      $("btn-new-chat").addEventListener("click", () => setListView(listView === "new" ? "chats" : "new"));
      syncHeaderButtons();
    } catch (err) {
      diagnostics.append("error", `boot: bind ui failed: ${err?.message || err}`);
    }

    // Chat list: cores with fine-grained chat-list events (rpc-core) drive
    // it through chatlist-changed / chatlist-item-changed below — the core
    // emits them alongside every IncomingMsg/MsgsChanged/MsgsNoticed. Other
    // cores (mock) keep the full refresh on the coarse events.
    core.addEventListener("chatlist-changed", () => scheduleChatListUpdate({ order: true }));
    core.addEventListener("chatlist-item-changed", ev => scheduleChatListUpdate({ chatId: ev?.detail?.chatId || 0 }));
    core.addEventListener("incoming-msg", ev => {
      if (!incrementalChatList()) scheduleChatListRefresh();
      const msg = ev?.detail?.msg;
      const chat = state.chats.find(c => c.id === msg?.chatId);
      notifyIncoming(
        msg?.fromContact?.name || msg?.fwdFrom || "New message",
        (msg?.text || "").replace(/\s+/g, " ").slice(0, 120) || "New message",
        {
          chatName: chat?.name || null,
          senderName: msg?.fromContact?.name || null,
          senderAvatar: msg?.fromContact?.avatar || null,
          accountId: core.accountId ?? null,
          chatId: msg?.chatId ?? null,
        },
      );
    });
    core.addEventListener("call-ended", ev => {
      recordCallEnded(ev?.detail?.chatId);
    });
    core.addEventListener("msgs-changed", () => {
      if (!incrementalChatList()) scheduleChatListRefresh();
      // Local chat (and any transport without push-to-view) relies on this to
      // pull new messages into the open chat without waiting for the 20s tick.
      if (state.activeChatId) chatView?.onMsgsChanged(state.activeChatId);
      renderLcQueueTray();
    });
    core.addEventListener("chat-updated", ev => {
      if (!incrementalChatList()) scheduleChatListRefresh();
      refreshActiveChatHeader(ev?.detail?.chatId);
      const updId = ev?.detail?.chatId;
      if (updId && updId === state.activeChatId) refreshChatHeadPresence(updId);
    });
    // Safety net only: contact requests and new chats normally arrive via
    // core events (handled above with a debounced refresh). With in-place
    // chat-list updates a refresh is cheap, but each one still costs two RPC
    // round trips, so don't run it more often than needed.
    // Incremental cores (#25): each tick only re-reads the entry list (new
    // chats / contact requests show up, ids only); every 10th tick (5 min)
    // is a full item refresh in case a chat-list event was ever missed.
    let safetyTick = 0;
    setInterval(() => {
      if (incrementalChatList() && ++safetyTick % 10) scheduleChatListUpdate({ order: true });
      else scheduleChatListRefresh();
      const activeId = state.activeChatId;
      const activeChat = activeId != null ? state.chats.find(c => c.id === activeId) : null;
      if (activeChat?.kind === "single") refreshChatHeadPresence(activeId);
    }, 30000);

    // Auto-reconnect: the service APK can restart or drop its loopback socket
    // mid-session; without this loop the only recovery is a full page reload.
    // Retries forever at a capped interval — the app should come back
    // whenever the core does, however long that takes.
    let reconnecting = false;
    addEventListener("velta-core-disconnected", () => {
      toast("Lost connection to local Delta Chat core — reconnecting…", 4500);
      if (reconnecting || typeof core?.reconnect !== "function") return;
      reconnecting = true;
      (async () => {
        for (let delay = 1000; ; delay = Math.min(delay * 2, 15000)) {
          await new Promise(r => setTimeout(r, delay));
          try { if (await core.reconnect()) break; } catch { /* still down */ }
        }
        reconnecting = false;
        // Transports fire this on connect; transport.reconnect() doesn't, so
        // do it here to update the backend.connected flag and status pill.
        dispatchEvent(new CustomEvent("velta-core-status", { detail: { connected: true, backend: core.backend?.kind } }));
        scheduleChatListRefresh(0);
        toast("Reconnected to Delta Chat core", 2500);
      })();
    });

    appLog("boot: handleDeeplink");
    // Before any chat link is routed: a cold-start notification is parked in
    // the opened-url queue and would otherwise be accepted with no token yet.
    try {
      const token = await window.__TAURI__?.core?.invoke?.("chat_link_token");
      if (typeof token === "string" && token) chatLinkToken = token;
    } catch (err) {
      console.warn("chat link token unavailable:", err);
    }
    await handleDeeplink();

    // OS opens (invite links, notification taps, #97 shares). The shell parks
    // them until take_opened_urls; "deeplink" is only the wake-up, so a burst
    // of photos is one drain. Listen first, then drain, or a share that
    // arrives during boot is emitted before anyone is listening.
    try {
      const tauri = window.__TAURI__;
      if (tauri?.event?.listen) {
        await tauri.event.listen("deeplink", () => scheduleDrainOpened());
        // Desktop event emitted by tauri-plugin-deep-link (Windows / Linux / macOS).
        // That plugin does not use the opened-url queue.
        await tauri.event.listen("deep-link://new-url", ev => {
          const urls = Array.isArray(ev.payload) ? ev.payload : [ev.payload];
          routeOpenedBatch(urls.filter(Boolean));
        });
      }
      await drainOpened();
    } catch (err) {
      console.warn("Tauri deep-link setup failed:", err);
    }
    // The chat list is up: a share parked during boot opens its picker now.
    shareInbox.ready();
    // A wake-up emitted while the WebView was frozen or reloading can be
    // lost; the shell keeps the urls, so drain again on every return.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleDrainOpened(); });
    try { window.__TAURI__?.event?.listen?.("velta-foreground", () => scheduleDrainOpened()); } catch { /* no shell */ }

    // diagnostic hook: ?openchat=<id> opens a chat directly after boot
    const autoOpen = new URLSearchParams(location.search).get("openchat");
    if (autoOpen && !isNaN(+autoOpen)) openChat(+autoOpen);

    // PWA: service worker + install prompt
    // The SW was removed from the native shells (Tauri/Android): they serve
    // bundled assets fresh on every launch, and a cache-first SW kept serving
    // STALE js across upgrades — devices kept running old code with a new
    // Rust shell, which is un-debuggable. Unregister leftovers. The C4 PWA
    // dist (window.VELTA_PWA) registers its own precache SW and is exempt —
    // there the SW is the update mechanism, not a staleness hazard.
    if ("serviceWorker" in navigator && !window.VELTA_PWA) {
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
      if (e.key === "Escape") { chatView?.exitSelection(); closeAllPopups(); }
    });
    appLog("boot: done");
  } catch (err) {
    appLog(`boot FAILED: ${err?.message || err}\n${err?.stack || ""}`);
    errToast(`Startup error: ${err?.message || err}`, 8000);
    // No usable UI yet → the splash is the error surface (it shows this log).
    if (!uiLive && !splashSession) splashSession = showSplash();
    throw err;
  }
}

boot();
