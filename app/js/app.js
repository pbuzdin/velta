// app.js — Velta bootstrap: chat list, navigation, modals, PWA
import { createCore } from "./transport.js";
import "./components.js";
import { escapeHtml, escapeAttr } from "./components.js";
import { fileUrl } from "./media.js";
import { buildAvatarSvg, setFingerprintSource, fingerprintFor, fingerprintGroups } from "./avatar.js";
import { ChatView, setAvatarProfileOpener } from "./chat-view.js";
import { initCalls } from "./calls.js";
import { initWebxdc } from "./webxdc-manager.js";
import { diagnosticsSink, DiagnosticsStore, DIAGNOSTICS_CHAT_ID, diagnosticRow } from "./diagnostics.js";
import { parseInviteLink, inviteLabel, bindInviteInterception, showInviteDomainsModal } from "./invites.js";
import { buildDrawer, showModal, showContextMenu, toast, closeAllPopups, confirmModal, showInvite, showEditProfile, notifyIncoming, setCoreVersionDisplay, checkForUpdate } from "./ui.js";
import { p2pAvailable, p2pEnabled, setP2pEnabled, pairNearbyFlow, showInviteModal, addContact } from "./p2p.js";
import { withLocalChat, hubModel, renameDevice, removePeer, lcQueueItems, retryQueuedItem, cancelQueuedItem } from "./local-chat.js";
import { timeAgo, formatBytes } from "./mock-core.js";
import { acquireCode } from "./qr-scan.js";

const diagnostics = new DiagnosticsStore();
window.__veltaDiagnostics = diagnostics;
let core = null;
let diagnosticsOpen = false;
let chatView = null;
let calls = null;
let coreStartupPromise = null;
// Declared at the top: scheduleChatListRefresh() is reachable from the
// diagnostics "changed" listener while the module is still evaluating (the
// top-level await below yields to events), so these must not live further
// down — `let` declarations would still be in their temporal dead zone.
let chatListRefreshTimer = null;
let chatListInFlight = null;
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
let listView = "chats";
const CALL_LOG_KEY = "velta-call-log";
const state = {
  account: null,
  accountChanging: false,
  accounts: [],  // all core profiles, for the drawer account switcher
  chats: [],
  activeChatId: null,
  query: "",
  theme: localStorage.getItem("dw-theme") || "auto",
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
  const head = document.createElement("velta-chat-head");
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
  setFingerprintSource((contactId) => core.getContactEncryptionInfo(contactId));
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
  chatListRefreshTimer = null;
  chatListInFlight = null;
  state.chats = [];
  state.query = "";
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

addEventListener("velta-core-status", e => {
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
// per-transport connectivity/quota JSON-RPC in the core.
function parseConnectivityHtml(html) {
  const out = [];
  const weight = { red: 3, yellow: 2, grey: 1, green: 0 };
  const stateFor = { green: "ok", yellow: "connecting", grey: "connecting", red: "down" };
  // The transport <li>s nest a quota <ul><li>, so match each transport from
  // its opening tag to the next one (or the end of the transports section,
  // i.e. the next <h3> / </body>) instead of the first </li>.
  const start = html.indexOf('<li class="transport');
  if (start < 0) return out;
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
  return out;
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

  // Detail bar (hover / pull-down reveal): one row per relay — status, quota.
  const detail = document.getElementById("relay-detail");
  if (detail) {
    detail.replaceChildren(...segs.map(s => {
      const row = document.createElement("div");
      row.className = "relay-detail-row";
      row.dataset.state = s.state;
      const dot = document.createElement("span"); dot.className = "relay-detail-dot";
      const dom = document.createElement("span"); dom.className = "relay-detail-domain";
      dom.textContent = s.domain || "Relay";
      const txt = document.createElement("span"); txt.className = "relay-detail-text";
      txt.textContent = s.quota ? `${s.text || title} · ${s.quota}` : (s.text || title);
      row.append(dot, dom, txt);
      return row;
    }));
  }
}

// Mobile: pulling down at the top of the chat list reveals the detail bar
// (pull-to-refresh gesture); it hides itself again after a few seconds.
const chatListEl = document.getElementById("chat-list");
const relayDetailEl = document.getElementById("relay-detail");
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
  if (state.accountChanging) return;
  if (chatListRefreshTimer) return; // a trailing refresh is already pending
  chatListRefreshTimer = setTimeout(async () => {
    chatListRefreshTimer = null;
    await refreshChatList();
  }, delay);
}

// Report UI visibility to the Rust shell: the Android background event
// poller only drains core events while this WebView is paused (the
// foreground CoreService keeps the process alive). Events it consumed never
// reached the frontend, so on becoming visible we refetch what's on screen.
function reportUiVisible() {
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    invoke?.("set_ui_visible", { visible: !document.hidden })?.catch?.(() => {});
  } catch {}
  if (!document.hidden && core) {
    scheduleChatListRefresh();
    if (state.activeChatId) chatView?.onMsgsChanged(state.activeChatId);
  }
}
document.addEventListener("visibilitychange", reportUiVisible);

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

function toggleLcQueuePop(chatId) {
  const existing = document.getElementById("lc-queue-pop");
  if (existing) { existing.remove(); return; }
  const items = lcQueueItems(chatId);
  const pop = document.createElement("div");
  pop.id = "lc-queue-pop";
  pop.innerHTML = `<div class="lq-head">Queued — sends when the device is reachable</div>` + items.map(it => `
    <div class="lq-row" data-id="${escapeAttr(it.id)}">
      <span class="lq-name">${escapeHtml(it.name || "file")}${it.size ? ` · ${formatBytes(it.size)}` : ""}</span>
      <button class="btn-text" data-lq-retry="${escapeAttr(it.id)}">Send now</button>
      <button class="btn-text" data-lq-cancel="${escapeAttr(it.id)}" aria-label="Remove from queue">✕</button>
    </div>`).join("");
  document.body.appendChild(pop);
  pop.addEventListener("click", async e => {
    const retryId = e.target.closest("[data-lq-retry]")?.dataset.lqRetry;
    const cancelId = e.target.closest("[data-lq-cancel]")?.dataset.lqCancel;
    if (retryId) {
      try { await retryQueuedItem(chatId, retryId); toast("Sending…"); }
      catch (err) { toast(String(err?.message || err)); }
      toggleLcQueuePop(chatId); // re-render with fresh queue
    }
    if (cancelId) { cancelQueuedItem(chatId, cancelId); toggleLcQueuePop(chatId); }
  });
  const anchor = () => document.getElementById("lc-queue-chip");
  const place = () => {
    const a = anchor();
    if (!a) return;
    pop.style.right = Math.max(8, innerWidth - a.getBoundingClientRect().right) + "px";
    pop.style.bottom = Math.round(innerHeight - a.getBoundingClientRect().top + 10) + "px";
  };
  place();
  const outside = ev => { if (!pop.contains(ev.target) && ev.target !== document.getElementById("lc-queue-chip")) { pop.remove(); document.removeEventListener("pointerdown", outside, true); } };
  document.addEventListener("pointerdown", outside, true);
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
    renderLocalChatCard();
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
      <button class="btn-text lc-chat" data-chat="${escapeAttr(p.id)}" title="Open chat" aria-label="Open chat with ${escapeAttr(p.name)}">Chat</button>
      <button class="btn-text lc-remove" data-remove="${escapeAttr(p.rawId || p.id)}" title="Remove device" aria-label="Remove ${escapeAttr(p.name)}">✕</button>
    </div>`).join("");
  const nearbyRows = model.nearby.map(n => `
    <div class="lc-row" data-pair="${escapeAttr(n.id)}">
      <span class="lc-dot on"></span>
      <span class="lc-row-name">${escapeHtml(n.name || n.id.slice(0, 12))}</span>
      <button class="btn-text" data-pair="${escapeAttr(n.id)}">Pair</button>
    </div>`).join("");
  el.innerHTML = `
    <div class="lc-card-head${lcCardOpen ? " open" : ""}" data-toggle>
      ${wifiSvg}
      <span class="lc-card-title">Local chat</span>
      <span class="lc-card-chevron"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </div>
    <div class="lc-card-body">
      <div class="lc-device">This device: <b>${escapeHtml(model.device.name)}</b>${short ? ` <span class="lc-nodeid">(${escapeHtml(short)})</span>` : ""} <button class="btn-text" data-rename>Edit name</button></div>
      <div class="lc-actions">
        <button class="btn-text" data-invite>Show invite</button>
        <button class="btn-text" data-add>Add contact</button>
      </div>
      ${nearbyRows ? `<div class="lc-sec">Nearby — discovered on this network</div>${nearbyRows}` : ""}
      ${peerRows ? `<div class="lc-sec">Paired devices</div>${peerRows}` : ""}
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
    if (!(await confirmModal("Remove device", `Forget "${name}"? Its chat history and received files will be deleted. The device can re-pair with a new invite.`, "Remove"))) return;
    try {
      await removePeer(peerId);
      toast("Device removed");
      renderLocalChatCard();
      refreshChatList();
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
  listView = listView === view ? "chats" : view;
  for (const b of document.querySelectorAll(".list-bar .bar-btn[data-view]")) {
    b.classList.toggle("active", b.dataset.view === listView);
  }
  syncHeaderButtons();
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
      } catch (err) { toast(`Could not open chat: ${err?.message || err}`); }
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
    b.className = "chat-item call-row";
    b.innerHTML = `
      <span class="call-row-ico"><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 006.6 6.6l2.2-2.2a1 1 0 011-.24 11.4 11.4 0 003.6.58 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.4 11.4 0 00.57 3.6 1 1 0 01-.25 1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></span>
      <div class="ci-name">${escapeHtml(chat ? chat.name : "Unknown chat")}</div>
      <div class="ci-time">${timeAgo(e.ts)}</div>`;
    b.addEventListener("click", () => { setListView("chats"); openChat(e.chatId); });
    rows.append(b);
  }
}

function renderQrView() {
  const rows = sideViewShell("Your QR code", "Others scan this to reach you with verified encryption");
  const wrap = document.createElement("div");
  wrap.className = "qr-view";
  wrap.innerHTML = `
    <div class="qr-box"><div class="qr-loading">Generating QR code…</div></div>
    <div class="invite-link" style="word-break:break-all"></div>
    <button class="btn-text" data-scan>Scan a code instead</button>`;
  rows.append(wrap);
  wrap.querySelector("[data-scan]").addEventListener("click", () => { setListView("chats"); joinFlow(); });
  inviteQrProvider(null)()
    .then(({ svg, link }) => {
      const box = wrap.querySelector(".qr-box");
      if (listView !== "qr") return;
      box.innerHTML = svg || "<div class='qr-loading'>QR unavailable</div>";
      wrap.querySelector(".invite-link").textContent = link;
    })
    .catch(err => {
      if (listView !== "qr") return;
      wrap.querySelector(".qr-box").innerHTML =
        `<div class='qr-loading'>Couldn't create the invite:<br>${escapeHtml(String(err?.message || err))}</div>`;
    });
}

function renderChatList() {
  if (listView !== "chats") return; // another side view owns the container
  const list = $("chat-list");
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
  for (const child of [...list.children]) {
    if (child.tagName === "VELTA-CHAT-ITEM") {
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
  });
}

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
  callBtn.onclick = chat.kind === "single" && !chat.isP2p ? () => calls?.startOutgoing(chat.id, chat.name) : null;
  // Device messages are read-only system posts — no composer. Every open
  // sets it explicitly (closeChatUI restores it to visible). Channels need a
  // rights check: members without posting rights get no composer either.
  $("main-composer").hidden = chat.kind === "device";
  if (chat.kind === "channel" && core.canSend) {
    core.canSend(chatId).then(can => {
      if (!current() || state.activeChatId !== chatId) return;
      $("main-composer").hidden = !can;
    }).catch(() => {});
  }
  refreshChatHeadPresence(chatId);
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
  renderLcQueueTray();
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

async function showChatInfo(chat) {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
  // Hydrate presence for 1:1 profiles opened without it (the core tracks
  // last-seen from incoming messages; the self contact has none).
  if (!chat.contact && chat.kind === "single" && chat.contactId && chat.contactId !== 1 && core.getContact) {
    try { chat.contact = { ...(await core.getContact(chat.contactId)), contactId: chat.contactId }; } catch {}
  }
  const contactRows = chat.contact ? `
    <div class="info-row"><span class="k">Address</span><span class="v">${escapeHtml(chat.contact.addr)}</span></div>
    ${chat.contactId ? `<div class="info-row"><span class="k">Profile key</span><span class="v"><span class="avatar-profile-fpr" data-profile-key>…</span></span></div>` : ""}
    ${chat.contact && (chat.contact.online || chat.contact.lastSeen) ? `<div class="info-row"><span class="k">Last seen</span><span class="v">${escapeHtml(chat.contact.online ? "online" : timeAgo(chat.contact.lastSeen))}</span></div>` : ""}` : "";
  const isGroup = chat.kind === "group" || chat.kind === "channel";
  const body = document.createElement("div");
  body.innerHTML = `
    <div style="display:flex;justify-content:center;align-items:center;gap:16px;padding:8px 0 14px">
      <velta-avatar class="chat-info-avatar" name="${escapeHtml(chat.name)}" color="${chat.avatarColor || "#777"}" kind="${chat.kind}" size="168"${chat.contactId ? ` contact-id="${chat.contactId}"` : ""}${chat.contact && chat.contact.addr ? ` addr="${escapeAttr(chat.contact.addr)}"` : ""}${chat.avatar ? ` avatar="${escapeAttr(fileUrl(chat.avatar))}"` : ""}></velta-avatar>
      ${chat.contactId ? `<span class="chat-info-tile" data-caption-tile></span>` : ""}
    </div>
    ${!isGroup && chat.contactId && chat.contactId !== 1 ? `<div class="profile-actions">
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
    const epoch = core.accountEpoch;
    const chatId = chat.id;
    const p2p = chat.isP2p || String(chatId).startsWith("p2p:");
    const input = document.createElement("input");
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
    { label: "New group", onClick: async () => {
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
    { label: "Join chat via invite link", onClick: joinFlow },
    { label: "Add account via invite link", onClick: addAccountFlow },
  ];
}

function renderNewChatView() {
  const rows = sideViewShell("Start something", "Pick what to create");
  for (const opt of newChatOptions()) {
    const b = document.createElement("button");
    b.className = "chat-item side-option";
    b.innerHTML = `<span class="side-option-label">${escapeHtml(opt.label)}</span>
      <svg viewBox="0 0 24 24" class="side-option-arrow"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    b.addEventListener("click", () => { setListView("chats"); opt.onClick(); });
    rows.append(b);
  }
}

// Search view: live chat-name filter rendered in place of the chats list.
// The header search button toggles this view and flips to a cross.
function renderSearchView() {
  const rows = sideViewShell("Search chats", "Type at least two characters");
  const input = document.createElement("input");
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
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn-text btn-primary";
    ok.style.width = "auto";
    ok.textContent = okLabel || "Save";
    foot.append(cancel, ok);
    const done = v => { resolve(v); close(); };
    const { close } = showModal({ title, body, foot, onClose: () => resolve(null) });
    ok.addEventListener("click", () => done(input.value.trim()));
    cancel.addEventListener("click", () => done(null));
    input.addEventListener("keydown", e => { if (e.key === "Enter") done(input.value.trim()); });
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
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn-text btn-primary";
    ok.style.width = "auto"; // btn-primary defaults to the full-width onboarding bar
    ok.textContent = "Create group";
    foot.append(cancel, ok);
    const done = value => { resolve(value); close(); };
    const { close } = showModal({ title: "New group", body, foot, onClose: () => resolve(null) });
    ok.addEventListener("click", () => done(input.value.trim() || "New group"));
    cancel.addEventListener("click", () => done(null));
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") done(input.value.trim() || "New group");
    });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
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
    theme: state.theme,
    barHidden,
    onBarToggle: (key, visible) => {
      barHidden = visible ? barHidden.filter(k => k !== key) : [...new Set([...barHidden, key])];
      localStorage.setItem(BAR_HIDDEN_KEY, JSON.stringify(barHidden));
      applyBarVisibility();
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
        toast(`Local chat toggle failed: ${error?.message || error}`, 5000);
      }
      rebuildDrawer();
    },
    accounts: state.accounts,
    currentAccountId: core.accountId,
    onAccountTap: accountTapFlow,
    onRelays: () => openRelaysModal(),
    onSetTheme: (mode) => { state.theme = mode; applyTheme(); },
    onAddAccount: addAccountFlow,
    onSecondDevice: secondDeviceFlow,
    onInvite: () => showInvite(inviteQrProvider(null), { account: state.account }),
    onProfile: openSelfProfile,
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
  const foot = document.createDocumentFragment(); // direct child of .modal-foot -> one-row flex
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
        <button class="btn-text splash-btn" data-local type="button">Enter local chat…</button>
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
      await askNotificationPermission();
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

/* ---------------- boot ---------------- */
let uiLive = false; // set once the drawer + menu are wired and usable
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
      }
    } catch {}

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
      refreshAccounts();
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
      applyBarVisibility();
      bindChatHeadMenu();
      // Invite cards in messages + any invite-host link tap → join flow
      bindInviteInterception(link => joinFromInvite(link));

      $("btn-search").addEventListener("click", () => setListView(listView === "search" ? "chats" : "search"));
      $("btn-new-chat").addEventListener("click", () => setListView(listView === "new" ? "chats" : "new"));
      syncHeaderButtons();
    } catch (err) {
      diagnostics.append("error", `boot: bind ui failed: ${err?.message || err}`);
    }

    core.addEventListener("incoming-msg", ev => {
      scheduleChatListRefresh();
      const msg = ev?.detail?.msg;
      const chat = state.chats.find(c => c.id === msg?.chatId);
      notifyIncoming(
        msg?.fromContact?.name || msg?.fwdFrom || "New message",
        (msg?.text || "").replace(/\s+/g, " ").slice(0, 120) || "New message",
        {
          chatName: chat?.name || null,
          senderName: msg?.fromContact?.name || null,
          senderAvatar: msg?.fromContact?.avatar || null,
        },
      );
    });
    core.addEventListener("call-ended", ev => {
      recordCallEnded(ev?.detail?.chatId);
    });
    core.addEventListener("msgs-changed", () => {
      scheduleChatListRefresh();
      // Local chat (and any transport without push-to-view) relies on this to
      // pull new messages into the open chat without waiting for the 20s tick.
      if (state.activeChatId) chatView?.onMsgsChanged(state.activeChatId);
      renderLcQueueTray();
    });
    core.addEventListener("chat-updated", ev => {
      scheduleChatListRefresh();
      refreshActiveChatHeader(ev?.detail?.chatId);
      const updId = ev?.detail?.chatId;
      if (updId && updId === state.activeChatId) refreshChatHeadPresence(updId);
    });
    // Safety net only: contact requests and new chats normally arrive via
    // core events (handled above with a debounced refresh). With in-place
    // chat-list updates a refresh is cheap, but each one still costs two RPC
    // round trips, so don't run it more often than needed.
    setInterval(() => {
      scheduleChatListRefresh();
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
      if (e.key === "Escape") { chatView?.exitSelection(); closeAllPopups(); }
    });
    appLog("boot: done");
  } catch (err) {
    appLog(`boot FAILED: ${err?.message || err}\n${err?.stack || ""}`);
    toast(`Startup error: ${err?.message || err}`, 8000);
    // No usable UI yet → the splash is the error surface (it shows this log).
    if (!uiLive && !splashSession) splashSession = showSplash();
    throw err;
  }
}

boot();
