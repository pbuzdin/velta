// app.js — Velta bootstrap: chat list, navigation, modals, PWA
import { createCore } from "./transport.js";
import { createNetWatch, NET_DEFAULTS } from "./net-watch.js";
import "./components.js";
import { escapeHtml, escapeAttr } from "./components.js";
import { chatCategoryOf, chatIsUnread, swipeCategoryStep, batteryReactionPlan, chatsInCommon } from "./rpc-core.js";
import { probeLock, unlockInteractive, prfSupported } from "./db-lock.js";
import { deriveKekPassphrase, deriveKekPrf, prfCreate, prfEval, b64 } from "./db-crypt.js";
import { fileUrl, setWasmBlobReader, redactMediaUrl } from "./media.js";
import { mountMemberList } from "./member-list.js";
import { adminCaps, adminBadgeHtml, adminInfoText, canRemoveMember } from "./admin-group.js";
import { mentionsMe, fprCode } from "./mentions.js";
import { mutedChatAllows, mentionInMutedOn } from "./notify-policy.js";
import { buildAvatarSvg, setFingerprintSource, fingerprintFor, fingerprintFromVcard, fingerprintGroups, cachedFingerprintIsDerived } from "./avatar.js";
import { ChatView, setAvatarProfileOpener, saveAttachmentFile, openAttachmentFile } from "./chat-view.js";
import { mediaSectionsHtml, mountChatMedia } from "./chat-media.js";
import { initCalls } from "./calls.js";
import { initWebxdc, openWebxdc, prefetchInfo, appIconUrl } from "./webxdc-manager.js";
import { initGroupCallUi } from "./group-call-ui.js";
import { notePushDiagnostic, relaySupportsPush } from "./relay-push.js";
import { diagnosticsSink, DiagnosticsStore, DIAGNOSTICS_CHAT_ID, diagnosticRow, isSendFailureDiagnostic, createRelaySendErrorState } from "./diagnostics.js";
import { parseInviteLink, inviteLabel, bindInviteInterception, showInviteDomainsModal, isShortInviteLink, expandShortInvite } from "./invites.js";
import { activeWsRelay, addWsRelay, listWsRelays, normalizeHost, probeC3Relay, probeDnsVia, showWsRelaysModal, useWsRelay } from "./ws-relays.js";
import { getChoice as getMdChoice, recordChoice as recordMdChoice, markNotified as markMdNotified, classify as classifyMultiDevice, mdLabel, retryDelay as mdRetryDelay, offConfirmText as mdOffConfirmText, forgetAccount as forgetMdAccount, MD_REENABLED_NOTE } from "./multidevice.js";
import { openImageLightbox, openVideoLightbox, bindMenuToggle, buildDrawer, showModal, footButtons, showContextMenu, toast, closeAllPopups, confirmModal, showInvite, showEditProfile, notifyIncoming, notifyThrottled, setCoreVersionDisplay, checkForUpdate, popoverSupported, fillSplashVersion, uiZoom, applyUiScale } from "./ui.js";
import { createNotifyQueue } from "./notify-queue.js";
import { serializeSettings, parseSettings, diffSettings, applySettings, normalizeDownloadLimit } from "./settings-transfer.js";
import { p2pAvailable, p2pEnabled, setP2pEnabled, pairNearbyFlow, showInviteModal, addContact, showCreateGroupModal, showAddMembersModal } from "./p2p.js";
import { withLocalChat, hubModel, renameDevice, removePeer, dismissLocalGroup, groupRename, groupRemoveMember, peerGroupImpact, groupActionsModel, groupMemberHint, removePeerImpactText, lcQueueItems, retryQueuedItem, cancelQueuedItem } from "./local-chat.js";
import { timeAgo, formatBytes, timeTag } from "./format.js";
import { openInAppBrowser } from "./inapp-browser.js";
import { dontKillMyAppUrl, makerLabel, shouldAskBattery, rememberBatteryAnswer } from "./battery-prompt.js";
// Fix 5 (startup): rarely used features load on first use via import().
// The PWA build precaches the whole dist and Tauri/Android serve app/ as is,
// so the lazily imported files ship everywhere (tests/lazy-modules.test.mjs).
const loadQrScan = () => import("./qr-scan.js");
const acquireCode = async (opts) => (await loadQrScan()).acquireCode(opts);
// Same handle as qr-scan.js mountScanner; calls made before the module
// arrives are replayed (start) or cancel the mount (destroy).
function mountScanner(opts) {
  let real = null, dead = false, want = false;
  loadQrScan().then((m) => {
    if (dead) return;
    real = m.mountScanner(opts);
    if (want) real.start();
  }).catch((err) => { if (!dead) opts.onState?.("error", String(err?.message || err)); });
  return {
    start() { if (real) return real.start(); want = true; },
    stop() { want = false; return real?.stop(); },
    destroy() { dead = true; want = false; return real?.destroy(); },
    get running() { return !!real?.running; },
  };
}
import { saveWsLink, joinWithWsLink } from "./ws-transport.js";
import { bindInviteCards, parseRelayInviteInput, relayClaimResult } from "./invite-cards.js";
import { extractWsLink, acceptWsLink, openWsTransportSettings, refreshWsTransportStatus, wsTransportStatus, wsDrawerLabel, testHostFor } from "./ws-transport.js";
import { scanTabAvailable, canShareLink, copyLink, shareLink, classifyScannedCode } from "./qr-actions.js";
import { parseSharePayload, shareTextIfUnconsumed, sharePlan, createShareInbox, buildSharePicker } from "./share-in.js";
import { linkPreviewMode, setLinkPreviewMode, LINK_PREVIEW_LABELS, setLinkPreviewProxySource, activeProxyUrl } from "./link-preview.js";
import { wirePushSection } from "./push-settings.js";
import { wireWebPushSection, refreshWebPush } from "./web-push.js";
import { extractTunnelLink, acceptTunnelLink, makeChooser, openTunnelSettings, refreshTunnelStatus, tunnelOffered, tunnelStatus, describeTunnel, bindTunnelNetworkEvents, initTunnelDiagnostics } from "./tunnel.js";
import { wrapIdentityBundle, unwrapIdentityBundle, buildIdentityBundle, bytesToBase64, base64ToBytes, backupDownloadName, gzipBytes, mailLoginFromTransports, accountDirFromToml, mailLoginsFromDbText } from "./identity-backup.js";
import { isAndroid, tauriInvoke } from "./tauri.js";
import { ScheduledRunner, localStore, tauriStore } from "./scheduled.js";
import { pickSendTime, openScheduledList, maybeAskExactAlarm, formatDue } from "./scheduled-ui.js";
import { recordApp } from "./app-browser.js";
import { applyDocumentLang, translateTree, t } from "./i18n.js";
import { mountInviteDomains } from "./invite-domains.js";
import { ICON, LOOP_SVG, P, svg } from "./icons.js";

applyDocumentLang();
translateTree(document);

const diagnostics = new DiagnosticsStore();
window.__veltaDiagnostics = diagnostics;

// Error toast that ALSO lands in the Diagnostics chat (see chat-view.js).
function errToast(text, ms = 3000) {
  diagnosticsSink.append("error", text);
  toast(text, ms);
}
let core = null;
// Multi-device switch state (see ensureMultiDevice). Declared up here, not
// next to its functions: event callbacks (imex-progress, resume) can run
// during the boot's top-level awaits, before later `let`s are initialized.
let multiDeviceState = "loading"; // "loading" | "on" | "off" | "unknown"
let multiDeviceReenabled = false;
let multiDeviceFor = null;
let multiDeviceGen = 0;
let multiDeviceRetry = null;
let multiDeviceAttempt = 0;
let diagnosticsOpen = false;
// Live-update gate for the open Diagnostics chat (pause button in its action
// bar): events keep being recorded into the store while paused, only the
// rendering freezes; resuming re-renders to catch up.
let diagnosticsPaused = false;
const DIAG_ICON_PAUSE = ICON.pause;
const DIAG_ICON_PLAY = ICON.playDiag;
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
  pendingChatId: null, // clicked chat, highlighted before its history is ready
  query: "",
  theme: localStorage.getItem("dw-theme") || "auto",
  // #57 category bar: active chip + lazy contact bot flags (P/B split).
  chatCategory: localStorage.getItem("velta-chat-category") || "all",
  contactBots: null, // null = not loaded; Map contactId -> bool once fetched
  contactBotsAcct: null, // account the contactBots map belongs to
};

function appLog(msg) {
  try {
    const invoke = tauriInvoke();
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
      toast(t("Core restarted"));
    } catch (error) {
      diagnostics.append("error", `Core restart failed: ${error?.message || error}`);
      errToast(t("Core restart failed: {why}", { why: error?.message || error }), 5000);
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
      toast(t("UI reconnected to core"));
    } catch (error) {
      diagnostics.append("error", `UI reconnect failed: ${error?.message || error}`);
      errToast(t("Reconnect failed: {why}", { why: error?.message || error }), 5000);
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
        const invoke = tauriInvoke();
        invoke?.("set_logging_enabled", { enabled: on }).catch?.(() => {});
        diagnostics.append("info", `Shell logging ${on ? "enabled" : "disabled"} — velta.log ${on ? "resumes" : "is frozen"} (Diagnostics chat keeps working)`);
      });
    }
  }
  if (devtoolsSw && !devtoolsSw.dataset.bound) {
    devtoolsSw.dataset.bound = "1";
    devtoolsSw.addEventListener("change", async () => {
      const on = devtoolsSw.checked;
      const invoke = tauriInvoke();
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
      const label = diagnosticsPaused ? t("Resume diagnostics") : t("Pause diagnostics");
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
  const invoke = tauriInvoke();
  invoke?.("set_logging_enabled", { enabled: localStorage.getItem("velta-logging") === "1" })?.catch?.(() => {});
}

// In the Tauri shell, record sidecar startup progress in diagnostics while the core is being located.
if (window.__TAURI__) {
  const tauri = window.__TAURI__;
  const invoke = tauri.core?.invoke || tauri.invoke;
  const event = tauri.event || tauri;
  const listen = event.listen ? event.listen.bind(event) : tauri.listen.bind(tauri);

  function applySidecarStatus(status) {
    diagnostics.append((status.error || status.stage === "error") ? "error" : "info", `Embedded core: ${status.stage || (status.running ? "running" : "stopped")}${(status.error || status.message) ? ` — ${status.error || status.message}` : ""}`);
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

  // Database locked (#178): accounts the OS-keychain key could not open.
  // Blocking overlay — onboarding must never run over unreadable data, and
  // nothing may look like a fresh install to the user.
  try {
    const showDbLocked = (payload) => {
      // #178 phase 4: an app-lock PIN session starts locked — the sidecar is
      // up but keyless; unlock_with_pin respawns it keyed. No reload button:
      // a reload would add nothing.
      if (payload?.mode === "pin") {
        if (document.getElementById("db-locked")) return;
        const el = document.createElement("div");
        el.id = "db-locked";
        el.innerHTML = `
          <div class="db-locked-card">
            <h2>Velta is locked</h2>
            <p>Enter your app-lock PIN to unlock this device's profiles. Nothing was reset.</p>
            <form class="db-pin-form">
              <input class="text-field db-pin-input" type="password" required autocomplete="current-password" placeholder="PIN">
              <button class="btn-primary db-pin-go" type="submit">Unlock</button>
            </form>
            <p class="db-locked-hint db-pin-status" hidden></p>
          </div>`;
        document.body.appendChild(el);
        const status = el.querySelector(".db-pin-status");
        const go = el.querySelector(".db-pin-go");
        el.querySelector(".db-pin-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          go.disabled = true;
          try {
            await invoke("unlock_with_pin", { pin: el.querySelector(".db-pin-input").value });
            location.reload();
          } catch (err) {
            const msg = String(err?.message || err || "");
            const wait = msg.startsWith("retry:") ? Number(msg.slice(6)) || 0 : 0;
            const tick = (left) => {
              if (left <= 0) { status.hidden = true; go.disabled = false; return; }
              status.textContent = `Too many attempts — wait ${left} s.`;
              status.hidden = false;
              setTimeout(() => tick(left - 1), 1000);
            };
            if (wait > 0) tick(wait);
            else {
              status.textContent = msg.includes("corrupt")
                ? "The PIN file is unreadable — restore your data via Profile management → Import backup."
                : `Couldn't unlock: ${msg}`;
              status.hidden = false;
              go.disabled = false;
            }
          }
        });
        el.querySelector(".db-pin-input").focus();
        return;
      }
      const locked = Array.isArray(payload?.locked) ? payload.locked.length : 0;
      if (!locked || document.getElementById("db-locked")) return;
      const el = document.createElement("div");
      el.id = "db-locked";
      el.innerHTML = `
        <div class="db-locked-card">
          <h2>Database locked</h2>
          <p>${locked} profile${locked === 1 ? " was" : "s were"} not decrypted with the key stored on this device. Your data is intact — nothing was reset.</p>
          <p class="db-locked-hint">Unlock your keychain (or credential manager) and try again, or restore via Profile management → Import backup.</p>
          <button class="btn-primary db-locked-retry" type="button">Try again</button>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".db-locked-retry").addEventListener("click", () => location.reload());
    };
    listen("velta-db-locked", ev => showDbLocked(ev.payload));
    invoke("get_db_lock_status").then(showDbLocked).catch(() => {});
  } catch (e) {
    console.warn("[velta] db-locked setup failed:", e);
  }

  // Encryption off / key missing (#178): a non-blocking notice so the user
  // knows this device is NOT storing the database encrypted, or why
  // encrypted profiles cannot open. Dismissible for the session only.
  try {
    invoke("get_db_key_issue").then((issue) => {
      if (!issue || document.getElementById("db-key-notice")) return;
      const missing = issue === "key-missing";
      const el = document.createElement("div");
      el.id = "db-key-notice";
      el.setAttribute("role", missing ? "alert" : "status");
      const title = missing ? t("Database key missing") : t("Database encryption is off");
      const body = missing
        ? t("Encrypted profiles exist, but this device's keychain has no key for them. No new key was created and nothing was reset. Restore the keychain or import a backup.")
        : t("No system keychain is available (on Linux: a Secret Service such as GNOME Keyring or KWallet), so messages on this device are stored unencrypted. Enable a keychain and restart Velta to turn encryption on.");
      el.innerHTML = `<div class="db-key-notice-text"><strong></strong><span></span></div><button type="button" class="db-key-notice-close"></button>`;
      el.querySelector("strong").textContent = title;
      el.querySelector("span").textContent = body;
      const close = el.querySelector("button");
      close.textContent = "×";
      close.setAttribute("aria-label", t("Dismiss"));
      close.addEventListener("click", () => el.remove());
      document.body.appendChild(el);
    }).catch(() => {});
  } catch (e) {
    console.warn("[velta] db-key notice setup failed:", e);
  }
}

// The splash is created on demand: boot shows it only when the account is
// unconfigured (setup screen) or the core failed to answer (log surface).
// Returning users with a configured profile never see it.
let splashSession = null;

// True from here (just before the first top-level await) until the module
// has evaluated. The early diagnostics chat is clickable while the top-level `await coreStartupPromise` (worker-wasm init,
// ~10+ s on phones) suspends evaluation, so renderChatList's helpers would
// hit module consts still in their TDZ (chatCatsEl, chatItemGhostIO, ...)
// and throw. renderChatList defers until the module is ready. (A global, not
// a module let, so test harnesses that lift renderChatList stay unaffected.)
globalThis.__veltaAppEvaluating = true;
let chatListRenderDeferred = false;
// Mirror diagnostics into velta.log (js_log): the in-app store is only
// visible on the phone's splash footer, while velta.log is pullable via
// adb (run-as) — every core/transport diagnostic must land in both.
// #178: an encrypted PWA snapshot unlocks BEFORE the transport exists (the
// worker gets the KEK in the boot message) so the 20s connect deadline
// never races the unlock prompt.
let bootDbKey = null;
let bootUnlockSrc = null;
let bootLockInfo = null;
if (!window.__TAURI__ && !window.VeltaBridge) {
  try {
    const lock = await probeLock();
    if (lock) {
      bootLockInfo = lock;
      ({ kek: bootDbKey, src: bootUnlockSrc } = await unlockInteractive(lock));
    }
  } catch (e) {
    diagnostics.append("error", `Unlock failed: ${e?.message || e}`);
  }
}
coreStartupPromise = createCore({
  dbKey: bootDbKey,
  unlockSrc: bootUnlockSrc,
  onDiagnostic: (level, message) => {
    diagnostics.append(level, message);
    notePushDiagnostic(message); // #110: relay "(U)" marks
    try {
      const invoke = tauriInvoke();
      if (invoke) invoke("js_log", { msg: `[diag:${level}] ${message}` }).catch(() => {});
    } catch {}
  },
});

// #178 phase 4: auto-lock — when enabled on an encrypted profile, returning
// after N minutes hidden reloads the page and the boot path asks for the
// passphrase/passkey/PIN again; the decrypted snapshot dies with the worker.
// The setting is read per transition, so the select applies at once.
if (bootLockInfo) {
  let armed = false;
  let timer = 0;
  document.addEventListener("visibilitychange", () => {
    const mins = Number(localStorage.getItem("velta-autolock-mins")) || 0;
    if (document.hidden) {
      armed = false;
      clearTimeout(timer);
      if (mins > 0) timer = setTimeout(() => { armed = true; }, mins * 60_000);
    } else {
      clearTimeout(timer);
      if (armed) location.reload();
    }
  });
}

// #178 phase 4 (desktop): auto-lock respawns the sidecar KEYLESS, so the
// PIN screen returns — only meaningful when a PIN is the key root (the
// keychain would just re-key without asking the user anything).
if (window.__TAURI__) {
  try {
    const invoke = tauriInvoke();
    if (invoke) {
      invoke("get_db_pin_state").then((pinOn) => {
        if (!pinOn) return;
        let armed = false;
        let timer = 0;
        document.addEventListener("visibilitychange", () => {
          const mins = Number(localStorage.getItem("velta-autolock-mins")) || 0;
          if (document.hidden) {
            armed = false;
            clearTimeout(timer);
            if (mins > 0) timer = setTimeout(() => { armed = true; }, mins * 60_000);
          } else {
            clearTimeout(timer);
            if (armed && !document.getElementById("db-locked")) invoke("lock_now").catch(() => {});
          }
        });
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("[velta] desktop auto-lock setup failed:", e);
  }
}

// #178 phase 4: backup reminder — stale after 30 days without a successful
// export (or right after encryption was turned on), re-shown at most weekly
// until one is exported. PWA only for now; the desktop reminder rides a
// later slice.
{
  const now = Date.now();
  const day = 86_400_000;
  const lastBak = Number(localStorage.getItem("velta-last-backup")) || 0;
  const reminded = Number(localStorage.getItem("velta-backup-reminded")) || 0;
  const nudge = localStorage.getItem("velta-enc-nudge") === "1";
  if (bootLockInfo && (((!lastBak || now - lastBak > 30 * day) && now - reminded > 7 * day) || (nudge && now - reminded > day))) {
    toast(t("Encryption is on but there is no recent backup. Export one from Profile management → Export backup — without it, losing the passphrase or the passkey loses the data."), 9000);
    try { localStorage.setItem("velta-backup-reminded", String(now)); localStorage.removeItem("velta-enc-nudge"); } catch {}
  }
}

try {
  core = withLocalChat(await coreStartupPromise);
  wireFingerprints();
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
// Device-chat language card when the OS speaks ru/fr and the UI does not.
import("./lang-cards.js").then(lc => lc.maybeAddLangCard(core)).catch(() => {});
if (core?.transport?.readCoreFile) setWasmBlobReader((path) => core.transport.readCoreFile(path));
// The core's per-transport Info events (IMAP/DNS/quota/idle chatter) flood
// the Diagnostics chat within seconds and bury everything useful. Keep
// warnings/errors plus the Info lines that actually describe message
// arrival and downloads.
const DIAGNOSTIC_INFO_KEEP = /receive_imf|download|secure|pre-message|post-message|Receiving message/i;
const DIAGNOSTIC_INFO_SKIP = /ConnectivityChanged|ImapInboxIdle|ImapConnected|SmtpConnected|SmtpMessageSent|imap\.rs|dns\.rs|scheduler\.rs|quota\.rs|select_folder\.rs|idle\.rs|key\.rs/i;
core.addEventListener?.("diagnostic", e => {
  const level = e.detail?.level || "info";
  const message = e.detail?.message || t("Core event");
  if (level === "info") {
    if (DIAGNOSTIC_INFO_SKIP.test(message) && !DIAGNOSTIC_INFO_KEEP.test(message)) return;
  }
  diagnostics.append(level, message);
  // #102: send failures also raise the relay line's transient "sending
  // delayed" state; the toast is throttled inside (error-level only).
  if (isSendFailureDiagnostic(level, message)) {
    const r = relaySendErrorState.note(level);
    if (r.raised) renderRelayLine();
    if (r.toast) toast(t("Sending delayed — the relay is retrying in the background"), 6000);
  }
});

// #28: pause the core's IMAP/SMTP loops while the device has no network
// (airplane mode / no interface) instead of hammering relays into retry
// storms; resume with a maybe_network nudge when connectivity returns.
// Boot-synced too, so starting Velta offline never arms the loops. Mock
// cores have no setNetworkIo — optional call is a no-op there.
// VPN-toggle fix: see net-watch.js — grace period before pausing, resume on
// any network/foreground signal, periodic safety net.
const netWatch = createNetWatch({ core: () => core, isOnline: () => navigator.onLine, opts: { pauseIo: !isAndroid() } });
addEventListener("online", () => netWatch.onSignal("online"));
addEventListener("offline", () => netWatch.onOffline());
addEventListener("focus", () => netWatch.onSignal("focus"));
addEventListener("pageshow", () => netWatch.onSignal("pageshow"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) netWatch.onSignal("visible"); });
try { navigator.connection?.addEventListener?.("change", () => netWatch.onSignal("connection")); } catch { /* unsupported */ }
try {
  window.__TAURI__?.event?.listen?.("velta-network", e => (e?.payload === false ? netWatch.onOffline() : netWatch.onSignal("native")));
  window.__TAURI__?.event?.listen?.("velta-foreground", () => netWatch.onSignal("foreground"));
} catch { /* no shell */ }
setInterval(() => netWatch.tick(), NET_DEFAULTS.tickMs);
netWatch.boot();

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
    const raw = await tauriInvoke()?.("get_battery_status");
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

function wireFingerprints() {
  setFingerprintSource(
    (contactId) => core.getContactEncryptionInfo(contactId),
    core.accountId,
    {
      addrOf: async (contactId) => (await core.getContact(contactId))?.addr || "",
      // get_contact_encryption_info throws for contact 1; make_vcard carries
      // the public key, whose OpenPGP fingerprint is the real identity.
      selfFingerprint: async () => core.makeVcard
        ? fingerprintFromVcard(await core.makeVcard([1]))
        : null,
    },
  );
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
  drawer?.destroy?.();
  drawer?.el.remove();
  drawer?.overlayEl?.remove();
  drawer = null;
});
// A finished (1000) or aborted (0) backup export / second-device transfer
// may have turned bcc_self on (core imex export_database): re-check so the
// user is told and offered "Turn off again".
core.addEventListener("imex-progress", e => {
  const p = e.detail?.progress;
  if (p === 1000 || p === 0) setTimeout(() => ensureMultiDevice(), 500);
});
core.addEventListener("account-changed", () => {
  state.accountChanging = false;
  wireFingerprints();
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
  const invoke = tauriInvoke();
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
const RELAY_SEND_SVG = ICON.relaySend;

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
    relayState = "local"; title = t("Demo mode — everything stays on this device");
  } else if (state.account && state.account.configured === false && p2pAvailable()) {
    relayState = "local"; title = t("Local chat mode — no relay configured");
  } else if (relayConnectivity == null) {
    relayState = "connecting"; title = t("Checking relay…");
  } else if (relayConnectivity >= 4000) {
    // #102: relay up but SMTP keeps retrying — distinct "delayed" state,
    // not the red relay-down look.
    relayState = relaySendErrorState.active ? "delayed" : "ok";
    title = relaySendErrorState.active ? t("Sending delayed — the relay is retrying") : t("Relay connected");
  } else if (relayConnectivity >= 2000) {
    relayState = "connecting"; title = t("Connecting to relay…");
  } else if (relayDownSince && Date.now() - relayDownSince > RELAY_DOWN_AFTER_MS) {
    relayState = "down"; title = t("Relay unreachable — retrying");
  } else {
    relayState = "connecting"; title = t("Relay problems — retrying…");
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
    if (s.state === "unreachable") return t("{relay}: not accepting new connections (web check failed)", { relay: base });
    if (s.state === "offline") return t("{relay}: offline (not accepting connections for a while)", { relay: base });
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
      chip.title = `${segTitle(s)}${s.quota ? ` · ${s.quota}` : ""}${isSendRelay(s) && relaySendErrorState.active ? " · " + t("sending delayed, retrying") : ""}`;
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

/* ---------------- settings transfer (Saved Messages) ---------------- */
// Manual only: the drawer's "Export settings" sends ONE plain text message
// to this account's Saved Messages; "Apply these settings" on such a message
// shows the diff and applies it live. Whitelist, format and exclusions live
// in settings-transfer.js (docs/settings-transfer.md).
async function savedMessagesChatId() {
  const chats = await core.getChatList({ query: "" });
  const saved = chats.find(c => c.kind === "saved");
  if (saved) return saved.id;
  // A fresh profile has no self-chat yet: the core creates it for contact 1
  // (DC_CONTACT_ID_SELF), exactly like "Saved Messages" in other clients.
  return core.createChatByContactId?.(1);
}
async function exportSettingsToSaved() {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
  try {
    const text = serializeSettings(localStorage, new Date());
    const chatId = await savedMessagesChatId();
    if (!accountIsCurrent(epoch)) return;
    if (chatId == null) throw new Error("no Saved Messages chat");
    await core.sendMessage(chatId, { text });
    if (!accountIsCurrent(epoch)) return;
    toast(t("Settings sent to Saved Messages"));
    openChat(chatId);
  } catch (err) {
    errToast(t("Couldn't export settings: ") + (err?.message || err));
  }
}
function settingsDiffModal(changes, parsed) {
  return new Promise(resolve => {
    const body = document.createElement("div");
    body.className = "settings-diff";
    const when = parsed.date ? ` from ${parsed.date}` : "";
    const notes = [];
    if (parsed.invalid.length) notes.push(t("Skipped (invalid value): {keys}", { keys: parsed.invalid.join(", ") }));
    if (parsed.ignored.length) notes.push(t("Skipped (unknown to this version): {keys}", { keys: parsed.ignored.join(", ") }));
    body.innerHTML = `<p>${t("Apply the settings{when} on this device?", { when: escapeHtml(when) })} ${changes.length === 1 ? escapeHtml(t("1 setting changes:")) : escapeHtml(t("Settings that change: {n}", { n: changes.length }))}</p>
      <ul class="settings-diff-list">${changes.map(c => `<li><span class="sd-label">${escapeHtml(t(c.label))}</span><span class="sd-vals"><span class="sd-from">${escapeHtml(c.from)}</span> → <b>${escapeHtml(c.to)}</b></span></li>`).join("")}</ul>
      ${notes.map(n => `<p class="bar-opts-hint">${escapeHtml(n)}</p>`).join("")}`;
    const { foot, cancel, ok } = footButtons("Apply", { okClass: "btn-text btn-primary" });
    const { close } = showModal({ title: "Apply these settings", body, foot, compact: true, onClose: () => resolve(false) });
    cancel.addEventListener("click", close);
    // Settle before close (AGENTS.md §11): close() resolves false.
    ok.addEventListener("click", () => { resolve(true); close(); });
  });
}
async function applySettingsFromMessage(text) {
  const parsed = parseSettings(text);
  if (!parsed) { errToast(t("This message isn't a valid Velta settings block")); return; }
  const changes = diffSettings(localStorage, parsed.values);
  if (!changes.length) { toast(t("This device already uses these settings")); return; }
  if (!(await settingsDiffModal(changes, parsed))) return;
  const applied = applySettings(localStorage, parsed.values);
  refreshAfterSettingsApply(applied.map(c => c.key));
  toast(applied.length === 1 ? t("1 setting applied") : t("{n} settings applied", { n: applied.length }));
}
// Everything a changed key needs to show live, no restart.
function refreshAfterSettingsApply(keys) {
  const has = k => keys.includes(k);
  // Strings are baked at render. Boot reapplies theme, scale and core copies.
  if (has("language")) { location.reload(); return; }
  if (has("theme")) { state.theme = localStorage.getItem("dw-theme") || "auto"; applyTheme(); }
  if (has("interface-scale")) applyUiScale();
  if (["message-text-size", "message-corners", "accent-color", "hyphenation"].some(has)) {
    globalThis.VeltaChatAppearance?.apply();
    window.dispatchEvent(new Event("resize")); // virtual scroller re-measures bubbles
  }
  if (has("bottom-bar-buttons")) {
    try { barHidden = JSON.parse(localStorage.getItem(BAR_HIDDEN_KEY)) || []; } catch { barHidden = []; }
    applyBarVisibility();
  }
  if (has("chat-categories")) {
    try { catsHidden = JSON.parse(localStorage.getItem(CATS_HIDDEN_KEY)) || []; } catch { catsHidden = []; }
    syncChatCategoryBar();
    renderChatList();
  }
  // Per-account core mirrors (same calls as the drawer handlers).
  const cfg = [["image-quality", "media_quality", "velta-media-quality", "0"], ["auto-download-limit", "download_limit", "velta-download-limit", "0"], ["read-receipts", "mdns_enabled", "velta-mdns", null]];
  for (const [k, coreKey, lsKey, dflt] of cfg) {
    if (!has(k)) continue;
    const v = lsKey === "velta-mdns" ? (localStorage.getItem(lsKey) === "0" ? "0" : "1") : (localStorage.getItem(lsKey) || dflt);
    core.setConfig?.(coreKey, v).catch(err => errToast(t("Couldn't save {key}: {why}", { key: k, why: err?.message || err })));
  }
  // Drawer labels/radios/switches read storage at build time.
  rebuildDrawer();
}

/* ---------------- chat list ---------------- */
// Event-driven refresh. refreshChatList() refetches the list from the core and
// re-renders it in place (renderChatList reuses existing <velta-chat-item>
// elements), so it is cheap — but bursts of core events (IMAP sync, markseen
// cascades) would still fire dozens of RPC round trips per second, so
// event-driven callers go through scheduleChatListRefresh() which collapses a
// burst into one trailing refresh.

// Incoming-message toasts, grouped per chat and flushed once per task: a
// burst yields at most one notifyIncoming call per chat (the latest
// message that passes the muted/mention gate) instead of one per message.
const incomingNotifyQueue = createNotifyQueue(flushIncomingNotify);

function queueIncomingNotify(msg) {
  incomingNotifyQueue.push(msg, core.accountEpoch);
}

async function flushIncomingNotify(groups, epoch) {
  for (const [chatId, msgs] of groups) {
    if (epoch !== core.accountEpoch || notifyThrottled()) return;
    const chat = state.chats.find(c => c.id === chatId);
    let msg = msgs[msgs.length - 1];
    // Muted chats stay quiet unless a message @mentions me (setting,
    // default on; docs/mentions.md). Android posts from Rust instead.
    if (chat?.muted) {
      const fpr = await fingerprintFor(1).catch(() => null);
      if (epoch !== core.accountEpoch) return;
      const self = { name: state.account?.displayName || "", code: cachedFingerprintIsDerived(1) ? "" : fprCode(fpr) };
      msg = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (mutedChatAllows({ muted: true, mentionsMe: mentionsMe(msgs[i]?.text || "", self), mentionInMuted: mentionInMutedOn() })) { msg = msgs[i]; break; }
      }
      if (!msg) continue;
    }
    notifyIncoming(
      msg?.fromContact?.name || msg?.fwdFrom || t("New message"),
      (msg?.text || "").replace(/\s+/g, " ").slice(0, 120) || t("New message"),
      {
        chatName: chat?.name || null,
        senderName: msg?.fromContact?.name || null,
        senderAvatar: msg?.fromContact?.avatar || null,
        accountId: core.accountId ?? null,
        chatId: msg?.chatId ?? null,
      },
    );
  }
}

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
  // A sync message from another device may have turned bcc_self back on
  // while we were in the background.
  ensureMultiDevice();
}
function reportUiVisible() {
  try {
    const invoke = tauriInvoke();
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
  chip.title = t("Offline media queued — tap to manage");
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
  pop.innerHTML = `<div class="lq-head">${escapeHtml(t("Queued — sends when the device is reachable"))}</div>` + items.map(it => `
    <div class="lq-row" data-id="${escapeAttr(it.id)}">
      <span class="lq-name">${escapeHtml(it.name || "file")}${it.size ? ` · ${formatBytes(it.size)}` : ""}</span>
      <button type="button" class="btn-text" data-lq-retry="${escapeAttr(it.id)}">${escapeHtml(t("Send now"))}</button>
      <button type="button" class="btn-text" data-lq-cancel="${escapeAttr(it.id)}" aria-label="${escapeHtml(t("Remove from queue"))}">${ICON.close}</button>
    </div>`).join("");
  document.body.appendChild(pop);
  pop.addEventListener("click", async e => {
    const retryId = e.target.closest("[data-lq-retry]")?.dataset.lqRetry;
    const cancelId = e.target.closest("[data-lq-cancel]")?.dataset.lqCancel;
    if (retryId) {
      try { await retryQueuedItem(chatId, retryId); toast(t("Sending…")); }
      catch (err) { toast(String(err?.message || err)); }
      toggleLcQueuePop(chatId);
    }
    if (cancelId) { cancelQueuedItem(chatId, cancelId); toggleLcQueuePop(chatId); }
  });
  const place = () => {
    const a = document.getElementById("lc-queue-chip");
    if (!a) return;
    const z = uiZoom();
    pop.style.right = Math.max(8, innerWidth - a.getBoundingClientRect().right) / z + "px";
    pop.style.bottom = Math.round(innerHeight - a.getBoundingClientRect().top + 10) / z + "px";
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
        syncArchivedLink();
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
      const invoke = tauriInvoke();
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
  const loopSvg = LOOP_SVG;
  const short = (model.device.nodeId || "").slice(0, 8);
  const peerRows = model.peers.map(p => `
    <div class="lc-row" data-open="${escapeAttr(p.id)}">
      <span class="lc-dot ${p.online ? "on" : ""}"></span>
      <span class="lc-row-name">${escapeHtml(p.name)}</span>
      ${p.queued ? `<span class="lc-row-queued">${escapeHtml(t("{n} queued", { n: p.queued }))}</span>` : ""}
      <button type="button" class="btn-text lc-chat" data-chat="${escapeAttr(p.id)}" title="${escapeHtml(t("Open chat"))}" aria-label="${escapeAttr(t("Open chat with {name}", { name: p.name }))}">${escapeHtml(t("Chat"))}</button>
      <button type="button" class="btn-text lc-remove" data-remove="${escapeAttr(p.rawId || p.id)}" title="${escapeHtml(t("Remove device"))}" aria-label="${escapeAttr(t("Remove {name}", { name: p.name }))}">${ICON.close}</button>
    </div>`).join("");
  const nearbyRows = model.nearby.map(n => `
    <div class="lc-row" data-pair="${escapeAttr(n.id)}">
      <span class="lc-dot on"></span>
      <span class="lc-row-name">${escapeHtml(n.name || n.id.slice(0, 12))}</span>
      <button type="button" class="btn-text" data-pair="${escapeAttr(n.id)}">${escapeHtml(t("Pair"))}</button>
    </div>`).join("");
  const groupRows = (model.groups || []).map(g => `
    <div class="lc-row" data-open="${escapeAttr(g.id)}">
      <span class="lc-dot ${g.removed ? "" : g.online > 1 ? "on" : ""}"></span>
      <span class="lc-row-name">${escapeHtml(g.name)}</span>
      <span class="lc-row-queued">${escapeHtml(g.removed ? t("closed") : t("{members} members · {online} online", { members: g.members, online: g.online }))}</span>
      <button type="button" class="btn-text lc-chat" data-chat="${escapeAttr(g.id)}" title="${escapeHtml(t("Open group"))}" aria-label="${escapeAttr(t("Open group {name}", { name: g.name }))}">${escapeHtml(t("Chat"))}</button>
    </div>`).join("");
  el.innerHTML = `
    <div class="lc-card-head${lcCardOpen ? " open" : ""}" data-toggle>
      ${loopSvg}
      <span class="lc-card-title">${escapeHtml(t("Velta Loop"))}</span>
      <span class="lc-card-chevron">${svg(P.chevronDown, "", 'width="16" height="16"')}</span>
    </div>
    <div class="bar-opts-hint ctx-hint">${t("Local chat on the same network")}</div>
    <div class="lc-card-body">
      <div class="lc-device">${escapeHtml(t("This device:"))} <b>${escapeHtml(model.device.name)}</b>${short ? ` <span class="lc-nodeid">(${escapeHtml(short)})</span>` : ""} <button type="button" class="btn-text" data-rename>${escapeHtml(t("Edit name"))}</button></div>
      <div class="lc-actions">
        <button type="button" class="btn-text" data-invite>${escapeHtml(t("Show invite"))}</button>
        <button type="button" class="btn-text" data-add>${escapeHtml(t("Add contact"))}</button>
        <button type="button" class="btn-text" data-new-group>${escapeHtml(t("New group"))}</button>
      </div>
      ${nearbyRows ? `<div class="lc-sec">${escapeHtml(t("Nearby on the same network"))}</div>${nearbyRows}` : ""}
      ${peerRows ? `<div class="lc-sec">${escapeHtml(t("Paired devices"))}</div>${peerRows}` : ""}
      ${groupRows ? `<div class="lc-sec">${escapeHtml(t("Groups"))}</div>${groupRows}` : ""}
    </div>`;
  if (lcCardOpen) el.classList.add("open");
  el.querySelector("[data-toggle]").addEventListener("click", () => { lcCardOpen = !lcCardOpen; el.classList.toggle("open"); });
  const invoke = tauriInvoke();
  const renderQr = text => core.createQrSvg(text);
  el.querySelector("[data-invite]").addEventListener("click", () => {
    if (!invoke) return toast(t("Pairing needs the Velta app shell"));
    showInviteModal(invoke, renderQr).catch(err => toast(String(err?.message || err)));
  });
  el.querySelector("[data-add]").addEventListener("click", () => {
    if (!invoke) return toast(t("Pairing needs the Velta app shell"));
    addContact(invoke).catch(err => toast(String(err?.message || err)));
  });
  el.querySelector("[data-new-group]").addEventListener("click", () => newLocalGroupFlow());
  el.querySelector("[data-rename]").addEventListener("click", async () => {
    const name = await askText(t("Device name"), model.device.name, t("Save"));
    if (!name || !name.trim()) return;
    try {
      await renameDevice(name.trim());
      toast(t("Device renamed"));
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
      toast(t("Device removed"));
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
  const invoke = tauriInvoke();
  if (!invoke || !p2pEnabled()) return toast(t("Local groups need the Velta app with local chat on"));
  const epoch = core.accountEpoch;
  try {
    const id = await showCreateGroupModal(invoke);
    if (!id || !accountIsCurrent(epoch)) return;
    await refreshChatList();
    renderLocalChatCard();
    if (!accountIsCurrent(epoch)) return;
    openChat(id);
  } catch (err) {
    errToast(t("Couldn't create the group: ") + (err?.message || err));
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
      ? ICON.close
      : ICON.search;
    btn.title = searchOn ? t("Close search") : t("Search chats");
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
  const rows = sideViewShell(t("Contacts"), t("Tap a contact to open the chat"));
  // #169: the toggle lives above the scroller's host — the VirtualScroller
  // owns rows' children, so the label must be a sibling, not a child.
  rows.before(knownContactsToggleRow(() => renderContactsView()));
  let contacts = [];
  try { contacts = await core.getContacts(); } catch { /* demo mode */ }
  if (listView !== "contacts") return; // user switched away mid-fetch
  const allCount = contacts.length;
  if (knownContactsOnly()) {
    const known = knownContactIds();
    contacts = contacts.filter(c => known.has(c.id));
  }
  if (!contacts.length) {
    rows.innerHTML = `<div class="side-view-empty">${escapeHtml(allCount ? t("No known contacts yet — untick “Show only known contacts” above to see everyone.") : t("No contacts yet"))}</div>`;
    return;
  }
  const renderRow = (c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-item contact-row";
    b.innerHTML = `
      <velta-avatar name="${escapeAttr(c.name)}" color="${escapeAttr(c.color || "#777")}" size="42" contact-id="${c.id}" addr="${escapeAttr(c.addr || "")}"${c.avatar ? ` avatar="${escapeAttr(fileUrl(c.avatar))}"` : ""}></velta-avatar>
      <div class="ci-name">${escapeHtml(c.name)}</div>`;
    b.addEventListener("click", async () => {
      try {
        const id = await core.createChat(c.name, [c.id], "single");
        setListView("chats");
        await refreshChatList();
        openChat(id);
      } catch (err) { errToast(t("Could not open chat: {why}", { why: err?.message || err })); }
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
    rows.innerHTML = `<div class="side-view-empty">${escapeHtml(t("No archived chats"))}</div>`;
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
  const rows = sideViewShell(t("Calls"), t("Calls you ended on this device (kept locally — the core stores no call log)"));
  let log = [];
  try { log = JSON.parse(localStorage.getItem(CALL_LOG_KEY)) || []; } catch { }
  if (!log.length) {
    rows.innerHTML = `<div class="side-view-empty">${escapeHtml(t("No calls yet"))}</div>`;
    return;
  }
  for (const e of log) {
    const chat = state.chats.find(c => c.id === e.chatId);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-item call-row";
    b.innerHTML = `
      <span class="call-row-ico">${ICON.phone}</span>
      <div class="ci-name">${escapeHtml(chat ? chat.name : t("Unknown chat"))}</div>
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
  const rows = sideViewShell(t("Your QR code"), qrTab === "scan"
    ? t("Point the camera at someone's QR code to start a chat or join a group")
    : t("Others scan this to reach you with verified encryption"));
  const wrap = document.createElement("div");
  wrap.className = "qr-view";
  const tabs = scanTab ? `
    <div class="chat-cats side-tabs" role="tablist">
      <button type="button" role="tab" data-qr-tab="mine" class="${qrTab === "mine" ? "active" : ""}">${escapeHtml(t("My code"))}</button>
      <button type="button" role="tab" data-qr-tab="scan" class="${qrTab === "scan" ? "active" : ""}">${escapeHtml(t("Scan a QR code"))}</button>
    </div>` : "";
  if (qrTab === "scan") {
    wrap.innerHTML = `${tabs}
      <div class="qr-scan"><video muted playsinline></video></div>
      <div class="qr-scan-status" data-scan-status>${escapeHtml(t("Starting camera…"))}</div>
      <button type="button" class="btn-text" data-scan-retry hidden>${escapeHtml(t("Try again"))}</button>`;
  } else {
    const canShare = canShareLink({
      ua: navigator.userAgent,
      hasInvoke: !!tauriInvoke(),
      hasWebShare: typeof navigator.share === "function",
    });
    wrap.innerHTML = `${tabs}
      <div data-domain-tabs></div>
      <div class="qr-box"><div class="qr-loading">${escapeHtml(t("Generating QR code…"))}</div></div>
      <div class="invite-link" style="word-break:break-all"></div>
      <div class="qr-actions">
        <button type="button" class="btn-text" data-copy-link disabled>${ICON.copy}<span>${escapeHtml(t("Copy a link"))}</span></button>
        ${canShare ? `<button type="button" class="btn-text" data-share-link disabled>${ICON.share}<span>${escapeHtml(t("Share a link"))}</span></button>` : ""}
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
        status.textContent = st === "starting" ? t("Starting camera…")
          : st === "scanning" ? t("Hold the QR code inside the frame")
          : st === "error" ? (msg || t("The camera could not be started"))
          : t("Camera stopped");
      },
      onCode: raw => {
        if (!accountIsCurrent(epoch)) return false;
        const kind = classifyScannedCode(raw, { parseInviteLink, isShortInviteLink });
        if (!kind) { toast(t("That QR code isn't a Velta or Delta Chat invite")); return false; }
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
      toast(t("Link copied"));
    } catch (err) { errToast(t("Couldn't copy the link: ") + (err?.message || err)); }
  });
  shareBtn?.addEventListener("click", async () => {
    try {
      const invoke = tauriInvoke();
      await shareLink(inviteText, {
        ua: navigator.userAgent, invoke,
        webShare: typeof navigator.share === "function" ? o => navigator.share(o) : null,
        title: t("Chat with me on Velta"), text: `${t("Chat with me on Velta")}: ${inviteText}`,
      });
    } catch (err) { errToast(t("Couldn't share the link: ") + (err?.message || err)); }
  });
  inviteQrProvider(null)()
    .then(({ svg, link }) => {
      const box = wrap.querySelector(".qr-box");
      if (listView !== "qr" || qrTab !== "mine") return;
      mountInviteDomains(wrap.querySelector("[data-domain-tabs]"), { svg, link }, (qr, l) => {
        box.innerHTML = qr || `<div class='qr-loading'>${escapeHtml(t("QR unavailable"))}</div>`;
        wrap.querySelector(".invite-link").textContent = l;
        inviteText = l || "";
      });
      copyBtn.disabled = !inviteText;
      if (shareBtn) shareBtn.disabled = !inviteText;
    })
    .catch(err => {
      if (listView !== "qr") return;
      wrap.querySelector(".qr-box").innerHTML =
        `<div class='qr-loading'>${escapeHtml(t("Couldn't create the invite:"))}<br>${escapeHtml(String(err?.message || err))}</div>`;
    });
}

// #57 category bar. Bot flags come from one get_contacts call, fetched the
// first time a People/Bots filter actually needs them — no boot RPC cost.
const chatCatsEl = document.getElementById("chat-categories");
// Bot flags are per account (contact ids are account-local) and change when
// a contact's first auto-generated message arrives, so the map is keyed by
// account and re-fetched whenever the People/Bots chip is chosen.
async function ensureContactBots(force = false) {
  if (!core?.getContacts) return;
  const acct = core.accountId;
  if (!force && state.contactBots && state.contactBotsAcct === acct) return;
  try {
    const contacts = await core.getContacts();
    if (core.accountId !== acct) return;
    state.contactBots = new Map(contacts.map(c => [c.id, !!c.bot]));
  } catch { state.contactBots = new Map(); }
  state.contactBotsAcct = acct;
  if (state.chatCategory === "people" || state.chatCategory === "bots") renderChatList();
}
const chatIsBot = (contactId) => state.contactBotsAcct === core?.accountId && state.contactBots?.get(contactId) === true;
function visibleChats() {
  const cat = state.chatCategory;
  if (cat === "all") return state.chats;
  // Unread cuts across the kind chips — a group and a person can both be
  // unread, so this is an intersection, not a chatCategoryOf bucket.
  if (cat === "unread") return state.chats.filter(chatIsUnread);
  // #77: a boot-restored People/Bots view renders before any chip click,
  // so it must kick the bot-flag fetch itself — otherwise contact bots
  // classify as "people" until the next chip interaction.
  if ((!state.contactBots || state.contactBotsAcct !== core?.accountId) && (cat === "people" || cat === "bots")) ensureContactBots();
  return state.chats.filter(c => chatCategoryOf(c, chatIsBot) === cat);
}
// One entry point for every category change (chip click, swipe): renderChatList
// re-syncs the chip active states via syncChatCategoryBar.
function setChatCategory(cat) {
  state.chatCategory = cat;
  localStorage.setItem("velta-chat-category", cat);
  if (cat === "people" || cat === "bots") ensureContactBots(true);
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
  if (globalThis.__veltaAppEvaluating) { chatListRenderDeferred = true; return; }
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
    } else if (child.id === "archived-link") {
      // kept; syncArchivedLink re-appends it last
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
    const active = chat.id === (state.pendingChatId ?? state.activeChatId);
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
  const link = document.getElementById("archived-link");
  const sameOrder = items.length === list.children.length - (link?.parentNode === list ? 1 : 0) &&
    items.every((el, i) => list.children[i] === el);
  if (!sameOrder) list.replaceChildren(...items);
  if (!chats.length && !(archivedCount && state.chatCategory === "all" && !state.query)) {
    const empty = document.createElement("div");
    empty.style.cssText = "text-align:center;color:var(--text-dim);padding:30px 16px;font-size:14.5px";
    empty.textContent = state.query ? t("No chats found")
      : state.chatCategory !== "all" ? t("No chats in this category")
      : t("No chats yet — start a new one");
    list.appendChild(empty);
  }
  syncArchivedLink();
  watchChatItemGhosts(list);
}

// Delta Chat's "Archived chats (N)" row, last in the main list. Only the
// label/visibility change — never triggers a list rebuild. Same target as
// the search screen's Archived tab.
function syncArchivedLink() {
  const list = $("chat-list");
  if (!list) return;
  let link = document.getElementById("archived-link");
  const show = listView === "chats" && archivedCount > 0 && !state.query && state.chatCategory === "all";
  if (!show) { link?.remove(); return; }
  if (!link) {
    link = document.createElement("button");
    link.type = "button";
    link.id = "archived-link";
    link.className = "archived-link";
    link.addEventListener("click", () => { searchScreenTab = "archived"; setListView("search"); });
  }
  const label = t("Archived chats ({n})", { n: archivedCount });
  const key = archivedCount + "|" + label;
  if (link._velKey !== key) {
    link._velKey = key;
    link.setAttribute("aria-label", label);
    link.innerHTML = `<span class="archived-link-icon" aria-hidden="true">${ICON.archive}</span><span>${escapeHtml(label)}</span>`;
  }
  if (list.lastElementChild !== link) list.appendChild(link);
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
// Labels are English keys, shown through t().
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
    pin: ICON.pin,
    mute: ICON.bell,
    archive: ICON.archive,
    read: ICON.markRead,
    link: ICON.link,
    trash: ICON.trash,
  };
  // Local P2P groups: only read state, link previews and delete (leave /
  // disband) apply — pin, mute, archive and old-message cleanup are relay-core.
  const grp = !!chat.isP2pGroup;
  showContextMenu([
    grp ? null : { label: chat.pinned ? t("Unpin") : t("Pin to top"), icon: icons.pin, onClick: () => core.setChatFlags(chat.id, { pinned: !chat.pinned }) },
    grp ? null : { label: chat.muted ? t("Unmute") : t("Mute notifications"), icon: icons.mute, onClick: () => core.setChatFlags(chat.id, { muted: !chat.muted }) },
    ...(tauriInvoke() ? [{ label: t("Link previews: {mode}", { mode: t(LINK_PREVIEW_LABELS[linkPreviewMode(chat.id)]) }), icon: icons.link, onClick: () => {
      if (!accountIsCurrent(epoch)) return;
      const apply = (mode) => {
        if (!accountIsCurrent(epoch)) return;
        setLinkPreviewMode(mode, chat.id);
        toast(t("Link previews: {mode} for this chat", { mode: t(LINK_PREVIEW_LABELS[mode]) }));
        if (state.activeChatId === chat.id && chatView?.open) {
          chatView.close();
          openChat(chat.id);
        }
      };
      showContextMenu([["off", t("Off")], ["picture", t("Send a picture")], ["fetch", t("Load on this device")]].map(([mode, label]) => ({
        label, onClick: () => apply(mode),
      })), x, y);
    } }] : []),
    chat.unread > 0 ? { label: "Mark as read", icon: icons.read, onClick: () => core.markRead(chat.id) } : null,
    grp ? null : {
      label: "Delete old messages…",
      icon: icons.trash,
      onClick: () => {
        showContextMenu(OLD_MESSAGE_SPANS.map(([label, ms]) => ({
          label: t("Older than {label}", { label: t(label) }),
          onClick: async () => {
            const ok = await confirmModal(
              t("Delete old messages"),
              t("Delete every message in \"{name}\" older than {label}? Pinned messages are kept. This cannot be undone.", { name: chat.name, label: t(label) }),
              t("Delete"),
              true,
            );
            if (!ok || !accountIsCurrent(epoch)) return;
            try {
              const deleted = await core.deleteMessagesOlderThan(chat.id, Date.now() - ms);
              if (!accountIsCurrent(epoch)) return;
              toast(deleted ? (deleted === 1 ? t("1 message deleted") : t("Messages deleted: {n}", { n: deleted })) : t("Nothing older than that"));
              refreshChatList();
            } catch (err) {
              errToast(t("Couldn't delete: ") + (err?.message || err));
            }
          },
        })), x, y);
      },
    },
    grp ? null : "-",
    grp ? null : { label: chat.archived ? t("Unarchive") : t("Archive"), icon: icons.archive, onClick: () => core.setChatFlags(chat.id, { archived: !chat.archived }) },
    grp ? { label: chat.readOnly ? t("Delete chat") : chat.canManage ? t("Disband and delete") : t("Leave and delete"), icon: icons.trash, danger: true, onClick: () => deleteLocalGroupChat(chat, epoch) }
    : { label: "Delete chat", icon: icons.trash, danger: true, onClick: async () => {
      // deleteMessages only clears history and leaves the chat in the list (#34).
      const p2p = chat.isP2p || String(chat.id).startsWith("p2p:");
      // #145: delete_chat does not leave. A group or in/out broadcast must
      // send the member-removed notice first. Mailing lists cannot (the core
      // rejects self-removal); an already-left chat errors and is ignored.
      const membership = !p2p && (chat.kind === "group" || chat.chatType === "OutBroadcast" || chat.chatType === "InBroadcast");
      const ok = p2p
        ? await confirmRemovePeer(String(chat.id).slice("p2p:".length), chat.name, t("Delete chat"))
        : await confirmModal(
          t("Delete chat"),
          membership
            ? t("Leave \"{name}\" and delete it with all its messages?", { name: chat.name })
            : t("Delete \"{name}\" and all its messages?", { name: chat.name }),
          membership ? t("Leave and delete") : t("Delete"));
      if (!ok || !accountIsCurrent(epoch)) return;
      try {
        if (p2p) await removePeer(String(chat.id).slice("p2p:".length));
        else {
          if (membership) await core.leaveGroup(chat.id).catch(() => {});
          if (!accountIsCurrent(epoch)) return;
          await core.deleteChat(chat.id);
        }
        if (!accountIsCurrent(epoch)) return;
        if (state.activeChatId === chat.id) closeChat();
        if (p2p) { renderLocalChatCard(); closeVanishedGroupChat(); }
        refreshChatList();
      } catch (err) {
        errToast(t("Couldn't delete chat: ") + (err.message || err));
      }
    } },
  ].filter(Boolean), x, y);
}

// Unpairing a device, with the group consequences spelled out: groups it
// created go away here (a creator we forgot can't re-sign anything for us),
// groups it is merely in keep it as a member we can't message directly.
async function confirmRemovePeer(peerId, name, title = t("Remove device")) {
  const text = removePeerImpactText(name, await peerGroupImpact(peerId));
  return confirmModal(title, text, title === t("Delete chat") ? t("Delete") : t("Remove"), true);
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
    `<button type="button" class="btn-text" data-pg="${a.key}"${a.danger ? ` style="color:var(--danger)"` : ""}${a.disabled ? " disabled" : ""}>${escapeHtml(t(a.label))}</button>`);
  return `<div class="profile-actions">${btns.join("")}</div>`;
}

// Leave a local group (a member) or disband it (the creator). The chat stays,
// read-only, with its history.
async function leaveLocalGroupFlow(chat, epoch) {
  const disband = !!chat.canManage;
  const ok = await confirmModal(
    disband ? t("Disband group") : t("Leave group"),
    disband
      ? t("You created this group. Disbanding closes it for everyone — nobody can write in it any more. The history stays on each device.")
      : t("You will leave this group and no longer receive its messages. The history stays on this device."),
    disband ? t("Disband") : t("Leave"), true);
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
    errToast(t("Couldn't leave: ") + (err?.message || err));
  }
}

// Local P2P group chat "delete": leave (or, for the creator, disband) the group
// if it is still active, then hide it from the list. The log stays on disk —
// the engine has no delete-group command before member management lands.
async function deleteLocalGroupChat(chat, epoch) {
  const active = !chat.readOnly;
  const disband = active && chat.canManage;
  const ok = await confirmModal(
    t("Delete chat"),
    !active
      ? t("Remove \"{name}\" from your chat list?", { name: chat.name })
      : disband
        ? t("Disband \"{name}\" and remove it from your list? You created this group: disbanding closes it for everyone.", { name: chat.name })
        : t("Leave \"{name}\" and remove it from your list? You will no longer receive its messages.", { name: chat.name }),
    disband ? t("Disband") : active ? t("Leave") : t("Delete"), true);
  if (!ok || !accountIsCurrent(epoch)) return;
  try {
    await dismissLocalGroup(String(chat.id).slice("p2pg:".length));
    if (!accountIsCurrent(epoch)) return;
    if (state.activeChatId === chat.id) closeChat();
    renderLocalChatCard();
    refreshChatList();
  } catch (err) {
    errToast(t("Couldn't delete chat: ") + (err.message || err));
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

// Swap the open chat's header for a fresh one (see renderChatHead).
function replaceChatHead(chat) {
  const fresh = renderChatHead(chat);
  state.activeChatHead?.replaceWith(fresh);
  state.activeChatHead = fresh;
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
      replaceChatHead(chat);
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
  // A click that is already the one loading is the same wait, not a new one.
  if (state.pendingChatId === chatId || (state.pendingChatId == null && state.activeChatId === chatId)) return;
  // Do not close the visible history before the next page is in hand. A send
  // plus a few quick switches otherwise clears the pane and leaves it black
  // until the core finishes the queued reads, and further clicks only re-clear it.
  const navigation = ++chatNavigation, epoch = core.accountEpoch;
  const current = () => navigation === chatNavigation && accountIsCurrent(epoch);
  state.pendingChatId = chatId;
  // click->open latency for the chat-open stats line (event.timeStamp is
  // on the performance.now() clock).
  const ev = typeof window !== "undefined" ? window.event : null;
  chatView.noteOpenClick?.(ev?.timeStamp > 0 ? ev.timeStamp : performance.now());
  chatView.cancelOpen?.();
  renderChatList();
  // Stall diagnostics + recovery (Refs #176): slow steps log
  // "open chat N: STEP took N ms"; an open still waiting after
  // 15 s releases the same-chat guard so a re-tap retries
  // instead of being swallowed until every chained RPC timed out.
  const openStarted = Date.now();
  const step = (name, since) => {
    const ms = Date.now() - since;
    if (ms >= 1000) appLog(`open chat ${chatId}: ${name} took ${ms} ms`);
  };
  const guard = setTimeout(() => {
    if (state.pendingChatId !== chatId || navigation !== chatNavigation) return;
    appLog(`open chat ${chatId}: still waiting after ${Date.now() - openStarted} ms, guard released`);
    state.pendingChatId = null;
    renderChatList();
  }, 15000);
  try {
  let stepStarted = Date.now();
  const chat = await core.getChat(chatId);
  step("get_chat", stepStarted);
  if (!current() || !chat) return;
  if (chat.kind === "deaddrop") {
    const ok = await confirmModal("Contact request", t("\"{name}\" wants to start a conversation with you. Accept it to read the messages and reply.", { name: chat.name }), t("Accept"), false);
    if (ok && current()) {
      await core.acceptChat(chatId);
      if (!current()) return;
      toast(t("Contact request accepted"));
      await refreshChatList();
      if (!current()) return;
      return openChat(chatId); // now a normal chat — open it
    }
    return;
  }
  state.activeChatId = chatId;
  // List clicks skip closeChatUI, so the diagnostics bar and its #history writer would stick.
  diagnosticsOpen = false;
  $("diagnostic-actions").hidden = true;
  chatView.externalSurface = false;
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
  // Video call next to the audio call, like Delta Chat's chat header.
  const videoBtn = $("btn-video-call");
  videoBtn.hidden = callBtn.hidden;
  videoBtn.onclick = callBtn.onclick ? () => startCallIfMicOk(chat, { video: true }) : null;
  refreshChannelAuthorButton(chat, current);
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
      replaceChatHead(chat);
    }).catch(() => {});
  }
  // Hand over the chat fetched above: the view used to fetch it again.
  stepStarted = Date.now();
  const opened = await chatView.open(chatId, chat);
  step("view open", stepStarted);
  if (!opened || !current()) return;
  // History entry per open chat: Android BACK pops it (chat -> chat list)
  // via WryActivity's WebView-history navigation instead of exiting.
  if (history.state?.velta !== "chat") history.pushState({ velta: "chat", chatId }, "");
  state.pendingChatId = null;
  renderChatList();
  renderLcQueueTray();
  } catch (error) {
    if (!current()) return;
    closeChatUI();
    errToast(t("Couldn't open chat: ") + (error.message || error));
  } finally {
    clearTimeout(guard);
    step("total", openStarted);
    if (state.pendingChatId === chatId && navigation === chatNavigation) state.pendingChatId = null;
  }
}

function closeChat() {
  const popHistory = history.state?.velta === "chat";
  closeChatUI();
  if (popHistory) history.back();
}

function closeChatUI() {
  chatNavigation++;
  state.pendingChatId = null;
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
  if (chatView) chatView.readOnly = false;
  $("chat-head-actions").style.visibility = "";
  hideChannelAuthorButton();
  renderChatList();
}

// Issue #132: "Message author" in an incoming channel's header opens (or
// creates) the 1:1 chat with its one author. Hidden until the core names an
// author; never shown for outgoing channels (we are the author), mailing
// lists or an unknown author.
function hideChannelAuthorButton() {
  const btn = $("btn-channel-author");
  if (!btn) return;
  btn.hidden = true;
  btn.onclick = null;
}
function refreshChannelAuthorButton(chat, current) {
  hideChannelAuthorButton();
  if (chat.kind !== "channel" || chat.chatType === "OutBroadcast" || chat.chatType === "Mailinglist" || !core.getChannelAuthorId) return;
  const chatId = chat.id;
  core.getChannelAuthorId(chatId).then(authorId => {
    if (!current() || state.activeChatId !== chatId) return;
    if (!authorId || authorId === 1) return;
    const btn = $("btn-channel-author");
    btn.hidden = false;
    btn.onclick = () => openDirectChat(authorId);
  }).catch(() => {});
}

// Open the 1:1 chat with a contact, creating it when needed.
async function openDirectChat(contactId) {
  const epoch = core?.accountEpoch;
  const existing = state.chats.find(c => c.contactId === contactId && c.kind === "single");
  if (existing) return openChat(existing.id);
  try {
    const chatId = await core.createChatByContactId(contactId);
    if (!accountIsCurrent(epoch)) return;
    await refreshChatList();
    if (!accountIsCurrent(epoch)) return;
    await openChat(Number(chatId));
  } catch { errToast(t("Couldn't open the chat")); }
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
    replaceChatHead(chat);
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
    replaceChatHead(chat);
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
  return EPHEMERAL_OPTIONS.find(o => o.secs === s)?.label ?? (s ? t("On ({n} s)", { n: s }) : t("Off"));
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
  legend.textContent = t("Disappearing messages");
  list.append(legend);
  for (const o of EPHEMERAL_OPTIONS) {
    const label = document.createElement("label");
    label.className = "eph-row";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "eph-option";
    input.value = o.secs;
    input.checked = o.secs === (current | 0);
    label.append(input, Object.assign(document.createElement("span"), { textContent: t(o.label) }));
    list.appendChild(label);
  }
  const note = document.createElement("div");
  note.className = "eph-note";
  note.textContent = t("Applies to all members of this chat; they can still copy, save, and forward messages.");
  const body = document.createElement("div");
  body.append(list, note);
  const { foot, cancel, ok } = footButtons("OK");
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
      errToast(t("Couldn't set disappearing messages: ") + (err.message || err));
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
  legend.textContent = t("Mute notifications");
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
        .then(() => { if (accountIsCurrent(epoch)) valEl.textContent = muted ? t("Muted") : t("On"); })
        .catch((err) => errToast(t("Couldn't update notifications: ") + (err.message || err)));
      close();
    });
    label.append(input, Object.assign(document.createElement("span"), { textContent: t(o.label) }));
    list.appendChild(label);
  }
  const { foot, cancel } = footButtons();
  const { close } = showModal({
    title: "Mute notifications", body: list, foot,
    onClose: async () => { await modalHistorySettled(); if (accountIsCurrent(epoch)) showChatInfo(chat); },
  });
  cancel.addEventListener("click", () => close());
}

async function showChatInfo(chat) {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
  // #177: admin groups — who administers it decides which controls show.
  if (chat.kind === "group" && !chat.isP2p && core.getGroupAdminId) {
    try { chat.groupAdminId = await core.getGroupAdminId(chat.id); } catch { /* keep */ }
    if (!accountIsCurrent(epoch)) return;
  }
  const caps = adminCaps(chat);
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
    <div class="info-row"><span class="k">${escapeHtml(t("Address"))}</span><span class="v">${escapeHtml(chat.contact.addr)}</span></div>
    ${chat.contactId ? `<div class="info-row"><span class="k">${escapeHtml(t("Profile key"))}</span><span class="v"><span class="avatar-profile-fpr" data-profile-key>…</span></span></div>` : ""}
    ${chat.contact && (chat.contact.online || chat.contact.lastSeen) ? `<div class="info-row"><span class="k">${escapeHtml(t("Last seen"))}</span><span class="v">${chat.contact.online ? escapeHtml(t("online")) : timeTag(chat.contact.lastSeen, timeAgo(chat.contact.lastSeen))}</span></div>` : ""}` : "";
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
      relayRows = `<div class="info-row"><span class="k">${escapeHtml(t("Relay"))}</span><span class="v">${escapeHtml(String(contactAddr).split("@")[1] || contactAddr)}</span></div>`;
    } else if (!isGroup) {
      let transports = [];
      try { transports = await core.listTransports(); } catch { /* offline — fall back below */ }
      if (!transports.length && state.account.relay) transports = [{ addr: state.account.addr }];
      const row = tr => `<div class="info-row" data-relays style="cursor:pointer"><span class="k">${escapeHtml(t("Relay"))}</span><span class="v">${escapeHtml(tr.addr || "")} ›</span></div>`;
      if (transports.length > 1) {
        relayRows = `<details class="info-details" data-relays-details>
          <summary class="info-row"><span class="k">${escapeHtml(t("Relays"))}</span><span class="v" data-relays-count>(${transports.length})</span></summary>
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
    ${caps.isAdminGroup ? `<div class="admin-group-info" data-admin-info>${ICON.shieldCheck}<span data-admin-info-text>${escapeHtml(adminInfoText(chat, ""))}</span></div>` : ""}
    <div class="profile-description" data-desc hidden></div>
    ${(isSelf || (isGroup && !chat.isP2pGroup && caps.canEditGroup)) ? `<div class="profile-actions"><button type="button" class="btn-text" data-pa="ep"${chat.kind === "channel" ? " hidden" : ""}>${escapeHtml(isSelf ? t("Edit profile") : chat.kind === "channel" ? t("Edit channel") : t("Edit group"))}</button></div>` : ""}
    ${chat.kind === "group" && !chat.isP2pGroup && caps.canAddMembers ? `<div class="profile-actions"><button type="button" class="btn-text" data-pa="add-members">${escapeHtml(t("Add members"))}</button><button type="button" class="btn-text" data-pa="invite">${escapeHtml(t("Invite via link/QR"))}</button></div>` : ""}
    ${chat.kind === "channel" ? `<div class="profile-actions"><button type="button" class="btn-text" data-pa="invite">${escapeHtml(t("Invite via link/QR"))}</button></div>` : ""}
    ${chat.isP2pGroup ? p2pGroupActionsHtml(chat) : ""}
    ${!isGroup && chat.contactId && chat.contactId !== 1 ? `<div class="profile-actions">
      <button type="button" class="btn-text" data-pa="send">${escapeHtml(t("Send message"))}</button>
      <button type="button" class="btn-text" data-pa="rename">${escapeHtml(t("Edit name"))}</button>
      <button type="button" class="btn-text" data-pa="block" style="color:var(--danger)">${escapeHtml(t("Block"))}</button>
    </div>` : ""}
    ${isGroup ? `<details class="info-details" data-members-details${chat.isP2pGroup ? " open" : ""}>
      <summary class="info-row"><span class="k">${escapeHtml(t("Members"))}</span><span class="v" data-member-count>…</span></summary>
      <div class="modal-list member-list" data-member-list></div>
    </details>` : ""}
    ${!chat.isP2p && (chat.kind === "group" || chat.kind === "channel" || chat.kind === "single") ? mediaSectionsHtml() : ""}
    ${chat.isP2pGroup ? `<div class="profile-description" data-pg-hint style="font-size:13px;opacity:.75;padding:6px 2px" hidden></div>` : ""}
    ${contactRows}
    ${!chat.isP2p && !isSelf && (chat.kind === "group" || chat.kind === "channel" || chat.kind === "single") ? `<div class="info-row" data-muted style="cursor:pointer"><span class="k">${escapeHtml(t("Notifications"))}</span><span class="v" data-muted-val>${escapeHtml(chat.muted ? t("Muted") : t("On"))}</span></div>` : `<div class="info-row"><span class="k">${escapeHtml(t("Notifications"))}</span><span class="v">${chat.muted ? "Muted" : "On"}</span></div>`}
    ${!chat.isP2p && !isSelf && (chat.kind === "group" || chat.kind === "single") ? (caps.canSetTimer
      ? `<div class="info-row" data-ephemeral style="cursor:pointer"><span class="k">${escapeHtml(t("Disappearing messages"))}</span><span class="v" data-ephemeral-val>…</span></div>`
      : `<div class="info-row" data-ephemeral data-admin-only aria-disabled="true" title="${escapeAttr(t("Only the group admin can do this"))}"><span class="k">${escapeHtml(t("Disappearing messages"))}</span><span class="v" data-ephemeral-val>…</span></div>`) : ""}
    ${!chat.isP2p ? `<div class="info-row"><span class="k">${escapeHtml(t("Storage"))}</span><span class="v" data-storage-val>…</span></div>
    <details class="info-details" data-old-messages>
      <summary class="info-row"><span class="k">${escapeHtml(t("Old messages"))}</span><span class="v">${escapeHtml(t("Clean up ›"))}</span></summary>
      ${OLD_MESSAGE_SPANS.map(([label, ms]) => `<div class="info-row" data-old-age="${ms}" style="cursor:pointer"><span class="k">${escapeHtml(t("Delete older than {label}", { label: t(label) }))}</span><span class="v">›</span></div>`).join("")}
    </details>` : ""}
    ${relayRows}
    ${!isGroup && chat.contactId ? `<details class="info-details" data-common hidden>
      <summary class="info-row"><span class="k">${escapeHtml(t("Chats in common"))}</span><span class="v" data-common-count></span></summary>
      <div class="modal-list" data-common-list style="max-height:180px;overflow:auto"></div>
    </details>` : ""}`;
  // Name sits below the avatar now, so the head bar carries only the close.
  const modal = showModal({ title: "", body });

  // Apps / Photos / Videos / Audio / Files: counts now, contents on open.
  // Contact profiles carry no chat id — scope their sections to the 1:1
  // chat with the contact, or hide them when there is none (opening a
  // profile must not create a chat). A null chatId would hit the core's
  // "all chats" fallback (#159).
  let mediaChatId = chat.id;
  if (!mediaChatId && chat.contactId && core.getChatIdByContactId) {
    try { mediaChatId = await core.getChatIdByContactId(chat.contactId) || null; } catch { mediaChatId = null; }
  }
  if (body.querySelector("[data-media]") && mediaChatId) {
    mountChatMedia(body, {
      core, chatId: mediaChatId, fileUrl,
      isCurrent: () => accountIsCurrent(epoch) && body.isConnected,
      appInfo: (id) => prefetchInfo(id),
      appIconUrl: (id, icon) => appIconUrl(id, icon),
      onOpen: (kind, m) => openChatMediaItem(kind, m),
      onShowInChat: (m) => showMediaInChat(m),
      onSave: async (m) => {
        try { if (await saveAttachmentFile(core, m)) toast(t("Saved")); }
        catch (err) { if (!/cancel/i.test(String(err?.message || err))) toast(t("Couldn't save: ") + (err?.message || err), 3000, { danger: true }); }
      },
    });
  }

  // Disappearing messages row: hydrate the current timer, open the editor.
  const ephRow = body.querySelector("[data-ephemeral]");
  if (ephRow && core.getChatEphemeralTimer) {
    const ephVal = ephRow.querySelector("[data-ephemeral-val]");
    (async () => {
      try {
        const t = await core.getChatEphemeralTimer(chat.id);
        if (!accountIsCurrent(epoch)) return;
        ephVal.textContent = formatEphemeralTimer(t);
      } catch { ephVal.textContent = t("Off"); }
    })();
    if (caps.canSetTimer) ephRow.addEventListener("click", () => openEphemeralDialog(chat, ephVal, epoch));
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
        const pageAt = performance.now();
        const page = await core.getMessages(chat.id, { beforeId, limit: 500 });
        chatView?.noteOpenStat?.("storage", performance.now() - pageAt);
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
        t("Delete old messages"),
        t("Delete every message in \"{name}\" older than {label}? Pinned messages are kept. This cannot be undone.", { name: chat.name, label: span ? t(span[0]) : "" }),
        t("Delete"),
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
        toast(deleted ? (deleted === 1 ? t("1 message deleted") : t("Messages deleted: {n}", { n: deleted })) : t("Nothing older than that"));
        if (deleted) {
          // The open chat view refreshes itself via msgs-changed; the sheet
          // reopens below and the Storage row recomputes.
          refreshChatList();
        }
      } catch (err) {
        errToast(t("Couldn't delete: ") + (err?.message || err));
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
    const picked = await pickContactModal(t("Add members"), true);
    if (!picked?.length || !accountIsCurrent(epoch)) return;
    try {
      await core.addChatMembers(chat.id, picked.map(c => c.id));
      if (!accountIsCurrent(epoch)) return;
      refreshChatList();
      toast(picked.length === 1 ? t("Member added") : t("{n} members added", { n: picked.length }));
      await modalHistorySettled();
      showChatInfo(chat); // fresh sheet: member count and list updated
    } catch (err) {
      errToast(t("Couldn't add members: ") + (err.message || err));
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
        title: chat.kind === "channel" ? t("Edit channel") : t("Edit group"),
      });
      if (!result || !accountIsCurrent(epoch)) return;
      try {
        const name = result.name.trim();
        if (name && name !== chat.name) await core.renameChat(chat.id, name);
        if (result.description !== currentDesc) await core.setChatDescription(chat.id, result.description);
        if (result.avatar === "remove") await core.setChatImage(chat.id, null);
        else if (result.avatar !== "keep") {
          await core.setChatImage(chat.id, result.avatar.path);
          dropUpload(result.avatar.path);
        }
        if (!accountIsCurrent(epoch)) return;
        if (name) chat.name = name;
        // The core's blobdir copy, not the picked temp path (gone above).
        if (result.avatar === "remove") chat.avatar = null;
        else if (result.avatar !== "keep") {
          const fresh = await core.getChat?.(chat.id).catch(() => null);
          chat.avatar = fresh?.avatar ?? null;
        }
        refreshChatList();
        if (state.activeChatHead && state.activeChatId === chat.id) {
          replaceChatHead(chat);
        }
        await modalHistorySettled();
        showChatInfo(chat); // fresh sheet — the editor's pop has landed by now
      } catch (err) {
        errToast(t("Couldn't update the chat: ") + (err.message || err));
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
      } catch { errToast(t("Couldn't open the chat")); }
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
      save.className = "btn-text btn-primary"; save.textContent = t("Save");
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn-text"; cancel.textContent = t("Cancel");
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
        toast(t("Name updated"));
        refreshChatList();
        if (state.activeChatHead && state.activeChatId === chat.id) {
          replaceChatHead(chat);
        }
        showChatInfo(chat); // fresh modal with the new name everywhere
        } catch (err) {
          errToast(t("Rename failed: ") + (err.message || err));
          save.disabled = false;
        }
      });
      setTimeout(() => { input.focus(); input.select(); }, 50);
    });
    const blockBtn = actBtn("block");
    if (core.getBlockedContactIds) {
      core.getBlockedContactIds().then(ids => {
        if (blockBtn && ids.includes(contactId)) {
          blockBtn.textContent = t("Unblock");
          blockBtn.dataset.blocked = "1";
        }
      }).catch(() => {});
    }
    blockBtn?.addEventListener("click", async () => {
      const blockedNow = blockBtn.dataset.blocked === "1";
      const ok = await confirmModal(
        blockedNow ? t("Unblock contact") : t("Block contact"),
        blockedNow
          ? t("{name} will be able to write to you again.", { name: chat.name })
          : t("You will no longer receive messages or requests from {name}.", { name: chat.name }),
        blockedNow ? t("Unblock") : t("Block"), false);
      if (!ok || !accountIsCurrent(epoch)) return;
      try {
        await core.blockContact(contactId, !blockedNow);
        if (!accountIsCurrent(epoch)) return;
        toast(blockedNow ? t("Contact unblocked") : t("Contact blocked"));
        blockBtn.textContent = blockedNow ? t("Block") : t("Unblock");
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
        const mono = cachedFingerprintIsDerived(chat.contactId);
        const slot = body.querySelector("[data-profile-key]");
        // A derived tile is not a key; do not show it as one.
        if (slot) slot.textContent = fpr && !mono ? formatFingerprint(fpr) : "—";
        const capSlot = body.querySelector("[data-caption-tile]");
        if (capSlot && groups) {
          // radius 0 — the svg element's own border-radius does the rounding.
          capSlot.innerHTML = buildAvatarSvg({ groups, withCaptions: true, size: 168, radius: 0, mono });
        } else if (capSlot) {
          capSlot.remove();
        }
      })
      .catch(() => {});
  }

  // Chats in common. An open used to reload every chat, then every group's
  // full member list. That queue is the long stall after an avatar tap.
  // Ids only, and only once the section is opened (#171).
  // ponytail: state.chats is search-narrowed while a query is active;
  // reloading the chat list here is the stall.
  const commonDetails = body.querySelector("[data-common]");
  if (commonDetails && core.getChatContactIds) {
    commonDetails.hidden = false;
    const countEl = commonDetails.querySelector("[data-common-count]");
    if (countEl) countEl.textContent = "…";
    let started = false;
    commonDetails.addEventListener("toggle", () => {
      if (!commonDetails.open || started) return;
      started = true;
      const list = commonDetails.querySelector("[data-common-list]");
      const idsOf = (id) => typeof id === "number"
        ? core.getChatContactIds(id)
        : core.getChatMembers(id).then(ms => (ms || []).map(m => m.id));
      chatsInCommon(state.chats, chat.contactId, idsOf, () => accountIsCurrent(epoch) && commonDetails.isConnected)
        .then(common => {
          if (!commonDetails.isConnected || !accountIsCurrent(epoch)) return;
          if (countEl) countEl.textContent = `(${common.length})`;
          if (!list) return;
          for (const c of common) {
            const row = document.createElement("div");
            row.className = "info-row clickable";
            row.innerHTML = `<span class="k">${escapeHtml(c.name)}</span><span class="v">${c.unread ? c.unread + " unread" : ""}</span>`;
            row.addEventListener("click", () => { modal.close(); openChat(c.id); });
            list.appendChild(row);
          }
        })
        .catch(() => { if (countEl && commonDetails.isConnected) countEl.textContent = "—"; });
    });
  }

  if (chat.isP2pGroup) {
    const gid = String(chat.id).slice("p2pg:".length);
    const invoke = tauriInvoke();
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
      const name = await askText(t("Group name"), chat.name, t("Save"));
      if (name && name.trim() && name.trim() !== chat.name) {
        await groupRename(gid, name.trim());
        toast(t("Group renamed"));
        refreshChatList();
      }
      await reopen();
    });
    act("add", async () => {
      if (!invoke) return;
      let n = null;
      try { n = await showAddMembersModal(invoke, gid); } catch (err) { errToast(String(err?.message || err)); }
      if (n) { toast(n === 1 ? t("Member added") : t("{n} members added", { n })); refreshChatList(); }
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
        t("Remove {name} from \"{chat}\"? They stop receiving new messages and keep what they already have.", { name, chat: chat.name }), t("Remove"), true);
      if (ok && accountIsCurrent(epoch)) {
        try { await groupRemoveMember(gid, id); toast(t("Member removed")); refreshChatList(); }
        catch (err) { errToast(t("Couldn't remove: ") + (err?.message || err)); }
      }
      await reopen();
    });
  }

  // #177: the admin removes a member (relay admin groups only).
  if (caps.canRemoveOthers && core.removeChatMember) {
    body.addEventListener("click", async e => {
      const btn = e.target.closest?.("[data-admin-remove]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const name = btn.dataset.name || "?";
      const ok = await confirmModal("Remove member",
        t("Remove {name} from \"{chat}\"? They stop receiving new messages and keep what they already have.", { name, chat: chat.name }), t("Remove"), true);
      if (!ok || !accountIsCurrent(epoch)) return;
      try {
        await core.removeChatMember(chat.id, Number(btn.dataset.adminRemove));
        if (!accountIsCurrent(epoch)) return;
        toast(t("Member removed"));
        refreshChatList();
        await modalHistorySettled();
        showChatInfo(chat);
      } catch (err) { errToast(t("Couldn't remove: ") + (err?.message || err)); }
    }, true);
  }

  if (isGroup && core.getChatMembers) {
    core.getChatMembers(chat.id).then(members => {
      const count = body.querySelector("[data-member-count]");
      const list = body.querySelector("[data-member-list]");
      if (count) count.textContent = members.length.toLocaleString();
      const adminText = body.querySelector("[data-admin-info-text]");
      if (adminText) {
        const admin = members.find(m => m.id === chat.groupAdminId);
        adminText.textContent = adminInfoText(chat, admin?.name);
      }
      const hint = body.querySelector("[data-pg-hint]");
      if (hint) {
        hint.hidden = false;
        hint.textContent = groupMemberHint(chat, members);
      }
      if (list) {
        // Avatar + name + address per member (the per-member relay line of
        // #72 is gone), live search and a fixed-height virtual window.
        // Local P2P groups keep their reachability subtitle and Remove.
        mountMemberList(list, members.map(m => ({ ...m, self: m.self || m.id === 1, avatarUrl: m.avatar ? fileUrl(m.avatar) : null })), {
          rowOptions: m => {
            if (!chat.isP2pGroup) {
              // #177: admin badge; the admin gets Remove on everyone else.
              const badge = caps.isAdminGroup && m.id === chat.groupAdminId ? adminBadgeHtml() : "";
              const remove = canRemoveMember(chat, m)
                ? `<button type="button" class="btn-text" data-admin-remove="${escapeAttr(m.id)}" data-name="${escapeAttr(m.name || "?")}" aria-label="${escapeAttr(t("Remove {name}", { name: m.name }))}">${escapeHtml(t("Remove"))}</button>` : "";
              return badge || remove ? { actionsHtml: badge + remove } : {};
            }
            const subtitle = (m.self ? t("you") : (m.online ? t("online") : t("offline")) + (m.introduced ? t(" · not paired") : "")) + (m.isCreator ? t(" · admin") : "");
            const canRemove = chat.isP2pGroup && chat.canManage && !chat.readOnly && !m.self && !m.isCreator;
            return { subtitle, actionsHtml: canRemove ? `<button type="button" class="btn-text" data-pg-remove="${escapeAttr(m.id)}" aria-label="${escapeAttr(t("Remove {name}", { name: m.name }))}">${escapeHtml(t("Remove"))}</button>` : "" };
          },
          // showModal replaces this sheet (and reuses its history entry).
          onOpen: chat.isP2pGroup ? null : m => {
            if (m.self) openSelfProfile();
            else openContactProfile({ contactId: m.id, name: m.name });
          },
        });
      }
    }).catch(() => {
      const count = body.querySelector("[data-member-count]");
      if (count) count.textContent = "unavailable";
    });
  }
}

// Chat info media sections → the viewers the chat bubbles already use.
// The info sheet owns a history entry: closing it calls history.back(),
// which lands ASYNC. Viewers opened in the same tick (the lightbox calls
// closeAllPopups itself, then pushes its own entry) were torn down by that
// late popstate — the tile tap "did nothing". Close the sheet and wait for
// its history to settle first.
async function openChatMediaItem(kind, m) {
  const ready = m.filePath && (!m.downloadState || m.downloadState === "Done");
  if (kind !== "apps" && !ready) { toast(t("Not downloaded yet — use Show in chat to download it")); return; }
  if (kind === "files") {
    // Files open natively or in their own overlay (audio rows play inline).
    openAttachmentFile(m.filePath, m.fileName, {
      openHtml: chatView ? (p, n) => chatView._openHtmlIsolated(p, n) : null,
      onError: (t) => toast(t, 3000, { danger: true }),
    });
    return;
  }
  closeAllPopups();
  await modalHistorySettled();
  if (kind === "apps") {
    if (m.filePath && (!m.downloadState || m.downloadState === "Done")) {
      recordApp(core.accountId, {
        name: (m.fileName || "App").replace(/\.xdc$/i, ""),
        file: m.filePath,
        filename: m.fileName || "app.xdc",
      });
    }
    openWebxdc(m.id, (m.fileName || "Webxdc app").replace(/\.xdc$/i, ""));
  }
  else if (kind === "photos") openImageLightbox(fileUrl(m.filePath), m.fileName || "photo");
  else if (kind === "videos") openVideoLightbox(fileUrl(m.filePath), m.fileName || "video");
}

// "Show in chat": close the sheet, open the chat if needed, then the same
// jump the search results and quotes use (scroll + highlight, fetching
// older pages when the message isn't loaded).
async function showMediaInChat(m) {
  const epoch = core.accountEpoch;
  closeAllPopups();
  await modalHistorySettled();
  if (!accountIsCurrent(epoch) || !chatView) return;
  if (Number(chatView.chat?.id) !== Number(m.chatId)) {
    await openChat(m.chatId);
    if (!accountIsCurrent(epoch) || Number(chatView.chat?.id) !== Number(m.chatId)) return;
  }
  return chatView._jumpToMessage(m.id);
}

/* ---------------- chat head menu ---------------- */
// The open chat. state.chats is the main (non-archived) list only, so a chat
// opened from the Archived tab is not in it; fall back to the chat object the
// ChatView opened with, else the head menu and in-chat search do nothing.
function activeChat() {
  const id = state.activeChatId;
  if (id == null) return null;
  return state.chats.find(c => c.id === id) || (chatView?.chat?.id === id ? chatView.chat : null);
}
function bindChatHeadMenu() {
  bindMenuToggle($("btn-chat-menu"), e => {
    const epoch = core.accountEpoch;
    const chat = activeChat();
    if (!chat) return;
    const r = e.currentTarget.getBoundingClientRect();
    return showContextMenu([
      { label: "Chat info", onClick: () => showChatInfo(chat) },
      // Phones have no room for a second header call icon (the name would
      // shrink to nothing at 320px): the video call lives here too.
      ...(chat.kind === "single" && !chat.isP2p ? [{ label: "Video call", onClick: () => startCallIfMicOk(chat, { video: true }) }] : []),
      // #177: only an admin group's admin may invite (chat-view loads groupAdminId).
      ...(!adminCaps(chat).canAddMembers ? [] : chat.kind === "group" && !chat.isP2pGroup ? [{ label: "Group invite QR", onClick: () =>
        showInvite(inviteQrProvider(chat.id), { title: chat.name, group: true }) }] : []),
      // Local P2P chats have no per-chat mute / pin (flags are relay-core state).
      ...(chat.isP2p ? [] : [
        { label: chat.muted ? t("Unmute") : t("Mute"), onClick: () => core.setChatFlags(chat.id, { muted: !chat.muted }) },
        { label: chat.pinned ? t("Unpin") : t("Pin"), onClick: () => core.setChatFlags(chat.id, { pinned: !chat.pinned }) },
      ]),
      ...(chat.isP2pGroup && chat.readOnly ? [{
        label: "Delete chat", danger: true,
        onClick: () => deleteLocalGroupChat(chat, epoch),
      }] : []),
      ...((chat.kind === "group" || (chat.kind === "channel" && chat.chatType !== "Mailinglist")) && !(chat.isP2pGroup && chat.readOnly) ? [{
        label: chat.kind === "channel" ? t("Leave channel") : chat.isP2pGroup && chat.canManage ? t("Disband group") : t("Leave group"),
        onClick: async () => {
          if (chat.isP2pGroup) return leaveLocalGroupFlow(chat, epoch);
          const ok = await confirmModal(
            chat.kind === "channel" ? t("Leave channel") : t("Leave group"),
            chat.kind === "channel"
              ? t("You will no longer receive messages from this channel. Re-subscribe via its invite link/QR.")
              : t("You will leave this chat and no longer receive its messages."),
            t("Leave"), true);
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
            errToast(t("Couldn't leave: ") + (err.message || err));
          }
        },
      }] : []),
      ...(chat.isP2pGroup ? [] : [
      "-",
      { label: "Clear history", danger: true, onClick: async () => {
        if (await confirmModal("Clear history", t("Delete all messages in this chat?"))) {
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
  $("btn-chat-search").addEventListener("click", () => openChatSearch());
  // Settings transfer: "Apply these settings" on an export in Saved Messages.
  window.addEventListener("velta-apply-settings", e => {
    if (e.detail?.chatKind !== "saved") return;
    applySettingsFromMessage(String(e.detail?.text || ""));
  });
  // #134: a tapped #hashtag in message text opens the same search, prefilled.
  window.addEventListener("velta-hashtag", e => {
    const tag = String(e.detail?.tag || "");
    if (tag.startsWith("#")) openChatSearch(tag);
  });
  function openChatSearch(prefill = "") {
    const epoch = core.accountEpoch;
    const chat = activeChat();
    if (!chat) return;
    const chatId = chat.id;
    const p2p = chat.isP2p || String(chatId).startsWith("p2p:");
    const input = document.createElement("input");
    input.type = "search";
    input.enterKeyHint = "search";
    input.autocomplete = "off";
    input.setAttribute("aria-label", t("Search in chat"));
    input.className = "text-field";
    input.placeholder = p2p ? t("Search in loaded messages…") : t("Search in chat…");
    const results = document.createElement("div");
    results.className = "modal-list";
    const wrap = document.createElement("div");
    wrap.append(input, results);
    const emptyHint = p2p
      ? t("Nothing found in loaded history.")
      : t("Nothing found.");
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
          results.innerHTML = `<p style="color:var(--text-dim);font-size:14px;padding:8px 0">${escapeHtml(t("Search failed:"))} ${escapeHtml(String(e?.message || e))}</p>`;
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
    if (prefill) { input.value = prefill; search(); }
    setTimeout(() => input.focus(), 50);
  }
}

/* ---------------- new chat / forward ---------------- */
// "Show only known contacts" (#169): the contact surfaces default to people
// and bots you have a 1:1 chat with — the raw contact DB (group-only and
// key-update entries) is one checkbox away. Persisted, default ON.
const KNOWN_CONTACTS_KEY = "velta-known-contacts-only";
const knownContactsOnly = () => localStorage.getItem(KNOWN_CONTACTS_KEY) !== "0";
// Contact ids with an existing 1:1 chat — state.chats singles carry
// dmChatContact, so this is free (no per-contact RPCs).
const knownContactIds = () => new Set(state.chats.filter(c => c.kind === "single" && c.contactId).map(c => c.contactId));

// The shared checkbox row for the filtered surfaces; onChange refilters.
function knownContactsToggleRow(onChange) {
  const label = document.createElement("label");
  label.className = "scale-opt";
  label.style.margin = "0 2px 8px";
  label.innerHTML = `<input type="checkbox" role="switch"${knownContactsOnly() ? " checked" : ""}><span>${escapeHtml(t("Show only known contacts"))}</span>`;
  const box = label.querySelector("input");
  box.addEventListener("change", () => {
    if (box.checked) localStorage.removeItem(KNOWN_CONTACTS_KEY);
    else localStorage.setItem(KNOWN_CONTACTS_KEY, "0");
    onChange?.();
  });
  return label;
}

async function pickContactModal(title, multi = false) {
  if (state.accountChanging) return null;
  const epoch = core.accountEpoch;
  const contacts = await core.getContacts();
  if (!accountIsCurrent(epoch)) return null;
  return new Promise(resolve => {
    const list = document.createElement("div");
    list.className = "modal-list";
    const selected = new Set();
    const items = [];
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
      items.push([c, item]);
    }
    // #169: default to people and bots you actually have a 1:1 chat with.
    const known = knownContactIds();
    let knownOnly = knownContactsOnly();
    const empty = document.createElement("div");
    empty.className = "p2p-hint"; empty.style.opacity = ".6";
    empty.textContent = t("Nobody here yet — untick “Show only known contacts” to see everyone.");
    empty.hidden = true;
    const applyKnownFilter = () => {
      let shown = 0;
      for (const [c, item] of items) {
        const hit = !knownOnly || known.has(c.id);
        item.hidden = !hit;
        shown += hit;
      }
      empty.hidden = shown > 0;
    };
    applyKnownFilter();
    const wrap = document.createElement("div");
    wrap.append(knownContactsToggleRow(() => { knownOnly = knownContactsOnly(); applyKnownFilter(); }), list, empty);
    // Multi-select confirms a choice, it creates nothing — the group itself
    // is created in the following name dialog (#160).
    const { foot, cancel, ok } = footButtons(multi ? t("Add") : "OK");
    ok.disabled = true;
    const { close } = showModal({ title, body: wrap, foot, onClose: () => resolve(null) });
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
      const picked = await pickContactModal(t("New chat"));
      if (picked && accountIsCurrent(epoch)) {
        const id = await core.createChat(picked[0].name, [picked[0].id], "single");
        if (!accountIsCurrent(epoch)) return;
        await refreshChatList();
        if (!accountIsCurrent(epoch)) return;
        openChat(id);
      }
    } },
    { label: p2pEnabled() && p2pAvailable() ? t("New group (via relay)") : t("New group"), onClick: async () => {
      const epoch = core.accountEpoch;
      const picked = await pickContactModal("Add group members", true);
      if (!picked || !accountIsCurrent(epoch)) return;
      // The picker's history entry must pop before the next modal opens:
      // otherwise the name dialog's showModal skips its push (the modal
      // state is still current) and the pending pop closes it instantly —
      // Create appeared to do nothing (#151).
      await modalHistorySettled();
      const res = await askGroupName();
      if (!res || !accountIsCurrent(epoch)) return;
      {
        const id = await core.createChat(res.name, picked.map(c => c.id), res.admin ? "admin-group" : "group");
        if (!accountIsCurrent(epoch)) return;
        await refreshChatList();
        if (!accountIsCurrent(epoch)) return;
        openChat(id);
      }
    } },
    { label: "New channel", onClick: async () => {
      const epoch = core.accountEpoch;
      const raw = await askText(t("New channel"), t("New channel"), t("Create channel"));
      if (raw == null || !accountIsCurrent(epoch)) return;
      const id = await core.createChat(raw || t("New channel"), [], "channel");
      if (!accountIsCurrent(epoch)) return;
      await refreshChatList();
      if (!accountIsCurrent(epoch)) return;
      openChat(id);
    } },
    ...(p2pEnabled() && p2pAvailable() ? [{ label: "New local group (no relay)", onClick: newLocalGroupFlow }] : []),
    { label: "Join chat via invite link", onClick: joinFlow },
    // #149: second transport on this profile. No list refresh — that arg
    // reopens the Relays modal, which this row did not open.
    { label: "Add a relay to this account", onClick: () => addRelayFlow(core.accountEpoch) },
    { label: "Add account via invite link", onClick: () => openProfileManagement() },
  ];
}

function renderNewChatView() {
  const rows = sideViewShell(t("Start something"), t("Pick what to create"));
  for (const opt of newChatOptions()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-item side-option";
    b.innerHTML = `<span class="side-option-label">${escapeHtml(t(opt.label))}</span>
      ${svg(P.chevronRight, "side-option-arrow")}`;
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
        <button type="button" role="tab" data-tab="search">${escapeHtml(t("Search"))}</button>
        <button type="button" role="tab" data-tab="archived">${escapeHtml(t("Archived"))}${archivedCount ? ` (${archivedCount})` : ""}</button>
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
  input.setAttribute("aria-label", t("Search chats"));
  input.className = "text-field side-search-input";
  input.placeholder = t("Search chats…");
  const results = document.createElement("div");
  rows.append(input, results);
  const render = () => {
    if (listView !== "search") return;
    const q = input.value.trim().toLowerCase();
    results.replaceChildren();
    if (q.length < 2) {
      results.innerHTML = `<div class="side-view-empty">${escapeHtml(t("Type to search chats."))}</div>`;
      return;
    }
    const hits = state.chats.filter(c => (c.name || "").toLowerCase().includes(q)).slice(0, 30);
    if (!hits.length) {
      results.innerHTML = `<div class="side-view-empty">${escapeHtml(t("No chats found."))}</div>`;
      return;
    }
    for (const c of hits) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chat-item side-option";
      b.innerHTML = `<span class="side-option-label">${escapeHtml(c.name)}</span>
        ${svg(P.chevronRight, "side-option-arrow")}`;
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
    const { foot, cancel, ok } = footButtons(okLabel || t("Save"), { okType: "submit", okClass: "btn-text btn-primary" });
    ok.style.width = "auto";
    const done = v => { resolve(v); close(); };
    const { close, form } = showModal({ title, body, foot, form: true, onClose: () => resolve(null) });
    form.addEventListener("submit", () => done(input.value.trim()));
    cancel.addEventListener("click", () => done(null));
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

// Resolves { name, admin } or null. `admin` = the "Admin group" switch
// (#177, core quilt #19): only the creator may then manage the group.
function askGroupName() {
  return new Promise(resolve => {
    const body = document.createElement("div");
    body.innerHTML = `<input class="text-field" maxlength="60" placeholder="${escapeHtml(t("Group name"))}" value="${escapeHtml(t("New group"))}">
      <label class="scale-opt admin-group-opt">
        <input type="checkbox" role="switch" data-admin-group aria-describedby="admin-group-hint">
        <span class="admin-group-opt-text"><span class="admin-group-opt-title">${ICON.shieldCheck}${escapeHtml(t("Admin group"))}</span>
        <span class="admin-group-hint" id="admin-group-hint">${escapeHtml(t("Only you can add or remove members and edit the group. Protection works only in Velta and ArcaneChat."))}</span></span>
      </label>`;
    const input = body.querySelector("input");
    const adminBox = body.querySelector("[data-admin-group]");
    // Fragment, not a wrapping div: the buttons land as direct children of
    // .modal-foot and inherit its one-row flex layout.
    const { foot, cancel, ok } = footButtons("Create group", { okType: "submit", okClass: "btn-text btn-primary" });
    ok.style.width = "auto"; // btn-primary defaults to the full-width onboarding bar
    const done = value => { resolve(value); close(); };
    const { close, form } = showModal({ title: "New group", body, foot, form: true, onClose: () => resolve(null) });
    form.addEventListener("submit", () => done({ name: input.value.trim() || t("New group"), admin: adminBox.checked }));
    cancel.addEventListener("click", () => done(null));
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

// Profile management: one tabbed modal for the profile lifecycle — add a
// profile, second-device transfer, backup export, backup import. Tabs lock
// while a flow runs inside one (camera capture and transfers are stateful).
// The second device "receive" branch hands over to its own full-screen
// steps, which replaces this modal by design.
function openProfileManagement() {
  if (state.accountChanging) return;
  const epoch = core.accountEpoch;
  const canImport = !!tauriInvoke();
  // #178: snapshot encryption is a PWA-only feature (worker-wasm backend).
  const pwaEnc = core.backend?.kind === "worker-wasm" && !!core.transport?.setEncryption;
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="pm-tabs" data-tabs>
      <button type="button" class="pm-tab active" data-tab="add">${escapeHtml(t("Add profile"))}</button>
      <button type="button" class="pm-tab" data-tab="device">${escapeHtml(t("Second device"))}</button>
      <button type="button" class="pm-tab" data-tab="export">${escapeHtml(t("Export backup"))}</button>
      ${canImport ? `<button type="button" class="pm-tab" data-tab="import">${escapeHtml(t("Import backup"))}</button>` : ""}
      <button type="button" class="pm-tab" data-tab="delete" style="color:var(--danger)">${escapeHtml(t("Delete profile"))}</button>
    </div>
    <label class="scale-opt" style="margin:2px 2px 10px" title="${escapeHtml(t("Only the selected profile runs mail sync; background profiles are fully paused."))}">
      <input type="checkbox" role="switch" data-sync-only>
      <span>${escapeHtml(t("Sync only active profile — other profiles won't receive messages until you switch to them"))}</span>
    </label>
    ${pwaEnc ? `
    <div style="margin:0 2px 10px;display:grid;gap:8px" data-encrypt-box>
      <p class="pm-hint" data-enc-status></p>
      <div data-enc-on hidden>
        <form data-enc-form style="display:grid;gap:8px">
          <input class="text-field" data-enc-pass type="password" minlength="8" required placeholder="${escapeHtml(t("Passphrase (8+ characters)"))}" autocomplete="new-password">
          <input class="text-field" data-enc-pass2 type="password" minlength="8" required placeholder="${escapeHtml(t("Repeat passphrase"))}" autocomplete="new-password">
          <button class="btn-primary" type="submit">${escapeHtml(t("Encrypt local data"))}</button>
        </form>
        ${prfSupported() ? `<button class="btn-text" type="button" data-enc-prf>${escapeHtml(t("Use a passkey instead"))}</button>` : ""}
      </div>
      <div data-enc-off hidden>
        <button class="btn-primary" type="button" data-enc-disable>${escapeHtml(t("Turn off encryption"))}</button>
      </div>
      <div data-enc-lock hidden style="display:grid;gap:8px;border-top:1px solid var(--hairline);padding-top:10px">
        <p class="pm-hint" data-lock-status>${escapeHtml(t("Quicker unlocks for this profile. The PIN and the recovery code wrap the same key — the passphrase or the passkey stays the master way in."))}</p>
        <label class="pm-hint" style="display:grid;gap:4px">
          <span>${escapeHtml(t("Lock when hidden"))}</span>
          <select class="text-field" data-autolock>
            <option value="0">${escapeHtml(t("Off"))}</option>
            <option value="1">${escapeHtml(t("After 1 minute"))}</option>
            <option value="5">${escapeHtml(t("After 5 minutes"))}</option>
            <option value="15">${escapeHtml(t("After 15 minutes"))}</option>
          </select>
        </label>
        <div style="display:grid;gap:6px">
          <div data-pin-form hidden style="display:grid;gap:6px">
            <input class="text-field" data-pin type="password" minlength="6" required placeholder="${escapeHtml(t("App-lock PIN (6+ characters)"))}" autocomplete="new-password">
            <input class="text-field" data-pin2 type="password" minlength="6" required placeholder="${escapeHtml(t("Repeat PIN"))}" autocomplete="new-password">
            <div class="pm-actions">
              <button class="btn-primary" type="button" data-pin-save>${escapeHtml(t("Save PIN"))}</button>
              <button class="btn-text" type="button" data-pin-cancel>${escapeHtml(t("Cancel"))}</button>
            </div>
          </div>
          <div class="pm-actions" data-pin-actions hidden>
            <button class="btn-text" type="button" data-pin-edit>${escapeHtml(t("Change PIN"))}</button>
            <button class="btn-text" type="button" data-pin-remove style="color:var(--danger)">${escapeHtml(t("Remove PIN"))}</button>
          </div>
        </div>
        <div style="display:grid;gap:6px">
          <div class="pm-actions" data-rec-gen hidden>
            <button class="btn-text" type="button" data-rec-new>${escapeHtml(t("Generate a recovery code"))}</button>
          </div>
          <div class="pm-actions" data-rec-actions hidden>
            <button class="btn-text" type="button" data-rec-new>${escapeHtml(t("Replace the recovery code"))}</button>
            <button class="btn-text" type="button" data-rec-remove style="color:var(--danger)">${escapeHtml(t("Remove the recovery code"))}</button>
          </div>
        </div>
      </div>` : ""}
    <div class="pm-pane" data-pane="add">
      <p class="pm-hint">${t("Paste a <b>chatmail</b> invite link ({link}) or a relay domain — a new end-to-end encrypted profile is created on it.", { link: "<span>dcaccount:…</span>" })}</p>
      <form data-add-form>
        <input class="text-field" data-relay required placeholder="${escapeHtml(t("Relay address — e.g. nine.testrun.org"))}" autocomplete="off" inputmode="url" autocapitalize="none" spellcheck="false">
        <div class="pm-actions">
          <button type="button" class="btn-text" data-scan>${escapeHtml(t("Scan a QR code"))}</button>
          <button type="submit" class="btn-primary" data-add>${escapeHtml(t("Add profile"))}</button>
        </div>
      </form>
    </div>
    <div class="pm-pane" data-pane="device" hidden>
      <p class="p2p-hint">${escapeHtml(t("Move this profile to a new device, or receive a profile from another one. Both devices must be on the same network."))}</p>
      <div class="pm-actions pm-col">
        <button type="button" class="btn-text btn-primary" data-old>${escapeHtml(t("Show QR on this device"))}</button>
        <button type="button" class="btn-text" data-new>${escapeHtml(t("Receive a profile on this device…"))}</button>
      </div>
      <div data-transfer-pane></div>
    </div>
    <div class="pm-pane" data-pane="export" hidden>
      <p class="pm-hint">${escapeHtml(t("Write this profile — messages, contacts and keys — into a backup file. The profile stays signed in."))}</p>
      <input class="text-field" data-dest placeholder="${escapeHtml(t("Choose a folder…"))}" readonly>
      <input class="text-field" data-pass type="password" minlength="6" placeholder="${escapeHtml(t("Passphrase (optional, min 6 chars)"))}" autocomplete="new-password">
      <div class="pm-actions"><button type="button" class="btn-primary" data-export disabled>${escapeHtml(t("Export backup"))}</button></div>
      <div class="pm-progress" data-progress hidden></div>
    </div>
    ${canImport ? `<div class="pm-pane" data-pane="import" hidden>
      <p class="pm-hint">${escapeHtml(t("Read a backup file — messages, contacts and keys — into a new profile. The profile you are using now stays signed in."))}</p>
      <input class="text-field" data-pass type="password" minlength="6" placeholder="${escapeHtml(t("Passphrase (optional, min 6 chars)"))}" autocomplete="new-password">
      <div class="pm-actions"><button type="button" class="btn-primary" data-import>${escapeHtml(t("Import backup"))}</button></div>
    </div>` : ""}
    <div class="pm-pane" data-pane="delete" hidden>
      <p class="pm-hint">${t("Removes {name} for good: the account, its keys, the message database and all blobs on this device. This cannot be undone.", { name: "<b data-del-name></b>" })}</p>
      <p class="pm-hint">${t("Tip: write an <b>Export backup</b> first — it is the only copy that survives this.")}</p>
      <p class="pm-hint" data-del-last hidden style="color:var(--danger)">${escapeHtml(t("This is the last remaining profile — it cannot be deleted here."))}</p>
      <div data-del-form>
        <p class="pm-hint">${t("Type the profile's address ({addr}) to confirm.", { addr: "<b data-del-addr></b>" })}</p>
        <input class="text-field" data-del-confirm autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="${escapeHtml(t("Type the profile address to confirm deletion"))}">
        <div class="pm-actions"><button type="button" class="btn-text" data-delete disabled style="color:var(--danger)">${escapeHtml(t("Delete this profile"))}</button></div>
        <div class="pm-progress" data-del-progress hidden></div>
      </div>
    </div>`;

  const tabsBox = body.querySelector("[data-tabs]");
  const panes = {
    add: body.querySelector('[data-pane="add"]'),
    device: body.querySelector('[data-pane="device"]'),
    export: body.querySelector('[data-pane="export"]'),
    import: body.querySelector('[data-pane="import"]'),
    delete: body.querySelector('[data-pane="delete"]'),
  };
  const lock = (on) => tabsBox.classList.toggle("locked", on);
  tabsBox.addEventListener("click", e => {
    const tab = e.target.closest("[data-tab]");
    if (!tab || tabsBox.classList.contains("locked")) return;
    tabsBox.querySelectorAll(".pm-tab").forEach(t => t.classList.toggle("active", t === tab));
    for (const [key, pane] of Object.entries(panes)) if (pane) pane.hidden = key !== tab.dataset.tab;
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
      errToast(t("Couldn't apply the sync mode: ") + (err?.message || err));
    }
  });

  /* -- local data encryption (#178, PWA only) -- */
  const encBox = body.querySelector("[data-encrypt-box]");
  if (encBox) {
    const statusEl = encBox.querySelector("[data-enc-status]");
    const onBox = encBox.querySelector("[data-enc-on]");
    const offBox = encBox.querySelector("[data-enc-off]");
    // #178 phase 4: app-lock rows (PIN, recovery code, auto-lock).
    const lockBox = encBox.querySelector("[data-enc-lock]");
    const pinForm = lockBox.querySelector("[data-pin-form]");
    const pinActions = lockBox.querySelector("[data-pin-actions]");
    const recGen = lockBox.querySelector("[data-rec-gen]");
    const recActions = lockBox.querySelector("[data-rec-actions]");
    const alSel = lockBox.querySelector("[data-autolock]");
    alSel.value = localStorage.getItem("velta-autolock-mins") || "0";
    const refresh = async () => {
      const lock = await probeLock();
      if (lock) {
        statusEl.textContent = t("Local data is encrypted. Unlocking needs the passphrase or passkey you chose — the key never leaves this device.");
        onBox.hidden = true;
        offBox.hidden = false;
        lockBox.hidden = false;
        pinForm.hidden = true;
        pinActions.hidden = !lock.pin;
        recGen.hidden = !!lock.recovery;
        recActions.hidden = !lock.recovery;
      } else {
        statusEl.textContent = t("Local data is stored in plain text in this browser. Encryption protects it against access to the profile files (lost laptop, copied profile), not against malware while Velta is open.");
        onBox.hidden = false;
        offBox.hidden = true;
        lockBox.hidden = true;
      }
    };
    refresh();
    const form = encBox.querySelector("[data-enc-form]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pass = form.querySelector("[data-enc-pass]").value;
      if (pass !== form.querySelector("[data-enc-pass2]").value) { errToast(t("The passphrases don't match.")); return; }
      try {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const kek = await deriveKekPassphrase(pass, salt);
        await core.transport.setEncryption({ kek, meta: { v: 1, mode: "pass", salt: b64(salt), iter: 600000 } });
        toast(t("Local data encryption is on. The passphrase is the only way to unlock this profile — write it down."));
        try { localStorage.setItem("velta-enc-nudge", "1"); } catch {}
        await refresh();
      } catch (err) {
        errToast(t("Couldn't enable encryption: ") + (err?.message || err));
      }
    });
    encBox.querySelector("[data-enc-prf]")?.addEventListener("click", async () => {
      try {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const cred = await prfCreate();
        const prf = cred.getClientExtensionResults?.()?.prf;
        if (!prf?.isSupported) throw new Error(t("This authenticator does not support passkey encryption (PRF)."));
        const kek = await deriveKekPrf(await prfEval(cred.rawId, salt), salt);
        await core.transport.setEncryption({ kek, meta: { v: 1, mode: "prf", salt: b64(salt), credId: b64(new Uint8Array(cred.rawId)) } });
        toast(t("Local data encryption is on. Unlocking needs this passkey — keep a backup: losing the passkey means losing the data."));
        try { localStorage.setItem("velta-enc-nudge", "1"); } catch {}
        await refresh();
      } catch (err) {
        errToast(t("Couldn't enable encryption: ") + (err?.message || err));
      }
    });
    encBox.querySelector("[data-enc-disable]").addEventListener("click", async () => {
      try {
        await core.transport.disableEncryption();
        toast(t("Local data encryption is off."));
        await refresh();
      } catch (err) {
        errToast(t("Couldn't turn encryption off: ") + (err?.message || err));
      }
    });

    /* -- app lock: PIN, recovery code, auto-lock (#178 phase 4) -- */
    const saveWrap = async (kind, secret, meta) => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const kek = await deriveKekPassphrase(secret, salt);
      await core.transport.setUnlockWrap({ kind, kek, meta: { v: 1, kind, salt: b64(salt), iter: 600000, ...meta } });
    };
    alSel.addEventListener("change", () => {
      try { localStorage.setItem("velta-autolock-mins", alSel.value); } catch {}
    });
    lockBox.querySelector("[data-pin-edit]").addEventListener("click", () => {
      pinActions.hidden = true;
      pinForm.hidden = false;
    });
    lockBox.querySelector("[data-pin-cancel]").addEventListener("click", () => {
      pinForm.reset();
      pinForm.hidden = true;
      pinActions.hidden = false;
    });
    lockBox.querySelector("[data-pin-save]").addEventListener("click", async () => {
      if (!pinForm.reportValidity()) return;
      const pin = pinForm.querySelector("[data-pin]").value;
      if (pin !== pinForm.querySelector("[data-pin2]").value) { errToast(t("The PINs don't match.")); return; }
      try {
        await saveWrap("pin", pin);
        toast(t("App-lock PIN saved — it unlocks this profile faster. The passphrase or the passkey still works."));
        pinForm.reset();
        await refresh();
      } catch (err) {
        errToast(t("Couldn't save the PIN: ") + (err?.message || err));
      }
    });
    lockBox.querySelector("[data-pin-remove]").addEventListener("click", async () => {
      try {
        await core.transport.removeUnlockWrap("pin");
        toast(t("PIN removed."));
        await refresh();
      } catch (err) {
        errToast(t("Couldn't remove the PIN: ") + (err?.message || err));
      }
    });
    // Shown once — the code IS the secret, it cannot be displayed again.
    const genRecovery = async () => {
      const alph = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      const raw = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => alph[b % alph.length]).join("");
      try {
        await saveWrap("recovery", raw);
        const m = showModal({
          title: t("Recovery code"),
          body: `<p class="modal-hint">${escapeHtml(t("Write this down now — it is shown only once. It unlocks this profile if you lose the passphrase and the passkey."))}</p><p style="font-size:1.4em;letter-spacing:.08em;text-align:center"><b>${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}</b></p>`,
          foot: `<button class="btn-primary" type="button" data-done>${escapeHtml(t("I wrote it down"))}</button>`,
        });
        m.modal.querySelector("[data-done]").addEventListener("click", m.close);
        await refresh();
      } catch (err) {
        errToast(t("Couldn't save the recovery code: ") + (err?.message || err));
      }
    };
    lockBox.querySelectorAll("[data-rec-new]").forEach((b) => b.addEventListener("click", genRecovery));
    lockBox.querySelector("[data-rec-remove]").addEventListener("click", async () => {
      try {
        await core.transport.removeUnlockWrap("recovery");
        toast(t("Recovery code removed."));
        await refresh();
      } catch (err) {
        errToast(t("Couldn't remove the recovery code: ") + (err?.message || err));
      }
    });
  }

  /* -- add profile -- */
  const relayInput = panes.add.querySelector("[data-relay]");
  const submitAdd = async () => {
    const link = normalizeRelayLink(relayInput.value);
    const invite = parseRelayInvite(relayInput.value);
    if (!link && !invite) {
      toast(relayInput.value.trim() ? t("That doesn't look like a chatmail relay, invite link, or dcaccount: link") : t("Enter a relay address"));
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
      hint: t("Paste a chatmail invite link (<code>dcaccount:…</code>), just a relay domain like <code>nine.testrun.org</code>, or scan a QR code in the Delta Chat app to add another profile."),
      validate: c => (normalizeRelayLink(c) || parseRelayInvite(c) ? null : t("That doesn't look like a chatmail relay, relay invite or dcaccount: link")),
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
      <div class="qr-box" style="margin-top:10px"><div class="qr-loading">${escapeHtml(t("Preparing QR…"))}</div></div>
      <div class="p2p-hint" style="opacity:.6">${escapeHtml(t("On the new device, tap \"Receive a profile on this device\" and scan or paste this code. Keep both devices on this screen until the transfer finishes."))}</div>
      <div style="margin-top:8px"><button type="button" class="btn-text" data-cancel>${escapeHtml(t("Cancel"))}</button></div>`;
    const transferDone = () => {
      if (!accountIsCurrent(epoch)) return;
      cleanupTransfer();
      toast(t("Profile transferred to the second device"));
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
        `<div class="qr-loading">${escapeHtml(t("Couldn't prepare the transfer:"))}<br>${escapeHtml(String(err?.message || err))}</div>`;
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
  // #178 phase 4: a successful export feeds the backup reminder (and clears
  // the post-enable nudge).
  const stampBackup = () => {
    try { localStorage.setItem("velta-last-backup", String(Date.now())); localStorage.removeItem("velta-enc-nudge"); } catch {}
  };
  const onAndroid = isAndroid();
  // #104: wasm core (PWA) has no folder picker — the backup tar is written
  // into memfs and downloaded by the browser; desktop/Android paths unchanged.
  const pwaExport = core.backend?.kind === "worker-wasm" && !!core.transport?.readCoreFileList;
  if (pwaExport) {
    panes.export.querySelector(".pm-hint").textContent =
      t("Writes this profile — messages, contacts and keys — into a backup archive and downloads it. The profile stays signed in.");
    destInput.value = "/backup/export";
    exportBtn.disabled = false;
  } else if (onAndroid) {
    // The old fixed folder was app-private (/data/user/0/…/exports) — the
    // file existed and the user could not open it. The save dialog asks
    // where the file should go; the core still writes a temp tar first.
    destInput.hidden = true;
    panes.export.querySelector(".pm-hint").textContent =
      t("Writes this profile — messages, contacts and keys — into a backup file. You'll be asked where to save it. The profile stays signed in.");
    exportBtn.disabled = false;
  } else {
    const shell = tauriInvoke();
    if (!shell) {
      // #104: no export path in this backend — say so instead of a dead field.
      destInput.placeholder = t("Backup export needs the desktop app or the Velta PWA");
      destInput.readOnly = true;
    } else {
      destInput.addEventListener("click", async () => {
        try {
          const picked = await shell("plugin:dialog|open", { options: { directory: true, multiple: false, title: t("Choose backup folder") } });
          if (typeof picked === "string" && picked) {
            destInput.value = picked;
            exportBtn.disabled = false;
          }
        } catch (err) {
          errToast(t("Couldn't open the folder picker: ") + (err?.message || err));
        }
      });
    }
  }
  exportBtn.addEventListener("click", async () => {
    const pass = passInput.value;
    if (pass && !passInput.reportValidity()) return;
    const invoke = tauriInvoke();
    let androidUri = "";
    if (onAndroid && !pwaExport) {
      if (!invoke) { toast(t("Backup export needs the Velta app")); return; }
      const name = backupDownloadName(state.account?.addr, new Date().toISOString().slice(0, 10));
      try {
        const picked = await invoke("plugin:dialog|save", { options: {
          title: t("Save backup"),
          defaultPath: name,
          filters: [{ name: t("Velta backup"), extensions: ["tar"] }],
        }});
        androidUri = typeof picked === "string" ? picked : "";
      } catch (err) {
        const msg = String(err?.message || err || "");
        if (/cancel/i.test(msg)) return;
        errToast(t("Couldn't open the save dialog: ") + msg);
        return;
      }
      if (!androidUri) return;
    }
    const dest = destInput.value.trim();
    if (!androidUri && !pwaExport && !dest) { toast(t("Choose a destination folder first")); return; }
    lock(true);
    exportBtn.disabled = true;
    progressBox.hidden = false;
    progressBox.textContent = t("Exporting…");
    const onProg = (e) => {
      const p = e.detail?.progress || 0;
      progressBox.textContent = p >= 1000 ? t("Backup written.") : t("Exporting… {n}%", { n: Math.round(p / 10) });
    };
    core.addEventListener("imex-progress", onProg);
  try {
    if (pwaExport) {
      await runBackupExport(pass || null);
      progressBox.textContent = t("Backup downloaded — check your browser downloads.");
      stampBackup();
    } else if (androidUri) {
      const dir = await invoke("backup_scratch_dir");
      await core.exportBackup(dir, pass || null);
      progressBox.textContent = t("Saving…");
      await invoke("publish_backup", { dir, uri: androidUri });
      progressBox.textContent = t("Backup saved.");
      stampBackup();
    } else {
      await core.exportBackup(dest, pass || null);
      stampBackup();
    }
  } catch (err) {
      errToast(t("Export failed: ") + (err?.message || err));
      progressBox.hidden = true;
    } finally {
      core.removeEventListener("imex-progress", onProg);
      exportBtn.disabled = false;
      lock(false);
    }
  });

  /* -- import backup (a new profile; the core refuses a tar on one in use) -- */
  if (panes.import) {
  const importPass = panes.import.querySelector("[data-pass]");
  const importBtn = panes.import.querySelector("[data-import]");
  const importHint = panes.import.querySelector(".pm-hint");
  if (!tauriInvoke() || !core.beginBackupImport) {
    importBtn.disabled = true;
    importHint.textContent = t("Restore from a backup file needs the Velta app — use \"Add as a second device\" instead");
  }
  importBtn.addEventListener("click", async () => {
    if (importPass.value && !importPass.reportValidity()) return;
    const invoke = tauriInvoke();
    if (!invoke || !core.beginBackupImport) {
      toast(t("Restore from a backup file needs the Velta app — use \"Add as a second device\" instead"));
      return;
    }
    let picked;
    try { picked = await pickBackupTar(invoke); }
    catch (err) { errToast(t("Couldn't read the backup file: ") + (err?.message || err)); return; }
    if (!picked || !accountIsCurrent(epoch)) return;
    let job;
    try { job = await core.beginBackupImport(picked, importPass.value || null); }
    catch (err) {
      errToast(t("Restore failed: couldn't import the backup") + " " + (err?.message || err));
      return;
    }
    // account-changing closed this modal. Progress rides a new one; the
    // core signals 1000 / 0, and `pending` carries an early RPC error.
    const prog = showProgressModal("Import backup", t("Restoring profile…"));
    let settled = false;
    let seen = false;
    const finishOk = () => {
      if (settled) return;
      settled = true;
      core.removeEventListener("imex-progress", onProg);
      prog.update(t("Profile restored — restarting"));
      localStorage.setItem("velta-ask-notifications", "1");
      core._tunnelReapply?.();
      setTimeout(() => location.reload(), 800);
    };
    const finishErr = async (msg) => {
      if (settled) return;
      settled = true;
      core.removeEventListener("imex-progress", onProg);
      prog.close();
      try { await core.stopOngoingProcess?.(); } catch { /* already finished */ }
      if (job.created && String(job.targetId) !== String(job.prevId)) {
        try {
          if (String(core.accountId) === String(job.targetId)) await core.switchAccount(job.prevId);
        } catch { /* delete still drops the stray */ }
        try { await core.deleteAccount(job.targetId); } catch { /* leave the toast */ }
      }
      errToast(msg);
    };
    const onProg = (e) => {
      const p = e.detail?.progress || 0;
      if (p >= 1000) finishOk();
      else if (p > 0) {
        seen = true;
        prog.update(t("Restoring profile… {n}%", { n: Math.round(p / 10) }));
      } else if (seen) finishErr(t("Restore failed"));
    };
    core.addEventListener("imex-progress", onProg);
    job.pending.then(() => finishOk()).catch(err => {
      if (settled || seen) return;
      finishErr(t("Restore failed: couldn't import the backup") + " " + (err?.message || err));
    });
  });
  }

  /* -- delete profile (#100) -- */
  const delForm = panes.delete.querySelector("[data-del-form]");
  const delLast = panes.delete.querySelector("[data-del-last]");
  const delInput = panes.delete.querySelector("[data-del-confirm]");
  const delBtn = panes.delete.querySelector("[data-delete]");
  const delProgress = panes.delete.querySelector("[data-del-progress]");
  panes.delete.querySelector("[data-del-name]").textContent =
    state.account?.displayName || state.account?.addr || t("this profile");
  const delAddr = String(state.account?.addr || "");
  panes.delete.querySelector("[data-del-addr]").textContent = delAddr || t("(no address)");
  if (state.accounts.length <= 1) {
    delForm.hidden = true;
    delLast.hidden = false;
  }
  delInput.addEventListener("input", () => {
    delBtn.disabled = !delAddr || delInput.value.trim().toLowerCase() !== delAddr.toLowerCase();
  });
  delBtn.addEventListener("click", async () => {
    if (state.accountChanging || core._accountTransitionBusy) {
      errToast(t("Another account operation is running — try again in a moment"));
      return;
    }
    lock(true);
    delBtn.disabled = true;
    delProgress.hidden = false;
    delProgress.textContent = t("Deleting profile…");
    try {
      const deletedId = core.accountId;
      const moved = await core.deleteAccount(deletedId);
      forgetMdAccount(localStorage, deletedId);
      // account-changed refreshes chats and drawer for the reconciled
      // selection; the modal has nothing left to show either way.
      toast(moved ? t("Profile deleted — switched to {name}", { name: moved.displayName || moved.addr }) : t("Profile deleted"));
      close();
    } catch (err) {
      errToast(t("Delete failed: ") + (err?.message || err));
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
    if (d?.type === "velta-push-subscription-changed" && core?.backend?.kind === "worker-wasm") {
      refreshWebPush(core, { log: (lvl, m) => diagnostics.append(lvl, m) }).catch(() => {});
      return;
    }
    if (d?.type === "velta-notification-click" && Number(d.chatId) > 0) {
      openChatFromLink({ accountId: d.accountId != null ? Number(d.accountId) : null, chatId: Number(d.chatId) });
    }
  });
  navigator.serviceWorker.controller?.postMessage({ type: "velta-pending-notification" });
}
// PWA dist: pwa-config.js fires this when a new service worker took over an
// already-open page. This page still runs the old files until a reload.
addEventListener("velta-sw-updated", () => {
  diagnostics.append("info", "A new Velta version was installed; reload to use it");
  if (document.querySelector("#toasts .toast-sticky")) return;
  toast(t("Velta was updated — reload the page to use the new version"), 0, {
    sticky: true,
    action: { label: "Reload", run: () => location.reload() },
  });
});

// Doze and OEM battery managers freeze the in-process core while the
// activity is stopped, so mail waits until the next open. Asked ONCE
// (battery-prompt.js remembers any answer or close); the drawer keeps the
// manual path. sessionStorage still blocks a second dialog in the same
// process (account create and boot can both reach here).
async function askBatteryExemption() {
  if (!isAndroid()) return;
  if (sessionStorage.getItem("velta-battery-opt-asked")) return;
  const invoke = tauriInvoke();
  if (!invoke) return;
  let exempt = true;
  try {
    exempt = await invoke("battery_optimization_exempt");
  } catch {
    return;
  }
  if (!shouldAskBattery({ exempt, storage: localStorage })) return;
  sessionStorage.setItem("velta-battery-opt-asked", "1");
  let maker = "";
  try { maker = await invoke("device_maker"); } catch {}
  const ok = await batteryPromptModal(maker);
  rememberBatteryAnswer(localStorage);
  if (!ok) return;
  try {
    await invoke("request_battery_exemption");
  } catch (err) {
    diagnostics.append("warning", `battery exemption: ${err?.message || err}`);
  }
}

function batteryPromptModal(maker) {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    const label = makerLabel(maker);
    const body = document.createElement("div");
    body.innerHTML = `<p class="bat-prompt-text">${escapeHtml(t("Android stops Velta from syncing after you leave the app, so new messages wait until you open it. Allow unrestricted battery use so mail keeps arriving in the background."))}</p>
      <p class="bat-prompt-text"><a class="bat-dkma" href="${escapeAttr(dontKillMyAppUrl(maker))}" data-dkma>${escapeHtml(label ? t("Extra steps for {maker} phones", { maker: label }) : t("Extra steps for your phone"))}</a></p>`;
    body.querySelector("[data-dkma]").addEventListener("click", e => {
      e.preventDefault();
      openInAppBrowser(dontKillMyAppUrl(maker));
    });
    const foot = document.createElement("div");
    const later = document.createElement("button");
    later.type = "button"; later.className = "btn-text"; later.textContent = t("Not now");
    const allow = document.createElement("button");
    allow.type = "button"; allow.className = "btn-text"; allow.textContent = t("Allow");
    foot.append(later, allow);
    const { close } = showModal({ title: t("Keep messages arriving"), body, foot, compact: true, onClose: () => finish(false) });
    later.addEventListener("click", () => { finish(false); close(); });
    allow.addEventListener("click", () => { finish(true); close(); });
  });
}

// Configure a profile from a dcaccount: relay invite link (deeplink or manual).
async function addAccountFromInvite(link) {
  if (state.accountChanging) return;
  if (!core.addAccountWithQr) {
    toast(t("No background service available — install the Velta Core service app to add relay accounts"), 5000);
    return;
  }
  toast(t("Creating account on relay…"), 2500);
  try {
    const id = await core.addAccountWithQr(link);
    const epoch = core.accountEpoch;
    await accountRefreshPromise;
    if (accountIsCurrent(epoch)) await askNotificationPermission();
    if (accountIsCurrent(epoch) && core.accountId === id) toast(t("Account ready: {addr}", { addr: state.account?.addr || t("chatmail profile") }), 3500);
  } catch (err) {
    errToast(t("Invite failed: ") + err.message, 4500);
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
  toast(t("Checking {host}…", { host }));
  if (!(await probeC3Relay(host))) {
    // Stock chatmail has no tunnel. Keep the proxy already in use when it
    // resolves this host (it dials that relay's real mail ports).
    const via = activeWsRelay();
    if (via && await probeDnsVia(via, host)) return true;
    errToast(t("{host} doesn't answer browser mail, and {page} can't reach it either. Use the Velta app, or a WebSocket relay that dials other relays.", { host, page: via || t("this page") }), 7000);
    return false;
  }
  if (!listWsRelays().includes(host)) addWsRelay(host);
  useWsRelay(host);
  sessionStorage.setItem("velta-pending-add", link);
  toast(t("Routing mail through {host} — reloading…", { host }));
  location.reload();
  return new Promise(() => {}); // the reload never lets this resolve
}

// Relay signup invites (PLAN-PWA-WEBSOCKET R1/V2): https://<host>/i/<token> —
// distinct from the contact/group invites in invites.js. The token is the
// bearer secret; the relay's /i/claim endpoint swaps it for one-time
// credentials. PWA-only for now (native clients use dclogin: links).
function parseRelayInvite(raw) {
  const inv = parseRelayInviteInput(raw);
  const host = inv && normalizeHost(inv.host);
  return host ? { host, token: inv.token } : null;
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
    toast(t("Claiming invite…"));
    const invoke = tauriInvoke();
    let status, body;
    if (invoke) {
      // Native: the shell fetches (the renderer is CORS-bound) through the
      // profile's proxy — the WebSocket transport / DNS tunnel when in use.
      await invoke("tunnel_reapply").catch(() => {});
      let proxy = null;
      try {
        const [en, url] = await Promise.all([core.getConfig("proxy_enabled"), core.getConfig("proxy_url")]);
        proxy = activeProxyUrl(en, url);
      } catch { /* no profile config: direct */ }
      try { ({ status, body } = await invoke("relay_invite_claim", { host, token, proxy })); }
      catch (err) { throw new Error(`Couldn't reach ${host}: ${err?.message || err}`); }
    } else {
      let res;
      try {
        // GET, not POST — fcgiwrap on the relay 502s request bodies; the
        // token already rides URLs by design, credentials never do.
        res = await fetch(`https://${host}/i/claim?t=${encodeURIComponent(token)}`, { cache: "no-store" });
      } catch (err) {
        throw new Error(`Couldn't reach ${host}: ${err.message || err}`);
      }
      status = res.status;
      body = await res.json().catch(() => null);
    }
    creds = relayClaimResult(status, body);
    // The invite is consumed at claim time — park the credentials so a
    // configure failure can retry without burning a second invite.
    sessionStorage.setItem(parkKey, JSON.stringify({ host, token, creds, exp: Date.now() + 30 * 60_000 }));
  }
  toast(t("Setting up your profile…"));
  if (tauriInvoke() && core.addAccountWithCredentials) {
    // Native: a new profile (or the empty current one), selected on success.
    await core.addAccountWithCredentials(creds.email, creds.password);
  } else {
    await core.configureWithCredentials(creds.email, creds.password);
    if (core.startIo) await core.startIo();
  }
  sessionStorage.removeItem(parkKey);
  const epoch = core.accountEpoch;
  await accountRefreshPromise;
  if (accountIsCurrent(epoch)) await askNotificationPermission();
  if (accountIsCurrent(epoch)) toast(t("Account ready: {addr}", { addr: state.account?.addr || creds.email }), 3500);
}

// "Create account" on a relay invite card: the invite is single-use, so ask.
async function confirmRelayInvite({ host, token }) {
  const ok = await confirmModal(t("Create an account on {host}?", { host }),
    t("A new profile is created on {host} with this invite. The invite works once. Only continue if you trust the sender.", { host }),
    t("Create account"), false);
  if (ok) await createAccountFromRelayInvite(normalizeHost(host), token);
}

async function createAccountFromRelayInvite(host, token) {
  if (state.accountChanging) return;
  if (!window.VELTA_PWA?.wasmCore && !tauriInvoke()) { toast(t("Relay invites work in the Velta app and the Velta PWA"), 5000); return; }
  if (!core.configureWithCredentials) { toast(t("This backend cannot create relay accounts")); return; }
  // A tunnel switch reloads the page — park the invite so boot resumes it.
  if (activeWsRelay() !== host) sessionStorage.setItem("velta-pending-invite", JSON.stringify({ host, token }));
  if (!(await ensureMailTunnelForLink(`dcaccount:https://${host}/new`))) return;
  sessionStorage.removeItem("velta-pending-invite");
  try {
    await claimAndConfigure(host, token);
    return true;
  } catch (err) {
    errToast(err.message || String(err), 6000);
    return false;
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
      errToast(t("Switch failed: ") + (err.message || err));
      return;
    }
    await accountRefreshPromise;
  }
  const epoch = core.accountEpoch;
  const chat = await core.getChat(chatId).catch(() => null);
  if (!accountIsCurrent(epoch)) return;
  if (!chat) {
    toast(t("That chat is no longer available"), 2500);
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
    if (state.account?.configured) toast(t("You already have a profile — paste the invite into Add profile"), 5000);
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
  // DNS tunnel setup link: confirmed by the user before anything changes.
  const tunnelLink = extractTunnelLink(rawUrl);
  if (tunnelLink) {
    if (clearUrl) history.replaceState(null, "", location.pathname + location.search);
    await acceptTunnelLink(tunnelLink, { confirmModal, choose: makeChooser(showModal), toast, errToast, onChange: rebuildDrawer });
    return true;
  }
  // WebSocket transport link: validated and confirmed before anything changes.
  const wsLink = extractWsLink(rawUrl);
  if (wsLink) {
    if (clearUrl) history.replaceState(null, "", location.pathname + location.search);
    await acceptWsLink(wsLink, { confirmModal, toast, errToast, onChange: rebuildDrawer });
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
      t("A second-device code was opened. Receive that profile on this device and switch to it? Only continue if you started the transfer on your other device."),
      t("Receive"), false);
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
      <p class="p2p-hint">${t("Use the <b>{host}</b> invite to…", { host: escapeHtml(host) })}</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
        <button type="button" class="btn-text btn-primary" data-relay>${escapeHtml(t("Add the relay to this profile"))}</button>
        ${/^dclogin:/i.test(link) ? "" : `<button type="button" class="btn-text" data-new>${escapeHtml(t("Create a new profile on it"))}</button>`}
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
  errToast(t("Couldn't share: ") + (err?.message || err));
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
    if (!await shareAccountSettled()) { errToast(t("Couldn't share: the profile is still switching")); return; }
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
        errToast(t("Switch failed: ") + (err?.message || err));
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
    errToast(t("Couldn't open {name}", { name: chat.name }));
    return;
  }
  const result = await chatView.receiveShare({ text, files });
  if (result === "sent" && accountIsCurrent(epoch)) {
    toast(t("Sent to {name}", { name: chat.name }));
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
  const wrap = document.createElement("div");
  // Search above the chat list (#158) — same matching as the search screen.
  const search = document.createElement("input");
  search.type = "search";
  search.className = "text-field";
  search.placeholder = t("Search chats…");
  search.enterKeyHint = "search";
  search.autocomplete = "off";
  search.setAttribute("aria-label", t("Search chats"));
  search.style.marginBottom = "8px";
  const list = document.createElement("div");
  list.className = "modal-list";
  const empty = document.createElement("div");
  empty.className = "p2p-hint"; empty.style.opacity = ".6";
  empty.textContent = t("No chats match.");
  empty.hidden = true;
  wrap.append(knownContactsToggleRow(applyFilter), search, list, empty);
  const targets = state.chats.filter(c => !["deaddrop", "device"].includes(c.kind) && !c.isP2pGroup);
  const items = [];
  for (const chat of targets) {
    const item = document.createElement("velta-chat-item");
    item.setData(chat);
    item.addEventListener("click", async () => {
      close();
      if (!accountIsCurrent(epoch)) return;
      await core.forwardMessages(fromChatId, msgIds, chat.id);
      if (!accountIsCurrent(epoch)) return;
      if (navigation === chatNavigation) chatView?.exitSelection();
      toast(t("Forwarded to {name}", { name: chat.name }));
      refreshChatList();
    });
    list.appendChild(item);
    items.push([chat, item]);
  }
  // #158 search × #169 known-contacts: one filter, both conditions.
  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const [chat, item] of items) {
      const hit = (!knownContactsOnly() || chat.kind === "single")
        && (!q || (chat.name || "").toLowerCase().includes(q));
      item.hidden = !hit;
      shown += hit;
    }
    empty.hidden = shown > 0;
  }
  applyFilter();
  search.addEventListener("input", applyFilter);
  const { close } = showModal({ title: "Forward to…", body: wrap });
  // Phones: no keyboard over the list until the user taps the field.
  if (!/Android|iPhone|iPad/i.test(navigator.userAgent || "")) search.focus();
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
    toast(t("Switching account…"));
    const account = await core.switchAccount(id);
    const epoch = core.accountEpoch;
    await accountRefreshPromise;
    if (accountIsCurrent(epoch)) toast(t("Switched to {name}", { name: account.displayName || account.addr }));
  } catch (err) {
    errToast(t("Switch failed: ") + (err.message || err));
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

async function mailLoginForBackup() {
  const prefer = state.account?.addr;
  let transports = [];
  try { transports = await core.listTransports(); } catch { /* the db still has the login */ }
  const fromRpc = mailLoginFromTransports(transports, prefer);
  if (fromRpc) return fromRpc;
  // ponytail: list_transports can come back without a password while the
  // account db still has it (nested entered_param, or imap_password on the
  // configured copy). A core call that always returns the secret replaces this.
  const read = core.transport?.readCoreFile?.bind(core.transport);
  if (!read) return null;
  let dir = null;
  try {
    dir = accountDirFromToml(new TextDecoder().decode(await read("/accounts/accounts.toml")));
  } catch { return null; }
  if (!dir) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(await read(`/accounts/${dir}/dc.db`));
    return mailLoginFromTransports(mailLoginsFromDbText(text), prefer);
  } catch { return null; }
}

async function runIdentityExport(pass) {
  if (!pass || pass.length < 8) throw new Error("Use a passphrase of at least 8 characters — this file IS your account");
  // core 2.63.0 removed the legacy addr/mail_pw configs. The login is the
  // transport (flat password or the db's imap.password). Prefer the sending address.
  const login = await mailLoginForBackup();
  const addr = login?.addr;
  const mailPw = login?.mailPw;
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
  onPhase(t("Reading backup…"));
  // Wrong passphrase / corrupt file throw here — BEFORE any account is
  // created, so a bad file can never leave a stray behind.
  const bundle = await unwrapIdentityBundle(new Uint8Array(await file.arrayBuffer()), pass);
  onPhase(t("Adding account for {addr}…", { addr: bundle.addr }));
  const id = await core.addAccount();
  try {
    // core 2.63.0: legacy addr/mail_pw configs are gone — configure via
    // add_transport (it runs the full configure + start_io internally).
    onPhase(t("Logging in to the relay…"));
    await core.configureWithCredentials(bundle.addr, bundle.mail_pw, id);
  } catch (err) {
    // #99 family: add_account selected the fresh, empty account — a dead
    // relay here would strand the user on it. Remove the stray (the wrapper
    // reconciles selection back); on a fresh PWA nothing else exists and the
    // splash stays the usable retry surface.
    onPhase(t("Restore failed — removing the half-created profile…"));
    await core.deleteAccount(id).catch(() => {});
    throw err;
  }
  onPhase(t("Importing encryption keys…"));
  const dir = "/identity/import";
  for (const [name, b64] of Object.entries(bundle.keys)) {
    await core.transport.writeCoreFile(`${dir}/${name}`, base64ToBytes(b64));
  }
  await core.importSelfKeys(id, dir, pass);
  // #126: the reload must not outrun the save, or the restored profile
  // (login + keys) is not on disk yet and the next load starts empty.
  onPhase(t("Saving profile…"));
  await core.transport.checkpoint?.();
  onPhase(t("Done — reloading…"));
  setTimeout(() => location.reload(), 800);
}

function openIdentityBackup({ restoreOnly = false } = {}) {
  if (!identityBackupAvailable()) {
    toast(t("Identity backup needs the wasm core (the Velta PWA)"));
    return;
  }
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="modal-hint">${t("Your identity is the relay address, its password and your encryption keys — one file keeps all three. The passphrase protects it; losing the passphrase means losing the account. It holds <b>no message history</b> — a full copy including messages is Profile management → Export backup.")}</p>
    ${restoreOnly ? "" : `
    <details class="backup-export" open>
      <summary>${escapeHtml(t("Export this profile"))}</summary>
      <label class="modal-field">${escapeHtml(t("Passphrase"))} <input class="text-field" data-pass type="password" autocomplete="new-password" placeholder="${escapeHtml(t("at least 8 characters"))}"></label>
      <label class="modal-field">${escapeHtml(t("Repeat"))} <input class="text-field" data-pass2 type="password" autocomplete="new-password"></label>
      <button class="btn-primary" data-export type="button">${escapeHtml(t("Export identity backup"))}</button>
    </details>`}
    <details class="backup-restore"${restoreOnly ? " open" : ""}>
      <summary>${escapeHtml(t("Restore from a backup file"))}</summary>
      <label class="modal-field">${escapeHtml(t("Backup file"))} <input class="text-field" data-file type="file" accept=".velta-identity,application/octet-stream"></label>
      <label class="modal-field">${escapeHtml(t("Passphrase"))} <input class="text-field" data-pass-r type="password" autocomplete="off"></label>
      <button class="btn-primary" data-restore type="button">${escapeHtml(t("Restore"))}</button>
    </details>
    <p class="modal-status" data-status hidden></p>`;
  const status = body.querySelector("[data-status]");
  const phase = (text) => { status.hidden = false; status.textContent = text; };
  const busy = (btn, on) => { btn.disabled = on; btn.classList.toggle("btn-loading", on); };
  const exportBtn = body.querySelector("[data-export]");
  exportBtn?.addEventListener("click", async () => {
    const pass = body.querySelector("[data-pass]").value;
    if (pass !== body.querySelector("[data-pass2]").value) { toast(t("Passphrases don't match")); return; }
    busy(exportBtn, true);
    try {
      const addr = await runIdentityExport(pass);
      phase(t("Backup saved — keep the file somewhere safe ({addr})", { addr }));
    } catch (err) {
      phase(err?.message || String(err));
    } finally { busy(exportBtn, false); }
  });
  const restoreBtn = body.querySelector("[data-restore]");
  restoreBtn?.addEventListener("click", async () => {
    const file = body.querySelector("[data-file]").files[0];
    if (!file) { toast(t("Pick a backup file first")); return; }
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

// Core `bcc_self` is the multi-device switch (default 0). The core is the
// source of truth — a localStorage copy would clobber the default and other
// devices. Cached per account so rebuilding the drawer does not flicker.
// multidevice.js keeps only the user's LAST CHOICE per account (never
// rendered) to notice the core turning bcc_self back on by itself (backup
// export, Add second device, sync from another device). A failed read shows
// "unknown" (indeterminate) and retries; it never pretends to be "off".
// (state lives at the top of the module: see multiDeviceState)

function paintMultiDevice() {
  const root = drawer?.el;
  const box = root?.querySelector('[data-toggle="multidevice"]');
  if (box?.isConnected) {
    const known = multiDeviceState === "on" || multiDeviceState === "off";
    box.checked = multiDeviceState === "on";
    box.indeterminate = !known;
    if (known) box.removeAttribute("aria-checked"); else box.setAttribute("aria-checked", "mixed");
    const span = box.closest(".ctx-item")?.querySelector("span");
    if (span) span.textContent = t("Multi-device: {state}", { state: mdLabel(multiDeviceState) === "…" ? "…" : t(mdLabel(multiDeviceState)) });
  }
  const note = root?.querySelector("[data-md-note]");
  if (note) note.hidden = !multiDeviceReenabled;
}

function turnMultiDeviceOffAgain() {
  setMultiDevice(false, { quick: true }).then(ok => {
    if (ok) toast(t("Multi-device off"));
  });
}

// Reads bcc_self for the current account and repaints. Called on drawer
// open/rebuild, app resume and after a backup/transfer finishes — the core
// emits no event when it flips bcc_self (not a synced key).
function ensureMultiDevice() {
  const accountId = core?.accountId;
  const gen = ++multiDeviceGen;
  clearTimeout(multiDeviceRetry);
  multiDeviceRetry = null;
  if (multiDeviceFor !== accountId) {
    multiDeviceFor = accountId;
    multiDeviceState = "loading";
    multiDeviceReenabled = false;
    multiDeviceAttempt = 0;
    paintMultiDevice();
  }
  Promise.resolve()
    .then(() => {
      if (!core?.getConfig) throw new Error("no core");
      return core.getConfig("bcc_self");
    })
    .then(v => {
      if (gen !== multiDeviceGen || core.accountId !== accountId) return;
      multiDeviceAttempt = 0;
      const rec = getMdChoice(localStorage, accountId);
      const res = classifyMultiDevice(v, rec);
      if (res.seed) recordMdChoice(localStorage, accountId, res.state === "on");
      multiDeviceState = res.state;
      multiDeviceReenabled = res.reenabled;
      paintMultiDevice();
      if (res.notify) {
        markMdNotified(localStorage, accountId);
        toast(t(MD_REENABLED_NOTE) + " " + t("Turn it off again if this is your only device."), 12000,
          { action: { label: "Turn off again", run: turnMultiDeviceOffAgain } });
      }
    })
    .catch(err => {
      if (gen !== multiDeviceGen || core?.accountId !== accountId) return;
      multiDeviceState = "unknown";
      paintMultiDevice();
      if (multiDeviceAttempt === 0) diagnostics.append("warning", `multi-device read failed: ${err?.message || err}`);
      const delay = mdRetryDelay(multiDeviceAttempt++);
      multiDeviceRetry = setTimeout(() => {
        if (gen === multiDeviceGen && core?.accountId === accountId) ensureMultiDevice();
      }, delay);
    });
}

// The single write path for the switch, "Turn off again" and the toast
// action. Switching off asks first: off makes this device delete messages
// from the relay, which starves other devices. `quick` (Turn off again)
// skips the confirm — the user already read the note explaining it.
async function setMultiDevice(on, { quick = false } = {}) {
  if (!core?.setConfig) return false;
  const accountId = core.accountId;
  if (!on && !quick) {
    const sure = await confirmModal("Turn off multi-device?", mdOffConfirmText(multiDeviceReenabled), "Turn off", true);
    if (!sure || core.accountId !== accountId) {
      paintMultiDevice();
      return false;
    }
  }
  const prevState = multiDeviceState;
  const prevReenabled = multiDeviceReenabled;
  multiDeviceGen++;
  clearTimeout(multiDeviceRetry);
  multiDeviceState = on ? "on" : "off";
  multiDeviceReenabled = false;
  multiDeviceFor = accountId;
  paintMultiDevice();
  try {
    await core.setConfig("bcc_self", on ? "1" : "0");
    recordMdChoice(localStorage, accountId, on);
    return true;
  } catch (err) {
    multiDeviceState = prevState;
    multiDeviceReenabled = prevReenabled;
    paintMultiDevice();
    errToast(t("Couldn't save multi-device: ") + (err?.message || err));
    ensureMultiDevice();
    return false;
  }
}

function savedDownloadLimit() {
  const raw = localStorage.getItem("velta-download-limit");
  const v = normalizeDownloadLimit(raw);
  if (raw != null && raw !== v) localStorage.setItem("velta-download-limit", v);
  return v;
}

function rebuildDrawer() {
  if (state.accountChanging) return;
  // Rebuilds land from async paths (boot, refreshAccounts, tunnel status,
  // profile/relay edits, Local chat toggle), often while the drawer is open.
  // Carry the open drawer and account switcher over to the new DOM instead of
  // silently dropping them, and unhook the old drawer's document listeners.
  const wasOpen = !!drawer?.el?.classList.contains("open");
  const switcherWasOpen = !!drawer?.acctSwitch?.open;
  drawer?.destroy?.();
  drawer?.el.remove();
  drawer?.overlayEl?.remove();
  // Boot/account-change sync: mirror persisted preferences into the core's
  // per-account config (the drawer's change handlers push on every change
  // too). localStorage is the source of truth for the UI; the core copies
  // keep the account config honest for other consumers.
  const savedMq = localStorage.getItem("velta-media-quality") || "0";
  // Device-global: core keeps download_limit on the account but does not
  // multi-device-sync it, so this one value is copied into the open account.
  const savedDl = savedDownloadLimit();
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
        errToast(t("Couldn't save image quality: ") + (err?.message || err)));
      toast(value === "1" ? t("Image quality: Compact") : t("Image quality: Standard"));
    },
    downloadLimit: savedDl,
    onDownloadLimit: (value) => {
      localStorage.setItem("velta-download-limit", value);
      core.setConfig?.("download_limit", value).catch(err =>
        errToast(t("Couldn't save download limit: ") + (err?.message || err)));
      toast(value === "0" ? t("Auto-download limit: none") : t("Auto-download limit set"));
    },
    onReadReceipts: (on) => {
      // localStorage mirror + per-account core config (same pattern as
      // media quality); pushed from rebuildDrawer on boot/account switch.
      localStorage.setItem("velta-mdns", on ? "1" : "0");
      core.setConfig?.("mdns_enabled", on ? "1" : "0").catch(err =>
        errToast(t("Couldn't save read receipts: ") + (err?.message || err)));
    },
    multiDeviceState: multiDeviceFor === core.accountId ? multiDeviceState : "loading",
    multiDeviceReenabled: multiDeviceFor === core.accountId && multiDeviceReenabled,
    onDrawerOpen: () => ensureMultiDevice(),
    onMultiDeviceKeep: () => {
      // "Keep on": the user accepts the core's flip as their choice.
      recordMdChoice(localStorage, core.accountId, true);
      multiDeviceReenabled = false;
      paintMultiDevice();
    },
    onMultiDevice: (on, opts) => setMultiDevice(on, opts),
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
        toast(enable ? t("Local chat enabled") : t("Local chat disabled"));
        if (!enable) {
          const id = String(state.activeChatId || "");
          if (id.startsWith("p2p:") || id.startsWith("p2pg:")) closeChatUI();
          refreshChatList();
          // The browser can enter local chat from the splash and has no
          // engine. Turning it off must bring setup back on an unconfigured
          // profile, or the preview is the only screen left.
          if (state.account?.configured === false && !document.getElementById("splash")) {
            splashSession = showSplash();
            splashSession?.showActions();
          }
        }
      } catch (error) {
        diagnostics.append("error", `Local chat toggle failed: ${error?.message || error}`);
        errToast(t("Local chat toggle failed: {why}", { why: error?.message || error }), 5000);
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
    onPrivacySecurity: window.__TAURI__ && tauriInvoke() ? () => openPrivacySecurity() : null,
    onInvite: () => showInvite(inviteQrProvider(null), { account: state.account }),
    onProfile: openSelfProfile,
    onEditProfile: editProfileFlow,
    onInviteDomains: () => showInviteDomainsModal(),
    onDiagnostics: async () => { await modalHistorySettled(); openDiagnosticsChat(); },
    onScheduled: () => openAllScheduled(),
    onExportSettings: () => exportSettingsToSaved(),
    backendKind: core?.backend?.kind || null,
    onTunnel: tunnelOffered()
      ? () => openTunnelSettings({ showModal, confirmModal, askText, choose: makeChooser(showModal), toast, errToast, onChange: rebuildDrawer, renderQr: text => core.createQrSvg(text) })
      : null,
    tunnelLabel: describeTunnel(tunnelStatus()).headline,
    // Native shells only; the PWA already speaks WebSocket (WebSocket relays).
    onWsTransport: window.__TAURI__
      ? async () => {
        let mailServer = "";
        try { mailServer = await core.getConfig("configured_mail_server") || ""; } catch { /* offline */ }
        openWsTransportSettings({ showModal, confirmModal, toast, errToast, onChange: rebuildDrawer, testHost: testHostFor({ mailServer, addr: state.account?.addr }) });
      }
      : null,
    wsTransportLabel: wsDrawerLabel(wsTransportStatus()),
    onPushSection: (el) => wirePushSection(el, {
      invoke: tauriInvoke(),
      getRelayAddrs: async () => {
        let t = [];
        try { t = await core.listTransports?.() || []; } catch { /* offline */ }
        const addrs = t.map(x => x?.addr).filter(Boolean);
        return addrs.length ? addrs : [state.account?.addr].filter(Boolean);
      },
      openUrl: (url) => openInAppBrowser(url),
      toast, errToast,
    }),
    onWebPushSection: (core?.backend?.kind === "worker-wasm" && typeof core.transport?.setPushDeviceToken === "function")
      ? (el) => wireWebPushSection(el, { core, toast, errToast })
      : null,
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
  if (wasOpen) {
    // no slide-in: the drawer was already on screen
    drawer.el.style.transition = "none";
    drawer.open();
    if (switcherWasOpen && drawer.acctSwitch) drawer.acctSwitch.open = true;
    void drawer.el.offsetWidth;
    drawer.el.style.transition = "";
  }
  ensureMultiDevice();
}

// #178 phase 4: app-wide Privacy & security (native shells). The database
// key (DEK) is one per install, so its key root — the app-lock PIN on
// desktop, the biometric lock on Android — and auto-lock live here, not in
// the per-profile Profile management screen.
function openPrivacySecurity() {
  const body = document.createElement("div");
  body.innerHTML = `
    <div style="display:grid;gap:8px" data-applock-box>
      <p class="pm-hint" data-applock-status></p>
      <p class="pm-hint" data-blob-status hidden></p>
      <div data-pin-form hidden style="display:grid;gap:6px">
        <input class="text-field" data-pin-cur type="password" placeholder="${escapeHtml(t("Current PIN"))}" autocomplete="current-password">
        <input class="text-field" data-pin-new type="password" minlength="6" required placeholder="${escapeHtml(t("App-lock PIN (6+ characters)"))}" autocomplete="new-password">
        <input class="text-field" data-pin-new2 type="password" minlength="6" required placeholder="${escapeHtml(t("Repeat PIN"))}" autocomplete="new-password">
        <div class="pm-actions">
          <button class="btn-primary" type="button" data-pin-save>${escapeHtml(t("Save PIN"))}</button>
          <button class="btn-text" type="button" data-pin-cancel>${escapeHtml(t("Cancel"))}</button>
        </div>
      </div>
      <div class="pm-actions" data-pin-off-row hidden>
        <button class="btn-text" type="button" data-pin-add>${escapeHtml(t("Add app-lock PIN"))}</button>
      </div>
      <div class="pm-actions" data-pin-rows hidden>
        <button class="btn-text" type="button" data-pin-edit>${escapeHtml(t("Change PIN"))}</button>
        <button class="btn-text" type="button" data-pin-remove style="color:var(--danger)">${escapeHtml(t("Remove PIN"))}</button>
      </div>
      ${isAndroid() ? `<div class="pm-actions" style="display:grid;gap:6px">
        <button class="btn-text" type="button" data-bio-toggle></button>
      </div>` : ""}
      <label class="pm-hint" style="display:grid;gap:4px">
        <span>${escapeHtml(t("Lock when hidden"))}</span>
        <select class="text-field" data-autolock>
          <option value="0">${escapeHtml(t("Off"))}</option>
          <option value="1">${escapeHtml(t("After 1 minute"))}</option>
          <option value="5">${escapeHtml(t("After 5 minutes"))}</option>
          <option value="15">${escapeHtml(t("After 15 minutes"))}</option>
        </select>
      </label>
    </div>
  `;
  const cleanups = [];
  /* -- app-lock PIN + auto-lock (#178 phase 4, native shell) -- */
  const applockBox = body.querySelector("[data-applock-box]");
  if (applockBox) {
    const shell = tauriInvoke();
    const statusEl = applockBox.querySelector("[data-applock-status]");
    const pinForm = applockBox.querySelector("[data-pin-form]");
    const pinCur = pinForm.querySelector("[data-pin-cur]");
    const pinNew = pinForm.querySelector("[data-pin-new]");
    const pinNew2 = pinForm.querySelector("[data-pin-new2]");
    const pinOffRow = applockBox.querySelector("[data-pin-off-row]");
    const pinRows = applockBox.querySelector("[data-pin-rows]");
    const alSel = applockBox.querySelector("[data-autolock]");
    alSel.value = localStorage.getItem("velta-autolock-mins") || "0";
    alSel.addEventListener("change", () => {
      try { localStorage.setItem("velta-autolock-mins", alSel.value); } catch {}
      if (isAndroid() && tauriInvoke()) tauriInvoke()("set_autolock_mins", { mins: Number(alSel.value) || 0 }).catch(() => {});
    });
    // Android: the biometric lock replaces the PIN (the Keystore KEK is the
    // user-auth root there); the result arrives as a velta-biometric event.
    // #178 phase 5: the encryption decision's honest boundary — the
    // message database is keyed, attachments are not; say what still rides
    // on platform/disk encryption.
    const blobEl = applockBox.querySelector("[data-blob-status]");
    if (blobEl) {
      blobEl.hidden = false;
      if (isAndroid()) {
        blobEl.textContent = t("Attachments stay in the app's private storage, which Android encrypts at rest (file-based encryption).");
      } else {
        const shell2 = tauriInvoke();
        if (shell2) {
          shell2("volume_encryption_status").then((st) => {
            const vol = st === "on"
              ? " " + t("Disk encryption: on.")
              : st === "off"
                ? " " + t("Disk encryption: OFF — turn on BitLocker (or FileVault) to protect attachments at rest.")
                : "";
            blobEl.textContent = t("Attachments stay unencrypted — they rely on platform isolation and, on this device, your disk encryption.") + vol;
          }).catch(() => {});
        }
      }
    }
    const bioBtn = applockBox.querySelector("[data-bio-toggle]");
    if (bioBtn) {
      let bioOn = false;
      const refreshBio = async () => {
        try {
          bioOn = await tauriInvoke()("biometric_state");
          bioBtn.textContent = bioOn ? t("Turn off the biometric lock") : t("Use the biometric lock");
        } catch {}
      };
      // The prompt's error code + message rides in payload.detail (also in
      // velta.log); surface it so a failure is diagnosable.
      const bioFail = (why) => {
        diagnostics.append("error", `Biometric lock: ${why || "failed"}`);
        errToast(why ? t("The biometric prompt did not succeed: {why}", { why }) : t("The biometric prompt did not succeed."), 6000);
      };
      const unlistenP = window.__TAURI__?.event?.listen?.("velta-biometric", (ev) => {
        refreshBio();
        if (ev?.payload && !ev.payload.ok) bioFail(ev.payload.detail);
        else if (ev?.payload?.ok) toast(ev.payload.on ? t("Biometric lock is on.") : t("Biometric lock is off."));
      });
      cleanups.push(() => { Promise.resolve(unlistenP).then((un) => un?.()).catch(() => {}); });
      bioBtn.addEventListener("click", () => {
        tauriInvoke()("biometric_set", { on: !bioOn }).catch((err) => bioFail(String(err?.message || err)));
      });
      refreshBio();
    }
    // "set" (no PIN yet), "change", "remove" — the current PIN is asked for
    // whenever one is set; the Rust side re-verifies it anyway.
    let formMode = "set";
    const refresh = async () => {
      if (isAndroid()) {
        // PIN is a desktop mode; Android gates through the Keystore.
        statusEl.textContent = t("The biometric lock protects the database key of all profiles at rest — cold starts ask for your fingerprint before any data opens.");
        pinForm.hidden = true;
        pinOffRow.hidden = true;
        pinRows.hidden = true;
        return;
      }
      let on = false;
      try { on = await shell("get_db_pin_state"); } catch {}
      statusEl.textContent = on
        ? t("App-lock PIN is on. The PIN — not the OS keychain — protects this profile's database key at rest, and auto-lock can re-lock the app.")
        : t("The database key lives in the OS keychain. Add a PIN to require it at every start and to enable auto-lock.");
      pinForm.hidden = true;
      pinOffRow.hidden = on;
      pinRows.hidden = !on;
      pinCur.hidden = !on;
      pinCur.required = on;
    };
    refresh();
    const openForm = (mode) => {
      formMode = mode;
      pinForm.reset();
      pinNew.hidden = mode === "remove";
      pinNew2.hidden = mode === "remove";
      pinNew.required = mode !== "remove";
      pinNew2.required = mode !== "remove";
      pinOffRow.hidden = true;
      pinRows.hidden = true;
      pinForm.hidden = false;
      (mode === "remove" ? pinCur : pinNew).focus();
    };
    applockBox.querySelector("[data-pin-add]").addEventListener("click", () => openForm("set"));
    applockBox.querySelector("[data-pin-edit]").addEventListener("click", () => openForm("change"));
    applockBox.querySelector("[data-pin-remove]").addEventListener("click", () => openForm("remove"));
    applockBox.querySelector("[data-pin-cancel]").addEventListener("click", refresh);
    pinForm.querySelector("[data-pin-save]").addEventListener("click", async () => {
      if (!pinForm.reportValidity()) return;
      try {
        if (formMode === "remove") {
          await shell("clear_db_pin", { pin: pinCur.value });
          toast(t("PIN removed."));
        } else {
          if (pinNew.value !== pinNew2.value) { errToast(t("The PINs don't match.")); return; }
          await shell("set_db_pin", { old: pinCur.hidden ? null : pinCur.value, pin: pinNew.value });
          toast(t("App-lock PIN saved — it is required at every start. Keep it safe: without it, restore from a backup."));
        }
        await refresh();
      } catch (err) {
        const msg = String(err?.message || err || "");
        const wait = msg.startsWith("retry:") ? Number(msg.slice(6)) || 0 : 0;
        errToast(wait > 0
          ? t("Too many attempts — wait {n} s.", { n: wait })
          : t("Couldn't save the PIN: ") + (msg.includes("no-key")
            ? t("This profile has no database key yet — nothing for a PIN to protect.")
            : msg.includes("keychain-unavailable")
              ? t("The OS keychain is unavailable.")
              : msg || err));
      }
    });
  }

  showModal({ title: "Privacy & security", body, onClose: () => cleanups.forEach((fn) => fn()) });
}

// Profile editor flow: name + avatar picture.
// The core's selfavatar config takes a filesystem path it can read, so the
// picked image goes through the same pipeline as attachments: absolute path
// on desktop, content-URI copy into uploads/ on Android, memfs /uploads/ in
// the PWA, data URL in demo.
async function writePickedImage(file) {
  const write = core?.transport?.writeCoreFile;
  if (typeof write !== "function") return null;
  const ext = (String(file.name || "bin").split(".").pop() || "bin").replace(/[^a-z0-9]/gi, "") || "bin";
  const path = `/uploads/avatar-${Date.now()}.${ext}`;
  await write.call(core.transport, path, new Uint8Array(await file.arrayBuffer()));
  return path;
}

// The core copied the picture into its blobdir (set_config selfavatar /
// set_chat_profile_image), so the /uploads/ temp copy only costs memory.
function dropUpload(path) {
  const rm = core?.transport?.removeCoreFile;
  if (typeof rm !== "function" || !/^\/uploads\//.test(String(path || ""))) return;
  rm.call(core.transport, path).catch(() => {});
}

async function pickProfileImage() {
  const invoke = tauriInvoke();
  if (!invoke) {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/png,image/jpeg,image/webp,image/gif";
    const file = await new Promise(resolve => {
      inp.onchange = () => resolve(inp.files && inp.files[0] || null);
      inp.click();
    });
    if (!file) return null;
    const path = await writePickedImage(file);
    if (path) return { path, url: URL.createObjectURL(file) };
    const dataUrl = await new Promise((ok, bad) => {
      const reader = new FileReader();
      reader.onload = () => ok(String(reader.result));
      reader.onerror = () => bad(reader.error);
      reader.readAsDataURL(file);
    });
    return { path: dataUrl, url: dataUrl };
  }
  let picked = await invoke("plugin:dialog|open", { options: {
    multiple: false,
    filters: [{ name: t("Images"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
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
    else if (result.avatar !== "keep") {
      await core.setAvatar(result.avatar.path);
      dropUpload(result.avatar.path);
    }
    if (core.setSelfStatus && result.description !== status) await core.setSelfStatus(result.description);
    if (!accountIsCurrent(epoch)) return;
    const account = await core.getAccount();
    if (!accountIsCurrent(epoch)) return;
    state.account = account;
    rebuildDrawer();
    toast(t("Profile updated"));
  } catch (err) {
    errToast(t("Couldn't update profile: ") + (err.message || err), 4500);
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
    toast(t("Joining chats needs the background core — not available in demo mode"), 4500);
    return;
  }
  let parsed = parseInviteLink(link);
  if (!parsed && isShortInviteLink(link)) {
    parsed = await expandShortInvite(link);
    if (!parsed) { errToast(t("Could not expand this short invite link"), 4500); return; }
  }
  const label = parsed ? inviteLabel(parsed) : null;
  // joinFlow closed its modal right before calling us: its history.back()
  // lands async, and a confirm opened before the pop shares the dying entry
  // and is torn down by it — resolve(false), Join silently does nothing (#103).
  await modalHistorySettled();
  let ok;
  if (label?.kind === "group") {
    ok = await confirmModal("Join group",
      t("{actor} invited you to join the group \"{group}\".", { actor: label.actor, group: label.group }), t("Join group"), false);
  } else if (label?.kind === "channel") {
    ok = await confirmModal("Subscribe to channel",
      t("Subscribe to the channel \"{group}\"?", { group: label.group }), t("Subscribe"), false);
  } else if (label?.kind === "person") {
    ok = await confirmModal("Start chat",
      t("Start a chat with {name}?", { name: label.addr ? `${label.actor} (${label.addr})` : label.actor }), t("Start chat"), false);
  } else {
    ok = await confirmModal("Join chat", t("Open this invite and start the SecureJoin handshake?"), t("Join"), false);
  }
  if (!ok || !accountIsCurrent(epoch)) return;
  const { update, close } = showProgressModal(t("Joining chat"), t("Starting SecureJoin handshake…"));
  try {
    // Mirror links (i.gluek.info & friends) are normalized onto the canonical
    // i.delta.chat form — the core only parses that scheme, and the payload
    // lives in the URL fragment, so the host is irrelevant to the join.
    const chatId = await core.secureJoin(parsed ? parsed.link : link);
    if (!accountIsCurrent(epoch)) return;
    update(t("Opening chat…"));
    await refreshChatList();
    if (!accountIsCurrent(epoch)) return;
    openChat(chatId);
    update(t("Joined successfully"));
    setTimeout(close, 700);
  } catch (err) {
    close();
    errToast(t("Join failed: ") + err.message, 4500);
  }
}

function joinFlow() {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:4px">${t("Paste an invite link (<code>https://i.delta.chat/#…</code>, a mirror domain, or a short link like <code>deltachat.id/&lt;name&gt;</code>) — works for both 1:1 contacts and group chats.")}</p>
    <input class="text-field" placeholder="https://i.delta.chat/#DD1F…" id="join-input" required inputmode="url" autocapitalize="none" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(t("Invite link"))}">`;
  const { foot, cancel, ok } = footButtons("Join", { okType: "submit" });
  const { close, form } = showModal({ title: "Join chat via invite link", body, foot, form: true });
  cancel.addEventListener("click", close);
  form.addEventListener("submit", () => {
    const v = body.querySelector("#join-input").value.trim();
    if (!parseInviteLink(v) && !isShortInviteLink(v)) {
      toast(t("That doesn't look like an invite link (e.g. https://i.delta.chat/#… or OPENPGP4FPR:…)")); return;
    }
    close();
    joinFromInvite(v);
  });
}

/* ---------------- onboarding (real core only) ---------------- */
// Shared by the welcome splash and Profile management → Import backup.
// Android content URIs are copied to a real path; a gzip PWA download is
// unpacked by the shell. Null when the picker is cancelled.
async function pickBackupTar(invoke) {
  let picked = await invoke("plugin:dialog|open", { options: {
    multiple: false,
    filters: [{ name: t("Velta backup"), extensions: ["tar", "gz"] }],
  }});
  if (Array.isArray(picked)) picked = picked[0];
  if (!picked) return null;
  if (/^content:\/\//.test(picked)) {
    picked = await invoke("resolve_content_uri", { uri: picked, filename: `backup-${Date.now()}.tar` });
  }
  // PWA exports arrive gzip-compressed; the shell sniffs the magic and
  // hands back a decompressed temp path the core can import.
  try { picked = await invoke("prep_backup", { path: picked }); } catch {}
  return picked;
}


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
// account is unconfigured (first boot): large Velta logo,
// tagline, the three setup paths (create an account / add as a second device /
// restore from a backup), a version line (#127) pinned just above the
// collapsed app-log footer for errors and debug messages.
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
      <img class="splash-logo" src="./icons/v-logo.svg" alt="${escapeHtml(t("Velta logo"))}">
      <h1 class="splash-title">${escapeHtml(t("Welcome to Velta"))}</h1>
      <p class="splash-tag">${escapeHtml(t("End-to-end encrypted messaging built on Delta Chat — no phone number, no central server. Pick how to set up your profile:"))}</p>
      <div class="splash-actions" data-actions>
        <button class="btn-primary splash-btn" data-create type="button">${escapeHtml(t("Create an account"))}</button>
        <button class="btn-text splash-btn" data-second type="button">${escapeHtml(t("Add as a second device…"))}</button>
        ${tauriInvoke() ? `<button class="btn-text splash-btn" data-restore type="button">${escapeHtml(t("Restore from a backup…"))}</button>` : ""}
        ${identityBackupAvailable() ? `<button class="btn-text splash-btn" data-identity-restore type="button">${escapeHtml(t("Restore an identity backup…"))}</button>` : ""}
        ${tauriInvoke() ? `<button class="btn-text splash-btn" data-local type="button">${escapeHtml(t("Enter local chat…"))}</button>` : ""}
        ${(!window.__TAURI__ && !window.VeltaBridge && (window.VELTA_PWA?.wasmCore || localStorage.getItem("velta-wasm") === "1")) ? `<button class="btn-text splash-btn" data-ws-relays type="button">${escapeHtml(t("WebSocket relays"))}</button>` : ""}
      </div>
      <form class="splash-form" data-form hidden>
        <p class="splash-hint">${t("Enter a <b>chatmail</b> relay address — an instant end-to-end encrypted profile will be created for you. No email or password needed.")}</p>
        <input class="text-field" data-relay required placeholder="${escapeHtml(t("Relay address — e.g. nine.testrun.org"))}" autocomplete="off" inputmode="url" autocapitalize="none" spellcheck="false">
        ${navigator.mediaDevices?.getUserMedia ? `<div style="margin-top:10px"><button class="btn-text" data-scan type="button">${escapeHtml(t("Scan a QR code"))}</button></div>` : ""}
        <div style="margin-top:12px"><button class="btn-primary splash-btn" data-ok type="submit">${escapeHtml(t("Create account"))}</button></div>
        ${core?.initTransports ? `<div style="margin-top:4px"><button class="btn-text" data-auto type="button">${escapeHtml(t("Autopick the fastest relay"))}</button></div>` : ""}
      </form>
      <ul class="ob-steps" data-steps></ul>
    </div>
    <p class="splash-ver" data-splash-ver>…</p>
    <details class="splash-log">
      <summary>${escapeHtml(t("App log — errors & debug"))}</summary>
      <div class="splash-log-bar"><button class="btn-text" data-copylog type="button">${escapeHtml(t("Copy log"))}</button></div>
      <pre data-logpre></pre>
    </details>`;
  document.body.appendChild(el);
  fillSplashVersion(el);

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

  const { addStep, finishSteps } = stepList(stepsEl);

  const showActions = () => {
    epoch = core?.accountEpoch;
    actionsEl.hidden = false;
    formEl.hidden = true;
    stepsEl.replaceChildren();
  };

  // Loading state until boot knows the account: actions stay hidden and the
  // log footer is the only visible activity.
  actionsEl.hidden = true;
  addStep(t("Connecting to the encryption core…"));

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
      hint: t("Point the camera at the relay's QR code — or paste the code below."),
      validate: c => normalizeRelayLink(c) || parseRelayInvite(c) ? null : t("That QR code is not a relay invite"),
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
  el.querySelector("[data-local]")?.addEventListener("click", async () => {
    if (!accountIsCurrent(epoch)) return;
    actionsEl.hidden = true;
    stepsEl.replaceChildren();
    addStep(t("Starting local chat…"));
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
  el.querySelector("[data-restore]")?.addEventListener("click", async () => {
    if (!core.importBackup) { toast(t("Restore is not available on this backend")); return; }
    const invoke = tauriInvoke();
    if (!invoke) { toast(t("Restore from a backup file needs the Velta app — use \"Add as a second device\" instead")); return; }
    let picked;
    try { picked = await pickBackupTar(invoke); }
    catch (err) { errToast(t("Couldn't read the backup file: ") + (err?.message || err)); return; }
    if (!picked || !accountIsCurrent(epoch)) return;

    actionsEl.hidden = true;
    stepsEl.replaceChildren();
    const prog = addStep(t("Restoring profile…")).querySelector("span:last-child");
    let seenProgress = false;
    const onProg = (e) => {
      const p = e.detail?.progress || 0;
      if (p >= 1000) {
        finishSteps(true);
        addStep(t("Profile restored — restarting"));
        core.removeEventListener("imex-progress", onProg);
        localStorage.setItem("velta-ask-notifications", "1");
        setTimeout(() => location.reload(), 800);
      } else if (p > 0) {
        seenProgress = true;
        prog.textContent = t("Restoring profile… {n}%", { n: Math.round(p / 10) });
      } else if (seenProgress) {
        finishSteps(false);
        addStep(t("Restore failed"));
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
      addStep(t("Restore failed: couldn't import the backup"));
      core.removeEventListener("imex-progress", onProg);
      showActions();
    });
  });

  // Shared scaffolding for both create paths (named relay / auto-discovery):
  // trigger+input disabling, the intro step, ConfigureProgress phase lines
  // (0..1000), success (notification ask + nickname ask + splash teardown +
  // toast) and failure (Retry) handling. `run()` performs the configure and
  // returns the fresh account; `hostOf` names the relay in the success toast.
  const hostOf = (a) => (a?.addr || "").split("@")[1] || a?.relay || t("your new relay");
  // Issue #6: right after the account exists, politely offer a nickname —
  // once, skippable, never holding onboarding hostage.
  const askNickname = () => new Promise((resolve) => {
    const input = document.createElement("input");
    input.className = "text-field"; input.maxLength = 64;
    input.placeholder = t("How should we call you?");
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
    skip.className = "btn-text"; skip.textContent = t("Skip");
    skip.addEventListener("click", () => settle(false));
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "btn-text btn-primary"; save.textContent = t("Save name");
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
    trigger.disabled = true; trigger.classList.add("btn-loading"); trigger.textContent = t("Creating…");
    input.disabled = true;
    stepsEl.replaceChildren();
    addStep(intro);
    const stopPhases = trackPhases(phases, addStep);
    try {
      const account = await run();
      if (!accountIsCurrent(epoch)) return;
      addStep(t("Account created — welcome!"));
      finishSteps(true);
      if (!accountIsCurrent(epoch)) return;
      state.account = account;
      await askNotificationPermission();
      await askNickname();
      setTimeout(() => {
        if (!accountIsCurrent(epoch)) return;
        finishOk();
        toast(t("Account created on {host}", { host: hostOf(account) }), 3000);
      }, 900);
    } catch (err) {
      if (!accountIsCurrent(epoch)) return;
      finishSteps(false);
      addStep(t("Setup failed: ") + (err.message || err));
      trigger.disabled = false; trigger.classList.remove("btn-loading"); trigger.textContent = t("Retry");
      input.disabled = false;
    } finally {
      stopPhases();
    }
  };

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!accountIsCurrent(epoch)) return;
    const raw = input.value;
    const invite = parseRelayInvite(raw);
    const link = invite ? null : normalizeRelayLink(raw);
    if (!link && !invite) { toast(raw.trim() ? t("That doesn't look like a relay or invite address") : t("Enter a relay address")); return; }
    if (invite) {
      if (activeWsRelay() !== invite.host) sessionStorage.setItem("velta-pending-invite", JSON.stringify(invite));
      if (!(await ensureMailTunnelForLink(`dcaccount:https://${invite.host}/new`))) return;
      sessionStorage.removeItem("velta-pending-invite");
      await runCreate({
        trigger: ok,
        intro: t("Claiming your invite on {host}", { host: invite.host }),
        phases: [
          [1,   t("Invite accepted at {host}", { host: invite.host })],
          [200, t("Setting up your profile")],
          [750, t("Finalizing account")],
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
      intro: t("Attempting to connect to relay at {host}", { host }),
      phases: [
        [1,   t("Relay found at {host}", { host })],
        [200, t("Requesting new account credentials")],
        [450, t("Generating encryption keys")],
        [750, t("Finalizing account")],
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
    // The core probes its relay pool through the one tunnel set at boot.
    // example.com is the canary: a locked tunnel resolves only itself.
    if (window.VELTA_PWA?.wasmCore) {
      const via = activeWsRelay();
      if (!via || !(await probeDnsVia(via, "example.com"))) {
        errToast(via
          ? t("{via} can't reach other relays from this browser yet.", { via })
          : t("Add a WebSocket relay before autopick can run in the browser."), 7000);
        return;
      }
    }
    await runCreate({
      trigger: el.querySelector("[data-auto]"),
      intro: t("Looking for a fast relay…"),
      phases: [
        [1,   t("Found a relay that answers fast")],
        [200, t("Requesting new account credentials")],
        [450, t("Generating encryption keys")],
        [750, t("Finalizing account")],
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
    logSummary.textContent = t("App log ({n}) — errors & debug", { n: diagnostics.messages.length });
    logPre.scrollTop = logPre.scrollHeight;
  };
  diagnostics.addEventListener("changed", renderLog);
  renderLog();
  el.querySelector(".splash-log").addEventListener("toggle", (e) => {
    if (e.target.open) renderLog();
  });
  el.querySelector("[data-copylog]").addEventListener("click", () => {
    navigator.clipboard?.writeText(logPre.textContent)
      .then(() => toast(t("Log copied")))
      .catch(() => toast(t("Couldn't copy the log")));
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
// Capability flags for the relays modal (VENDORISSUES #15): C = calls (the
// relay hands out TURN credentials), I = iroh relay, P = push (metadata,
// falling back to the #110 diagnostic cache on cores without the RPC),
// D = instant delivery (IMAP IDLE, core patch #16), W = web/C3 endpoints
// (probed). Silver = not offered / not known yet,
// green = the relay advertised it. The letters' titles carry the words.
const relayFlagsHtml = (addr, meta) => {
  // on: true / false / null (null = not known yet even with metadata —
  // IMAP capabilities are only known after the relay's first connection).
  const flag = (letter, key, on, label = t(key)) =>
    `<span class="relay-flag${on ? " on" : ""}" title="${escapeAttr(label + (on ? "" : meta && on !== null ? " — " + t("not offered by this relay") : " — " + t("not known yet")))}" aria-label="${escapeAttr(label)}" role="img">${letter}</span>`;
  return [
    flag("C", "Calls: the relay hands out TURN credentials", !!meta?.hasTurn),
    flag("I", "iroh relay: helps Beam and peer-to-peer transfers", !!meta?.irohRelay),
    flag("P", "Push notifications: the relay accepts device tokens", !!meta?.supportsPush || relaySupportsPush(addr)),
    // D (core patch #16, IMAP IDLE): new mail arrives instantly instead of
    // on a polling interval. Older cores / the wasm core without the field
    // leave it "not known yet".
    flag("D", "Instant delivery: the relay pushes new mail to the app as it arrives (IMAP IDLE)", typeof meta?.canIdle === "boolean" ? meta.canIdle : null),
    `<span class="relay-flag" data-flag-w title="${escapeHtml(t("Web app endpoints (C3): this relay offers the WebSocket mail tunnel the browser app uses"))}" aria-label="${escapeHtml(t("Web app endpoints (C3): this relay offers the WebSocket mail tunnel the browser app uses"))}" role="img">W</span>`,
  ].join("");
};

// Details under a relay's address, from data the client already reads (no
// core patch): IMAP METADATA /shared/admin and /shared/comment (via
// get_server_metadata) and the quota the core renders in its connectivity
// page (quota-list, parsed per transport by parseConnectivityHtml). Quota
// shows only when the relay reports it; the bar is the highest resource %.
// Plain escaped text, never links: these strings come from the relay.
const relayDetailsHtml = (meta, quotaText) => {
  const lines = [];
  const comment = String(meta?.comment || "").trim();
  const admin = String(meta?.admin || "").trim();
  if (comment) lines.push(`<div class="relay-meta">${escapeHtml(comment)}</div>`);
  if (admin) lines.push(`<div class="relay-meta">${escapeHtml(t("Admin: {admin}", { admin }))}</div>`);
  // Core patch #16: recipient limit (maxsmtprecipients) and IMAP compression,
  // shown only when the core reports them.
  const facts = [];
  const rcpt = Number(meta?.maxSmtpRcptTo);
  if (Number.isInteger(rcpt) && rcpt > 0) facts.push(t("Up to {rcpt} recipients per message", { rcpt }));
  if (meta?.canCompress === true) facts.push(t("compressed connection"));
  if (facts.length) lines.push(`<div class="relay-meta">${escapeHtml(facts.join(" · "))}</div>`);
  const q = String(quotaText || "").trim();
  if (q) {
    const pcts = [...q.matchAll(/(\d{1,3})\s*%/g)].map(m => Math.min(100, Number(m[1])));
    const label = q.replace(/\s*\d{1,3}\s*%/g, "").trim();
    const pct = pcts.length ? Math.max(...pcts) : null;
    lines.push(`<div class="relay-meta relay-quota">${pct === null ? "" : `<span class="relay-quota-bar" role="img" aria-label="${escapeAttr(t("Storage {n}% used", { n: pct }))}"><span style="width:${pct}%"${pct >= 80 ? ' class="high"' : ""}></span></span>`}<span>${escapeHtml(label)}${pct === null ? "" : ` (${pct}%)`}</span></div>`);
  }
  return lines.join("");
};

// One C3 probe per relay domain per app session (the flag cache).
const relayC3Flags = new Map();

async function openRelaysModal() {
  if (state.accountChanging) return;
  if (!core.listTransports) {
    toast(t("Relay management is not available on this backend"));
    return;
  }
  const epoch = core.accountEpoch;
  const body = document.createElement("div");
  body.innerHTML = `
    <div data-list><div class="p2p-hint" style="opacity:.6">${escapeHtml(t("Loading…"))}</div></div>
    <div style="margin-top:10px"><button type="button" class="btn-text" data-add>${escapeHtml(t("Add relay…"))}</button></div>
    <div class="relay-legend" aria-hidden="true"><span class="relay-pair"><span class="relay-flag">C</span><span>${escapeHtml(t("calls (TURN)"))}</span></span><span class="relay-pair"><span class="relay-flag">I</span><span>${escapeHtml(t("iroh transfers"))}</span></span><span class="relay-pair"><span class="relay-flag">P</span><span>${escapeHtml(t("push notifications"))}</span></span><span class="relay-pair"><span class="relay-flag">D</span><span>${escapeHtml(t("instant delivery"))}</span></span><span class="relay-pair"><span class="relay-flag">W</span><span>${escapeHtml(t("web endpoints"))}</span></span><span class="relay-pair"><span class="relay-dot"></span><span>${escapeHtml(t("offered by the relay"))}</span></span></div>`;
  showModal({ title: "Relays", body });
  const listEl = body.querySelector("[data-list]");

  const refresh = async () => {
    let transports;
    try {
      transports = await core.listTransports();
    } catch (err) {
      if (accountIsCurrent(epoch)) {
        listEl.innerHTML = `<div class="p2p-hint" style="color:var(--danger)">${escapeHtml(t("Failed to load relays:"))} ${escapeHtml(String(err?.message || err))}</div>`;
      }
      return;
    }
    if (!accountIsCurrent(epoch)) return;
    // Per-relay live status for the stale-transport hint (issue #11 slice 3):
    // parseConnectivityHtml gives one state per relay domain — best effort,
    // the modal stays useful without it. smtpVia rides along: the transport
    // the SMTP loop is actually bound to (failover hint below).
    let statusByDomain = null;
    let smtpVia = null;
    try {
      if (core.getConnectivityHtml) {
        const parsed = parseConnectivityHtml(await core.getConnectivityHtml());
        statusByDomain = new Map(parsed.segs.map(s => [s.domain, s]));
        smtpVia = parsed.smtpVia;
      }
    } catch { /* best effort */ }
    if (!accountIsCurrent(epoch)) return;
    // Per-relay capabilities (VENDORISSUES #15): calls/TURN, iroh, push —
    // as the relays themselves advertise over IMAP METADATA. Old cores lack
    // the RPC; the flags then stay silver ("not known yet").
    let metaByAddr = null;
    try { metaByAddr = (await core.getServerMetadata?.()) || null; } catch { /* old core */ }
    if (!accountIsCurrent(epoch)) return;
    listEl.replaceChildren();
    if (!transports.length) {
      const empty = document.createElement("div");
      empty.className = "p2p-hint"; empty.style.opacity = ".6";
      empty.textContent = t("No relays configured.");
      listEl.appendChild(empty);
    }
    for (const tr of transports) {
      const row = document.createElement("div");
      const primary = state.account && tr.addr === state.account.addr;
      const other = transports.find(x => x.addr !== tr.addr);
      const st = statusByDomain?.get((tr.addr || "").split("@").pop());
      const hint = !st || st.state === "ok" ? "" : ` <span class="relay-row-status">${escapeHtml(st.state === "down" ? t("unreachable — messages queue until it's back") : t("connecting…"))}</span>`;
      const demote = primary && other ? `<button type="button" class="btn-text" data-demote>${escapeHtml(t("Stop using for sending"))}</button>` : "";
      // Failover (core patch smtp-via): smtpVia is the transport the SMTP
      // loop is ACTUALLY bound to. When it is not the pinned one, the pin's
      // relay failed a send and the core switched away — say so on both
      // rows instead of silently showing the stale pin.
      const domainOf = (a) => String(a || "").split("@")[1]?.toLowerCase() || null;
      const viaDomain = domainOf(smtpVia);
      const pinnedDomain = domainOf(state.account?.addr);
      const isVia = !!viaDomain && domainOf(tr.addr) === viaDomain;
      const failedOver = !!viaDomain && viaDomain !== pinnedDomain;
      const sendMark = primary
        ? ` <span class="relay-sending">${escapeHtml(t("· sending"))}${failedOver ? " — " + escapeHtml(t("send failed, switched to {relay} for now", { relay: smtpVia })) : ""}</span>`
        : isVia && failedOver
          ? ` <span class="relay-sending">${escapeHtml(t("· sending (failover)"))}</span>`
          : "";
      row.className = "relay-card";
      row.innerHTML = `
        <div class="relay-line">
          <span class="relay-addr">${escapeHtml(tr.addr)}${sendMark}${hint}</span>
          <span class="relay-flags">${relayFlagsHtml(tr.addr, metaByAddr?.[tr.addr] || null)}</span>
        </div>
        ${relayDetailsHtml(metaByAddr?.[tr.addr] || null, st?.quota)}
        <div class="relay-actions">${primary ? demote : `<button type="button" class="btn-text" data-sendvia>${escapeHtml(t("Use for sending"))}</button>`}<button type="button" class="btn-text" data-remove style="color:var(--danger)">${escapeHtml(t("Remove"))}</button></div>`;
      // W flag: probe the relay's C3 endpoints (probeC3Relay). In the Tauri
      // shells the probe runs in Rust without a browser Origin (relays gate
      // browser origins); in the PWA it is the browser's own WebSocket, i.e.
      // "capable from this origin". Silver until the relay answers; one
      // probe per relay per app session.
      const wEl = row.querySelector("[data-flag-w]");
      const wDomain = (tr.addr || "").split("@").pop();
      if (wEl && wDomain) {
        const cached = relayC3Flags.get(wDomain);
        const probe = cached || probeC3Relay(wDomain).catch(() => false);
        relayC3Flags.set(wDomain, probe);
        probe.then(ok => {
          if (ok && wEl.isConnected && accountIsCurrent(epoch)) wEl.classList.add("on");
        });
      }
      row.querySelector("[data-sendvia]")?.addEventListener("click", async () => {
        const ok = await confirmModal(
          t("Send via {addr}?", { addr: tr.addr }),
          t("New messages go out through this relay first and carry its address. If it is unreachable, Velta falls back to your other relays and retries this one every few minutes. This choice applies to this device."),
          t("Use for sending"));
        if (!ok || !accountIsCurrent(epoch)) return;
        try {
          await core.setSendRelay(tr.addr);
          toast(t("Sending via {addr}", { addr: tr.addr }));
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
          t("Stop using {addr} for sending?", { addr: tr.addr }),
          t("Sending moves to {addr}: new messages go out through it first and carry its address. This choice applies to this device.", { addr: other.addr }),
          t("Stop using for sending"));
        if (!ok || !accountIsCurrent(epoch)) return;
        try {
          await core.setSendRelay(other.addr);
          toast(t("Sending via {addr}", { addr: other.addr }));
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
          t("Remove {addr}?", { addr: tr.addr }),
          t("The relay stops being used right away and your contacts are informed automatically, but messages still on their way to the old address may arrive for a short while. Your last relay cannot be removed."),
          t("Remove"));
        if (!ok || !accountIsCurrent(epoch)) return;
        try {
          await core.deleteTransport(tr.addr);
          toast(t("Relay removed"));
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
    toast(t("No background service available — install the Velta Core service app to add relays"), 5000);
    return;
  }
  // presetCode comes from a deeplink (already dcaccount:-prefixed by
  // extractInviteLink); without one, ask for a pasted/scanned code.
  const code = presetCode ?? await acquireCode({
    title: "Add relay",
    hint: t("Paste the relay's invite code (dcaccount:… or dclogin:…), just its domain (nine.testrun.org), or scan its QR. It becomes a second transport for this profile; messages are received on both relays."),
    validate: c => (/^(dcaccount:|dclogin:)/i.test(c.trim()) || normalizeRelayLink(c) ? null : t("That doesn't look like a relay address or invite code")),
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
  const { addStep, finishSteps } = stepList(stepsEl);

  addStep(t("Checking the code…"));
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
      [1,   t("Connecting to the relay")],
      [400, t("Adding relay to this profile")],
      [750, t("Finalizing")],
    ];
    const stopPhases = trackPhases(phases, addStep);
    try {
      await core.addTransportFromQr(qr);
      if (!accountIsCurrent(epoch)) return;
      finishSteps(true);
      addStep(t("Relay added — messages are received on both relays"));
      toast(t("Relay added"));
      refresh?.();
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
      stopPhases();
    }
  } catch (err) {
    if (!accountIsCurrent(epoch)) return;
    finishSteps(false);
    addStep(t("Adding relay failed: ") + (err?.message || err));
  }
}

// Step list (ul.ob-steps) shared by onboarding, add-relay and receive-profile:
// addStep marks the previous active line done and appends a new active one;
// finishSteps settles the active line as done or failed.
function stepList(stepsEl) {
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
  return { addStep, finishSteps };
}

// Friendly phase lines driven by the core's ConfigureProgress (0..1000):
// phases is [[threshold, text], ...] in ascending order. Returns the detach
// function (call it in a finally).
function trackPhases(phases, addStep) {
  let phaseIdx = 0;
  const onProg = (e) => {
    const p = e.detail?.progress || 0;
    while (phaseIdx < phases.length && p >= phases[phaseIdx][0]) {
      addStep(phases[phaseIdx][1]);
      phaseIdx++;
    }
  };
  core.addEventListener("configure-progress", onProg);
  return () => core.removeEventListener("configure-progress", onProg);
}

// Receive a profile on this device from another device's DCBACKUP<n>: code
// (scanned or pasted). Used by the second-device modal and by onboarding.
// Resolves true once the fresh account was created and selected; the transfer
// itself runs fire-and-forget and reports via ImexProgress.
async function receiveSecondDeviceProfile(epoch, onStart, presetCode) {
  if (!core.addAccountWithBackup) {
    toast(t("Second-device setup is not available on this backend"));
    return false;
  }
  const code = presetCode?.trim() || await acquireCode({
    title: "Receive a profile",
    hint: t("Scan or paste the code shown on the other device (DCBACKUP2:…). A copy of that profile is created here; the other device stays signed in."),
    // Core backup QRs are "DCBACKUP" + version digits + ":" (qr.rs:455) —
    // e.g. DCBACKUP2:<token>&<addr>. Don't require a bare "dcbackup:".
    validate: c => (/^dcbackup\d*:/i.test(c.trim()) ? null : t("That doesn't look like a second-device code")),
  });
  if (!code || !accountIsCurrent(epoch)) return false;
  onStart?.();

  const stepsBody = document.createElement("div");
  stepsBody.innerHTML = `<ul class="ob-steps" data-steps></ul>`;
  showModal({ title: "Receiving profile", body: stepsBody });
  const stepsEl = stepsBody.querySelector("[data-steps]");
  const { addStep, finishSteps } = stepList(stepsEl);

  addStep(t("Preparing this device…"));
  let seenProgress = false;
  const progHandler = (e) => {
    const p = e.detail?.progress || 0;
    if (p >= 1000) {
      finishSteps(true);
      addStep(t("Profile received — signing in"));
      toast(t("Profile received"));
      core.removeEventListener("imex-progress", progHandler);
    } else if (p > 0) {
      seenProgress = true;
      addStep(t("Receiving profile… {n}%", { n: Math.round(p / 10) }));
    } else if (seenProgress) {
      finishSteps(false);
      addStep(t("Transfer failed"));
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
    addStep(t("Transfer failed: ") + (err?.message || err));
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
async function startCallIfMicOk(chat, { video = false } = {}) {
  try {
    if (navigator.permissions?.query) {
      const st = await navigator.permissions.query({ name: "microphone" });
      if (st?.state === "denied") {
        await confirmModal("Microphone blocked", t("Velta can't place calls because microphone access is denied. Enable it in system settings (Windows: Settings → Privacy → Microphone; macOS: System Settings → Privacy → Microphone; Android: App settings → Permissions), then call again."));
        return;
      }
    }
  } catch { /* permissions API or name unsupported — let getUserMedia decide */ }
  // A blocked camera does not stop a video call: it starts audio-only and
  // the camera button stays available (calls.js toasts the failure).
  calls?.startOutgoing(chat.id, chat.name, { video });
}

// Call screen identity: the chat's name, the contact's address, photo and
// profile color (the same color the avatar tiles use).
async function callPeerInfo(chatId) {
  const chat = await core.getChat(chatId).catch(() => null);
  let contact = null;
  if (chat?.contactId) contact = await core.getContact?.(chat.contactId).catch(() => null);
  const photo = chat?.avatar || contact?.avatar || "";
  return {
    name: chat?.name || contact?.name || "",
    addr: contact?.addr || "",
    color: chat?.avatarColor || contact?.color || "",
    avatarUrl: photo ? fileUrl(photo) : "",
  };
}

async function boot() {
  try {
    // Calls first: the incoming-call listener must exist as early as the
    // event stream is available, or a call arriving during boot is missed.
    calls = initCalls(core, { notify: (msg) => toast(msg, 4500), peerInfo: callPeerInfo });
    initWebxdc(core);
    // Group calls: in-call bar + "open the call" from it (group-call-ui.js).
    initGroupCallUi({ open: (msgId) => openWebxdc(msgId, "Velta Circle") });
    window.addEventListener("velta-open-chat", (e) => { if (e.detail?.chatId) openChat(e.detail.chatId); });
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

    // Web Push (PWA): the core keeps the device token in memory only, so
    // hand it over again on every boot (docs/agents/web-push.md).
    if (core.backend?.kind === "worker-wasm") {
      refreshWebPush(core, { log: (lvl, m) => diagnostics.append(lvl, m) }).catch(() => {});
    }

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
      appLog(`media base: ${redactMediaUrl(window.veltaMediaBase)}`);
    } catch (e) {
      appLog(`media base unavailable: ${e?.message || e}`);
    }

    // Drawer + menu first: the profile/account recovery paths must stay
    // usable even when a later boot stage fails. uiLive marks the point
    // after which a boot failure keeps the (partially working) UI instead
    // of falling back to the splash.
    // Link previews (shell-side fetch) use the active account's proxy: the
    // user's own or the DNS tunnel's (tunnel.rs writes it into proxy_url).
    // A failed read throws, and link-preview.js then skips the fetch.
    setLinkPreviewProxySource(async () => {
      if (!core) throw new Error("core not ready");
      if (!core.getConfig) return null; // demo core: no proxy, no shell fetch
      const [enabled, url] = await Promise.all([core.getConfig("proxy_enabled"), core.getConfig("proxy_url")]);
      return activeProxyUrl(enabled, url);
    });
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

    try { startScheduled(); } catch (err) {
      diagnostics.append("error", `boot: scheduled messages failed: ${err?.message || err}`);
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
        open: ICON.close,
        closed: ICON.menu,
      };
      document.addEventListener("velta-drawer", e => {
        const btn = document.getElementById("bar-menu");
        if (!btn) return;
        btn.innerHTML = e.detail.open ? BAR_MENU_ICONS.open : BAR_MENU_ICONS.closed;
        btn.title = e.detail.open ? t("Close menu") : t("Menu");
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
      // Velta invite cards (proxy / relay / combined / tunnel): every action
      // is a tap, and each goes through its usual confirmation.
      bindInviteCards({
        useProxy: link => acceptWsLink(link, { confirmModal, toast, errToast, onChange: rebuildDrawer }),
        saveProxy: link => saveWsLink(link, { toast, errToast, onChange: rebuildDrawer }),
        createAccount: inv => confirmRelayInvite(inv),
        join: async ({ proxy, relay }) => {
          if (state.accountChanging) return;
          if (!(await joinWithWsLink(proxy, relay.host, { confirmModal, toast, errToast, onChange: rebuildDrawer }))) return;
          await createAccountFromRelayInvite(normalizeHost(relay.host), relay.token);
        },
        tunnel: link => acceptTunnelLink(link, { confirmModal, choose: makeChooser(showModal), toast, errToast, onChange: rebuildDrawer }),
        copy: async text => { try { await copyLink(text, { clipboard: navigator.clipboard }); toast(t("Link copied")); } catch { errToast(t("Couldn't copy the link")); } },
      });

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
      if (!incrementalChatList()) scheduleChatListRefresh(); // coalesced (one trailing refresh)
      const msg = ev?.detail?.msg;
      // Toasts are throttled to one per 4 s: skip the per-message work
      // outright while throttled, otherwise group the burst per chat.
      if (notifyThrottled()) return;
      queueIncomingNotify(msg);
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
      toast(t("Lost connection to local Delta Chat core — reconnecting…"), 4500);
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
        toast(t("Reconnected to Delta Chat core"), 2500);
      })();
    });

    // DNS tunnel row on Android and Windows, before a tunnel is saved.
    refreshTunnelStatus().then(s => { if (tunnelOffered(s)) rebuildDrawer(); });
    refreshWsTransportStatus().then(s => { if (s) rebuildDrawer(); });
    bindTunnelNetworkEvents();
    // Route switches, proxy changes and tunnel errors go to Velta Diagnostics.
    initTunnelDiagnostics({ append: (level, text) => diagnostics.append(level, text) });

    appLog("boot: handleDeeplink");
    // Before any chat link is routed: a cold-start notification is parked in
    // the opened-url queue and would otherwise be accepted with no token yet.
    try {
      const token = await tauriInvoke()?.("chat_link_token");
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
      toast(t("Velta can be installed — use your browser's install option"), 4000);
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { chatView?.exitSelection(); closeAllPopups(); }
    });
    appLog("boot: done");
  } catch (err) {
    appLog(`boot FAILED: ${err?.message || err}\n${err?.stack || ""}`);
    errToast(t("Startup error: {why}", { why: err?.message || err }), 8000);
    // No usable UI yet → the splash is the error surface (it shows this log).
    if (!uiLive && !splashSession) splashSession = showSplash();
    throw err;
  }
}

// ---- Scheduled messages ("Send later", docs/scheduled-messages.md) ----
// Tauri: scheduled.json in app private data (scheduled.rs); Android sends
// from the shell (alarm-safe, no WebView needed), desktop sends from here.
// PWA/browser: localStorage, sends only while a tab is open.
let scheduledRunner = null;
const schedBrowserOnly = () => !tauriInvoke();

function scheduledChatName(it) {
  if (it.accountId === core?.accountId) {
    const c = state.chats.find(x => x.id === it.chatId);
    if (c) return c.name;
  }
  const acc = (state.accounts || []).find(a => a.id === it.accountId);
  return `${acc?.displayName || acc?.addr || t("Profile")} · #${it.chatId}`;
}

function startScheduled() {
  if (scheduledRunner) return;
  const invoke = tauriInvoke();
  const android = !!invoke && isAndroid();
  scheduledRunner = new ScheduledRunner({
    store: invoke ? tauriStore(invoke) : localStore(),
    // The normal send path (rpc-core sendMessage → send_msg) for the
    // profile the message was written in.
    send: android ? null : it => core.sendMessage(it.chatId, { text: it.text, quoteId: it.quoteId, accountId: it.accountId }),
    nativeRun: android ? wake => invoke("scheduled_run_due", { wake }) : null,
    onChange: () => chatView?.renderScheduledChip(),
    onSent: (it, msg) => {
      if (msg && it.accountId === core.accountId && chatView?.chat?.id === it.chatId) chatView.appendOutgoing(msg);
      if (it.accountId === core.accountId) refreshChatList().catch(() => {});
    },
  });
  if (chatView) {
    chatView.scheduled = {
      count: chatId => scheduledRunner.doc.items.filter(x => x.accountId === core.accountId && x.chatId === chatId).length,
      pickTime: () => pickSendTime({ browserOnly: schedBrowserOnly() }),
      openList: chatId => openScheduledList({ runner: scheduledRunner, accountId: core.accountId, chatId, browserOnly: schedBrowserOnly() }),
      add: async ({ chatId, text, quoteId, dueAt }) => {
        try {
          const r = await scheduledRunner.op({ op: "add", item: { accountId: core.accountId, chatId, text, quoteId, dueAt } });
          if (!r?.id) throw new Error(r?.error || "rejected");
          toast(t("Scheduled for {time}", { time: formatDue(dueAt) }));
          if (android) maybeAskExactAlarm(invoke).catch(() => {});
          return true;
        } catch (err) {
          errToast(t("Couldn't schedule message: {error}", { error: err?.message || err }));
          return false;
        }
      },
    };
  }
  // Catch-up: at start, on resume (visibility / Android foreground), plus
  // the runner's own timer to the next due item and a 60 s safety tick
  // (timers stall while the device sleeps).
  scheduledRunner.start().catch(err => appLog(`scheduled: start failed: ${err?.message || err}`));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduledRunner.run(true); });
  try {
    window.__TAURI__?.event?.listen?.("velta-foreground", () => scheduledRunner.run(true));
    window.__TAURI__?.event?.listen?.("velta-scheduled-changed", () => scheduledRunner.refresh().catch(() => {}));
  } catch { /* no shell */ }
}

function openAllScheduled() {
  if (!scheduledRunner) return;
  openScheduledList({ runner: scheduledRunner, accountId: null, chatName: scheduledChatName, browserOnly: schedBrowserOnly() });
}

globalThis.__veltaAppEvaluating = false;
if (chatListRenderDeferred) { chatListRenderDeferred = false; renderChatList(); }
boot();

