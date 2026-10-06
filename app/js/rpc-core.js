// rpc-core.js — drop-in replacement for MockCore that talks to the real
// deltachat core over a pluggable JSON-RPC transport:
//   • Tauri IPC (inside the desktop/Android Tauri shell)
//   • WebSocket to a local background core (the service APK on 127.0.0.1:20808)
// Same interface + events as mock-core.js, so app.js doesn't care which one is active.
//
// Method names, parameter order and response shapes follow
// deltachat-jsonrpc/src/api.rs and api/types/*.

let nextId = 1;

// Which category chip a chat belongs to in the chat-list bar (#57). "all" is
// the bar's unfiltered state and is never returned here. Special and request
// chats are "system"; a 1:1 chat is "bots" when its contact is a bot,
// "people" otherwise (unknown contact counts as people — the safe default).
export function chatCategoryOf(chat, isBot = () => false) {
  if (chat.kind === "saved" || chat.kind === "device" || chat.kind === "deaddrop") return "system";
  if (chat.kind === "group") return "groups";
  if (chat.kind === "channel") return "channels";
  if (chat.kind === "single") return isBot(chat.contactId) ? "bots" : "people";
  return "system";
}

// #83: low-battery marker — pure decision for the auto 🪫 reaction. While
// the phone reports low + unplugged, the marker lives on the latest outgoing
// message (cleared from the previous one); when the state ends (charger,
// healthy battery, feature off) the marker is removed. add/clear are null
// when nothing needs to happen.
export function batteryReactionPlan(sentMsgId, prevReactedId, lowActive) {
  if (lowActive) {
    if (sentMsgId === prevReactedId) return { add: null, clear: null };
    return { add: sentMsgId, clear: prevReactedId || null };
  }
  if (prevReactedId) return { add: null, clear: prevReactedId };
  return { add: null, clear: null };
}

// Category swipe step for a touch drag (#57): +1 next chip, -1 previous,
// 0 not a swipe. Axis-locked — the drag must travel the threshold
// horizontally AND stay clearly horizontal, so vertical list scrolling and
// the pull-to-refresh zone never trigger it.
export function swipeCategoryStep(dx, dy, threshold = 48) {
  if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.4) return 0;
  return dx < 0 ? 1 : -1;
}

// Backstop for the event long-poll. The backend parks get_next_event until an
// event exists (no server-side timeout), so the ordinary 30 s RPC timeout must
// not apply — see _callEventPoll. Long enough that healthy polls rarely hit it
// (only truly quiet accounts), finite so a parked request can't outlive a
// dead connection indefinitely.
const EVENT_POLL_TIMEOUT_MS = 240_000;

import { debugLog } from "./diagnostics.js";
import { pageBounds } from "./format.js";

function rustLog(msg) {
  try {
    console.log("[velta]", msg);
  } catch {}
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) invoke("js_log", { msg }).catch(() => {});
  } catch {}
}

export class JsonRpcCore extends EventTarget {
  /**
   * transport: {
   *   name: string,                  // "tauri" | "websocket"
   *   send(line: string): void,      // deliver one JSON-RPC request line
   *   setReceiver(fn): Promise|void, // register handler for incoming lines
   * }
   */
  constructor(transport) {
    super();
    this.transport = transport;
    this.accountId = null;
    this.accountEpoch = 0;
    this._accountTransitionBusy = false;
    this.pending = new Map();     // rpc id -> {resolve, reject, onLate?}
    this.msgIdCache = new Map();  // chatId -> [msgIds ascending]
    this._sendingIds = new Set(); // msgIds handed to the core, not yet delivered/failed
    this._sendingBackstopTimer = null;
    // Latest known delivery state per outgoing msgId (MsgDelivered/MsgRead/
    // MsgFailed) — lets a just-inserted sent row reconcile past events.
    this._msgStateHints = new Map();
    this.eventPollTimeoutMs = EVENT_POLL_TIMEOUT_MS;
    this._eventPollMethod = "get_next_event_batch";
    // Emits chatlist-changed / chatlist-item-changed (see _handleCoreEvent):
    // app.js refreshes the chat list incrementally only for cores that do.
    this.chatlistEvents = true;
    this._eventChain = Promise.resolve(); // serializes core event handlers (arrival order)
    this._eventsQueued = 0;               // handlers queued or running on _eventChain
    this.eventHandlerStallMs = 2000;      // max time one slow handler holds the queue
    this.msgIdCache = new Map();  // chatId -> [msgIds ascending]
    this._onLine = this._onLine.bind(this);
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  _isCurrentAccount(epoch) {
    return epoch === this.accountEpoch && !this._accountTransitionBusy;
  }

  _emitAccount(name, detail, epoch) {
    if (this._isCurrentAccount(epoch)) this._emit(name, detail);
  }

  // Outgoing messages between send_msg and their MsgDelivered/MsgFailed event.
  // Drives the relay status line's sending dashes.
  _trackSending(msgId) {
    const wasEmpty = this._sendingIds.size === 0;
    this._sendingIds.add(msgId);
    this._emit("send-activity", { sending: true });
    if (wasEmpty) this._armSendingBackstop();
  }

  _untrackSending(msgId) {
    if (!this._sendingIds.delete(msgId)) return;
    if (this._sendingIds.size === 0) {
      clearTimeout(this._sendingBackstopTimer);
      this._emit("send-activity", { sending: false });
    } else {
      this._armSendingBackstop(); // keep covering the remaining ids
    }
  }

  // MsgDelivered/MsgFailed can be lost without the UI ever seeing them: the
  // Android background poller consumes events while the app is hidden
  // (AGENTS §9.2), a transport reconnect drops what was emitted mid-flight,
  // and a pending message deleted before delivery never delivers at all —
  // each left the sending dashes stuck on the relay status line. Two
  // defenses: reconcileSending() asks the core for the real state (wired to
  // visibility resume and reconnect in app.js), and a backstop force-clears
  // a set that stayed non-empty for `sendingBackstopMs` (instance knob for
  // tests; ceiling: a send legitimately pending longer loses its dashes).
  _armSendingBackstop() {
    clearTimeout(this._sendingBackstopTimer);
    this._sendingBackstopTimer = setTimeout(() => {
      if (!this._sendingIds.size) return;
      this._sendingIds.clear();
      this._emit("send-activity", { sending: false });
    }, this.sendingBackstopMs ?? 90000);
    this._sendingBackstopTimer?.unref?.();
  }

  async reconcileSending() {
    if (!this._sendingIds.size || this._accountTransitionBusy) return;
    const accountId = this.accountId;
    const accountEpoch = this.accountEpoch;
    for (const msgId of [...this._sendingIds]) {
      if (!this._isCurrentAccount(accountEpoch)) return;
      let state = null;
      try {
        state = this._mapState((await this._call("get_message", accountId, msgId))?.state);
      } catch { /* gone — deleted before delivery */ }
      if (state !== "pending") this._untrackSending(msgId);
    }
  }

  _beginAccountChange() {
    if (this._accountTransitionBusy) throw new Error("account transition already in progress");
    this._accountTransitionBusy = true;
    this.accountEpoch++;
    this.msgIdCache = new Map();
    this._msgStateHints.clear();
    this._callStateCache = new Map(); // call ids are per-account
    if (this._sendingIds.size) {
      this._sendingIds.clear();
      clearTimeout(this._sendingBackstopTimer);
      this._emit("send-activity", { sending: false });
    }
    this._emit("account-changing", { accountId: this.accountId, accountEpoch: this.accountEpoch });
  }

  async _finishAccountChange(failed) {
    try {
      if (failed) {
        // Selection can change in the core even when persisting it fails.
        this.accountId = await this._call("get_selected_account_id");
      }
    } catch (error) {
      this._emit("diagnostic", { level: "warning", message: `Could not reconcile selected account: ${error?.message || error}` });
    } finally {
      // Invalidate work started during the transition too, including A -> B -> A.
      this.accountEpoch++;
      this.msgIdCache = new Map();
      this._accountTransitionBusy = false;
      this._emit("account-changed", { accountId: this.accountId, accountEpoch: this.accountEpoch });
    }
  }

  /* ---------------- low-level JSON-RPC over the transport ---------------- */

  async init() {
    await this.transport.setReceiver(this._onLine);

    // Fail fast during the handshake: a socket that accepted but doesn't
    // answer RPC within a few seconds is a broken/stale service — better to
    // fall back quickly than to hang the whole app on 30s timeouts.
    const ids = await this._callWithTimeout(10000, "get_all_account_ids");
    if (ids.length === 0) {
      this.accountId = await this._callWithTimeout(4000, "add_account");
    } else {
      this.accountId = await this._callWithTimeout(4000, "get_selected_account_id");
      if (!this.accountId || !ids.includes(this.accountId)) this.accountId = ids[0];
    }
    await this._callWithTimeout(4000, "select_account", this.accountId);
    await this._callWithTimeout(4000, "start_io_for_all_accounts");
    this._pollEvents();
    return this;
  }

  // Re-establish the transport (e.g. after the service APK was restarted)
  // without dropping this core instance, so all UI listeners stay bound.
  async reconnect() {
    const { accountId, accountEpoch } = this;
    if (!this.transport.reconnect) return false;
    const ok = await this.transport.reconnect();
    if (!ok) return false;
    // fail all pending calls from the dead connection
    for (const { reject } of this.pending.values()) reject(new Error("reconnecting"));
    this.pending.clear();
    await this.transport.setReceiver(this._onLine);
    if (!this._isCurrentAccount(accountEpoch)) return false;
    await this._call("select_account", accountId);
    await this._call("start_io_for_all_accounts");
    // #28: reconnect after a service restart re-arms IO unconditionally —
    // pause it again if the device still has no network.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      await this._call("stop_io_for_all_accounts").catch(() => {});
    }
    this._invalidateChat(0, accountEpoch);
    return true;
  }

  async restartIo() {
    await this._call("stop_io_for_all_accounts");
    await this._call("start_io_for_all_accounts");
    await this._call("maybe_network");
    this._emit("diagnostic", { level: "info", message: "Core network I/O restarted" });
    return true;
  }

  // #28: airplane/offline — the core's IMAP/SMTP retry loops keep hammering a
  // dead network (retry storms in the log, battery drain). The webview's
  // connectivity signal reports false exactly in the cases that matter
  // (airplane mode, no interface), so the app pauses IO when it fires and
  // resumes — with a maybe_network nudge — when the network returns.
  // Optimistic link failures (interface up, router dead) still read online;
  // the core's own retry handling covers those.
  async setNetworkIo(on) {
    try {
      if (on) {
        await this._call("start_io_for_all_accounts");
        await this._call("maybe_network");
      } else {
        await this._call("stop_io_for_all_accounts");
      }
      this._emit("diagnostic", {
        level: "info",
        message: on ? "Network is back — core I/O resumed" : "No network — core I/O paused",
      });
      return true;
    } catch { return false; } // mock core / transient transport loss
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // Android: an event batch the Rust background poller took off the core's
    // queue after the UI came back (or whose Rust waiter was gone) is
    // forwarded here as a notification instead of being dropped (#21/#22).
    // It is dispatched exactly like this core's own poll results.
    if (msg.id == null && msg.method === "velta_core_events") {
      this._dispatchPollResult(msg.params?.[0]);
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      const { resolve, reject, onLate } = entry;
      this.pending.delete(msg.id);
      // onLate exists only for event-poll entries, and must run only when
      // the caller was already backstopped (entry.settled): those callers
      // are gone, so the late response is processed here instead of dropped.
      // A live poll entry is delivered through its resolve() below; running
      // the hook there too dispatched every single core event exactly twice.
      if (onLate && entry.settled) onLate(msg);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }

  _call(method, ...params) {
    return this._callWithTimeout(30000, method, ...params);
  }

  _callWithTimeout(timeoutMs, method, ...params) {
    const id = nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        const result = this.transport.send(line);
        // Tauri IPC returns a promise; catch invoke errors immediately
        if (result && typeof result.then === "function") {
          result.catch(e => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              reject(e);
            }
          });
        }
      } catch (e) {
        this.pending.delete(id);
        reject(e);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("rpc timeout: " + method));
        }
      }, timeoutMs);
    });
  }

  // Long-poll get_next_event_batch. The backend parks the request until at
  // least one event exists and then returns everything already queued (up to
  // ~100 events), so a burst (startup, sync, a busy group) drains in one
  // round trip instead of one event per poll (issue #25: the old loop paid a
  // 250 ms pause per event, capping the UI at 4 events/s). A client-side
  // timeout that DELETED the pending entry would lose events: the backend
  // waiter stays parked, consumes the next batch, and its response arrives
  // for an id the frontend no longer expects. This call therefore uses the
  // long backstop (not the 30 s default) and keeps the entry registered after
  // the backstop fires — the late response is then dispatched via onLate
  // instead of dropped. Entries are cleared on reconnect() (dead socket, no
  // waiter will answer); a transport that wedges silently without dying can
  // accumulate one parked entry per backstop period, but can no longer lose
  // its events.
  _callEventPoll() {
    const id = nextId++;
    const method = this._eventPollMethod;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params: [] });
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        onLate: msg => this._dispatchPollResult(msg?.result),
      });
      try {
        const result = this.transport.send(line);
        if (result && typeof result.then === "function") {
          result.catch(e => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              reject(e);
            }
          });
        }
      } catch (e) {
        this.pending.delete(id);
        reject(e);
        return;
      }
      const backstop = setTimeout(() => {
        // Backstop only rejects the caller so the loop re-polls; the entry
        // stays registered to receive its late response. settled marks the
        // caller as gone so _onLine routes the late response through onLate
        // instead of the (already rejected) resolve.
        if (this.pending.has(id)) {
          this.pending.get(id).settled = true;
          reject(new Error(`rpc timeout: ${method}`));
        }
      }, this.eventPollTimeoutMs);
      backstop?.unref?.(); // Node test harnesses: a parked poll must not keep the process alive
    });
  }

  // Accepts a get_next_event_batch result (array, oldest first) or a single
  // get_next_event result (legacy fallback, test stubs). Returns the number of
  // events queued for dispatch.
  _dispatchPollResult(result) {
    if (!result) return 0;
    const list = Array.isArray(result) ? result : [result];
    for (const ev of list) {
      if (!ev?.event) continue;
      if (debugLog.enabled) debugLog(`event raw: ${JSON.stringify(ev).slice(0, 400)}`);
      this._queueCoreEvent(ev.event, ev.contextId ?? ev.context_id);
    }
    return list.length;
  }

  // Handlers run strictly in arrival order: each one starts after the
  // previous one settled, so e.g. an IncomingMsg's decorated "incoming-msg"
  // still lands before a later MsgDelivered for the same chat — the order the
  // old one-event-per-poll loop produced. A handler stuck on a slow RPC
  // (get_message decoration, 30 s timeout) only holds the queue for
  // eventHandlerStallMs; it keeps running and emits when it finishes.
  _queueCoreEvent(ev, contextId) {
    const run = () => {
      const handled = this._handleCoreEvent(ev, contextId).catch(() => {});
      let timer;
      const stall = new Promise(r => { timer = setTimeout(r, this.eventHandlerStallMs); timer?.unref?.(); });
      return Promise.race([handled, stall]).finally(() => {
        clearTimeout(timer);
        this._eventsQueued--;
      });
    };
    // Idle queue: start right away (synchronously, like the old direct
    // dispatch) so the handler's synchronous part runs in this tick.
    this._eventChain = this._eventsQueued++ ? this._eventChain.then(run, run) : run();
    return this._eventChain;
  }

  async _pollEvents() {
    if (this._polling) return; // don't start a second loop on reconnect
    // Android single reader (#40/#52): the shell owns get_next_event_batch.
    // It forwards every batch here as a velta_core_events notification while
    // the UI is visible and notifies natively while hidden, so the page must
    // not long-poll alongside it (the core's event queue has one reader per
    // parked request). The handshake fires after setReceiver() — init()
    // awaits it — so the shell cannot forward into an uninstalled listener,
    // and it learns the initial visibility in the same round trip so the
    // shell's first polls cannot notify while the app is foreground.
    try {
      const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
      if (invoke && (await invoke("get_event_reader_mode")) === "rust") {
        await invoke("events_listener_ready", { visible: !document.hidden });
        return;
      }
    } catch {
      // Probe failed (desktop shell without the command, tests): keep the
      // JS poll — dual reader as before.
    }
    this._polling = true;
    // The core queues events; poll like deltachat-desktop does.
    // Event shape: { event: { kind: "IncomingMsg", chatId, msgId }, contextId }
    let failures = 0;
    for (;;) {
      let delay = 0;
      try {
        const count = this._dispatchPollResult(await this._callEventPoll());
        failures = 0;
        // An empty batch means the backend returned without events (event
        // channel closed) — don't spin on it.
        if (!count) delay = 250;
      } catch (error) {
        if (this._eventPollMethod === "get_next_event_batch" && /method not found|-32601|unknown method/i.test(String(error?.message || error))) {
          // Very old backend without the batch method: fall back to single
          // events (still without a per-event pause).
          this._eventPollMethod = "get_next_event";
          this._emit("diagnostic", { level: "warning", message: "Core has no get_next_event_batch; polling single events" });
          continue;
        }
        // While the transport is down (recovery is core.reconnect(), driven
        // from app.js) the poll fails fast on every iteration — log and
        // re-poll sparsely with a ramping delay, not 4x/second forever.
        failures++;
        if (failures === 1 || failures % 20 === 0) {
          this._emit("diagnostic", { level: "warning", message: `Event polling failed: ${error?.message || error}` });
        }
        delay = Math.min(250 * failures, 5000);
      }
      // Success: re-poll immediately — the backend parks the next request
      // until an event exists, so this does not busy-loop.
      if (delay) await new Promise(r => setTimeout(r, delay));
    }
  }

  async _handleCoreEvent(ev, contextId) {
    const { accountId, accountEpoch } = this;
    // deltachat-jsonrpc serializes event payloads with camelCase ("chatId"),
    // but hand-rolled transports may deliver snake_case — accept both.
    const chatId = ev.chatId ?? ev.chat_id;
    const msgId = ev.msgId ?? ev.msg_id;
    if (debugLog.enabled) debugLog(`event kind=${ev.kind} chatId=${chatId ?? "null"} msgId=${msgId ?? "null"}`);
    switch (ev.kind) {
      case "Info":
      case "Warning":
      case "Error":
      case "ImapConnected":
      case "SmtpConnected":
      case "SmtpMessageSent":
      case "ImapInboxIdle":
      case "ConnectivityChanged":
        if (ev.kind === "ConnectivityChanged") this._emitAccount("connectivity-changed", {}, accountEpoch);
        this._emit("diagnostic", {
          level: ev.kind === "Error" ? "error" : ev.kind === "Warning" ? "warning" : "info",
          message: ev.msg || ev.comment || ev.kind,
        });
        return;
    }
    // Unknown/foreign contexts must never invalidate chats or decorate messages.
    if (contextId == null || contextId !== accountId) return;
    if (ev.kind === "ConfigureProgress") {
      this._emit("configure-progress", { progress: ev.progress || 0, comment: ev.comment || "" });
      return;
    }
    if (ev.kind === "ImexProgress") {
      // Second-device backup transfer progress (0..1000; 1000 = done, 0 = failed).
      this._emit("imex-progress", { progress: ev.progress || 0 });
      return;
    }
    if (!this._isCurrentAccount(accountEpoch)) return;
    switch (ev.kind) {
      case "IncomingMsg":
      case "IncomingMsgBunch": {
        // IncomingMsgBunch carries no chat_id/msg_id — use 0 ("any chat").
        const cid = chatId || 0;
        this._invalidateChat(cid, accountEpoch);
        // Fallback signal so an open chat can reload its tail even if the
        // decorated fast-path below fails or carries no ids.
        this._emitAccount("msgs-changed", { chatId: cid }, accountEpoch);
        if (msgId) {
          const m = await this._getDecoratedMessage(msgId, accountId);
          if (m) this._emitAccount("incoming-msg", { chatId: m.chatId, msg: m }, accountEpoch);
        }
        break;
      }
      case "MsgsChanged": {
        const cid = chatId || 0;
        this._invalidateChat(cid, accountEpoch);
        this._emitAccount("msgs-changed", { chatId: cid }, accountEpoch);
        if (msgId) {
          const m = await this._getDecoratedMessage(msgId, accountId);
          if (m) this._emitAccount("msg-updated", { chatId: m.chatId, msg: m }, accountEpoch);
        }
        break;
      }
      case "ReactionsChanged":
        // #93: peer reactions arrive as this kind, never as MsgsChanged —
        // without it the open chat kept stale chips until restart. Core emits
        // ChatlistItemChanged separately for the chat-list preview line.
        this._invalidateChat(chatId || 0, accountEpoch);
        if (msgId) {
          const m = await this._getDecoratedMessage(msgId, accountId);
          if (m) this._emitAccount("msg-updated", { chatId: m.chatId, msg: m }, accountEpoch);
        }
        break;
      case "MsgDelivered":
        this._untrackSending(msgId);
        if (msgId) this._msgStateHints.set(msgId, "delivered");
        this._emitAccount("msg-state", { chatId, msgId, state: "delivered" }, accountEpoch);
        break;
      case "MsgRead":
      case "MsgReadCountChanged":
        if (msgId) this._msgStateHints.set(msgId, "read");
        this._emitAccount("msg-state", { chatId, msgId, state: "read" }, accountEpoch);
        break;
      case "MsgFailed":
        this._untrackSending(msgId);
        if (msgId) this._msgStateHints.set(msgId, "failed");
        this._emitAccount("msg-state", { chatId, msgId, state: "failed" }, accountEpoch);
        break;
      case "MsgDeleted": {
        // Explicitly deleted, expired (ephemeral) or hidden message. Was
        // unmapped before #69: remote/timer deletions never reached the UI,
        // and the core sends no MessageUnpinned when its tombstone REPLACE
        // silently clears a pin, so the pin tray kept the ghost.
        const cid = chatId || 0;
        this._invalidateChat(cid, accountEpoch);
        this._emitAccount("msgs-deleted", { chatId: cid, ids: msgId ? [msgId] : [] }, accountEpoch);
        this._emitAccount("msgs-changed", { chatId: cid }, accountEpoch);
        break;
      }
      case "TransportsModified":
        // Relay added/removed/sending changed; 2.60.0+ emits this on the
        // device that made the change too, not only on synced devices.
        this._emitAccount("transports-modified", {}, accountEpoch);
        break;
      case "MessagePinned":
      case "MessageUnpinned":
        this._emitAccount("pinned-changed", { chatId }, accountEpoch);
        break;
      case "IncomingCall":
        // placeCallInfo carries the caller's SDP offer, but read the fresh
        // copy via callInfo() on accept — it is valid even if this event
        // was missed while the app was closed.
        this._emitAccount("incoming-call", {
          msgId: msgId,
          chatId: chatId,
          placeCallInfo: ev.placeCallInfo ?? ev.place_call_info ?? "",
          hasVideo: !!ev.hasVideo,
        }, accountEpoch);
        break;
      case "IncomingCallAccepted":
        // fromThisDevice: true is the echo of our own accept; false means
        // another of this account's devices accepted — stop ringing.
        this._emitAccount("incoming-call-accepted", {
          msgId: msgId,
          chatId: chatId,
          fromThisDevice: !!ev.fromThisDevice,
        }, accountEpoch);
        break;
      case "OutgoingCallAccepted":
        // The peer accepted our outgoing call; acceptCallInfo is the SDP answer.
        this._emitAccount("outgoing-call-accepted", {
          msgId: msgId,
          chatId: chatId,
          acceptCallInfo: ev.acceptCallInfo ?? ev.accept_call_info ?? "",
        }, accountEpoch);
        break;
      case "CallEnded":
        this._emitAccount("call-ended", { msgId: msgId, chatId: chatId }, accountEpoch);
        break;
      case "WebxdcStatusUpdate":
        // serial points at the newest known update — the webxdc manager
        // fetches everything newer than its own last serial.
        this._emitAccount("webxdc-status-update", {
          msgId: msgId,
          serial: ev.statusUpdateSerial ?? ev.status_update_serial ?? 0,
        }, accountEpoch);
        break;
      case "WebxdcInstanceDeleted":
        this._emitAccount("webxdc-instance-deleted", { msgId: msgId }, accountEpoch);
        break;
      case "ChatlistChanged":
      case "ChatlistItemChanged":
        // Fine-grained chat-list signals (issue #25), used by app.js to
        // refetch only what changed: ChatlistChanged = order/membership
        // (entries), ChatlistItemChanged = one item (chatId) or all (none).
        if (ev.kind === "ChatlistChanged") this._emitAccount("chatlist-changed", {}, accountEpoch);
        else this._emitAccount("chatlist-item-changed", { chatId: chatId || 0 }, accountEpoch);
        this._invalidateChat(chatId || 0, accountEpoch);
        break;
      case "ChatModified":
      case "MsgsNoticed":
        this._invalidateChat(chatId || 0, accountEpoch);
        break;
    }
  }

  _invalidateChat(chatId, epoch) {
    if (!this._isCurrentAccount(epoch)) return;
    if (chatId) this.msgIdCache.delete(chatId);
    else this.msgIdCache.clear(); // 0 = unknown/any chat: drop all cached id lists
    this._emit("chat-updated", { chatId });
  }

  /* ---------------- mapping: core → UI shapes ---------------- */

  _chatKind(c) {
    if (c.isSelfTalk) return "saved";
    if (c.isDeviceTalk) return "device";
    if (c.isContactRequest) return "deaddrop";
    switch (c.chatType) {
      case "Group": return "group";
      case "Mailinglist":
      case "OutBroadcast":
      case "InBroadcast": return "channel";
      default: return "single";
    }
  }
  // ChatListItemFetchResult { kind: "ChatListItem", ...flat fields }
  _mapChatListItem(c) {
    const kind = this._chatKind(c);
    const lastType = c.lastMessageType;
    let lastMsg = [c.summaryText1, c.summaryText2].filter(Boolean).join(": ");
    if (lastType === "Image" || lastType === "Gif") lastMsg = "📷 " + (c.summaryText2 || "Photo");
    else if (lastType === "Voice" || lastType === "Audio") lastMsg = "🎤 " + (c.summaryText2 || "Voice message");
    else if (lastType === "Video") lastMsg = "🎬 " + (c.summaryText2 || "Video");
    else if (lastType === "File") lastMsg = "📎 " + (c.summaryText2 || "File");
    else if (lastType === "Sticker") lastMsg = c.summaryText2 || "Sticker";
    const outgoing = c.summaryStatus >= 18 && c.summaryStatus <= 28;
    return {
      id: c.id,
      name: c.name || "?",
      kind,
      contactId: c.dmChatContact ?? null,
      memberCount: 0,
      pinned: !!c.isPinned,
      muted: !!c.isMuted,
      archived: !!c.isArchived,
      verified: false,
      encrypted: !!c.isEncrypted,
      unread: c.freshMessageCounter ?? 0,
      draft: null,
      avatarColor: c.color || null,
      avatar: c.avatarPath || null,
      lastMsg: lastMsg || null,
      lastTs: c.lastUpdated ? c.lastUpdated * 1000 : 0,
      lastFrom: outgoing ? 1 : null,
      lastState: outgoing ? this._mapState(c.summaryStatus) : null,
    };
  }

  _mapState(state) {
    // deltachat::message::MessageState
    if (state == null) return "sent";
    if (state === 18 || state === 19 || state === 20) return "pending"; // OutPreparing/OutDraft/OutPending
    if (state === 24) return "failed";                                  // OutFailed
    if (state === 26) return "delivered";                               // OutDelivered
    if (state === 28) return "read";                                    // OutMdnRcvd
    return "received";
  }

  // InFresh (10) / InNoticed (13): not seen yet. Same pair the core's
  // get_first_unread_message_of_chat treats as unread.
  _isUnreadState(state) {
    return state === 10 || state === 13;
  }

  _mapViewtype(v) {
    switch (v) {
      case "Image": case "Gif": return "image";
      case "Sticker": return "sticker"; // stickers float — renderer drops the bubble chrome
      case "Voice": return "voice";
      case "Audio": return "audio";
      case "Video": return "video";
      case "File": return "file";
      case "Vcard": return "vcard";
      case "Webxdc": return "webxdc";
      case "Call": return "call"; // issue #8: call-message cards
      default: return "text";
    }
  }

  _toCoreViewtype(v) {
    switch (v) {
      case "image": return "Image";
      case "video": return "Video";
      case "file": return "File";
      case "voice": return "Voice";
      case "audio": return "Audio";
      case "gif": return "Gif";
      case "sticker": return "Sticker";
      default: return "Text";
    }
  }

  _mapQuote(q) {
    if (!q) return null;
    if (q.kind === "JustText") {
      return { id: 0, from: 0, text: q.text || "", fromContact: { name: "", color: "#888" } };
    }
    return {
      id: q.messageId ?? 0,
      from: 0,
      text: q.text || "",
      fromContact: { name: q.overrideSenderName || q.authorDisplayName || "", color: q.authorDisplayColor || "#888" },
    };
  }

  _mapContact(c) {
    return {
      id: c.id,
      name: c.displayName || c.name || c.address || "?",
      addr: c.address,
      color: c.color || "#888",
      avatar: c.profileImage || null,
      // profile bio / status text (self contact 1 carries the selfstatus)
      status: c.status || "",
      // core 2.61.0: was_seen_recently became the freshness enum
      // ("Normal" | "RecentlySeen" | "Old"); lastSeen stays.
      online: c.freshness === "RecentlySeen",
      lastSeen: c.lastSeen ? c.lastSeen * 1000 : null, // core sends 0 = never seen
      bot: !!c.isBot, // core sends camelCase isBot on every ContactObject
    };
  }

  // A pre-message is viewtype Text plus a core suffix " [Image – 1.34 MiB]"
  // (en dash) until the file mail arrives. Promote it to the download card
  // the media branches already draw. Webxdc and vcards stay a file card
  // until the bytes exist — their own cards need the downloaded file.
  _presentPendingDownload(msg) {
    const state = msg.downloadState;
    if (!state || state === "Done" || state === "Undecipherable") return;
    if (msg.viewtype !== "text") return;
    const suffix = / \[([^\[\]\n]+?) – ([^\]\n]+)\]$/.exec(msg.text || "");
    const label = suffix ? suffix[1] : "";
    if (!suffix && !(msg.fileSize > 0) && !msg.fileName) return;
    if (suffix) msg.text = (msg.text || "").slice(0, suffix.index);
    const ext = String(msg.fileName || "").split(".").pop().toLowerCase();
    const byExt = {
      png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", heic: "image", heif: "image",
      mp4: "video", mov: "video", mkv: "video", avi: "video", webm: "video",
      mp3: "audio", m4a: "audio", wav: "audio", flac: "audio", aac: "audio",
    }[ext];
    const byLabel = {
      image: "image", gif: "image", sticker: "sticker", video: "video",
      "voice message": "voice", audio: "audio",
    }[(label || "").toLowerCase()];
    msg.viewtype = byExt || byLabel || "file";
    if (!msg.fileName && label) msg.fileName = label;
  }

  _mapMessage(m) {
    if (m.isInfo) {
      return {
        id: m.id, chatId: m.chatId, kind: "service", viewtype: "text",
        from: 0, text: m.text || "", ts: (m.sortTimestamp || m.timestamp) * 1000,
        state: "read", fromContact: { name: "", color: "#888" },
        unread: this._isUnreadState(m.state),
      };
    }
    const out = m.fromId === 1; // ContactId::SELF
    const sender = m.sender || {};
    const vt = this._mapViewtype(m.viewType);
    const msg = {
      id: m.id,
      chatId: m.chatId,
      kind: "msg",
      viewtype: vt,
      from: out ? 1 : 0,
      text: m.text || "",
      ts: (m.sortTimestamp || m.timestamp) * 1000,
      state: this._mapState(m.state),
      // Core error text for failed sends (e.g. "5.3.4 message file too big")
      error: m.error || null,
      // Incoming and not yet seen — the chat view marks these seen as they
      // scroll into view (see ChatView._checkSeen).
      unread: !out && this._isUnreadState(m.state),
      starred: !!m.savedMessageId,
      // Set on the copy in Saved Messages. The original stays in its chat.
      originalMsgId: m.originalMsgId > 0 ? m.originalMsgId : null,
      edited: !!m.isEdited,
      quote: this._mapQuote(m.quote),
      reactions: this._mapReactions(m.reactions),
      fwdFrom: m.isForwarded ? (m.overrideSenderName || sender.displayName || "") : null,
      filePath: m.file || null,
      fileName: m.fileName || (m.file ? m.file.split("/").pop() : null),
      fileSize: m.fileBytes ?? null,
      fileMime: m.fileMime || null,
      downloadState: m.downloadState || "Done",
      // Core's mime_modified: a stored original body exists for Read more.
      // False on forwarded copies — the raw mime is not copied on forward.
      hasHtml: !!m.hasHtml,
      // Core-reported pixel size of images (0 when unknown) — the chat view
      // uses these to reserve the exact image box before the file decodes.
      dimensionsWidth: m.dimensionsWidth > 0 ? m.dimensionsWidth : null,
      dimensionsHeight: m.dimensionsHeight > 0 ? m.dimensionsHeight : null,
      encrypted: m.showPadlock !== false, // padlock true = e2e-encrypted
      pinned: !!m.isPinned,
      img: null, // real blobs need blob-dir serving; placeholder for now
      duration: m.duration ? Math.round(m.duration / 1000) : undefined,
      fromContact: out
        ? { id: 1, name: "You", color: "#5aa2e6" }
        : this._mapContact(sender),
    };
    if (vt === "voice" && msg.duration) {
      msg.wave = Array.from({ length: 32 }, () => 4 + Math.floor(Math.random() * 22));
    }
    this._presentPendingDownload(msg);
    return msg;
  }

  _mapReactions(r) {
    const list = r?.reactions;
    if (!Array.isArray(list) || !list.length) return null;
    return list.map(x => ({ emoji: x.emoji, count: x.count, mine: !!x.isFromSelf }));
  }

  async _getDecoratedMessage(msgId, accountId = this.accountId) {
    try {
      const m = await this._call("get_message", accountId, msgId);
      return this._mapMessage(m);
    } catch { return null; }
  }

  /* ---------------- MockCore-compatible API ---------------- */

  // Account-scoped promises return entry-account data even after a switch.
  // Callers must check accountEpoch before using results in the UI; the core
  // suppresses stale cache writes/events, but does not cancel source-account RPCs.
  async getAccount() {
    const { accountId } = this;
    const acc = await this._call("get_account_info", accountId);
    if (acc.kind === "Unconfigured") {
      return {
        id: accountId, addr: "not configured", displayName: "New account",
        color: "#5aa2e6", bio: "", relay: "", configured: false,
      };
    }
    // core 2.61.0: the Account object no longer carries `addr` — the sending
    // address lives in the `configured_addr` config (what setSendRelay writes).
    let addr = "";
    try {
      addr = (await this._call("get_config", accountId, "configured_addr")) || "";
    } catch { /* unconfigured or transport hiccup — fall back to "" */ }
    const account = {
      id: accountId,
      addr,
      displayName: acc.displayName || addr || "Account",
      color: acc.color || "",
      bio: "",
      relay: addr.split("@")[1] || "",
      configured: true,
    };
    // get_account_info carries no profile color of its own — the self contact
    // (id 1) is the authoritative source for color and photo, so the drawer
    // avatar renders color-coded like every other avatar.
    try {
      const self = await this._call("get_contact", accountId, 1);
      if (!account.color) account.color = self.color || "#5aa2e6";
      account.avatar = self.profileImage || null;
    } catch {
      if (!account.color) account.color = "#5aa2e6";
      account.avatar = null;
    }
    return account;
  }

  // Every profile in the accounts file, for the drawer's account switcher.
  // IO for all accounts is already running (start_io_for_all_accounts at
  // init), so switching is just select_account + UI refresh.
  async getAllAccounts() {
    const current = this.accountId;
    const ids = await this._call("get_all_account_ids");
    const infos = await Promise.all(ids.map(id =>
      this._call("get_account_info", id).catch(() => null)
    ));
    // core 2.61.0: Account objects carry no `addr` — read the sending
    // address from `configured_addr` per account (one extra RPC per row).
    const addrs = await Promise.all(ids.map(id =>
      this._call("get_config", id, "configured_addr").catch(() => null)
    ));
    return infos
      .map((acc, i) => ({ acc, id: ids[i], addr: addrs[i] || "" }))
      .filter(({ acc }) => acc)
      .map(({ acc, id, addr }) => ({
        id,
        addr,
        name: acc.displayName || addr || `Account ${id}`,
        relay: addr.split("@")[1] || "",
        configured: acc.kind !== "Unconfigured",
        isCurrent: id === current,
      }));
  }

  // Selects another existing profile and re-points the whole UI at it.
  // Returns that account's snapshot, not a live selection. Both boundaries
  // advance accountEpoch; account-changed also fires when selection fails.
  async switchAccount(id) {
    // Drawer taps hand the id through a data attribute, i.e. always a string;
    // select_account expects u32. Normalize at the RPC boundary.
    id = Number(id);
    if (!Number.isInteger(id)) throw new Error(`Bad account id: ${id}`);
    this._beginAccountChange();
    let failed = true;
    try {
      await this._call("select_account", id);
      this.accountId = id;
      const account = await this.getAccount();
      failed = false;
      return account;
    } finally {
      await this._finishAccountChange(failed);
    }
  }

  // Core relay connectivity: 1000 not connected, 2000 connecting,
  // 3000 working, 4000 connected. Changes arrive as ConnectivityChanged
  // events ("connectivity-changed" here).
  async getConnectivity() {
    return this._call("get_connectivity", this.accountId);
  }

  // HTML overview listing each transport with its per-folder connectivity
  // dots — the only per-relay status the core exposes (parsed in app.js).
  async getConnectivityHtml() {
    return this._call("get_connectivity_html", this.accountId);
  }

  /* -- multi-transport relay management (desktop 2.47+ "Relays" UI) -- */

  // Published transports only; unpublished ones count as removed from the
  // user's point of view and must not be shown.
  async listTransports() {
    return this._call("list_transports", this.accountId);
  }

  // Returns { kind: "account"|"login", domain?|address? } for relay codes.
  async checkQr(qr) {
    return this._call("check_qr", this.accountId, qr);
  }

  // Adds a relay from a dcaccount:/dclogin: code. Runs the core's configure
  // (ConfigureProgress events flow as "configure-progress") and restarts I/O.
  async addTransportFromQr(qr) {
    return this._call("add_transport_from_qr", this.accountId, qr);
  }

  // Core-side auto onboarding (core 2.61.0 autorelay): probes the built-in
  // relay candidate pool and configures the first transport on the relay
  // that answers fastest; the profile then grows to ~3 relays in the
  // background (IMAP idle hooks). qr=null means "no relay name known".
  // ConfigureProgress events flow as "configure-progress", same as
  // configureWithQr. No-op if the account is already configured.
  async initTransports(qr = null) {
    // The core method itself ends with start_io() on success.
    await this._callWithTimeout(180000, "init_transports", this.accountId, qr);
  }

  // Make `addr` the sending (primary) transport. The core validates that the
  // address belongs to a configured transport and republishes/re-signs the
  // public key. Core 2.61.0: no I/O restart anymore, and no device-sync
  // message on this change (other devices learn via TransportsModified when
  // transports actually change).
  async setSendRelay(addr) {
    return this._call("set_config", this.accountId, "configured_addr", addr);
  }

  // Removes the relay immediately (core 2.60.0+). The core refuses only to
  // remove the last relay, re-electing the sending transport as needed, and
  // sends keyupdate messages so contacts learn the new address set.
  async deleteTransport(addr) {
    return this._call("delete_transport", this.accountId, addr);
  }

  /* -- audio calls (core 2.60+): encrypted signaling, client WebRTC -- */

  // place_call_info is the caller's SDP offer (raw SDP, non-trickle ICE —
  // candidates are gathered before the call is placed, so one message
  // carries the whole offer).
  async placeOutgoingCall(chatId, placeCallInfo, hasVideo = false) {
    return this._call("place_outgoing_call", this.accountId, chatId, placeCallInfo, hasVideo);
  }

  // accept_call_info is the callee's SDP answer.
  async acceptIncomingCall(msgId, acceptCallInfo) {
    return this._call("accept_incoming_call", this.accountId, msgId, acceptCallInfo);
  }

  // Cancels an outgoing call, declines an incoming one, or hangs up.
  async endCall(msgId) {
    return this._call("end_call", this.accountId, msgId);
  }

  // { sdpOffer, hasVideo, state } — sdpOffer is present even if the
  // incoming-call event was missed (e.g. the app was closed).
  async callInfo(msgId) {
    return this._call("call_info", this.accountId, msgId);
  }

  // State for call-message cards: { kind: Alerting|Active|Missed|Declined|
  // Canceled|Completed{duration} }. Cached per msgId — chat rows re-mount on
  // every scroll pass and a ended call's state is terminal. Cleared on
  // account switch (ids are per-account).
  async callState(msgId) {
    this._callStateCache = this._callStateCache || new Map();
    if (this._callStateCache.has(msgId)) return this._callStateCache.get(msgId);
    const info = await this.callInfo(msgId);
    const state = info?.state || null;
    this._callStateCache.set(msgId, state);
    return state;
  }

  // JSON string of relay-provided STUN/TURN servers for RTCPeerConnection.
  async iceServers() {
    const raw = await this._call("ice_servers", this.accountId);
    try { return JSON.parse(raw); } catch { return []; }
  }

  /* -- webxdc apps -- */

  async getWebxdcInfo(msgId) {
    return this._call("get_webxdc_info", this.accountId, msgId);
  }

  // Returns the raw JSON string from the core: an array of updates, each
  // carrying payload + serial (+ max_serial). Parse on the caller side.
  async getWebxdcStatusUpdates(msgId, lastSerial) {
    return this._call("get_webxdc_status_updates", this.accountId, msgId, lastSerial);
  }

  async sendWebxdcStatusUpdate(msgId, updateStr, description = null) {
    return this._call("send_webxdc_status_update", this.accountId, msgId, updateStr, description);
  }

  async sendWebxdcRealtimeData(msgId, dataBytes) {
    return this._call("send_webxdc_realtime_data", this.accountId, msgId, dataBytes);
  }

  async leaveWebxdcRealtime(msgId) {
    return this._call("leave_webxdc_realtime", this.accountId, msgId);
  }

  async setDisplayName(name) {
    const trimmed = (name || "").trim();
    await this._call("set_config", this.accountId, "displayname", trimmed || null);
  }

  // path: absolute filesystem path the core can read (uploads/ dir), or null
  // to remove the picture. The core copies the file into its blobdir.
  async setAvatar(path) {
    await this._call("set_config", this.accountId, "selfavatar", path || null);
  }

  async getContacts() {
    const list = await this._call("get_contacts", this.accountId, 0, null);
    return list.map(c => this._mapContact(c));
  }

  // System-level info (no account needed): deltachat_core_version, sqlite, arch...
  async getSystemInfo() {
    return this._call("get_system_info");
  }

  // Retry delivery of a failed outgoing message: the core flips it back to
  // OutPending, re-queues it, and MsgDelivered/MsgFailed events follow.
  async resendMessage(msgId) {
    const result = await this._call("resend_messages", this.accountId, [msgId]);
    // Re-queued — the relay line spins again until the terminal event.
    this._trackSending(msgId);
    return result;
  }

  // Pin/unpin a message (core 2.59+ pinned-messages API; works in group and
  // private chats). MessagePinned/MessageUnpinned events arrive as
  // "pinned-changed".
  async pinMessage(msgId, pinned) {
    return this._call("set_pinned_message_state", this.accountId, msgId, !!pinned);
  }

  // All pinned message ids of a chat, in the core's order.
  async getPinnedMessages(chatId) {
    return this._call("get_pinned_messages", this.accountId, chatId);
  }

  async getContact(contactId) {
    const c = await this._call("get_contact", this.accountId, contactId);
    return this._mapContact(c);
  }

  // Chat/group/channel description (core 2.62+ get_chat_description).
  async getChatDescription(chatId) {
    return this._call("get_chat_description", this.accountId, chatId);
  }

  // Empty string clears. Core informs members via a status message on its own.
  async setChatDescription(chatId, description) {
    await this._call("set_chat_description", this.accountId, chatId, description ?? "");
  }

  // Own profile bio/status (config "selfstatus"; the self contact carries it
  // as Contact.status). null clears.
  async setSelfStatus(status) {
    await this._call("set_config", this.accountId, "selfstatus", (status || "").trim() || null);
  }

  // Group/channel name + picture. set_chat_profile_image with null removes
  // the image; promoted groups inform members core-side for both.
  async renameChat(chatId, name) {
    await this._call("set_chat_name", this.accountId, chatId, (name || "").trim());
  }

  async setChatImage(chatId, path) {
    await this._call("set_chat_profile_image", this.accountId, chatId, path || null);
  }

  // Disappearing-messages timer for a chat, in seconds (0 = off). Changing
  // it makes the core post its own system notice into the chat, so members
  // learn without extra UI work here.
  async getChatEphemeralTimer(chatId) {
    const t = await this._call("get_chat_ephemeral_timer", this.accountId, chatId);
    return t || 0;
  }

  async setChatEphemeralTimer(chatId, seconds) {
    const { accountId, accountEpoch } = this;
    await this._call("set_chat_ephemeral_timer", accountId, chatId, Math.max(0, seconds | 0));
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
  }

  // Multi-line encryption info: own + the contact's OpenPGP fingerprint.
  async getContactEncryptionInfo(contactId) {
    return this._call("get_contact_encryption_info", this.accountId, contactId);
  }

  // Chat ids in chatlist order — (account_id, list_flags, query_string,
  // query_contact_id); list_flags 0x01 = DC_GCL_ARCHIVED_ONLY (issue #13
  // archived folder). NOT 0x02: that is DC_GCL_NO_SPECIALS and silently
  // returned the unarchived list, hiding every archived chat. Cheap (one
  // query, ids only) — use it where only order or a count is needed.
  async getChatListIds({ query = "", archived = false } = {}, accountId = this.accountId) {
    return this._call("get_chatlist_entries", accountId, archived ? 1 : null, query || null, null);
  }

  // Mapped chatlist items for the given ids: Map id -> chat, or id -> null
  // for entries that are not a plain chat (archive link) or failed to load.
  // The core runs ~10 queries per item, so callers fetch only what changed.
  async getChatListItems(ids, accountId = this.accountId) {
    const out = new Map();
    if (!ids.length) return out;
    const items = await this._call("get_chatlist_items_by_entries", accountId, ids);
    for (const id of ids) {
      const item = items?.[String(id)];
      if (item?.kind === "ChatListItem") {
        out.set(id, this._mapChatListItem(item));
      } else {
        if (item?.kind === "Error") rustLog(`getChatList item error: ${JSON.stringify(item)}`);
        out.set(id, null);
      }
    }
    return out;
  }

  async getChatList({ query = "", archived = false } = {}, accountId = this.accountId) {
    const ids = await this.getChatListIds({ query, archived }, accountId);
    if (!ids.length) return [];
    // keep the core's order (ids are already sorted by the chatlist)
    const items = await this.getChatListItems(ids, accountId);
    return ids.map(id => items.get(id)).filter(Boolean);
  }

  // Channels the member cannot post in (and other read-only chats) — the
  // composer hides for these.
  async canSend(chatId) {
    return this._call("can_send", this.accountId, chatId);
  }

  async getChat(chatId) {
    const { accountId } = this;
    // Just this chat's chatlist item (same shape as the list rows, works for
    // archived chats too) — this used to load and map the WHOLE chat list,
    // three times per chat open (issue #25).
    const items = await this.getChatListItems([chatId], accountId).catch(() => null);
    const found = items?.get(chatId);
    if (found) return found;
    // fallback: minimal info when there is no chatlist item (special ids,
    // item errors)
    const info = await this._call("get_basic_chat_info", accountId, chatId).catch(() => null);
    if (!info) return null;
    // core 2.61.0: BasicChat no longer carries dmChatContact — derive the
    // single-chat contact from get_chat_contacts, or presence/bot hydration
    // (refreshChatHeadPresence) silently bails and cht-status stays empty.
    let contactId = null;
    if (info.chatType === "Single") {
      const ids = await this._call("get_chat_contacts", accountId, chatId).catch(() => []);
      contactId = ids.find(id => id > 9) ?? null; // skip reserved ids (SELF=1, info, …)
    }
    // The chat view opens at the first unread message when there is one.
    const unread = await this._call("get_fresh_msg_cnt", accountId, chatId).catch(() => 0);
    return {
      id: chatId, name: info.name || "?", kind: this._chatKind(info),
      contactId, unread,
      encrypted: !!info.isEncrypted, verified: false, muted: !!info.isMuted, pinned: !!info.pinned,
      archived: !!info.archived, avatarColor: info.color || null, avatar: info.profileImage || null, contact: null, memberCount: 0,
    };
  }

  // The chat's message ids, ascending. Cache-backed; used for page math and
  // by clear history, which needs ids only (never the full messages).
  async getMessageIds(chatId) {
    const { accountId, accountEpoch } = this;
    let ids = this.msgIdCache.get(chatId);
    if (!ids) {
      ids = await this._call("get_message_ids", accountId, chatId, false, false);
      if (this._isCurrentAccount(accountEpoch)) this.msgIdCache.set(chatId, ids);
    }
    return ids;
  }

  // One page of a chat's history. Default: the newest `limit` messages;
  // beforeId: the page before it (paging up); afterId: the page after it
  // (paging down a window that does not reach the tail yet); aroundId: a
  // window starting `before` messages above it (opening a chat at its first
  // unread message or read marker). An anchor id that is not in the chat
  // falls back to the newest page. hasMore = older messages exist,
  // hasNewer = newer messages exist.
  async getMessages(chatId, { beforeId = null, afterId = null, aroundId = null, before = 10, limit = 40, fresh = false } = {}) {
    const { accountId, accountEpoch } = this;
    if (fresh && this._isCurrentAccount(accountEpoch)) this.msgIdCache.delete(chatId);
    const ids = await this.getMessageIds(chatId);
    const { start, end } = pageBounds(ids, { beforeId, afterId, aroundId, before, limit });
    const page = ids.slice(start, end);
    if (!page.length) return { messages: [], hasMore: start > 0, hasNewer: end < ids.length };
    const loaded = await this._call("get_messages", accountId, page);
    const messages = [];
    for (const id of page) {
      const entry = loaded[String(id)];
      // NB: MessageLoadResult uses serde rename_all camelCase on its tag,
      // so the variant arrives as "message" (NOT "Message").
      if (entry?.kind === "message" || entry?.kind === "Message") {
        messages.push(this._mapMessage(entry));
      }
    }
    return { messages, hasMore: start > 0, hasNewer: end < ids.length };
  }

  // Core fulltext search (SQLite FTS) over message text — every chat type,
  // groups included. With chatId: that chat only (unlimited results);
  // without: all chats (core caps at 1000 ids). Returns mapped messages,
  // newest first, at most `limit`.
  async searchMessages(query, chatId = null, limit = 30) {
    const { accountId } = this;
    const ids = await this._call("search_messages", accountId, query, chatId);
    const page = ids.slice(-limit).reverse();
    if (!page.length) return [];
    const loaded = await this._call("get_messages", accountId, page);
    const messages = [];
    for (const id of page) {
      const entry = loaded[String(id)];
      if (entry?.kind === "message" || entry?.kind === "Message") {
        messages.push(this._mapMessage(entry));
      }
    }
    return messages;
  }

  async sendMessage(chatId, { text = "", quoteId = null, viewtype = "text", file = null, filename = null } = {}) {
    const { accountId, accountEpoch } = this;
    // BOTH casings for the fields whose JSON name differs between core
    // builds: the deployed sidecar accepts snake_case (`viewtype`,
    // `quoted_message_id`) — serde silently IGNORES the camelCase forms
    // there, so a sticker sent as `viewType` became File→Image (the
    // "stickers send as images" bug) and quote ids would drop. Newer
    // cores with `rename_all = camelCase` read the camelCase forms and
    // ignore these snake ones. Send both; each build reads its own.
    const data = { text: text || "", quotedMessageId: quoteId ?? null, quoted_message_id: quoteId ?? null };
    if (viewtype && viewtype !== "text") {
      const coreType = this._toCoreViewtype(viewtype);
      data.viewType = coreType;
      data.viewtype = coreType;
    }
    if (file) {
      data.file = file;
      if (filename) {
        data.filename = filename;
        data["fileName"] = filename; // legacy casing some builds exposed — harmless extra
      }
    }
    const msgId = await this._call("send_msg", accountId, chatId, data);
    this._trackSending(msgId);
    // #83: low-battery marker — best-effort hook installed by app.js; a
    // failure here must never surface as a send error.
    if (this._batteryGate) {
      try { this._batteryGate(chatId, msgId); } catch { /* ignore */ }
    }
    if (this._isCurrentAccount(accountEpoch)) this.msgIdCache.get(chatId)?.push(msgId);

    // Outgoing media messages start in OutPreparing (18). Wait briefly until the
    // core has finished copying/processing the blob so get_message returns the
    // correct viewType and file path instead of plain text.
    const raw = await this._waitForPreparedMessage(msgId, accountId);
    const msg = raw ? this._mapMessage(raw) : await this._getDecoratedMessage(msgId, accountId);
    if (msg) {
      // A fast relay can fire MsgDelivered before the row is even inserted
      // (chat-view then drops the msg-state event for the unknown row) —
      // reconcile here so the pending spinner doesn't stick spinning.
      msg.state = this._msgStateHints.get(msgId) ?? msg.state;
      this._msgStateHints.delete(msgId);
      this._emitAccount("msg-sent", { chatId, msg }, accountEpoch);
    }
    return msg;
  }

  async _waitForPreparedMessage(msgId, accountId = this.accountId, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const m = await this._call("get_message", accountId, msgId);
        // 18 = OutPreparing. Keep polling while the blob is still being copied.
        if (m.state !== 18) {
          rustLog(`sendMessage prepared id=${msgId} state=${m.state} viewType=${m.viewType}`);
          return m;
        }
      } catch (e) {
        rustLog(`sendMessage prepare poll error: ${e}`);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    rustLog(`sendMessage prepare timeout for id=${msgId}`);
    return null;
  }

  // Original (unsimplified) mail body of a message as HTML, or null when the
  // message has none. Messages received with a cut footer/quote end in
  // " [...]" in their text — the full version lives here.
  async getMessageHtml(msgId) {
    return this._call("get_message_html", this.accountId, msgId);
  }

  async getMessage(msgId) {    const m = await this._call("get_message", this.accountId, msgId);
    return this._mapMessage(m);
  }

  async downloadFullMessage(msgId) {
    await this._call("download_full_message", this.accountId, msgId);
  }

  // Accept a contact request — unblocks the chat so it becomes a normal
  // conversation and the contact can be replied to.
  async acceptChat(chatId) {
    const { accountId, accountEpoch } = this;
    await this._call("accept_chat", accountId, chatId);
    this._invalidateChat(chatId, accountEpoch);
    this._emitAccount("chat-updated", { chatId: 0 }, accountEpoch);
  }

  async blockChat(chatId) {
    const { accountId, accountEpoch } = this;
    await this._call("block_chat", accountId, chatId);
    this._emitAccount("chat-updated", { chatId: 0 }, accountEpoch);
  }

  async markRead(chatId) {
    const { accountId, accountEpoch } = this;
    try {
      // One call, no id list (#47): core marks every fresh message noticed,
      // which clears the badge, without shipping up to 100k ids. Rows
      // actually shown are marked seen (read receipts) by the chat view's
      // per-visible-row markSeen.
      await this._call("marknoticed_chat", accountId, chatId);
    } catch { /* nothing to mark */ }
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
  }

  // Mark just these messages seen (read receipts go out for them, the chat's
  // fresh counter drops by as many) — the chat view calls this for rows that
  // actually scrolled into view, so a half-read chat keeps its badge.
  async markSeen(chatId, ids) {
    const { accountId, accountEpoch } = this;
    if (!ids?.length) return;
    try {
      await this._call("markseen_msgs", accountId, ids);
    } catch { /* nothing to mark */ }
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
  }

  // Id of the first message after the last seen one (the "Unread messages"
  // line), or null when the chat is fully read.
  async getFirstUnreadMessageId(chatId) {
    return (await this._call("get_first_unread_message_of_chat", this.accountId, chatId)) ?? null;
  }

  // options.forAll: also ask the other chat members' devices to delete the
  // messages (core: delete_messages_for_all — sends an encrypted Chat-Delete
  // request). The core only accepts that for self-sent, encrypted messages
  // from a single chat and rejects otherwise, which the caller surfaces.
  async deleteMessages(chatId, ids, { forAll = false } = {}) {
    const { accountId, accountEpoch } = this;
    await this._call(forAll ? "delete_messages_for_all" : "delete_messages", accountId, ids);
    if (!this._isCurrentAccount(accountEpoch)) return;
    const cache = this.msgIdCache.get(chatId);
    if (cache) this.msgIdCache.set(chatId, cache.filter(id => !ids.includes(id)));
    this._emitAccount("msgs-deleted", { chatId, ids }, accountEpoch);
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
  }

  // Remove the chat itself. deleteMessages only drops rows and leaves the
  // chat in the list (issue #34). The core emits ChatDeleted plus
  // ChatlistChanged; this drops the cached id list for the chat we removed.
  // Deletes every message in the chat older than `cutoffMs` (epoch ms),
  // skipping pinned messages. Pages newest→oldest collecting ids (once a
  // page is entirely older than the cutoff everything beyond is too, but
  // the ids are still needed), then deletes in chunks. Returns the count.
  async deleteMessagesOlderThan(chatId, cutoffMs, { onProgress = () => {} } = {}) {
    const { accountId, accountEpoch } = this;
    const ids = [];
    let beforeId = null;
    let hasMore = true;
    while (hasMore) {
      if (!this._isCurrentAccount(accountEpoch)) return 0;
      const page = await this.getMessages(chatId, { beforeId, limit: 500 });
      if (!this._isCurrentAccount(accountEpoch)) return 0;
      const msgs = page.messages || [];
      for (const m of msgs) {
        if (m.pinned) continue;
        if ((m.ts || 0) < cutoffMs) ids.push(m.id);
      }
      hasMore = !!page.hasMore && msgs.length > 0;
      // Pages are oldest→newest: chain from the SMALLEST id (the last/newest
      // id would re-return the same window forever).
      beforeId = msgs.length ? Math.min(...msgs.map(m => m.id)) : null;
      if (beforeId == null) break;
    }
    const CHUNK = 800;
    let deleted = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      if (!this._isCurrentAccount(accountEpoch)) return deleted;
      const chunk = ids.slice(i, i + CHUNK);
      await this.deleteMessages(chatId, chunk);
      deleted += chunk.length;
      onProgress(deleted, ids.length);
    }
    return deleted;
  }

  async deleteChat(chatId) {
    const { accountId, accountEpoch } = this;
    await this._call("delete_chat", accountId, chatId);
    if (!this._isCurrentAccount(accountEpoch)) return;
    this.msgIdCache.delete(chatId);
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
  }

  async starMessages(chatId, ids) {
    const { accountId, accountEpoch } = this;
    await this._call("save_msgs", accountId, ids);
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
  }

  async forwardMessages(fromChatId, ids, toChatId) {
    const { accountId, accountEpoch } = this;
    await this._call("forward_messages", accountId, ids, toChatId);
    this._emitAccount("chat-updated", { chatId: toChatId }, accountEpoch);
  }

  async addReaction(chatId, msgId, emoji) {
    const { accountId, accountEpoch } = this;
    await this._call("send_reaction", accountId, msgId, [emoji]);
    const m = await this._getDecoratedMessage(msgId, accountId);
    if (m) this._emitAccount("msg-updated", { chatId, msg: m }, accountEpoch);
  }

  async clearReaction(msgId) {
    const { accountId } = this;
    await this._call("send_reaction", accountId, msgId, []);
  }

  async editMessage(chatId, msgId, text) {
    const { accountId, accountEpoch } = this;
    await this._call("send_edit_request", accountId, msgId, text);
    const m = await this._getDecoratedMessage(msgId, accountId);
    if (m) this._emitAccount("msg-updated", { chatId, msg: m }, accountEpoch);
  }

  // Sticker folder per account: { collection: [file paths] } (DC desktop's
  // misc_* prototyping API — the picker and "Save sticker" ride it).
  async getStickers() {
    return this._call("misc_get_stickers", this.accountId);
  }

  async saveSticker(msgId, collection = "Default") {
    await this._call("misc_save_sticker", this.accountId, msgId, collection);
  }

  async setChatFlags(chatId, { pinned, muted, archived }) {
    const { accountId, accountEpoch } = this;
    if (pinned !== undefined || archived !== undefined) {
      const visibility = archived ? "Archived" : pinned ? "Pinned" : "Normal";
      await this._call("set_chat_visibility", accountId, chatId, visibility);
    }
    if (muted !== undefined) {
      // MuteDuration is an internally tagged enum on the wire (#[serde(tag =
      // "kind")]): a bare "Forever" string fails deserialization, so the
      // corner-menu Mute died silently (#52 mute-gate device run).
      await this._call("set_chat_mute_duration", accountId, chatId, muted ? { kind: "Forever" } : { kind: "NotMuted" });
    }
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
  }

  // Timed mute (the info-sheet dialog): 0 = unmute, -1 = forever, else
  // seconds from now — MuteDuration::Until counts seconds the core adds to
  // "now" at apply time. The core emits ChatModified, so the chat list and
  // the notifications state refresh through the usual event path.
  async setChatMuted(chatId, seconds) {
    const { accountId, accountEpoch } = this;
    const duration = seconds === 0 ? { kind: "NotMuted" } : seconds < 0 ? { kind: "Forever" } : { kind: "Until", duration: seconds };
    await this._call("set_chat_mute_duration", accountId, chatId, duration);
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
  }

  async createChat(name, contactIds, kind = "group") {
    const { accountId, accountEpoch } = this;
    let chatId;
    if (kind === "single") {
      chatId = await this._call("create_chat_by_contact_id", accountId, contactIds[0]);
    } else {
      chatId = await this._call("create_group_chat", accountId, name, false);
      for (const cid of contactIds) {
        await this._call("add_contact_to_chat", accountId, chatId, cid);
      }
    }
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
    return chatId;
  }

  // Add contacts to an existing group. Idempotent core-side for contacts
  // already in; the core informs the group via its own system message.
  async addChatMembers(chatId, contactIds) {
    const { accountId, accountEpoch } = this;
    for (const cid of contactIds) {
      await this._call("add_contact_to_chat", accountId, chatId, cid);
    }
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
  }

  // Leave a group / unsubscribe from a channel: removes SELF and, for
  // promoted groups, informs the members via the core's own status message.
  async leaveGroup(chatId) {
    const { accountId, accountEpoch } = this;
    await this._call("leave_group", accountId, chatId);
    this._emitAccount("chat-updated", { chatId }, accountEpoch);
  }

  // --- onboarding: configure the account (not in MockCore) ---
  async configureWithCredentials(addr, password) {
    const { accountId, accountEpoch } = this;
    await this._call("add_transport", accountId, { addr, password });
    this._emitAccount("chat-updated", { chatId: 0 }, accountEpoch);
  }

  async configureWithQr(qrContent, accountId = this.accountId) {
    // Account creation involves network round trips + key generation — allow 3 min.
    await this._callWithTimeout(180000, "set_config_from_qr", accountId, qrContent);
    // The account was unconfigured when init() started IO, so start it now.
    await this._call("start_io", accountId);
  }

  async startIo() {
    await this._call("start_io", this.accountId);
  }

  // Group members as mapped contacts (empty list for 1:1 chats).
  async getChatMembers(chatId) {
    const { accountId } = this;
    const full = await this._call("get_full_chat_by_id", accountId, chatId);
    // Keep self (ContactId::SELF = 1) so the member count and list include
    // this account; only skip the other reserved ids (info, archived link, …).
    const ids = (full.contactIds || []).filter(id => id > 9 || id === 1);
    if (!ids.length) return [];
    const byId = await this._call("get_contacts_by_ids", accountId, ids);
    return ids.map(id => byId[String(id)]).filter(Boolean).map(c => this._mapContact(c));
  }

  async getConfig(key) {
    return (await this._call("get_config", this.accountId, key)) ?? null;
  }

  async setConfig(key, value) {
    await this._call("set_config", this.accountId, key, value === null ? null : String(value));
  }

  async renameContact(contactId, name) {
    await this._call("change_contact_name", this.accountId, contactId, name);
  }

  async blockContact(contactId, blocked) {
    await this._call(blocked ? "block_contact" : "unblock_contact", this.accountId, contactId);
  }

  async getBlockedContactIds() {
    const blocked = await this._call("get_blocked_contacts", this.accountId);
    const arr = Array.isArray(blocked) ? blocked : Object.values(blocked || {});
    return arr.map(c => c.id).filter(id => id != null);
  }

  // Returns the chat id of the existing (or newly created) DM chat.
  async createChatByContactId(contactId) {
    return this._call("create_chat_by_contact_id", this.accountId, contactId);
  }

  // Parses a vCard attachment file (core-side path, e.g. a message's filePath).
  // Returns the contacts in their original order ({ addr, displayName, key, … }).
  async parseVcard(path) {
    return this._call("parse_vcard", path);
  }

  // Imports contacts from a vCard file (core-side path). Returns the ids of
  // the created/modified contacts in the order they appear in the vCard.
  async importVcard(path) {
    return this._call("import_vcard", this.accountId, path);
  }

  // Returns a vCard (text) containing the contacts with the given ids — the
  // canonical shareable form of a contact (this core has no contact QRs).
  async makeVcard(contactIds) {
    return this._call("make_vcard", this.accountId, contactIds);
  }

  // SecureJoin invite QR for this account (chatId=null) or a group chat.
  // Returns { text, svg, link } — the core renders the SVG itself.
  async getInviteQr(chatId = null) {
    const [text, svg] = await this._call("get_chat_securejoin_qr_code_svg", this.accountId, chatId);
    return { text, svg, link: text };
  }

  // Renders arbitrary text (e.g. a local-chat invite ticket) as a QR SVG.
  async createQrSvg(text) {
    return this._call("create_qr_svg", text);
  }

  // Join a 1:1 or group chat from an i.delta.chat invite link / QR text.
  // The handshake runs in background; returns the chat to open.
  async secureJoin(qr) {
    const { accountId, accountEpoch } = this;
    const chatId = await this._call("secure_join", accountId, qr);
    this._invalidateChat(0, accountEpoch);
    return chatId;
  }

  // Add a profile from a dcaccount: / relay invite link.
  // Configures the current account if it's still empty, otherwise creates
  // a new account on the relay and switches to it.
  // Returns the configured account ID. Uses the same two epoch boundaries
  // as switchAccount, including when configuring the existing empty profile.
  async addAccountWithQr(qrContent) {
    let { accountId } = this;
    if (!/^dcaccount:/i.test(qrContent) && !/^https?:\/\//i.test(qrContent)) {
      throw new Error("not a relay invite link");
    }
    this._beginAccountChange();
    let failed = true;
    try {
      const acc = await this._call("get_account_info", accountId);
      if (acc.kind !== "Unconfigured") {
        accountId = await this._call("add_account");
        await this._call("select_account", accountId);
        this.accountId = accountId;
      }
      await this.configureWithQr(qrContent, accountId);
      failed = false;
      return accountId;
    } finally {
      await this._finishAccountChange(failed);
    }
  }

  // ---- second-device setup (backup transfer over the LAN) ----

  // Old device: offer this account's backup until a remote device retrieves
  // it. The call blocks server-side for the whole transfer — don't await it
  // in a timeout-sensitive path; completion arrives via ImexProgress.
  async provideBackup() {
    return this._call("provide_backup", this.accountId);
  }

  // QR text for a running provideBackup(). Blocks on the backend until the
  // provider is up (fails after 60 s).
  async getBackupQr() {
    return this._call("get_backup_qr", this.accountId);
  }

  // The backup QR as the 515x630 design card: reserves a clear center circle
  // instead of baking the Delta Chat logo into the modules, so the UI can
  // overlay its own badge (same geometry as the invite QR).
  async getBackupQrSvg() {
    return this._call("get_backup_qr_svg", this.accountId);
  }

  // Full-profile backup export (ImexMode::ExportBackup): writes messages,
  // contacts and keys into <destination>/<file>.tar. Progress rides
  // "imex-progress" (0..1000).
  async exportBackup(destination, passphrase = null) {
    await this._callWithTimeout(180000, "export_backup", this.accountId, destination, passphrase);
  }

  // New device: receive a profile from another device's backup QR. Imports
  // into a fresh account (reuses the current one if still unconfigured) and
  // starts IO on it. The transfer itself runs fire-and-forget — it can take
  // minutes; track it via imex-progress events. Same two epoch boundaries
  // as addAccountWithQr.
  async addAccountWithBackup(qrContent) {
    this._beginAccountChange();
    let failed = true;
    try {
      const acc = await this._call("get_account_info", this.accountId);
      let targetId = this.accountId;
      if (acc.kind !== "Unconfigured") {
        targetId = await this._call("add_account");
        await this._call("select_account", targetId);
        this.accountId = targetId;
      }
      this._call("get_backup", targetId, qrContent).catch(() => {});
      failed = false;
      return targetId;
    } finally {
      await this._finishAccountChange(failed);
    }
  }

  // Restore a profile from a local backup file (tar) into the current
  // account. Fire-and-forget on the wire — the import can take minutes;
  // track it via imex-progress events (1000 = done, 0 = failed).
  async importBackup(path) {
    return this._call("import_backup", this.accountId, path, null);
  }

  // Cancels the current account's ongoing process (backup provide/receive).
  async stopOngoingProcess() {
    return this._call("stop_ongoing_process", this.accountId);
  }

  // ---- V2.5 identity backup (spike days 17–20) ----
  // Self-keys imex over the worker's memfs: paths are DIRECTORIES of armored
  // key files (not tars), reached from the UI via the transport file
  // passthrough (readCoreFile/readCoreFileList/writeCoreFile). Restore
  // order matters: configure BEFORE import_self_keys (the import marks the
  // account configured and would short-circuit a later configure).

  // Fresh unconfigured account to receive a restored identity; returns the id.
  async addAccount() {
    return this._call("add_account");
  }

  async batchSetConfig(accountId, map) {
    const flat = Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, v == null ? null : String(v)]),
    );
    return this._call("batch_set_config", accountId, flat);
  }

  // Full relay login — minutes, not milliseconds.
  async configureAccount(accountId) {
    return this._callWithTimeout(180_000, "configure", accountId);
  }

  async getAccountConfig(accountId, key) {
    return (await this._call("get_config", accountId, key)) ?? null;
  }

  async exportSelfKeys(accountId, dir, passphrase) {
    return this._callWithTimeout(120_000, "export_self_keys", accountId, dir, passphrase);
  }

  async importSelfKeys(accountId, dir, passphrase) {
    return this._callWithTimeout(120_000, "import_self_keys", accountId, dir, passphrase);
  }
}
