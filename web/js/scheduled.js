// Scheduled messages ("Send later") — storage document, presets and the
// send runner. On-device only: nothing is handed to a relay before the due
// time; the message goes out through the normal send_msg path when due.
// docs/scheduled-messages.md has the design. Plain ES module, node-tested
// (no DOM at import time). The same document operations are implemented in
// Rust (velta-app/src-tauri/src/scheduled_store.rs) for the Tauri shells,
// where the JSON file lives in the app's private data dir so the Android
// alarm receiver can read it without the WebView.
//
// Item: { id, accountId, chatId, text, quoteId, dueAt (UTC ms), createdAt,
//         status: "pending" | "sending" | "error", error, attempts,
//         retryAt, claimedAt, uncertain }

export const SCHED_KEY = "velta-scheduled";
export const TEXT_MAX = 64 * 1024;
// A "sending" claim older than this was interrupted (crash / process
// death mid-send). The send may or may not have reached the core, so the
// item becomes an "uncertain" error that is NEVER retried automatically.
export const STALE_SENDING_MS = 2 * 60 * 1000;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export function emptyDoc() { return { version: 1, items: [] }; }

export function backoffMs(attempts) {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

function normDoc(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.items)) return emptyDoc();
  return { version: 1, items: doc.items.filter(it => it && typeof it.id === "string") };
}

function newId(now) {
  return "s" + now.toString(36) + Math.random().toString(36).slice(2, 8);
}

function validDue(v) { return Number.isFinite(v) && v > 0; }

/** Pure: apply one operation; returns { doc, result }. Never mutates `doc`.
 *  Ops: list | add {item} | update {id, text?, dueAt?} | remove {id} |
 *  claim {id} | done {id} | fail {id, error, uncertain?} | recover. */
export function applyOp(doc, op, now = Date.now()) {
  const d = normDoc(structuredClone(doc));
  const find = id => d.items.find(it => it.id === id);
  switch (op?.op) {
    case "list": return { doc: d, result: true };
    case "add": {
      const src = op.item || {};
      const text = String(src.text ?? "");
      if (!text.trim() || text.length > TEXT_MAX) return { doc: d, result: { error: "empty or too long" } };
      if (!validDue(src.dueAt) || src.accountId == null || src.chatId == null) return { doc: d, result: { error: "bad item" } };
      const it = {
        id: newId(now), accountId: Number(src.accountId), chatId: Number(src.chatId), text,
        quoteId: src.quoteId == null ? null : Number(src.quoteId),
        dueAt: Math.round(src.dueAt), createdAt: now, status: "pending", error: null, attempts: 0,
        retryAt: null, claimedAt: null, uncertain: false,
      };
      d.items.push(it);
      return { doc: d, result: { id: it.id } };
    }
    case "update": {
      const it = find(op.id);
      // An item being sent right now cannot be edited — it may already be out.
      if (!it || it.status === "sending") return { doc: d, result: false };
      if (op.text != null) {
        const text = String(op.text);
        if (!text.trim() || text.length > TEXT_MAX) return { doc: d, result: false };
        it.text = text;
      }
      if (op.dueAt != null) {
        if (!validDue(op.dueAt)) return { doc: d, result: false };
        it.dueAt = Math.round(op.dueAt);
      }
      // Any edit is an explicit user decision: back to a clean pending item
      // (this is also how an "uncertain" item is re-sent on purpose).
      Object.assign(it, { status: "pending", error: null, retryAt: null, uncertain: false });
      return { doc: d, result: true };
    }
    case "remove": {
      const it = find(op.id);
      if (!it || it.status === "sending") return { doc: d, result: false };
      d.items = d.items.filter(x => x !== it);
      return { doc: d, result: true };
    }
    case "claim": {
      // The no-double-send gate: only one sender wins a pending/error item.
      const it = find(op.id);
      if (!it || it.status === "sending" || it.uncertain) return { doc: d, result: false };
      Object.assign(it, { status: "sending", claimedAt: now });
      return { doc: d, result: true };
    }
    case "done": {
      const before = d.items.length;
      d.items = d.items.filter(x => x.id !== op.id);
      return { doc: d, result: d.items.length !== before };
    }
    case "fail": {
      const it = find(op.id);
      if (!it) return { doc: d, result: false };
      it.attempts = (it.attempts || 0) + 1;
      Object.assign(it, {
        status: "error", error: String(op.error || "Send failed").slice(0, 300), claimedAt: null,
        uncertain: !!op.uncertain, retryAt: op.uncertain ? null : now + backoffMs(it.attempts),
      });
      return { doc: d, result: true };
    }
    case "recover": {
      let n = 0;
      for (const it of d.items) {
        if (it.status === "sending" && !(now - (it.claimedAt || 0) < STALE_SENDING_MS)) {
          Object.assign(it, { status: "error", error: "Interrupted while sending — check the chat before sending again", uncertain: true, retryAt: null, claimedAt: null });
          n++;
        }
      }
      return { doc: d, result: n };
    }
    default: return { doc: d, result: false };
  }
}

/** Items to send now. `wake` (app start/resume, alarm) retries failed ones
 *  regardless of their backoff; the periodic timer respects it. */
export function dueItems(doc, now, { wake = false } = {}) {
  return normDoc(doc).items
    .filter(it => it.dueAt <= now && (it.status === "pending"
      || (it.status === "error" && !it.uncertain && (wake || (it.retryAt ?? 0) <= now))))
    .sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
}

/** Next instant something needs a wakeup (UTC ms) or null. */
export function nextWake(doc) {
  let best = null;
  for (const it of normDoc(doc).items) {
    let at = null;
    if (it.status === "pending") at = it.dueAt;
    else if (it.status === "error" && !it.uncertain) at = Math.max(it.dueAt, it.retryAt ?? it.dueAt);
    if (at != null && (best == null || at < best)) best = at;
  }
  return best;
}

export function itemsFor(doc, accountId, chatId = null) {
  return normDoc(doc).items
    .filter(it => (accountId == null || it.accountId === Number(accountId)) && (chatId == null || it.chatId === Number(chatId)))
    .sort((a, b) => a.dueAt - b.dueAt);
}

// Errors where we cannot know whether the core already queued the message:
// never auto-retried (no double send).
export function isUncertainError(err) {
  return /tim(ed|e) ?out|dropped|closed|restart|not running|disconnect/i.test(String(err?.message || err || ""));
}

// ---- presets (user's local time zone; DST-safe via local Date fields) ----

export const PRESETS = ["hour", "tonight", "tomorrow", "monday"];
const MIN_LEAD_MS = 60_000;

/** UTC ms for a preset, or null when it would not be in the future. */
export function presetTime(kind, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const at = (dayOffset, h) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, 0, 0, 0).getTime();
  let t;
  if (kind === "hour") t = nowMs + 3_600_000;
  else if (kind === "tonight") t = at(0, 20);
  else if (kind === "tomorrow") t = at(1, 9);
  else if (kind === "monday") {
    const delta = ((8 - now.getDay()) % 7) || 7; // next Monday, never today
    t = at(delta, 9);
  } else return null;
  return t - nowMs >= MIN_LEAD_MS ? t : null;
}

const pad = n => String(n).padStart(2, "0");

/** UTC ms → value for <input type="datetime-local"> in local time. */
export function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value → UTC ms (local time), or null. */
export function fromLocalInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(v || ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0);
  return Number.isNaN(d.getTime()) || d.getMonth() !== +m[2] - 1 ? null : d.getTime();
}

// ---- stores ----

/** localStorage-backed store (PWA / browser). Same op semantics. */
export function localStore(storage = globalThis.localStorage, key = SCHED_KEY, clock = () => Date.now()) {
  const read = () => { try { return normDoc(JSON.parse(storage.getItem(key) || "null")); } catch { return emptyDoc(); } };
  return {
    kind: "local",
    async op(op) {
      const { doc, result } = applyOp(read(), op, clock());
      if (op.op !== "list") storage.setItem(key, JSON.stringify(doc));
      return { doc, result };
    },
  };
}

/** Tauri store: the JSON file in app private data (scheduled.json), via
 *  the shell's scheduled_op command (which also re-arms the Android alarm). */
export function tauriStore(invoke) {
  return {
    kind: "tauri",
    async op(op) { return await invoke("scheduled_op", { op }); },
  };
}

// ---- runner ----

/**
 * Sends due items. `send(item)` must be the normal send path; it resolves
 * on success. `nativeRun(wake)` (Android) hands sending to the shell, which
 * owns the alarm and the in-process core — the page never sends there, so
 * the WebView and the alarm receiver cannot race each other.
 */
export class ScheduledRunner {
  constructor({ store, send = null, nativeRun = null, onChange = () => {}, onSent = () => {}, clock = () => Date.now(), timers = globalThis, periodMs = 60_000 }) {
    Object.assign(this, { store, send, nativeRun, onChange, onSent, clock, timers, periodMs });
    this._timer = null;
    this._interval = null;
    this._busy = null;
    this._again = false;
    this.doc = emptyDoc();
  }

  async refresh() {
    const { doc } = await this.store.op({ op: "list" });
    this.doc = doc;
    this._arm();
    this.onChange(doc);
    return doc;
  }

  async op(op) {
    const r = await this.store.op(op);
    this.doc = r.doc;
    this._arm();
    this.onChange(r.doc);
    return r.result;
  }

  start() {
    this._interval = this.timers.setInterval(() => this.run(false), this.periodMs);
    return this.run(true);
  }

  stop() {
    this.timers.clearTimeout(this._timer);
    this.timers.clearInterval(this._interval);
    this._timer = this._interval = null;
  }

  /** One pass; concurrent calls coalesce (one extra pass after the current). */
  run(wake = false) {
    if (this._busy) { this._again ||= wake || "tick"; return this._busy; }
    this._busy = (async () => {
      try { await this._pass(wake); }
      finally {
        this._busy = null;
        if (this._again) { const w = this._again === true; this._again = false; this.run(w); }
      }
    })();
    return this._busy;
  }

  async _pass(wake) {
    if (this.nativeRun) {
      try { await this.nativeRun(wake); } catch { /* shell logs */ }
      await this.refresh();
      return;
    }
    let { doc } = await this.store.op({ op: "recover" });
    for (const it of dueItems(doc, this.clock(), { wake })) {
      const { result: won } = await this.store.op({ op: "claim", id: it.id });
      if (!won) continue;
      let msg;
      try {
        msg = await this.send(it);
      } catch (err) {
        await this.store.op({ op: "fail", id: it.id, error: err?.message || String(err), uncertain: isUncertainError(err) });
        continue;
      }
      await this.store.op({ op: "done", id: it.id });
      try { this.onSent(it, msg); } catch { /* UI hook */ }
    }
    await this.refresh();
  }

  _arm() {
    this.timers.clearTimeout(this._timer);
    this._timer = null;
    const at = nextWake(this.doc);
    if (at == null) return;
    // Clamp: browsers overflow past 2^31 ms; the periodic check covers the rest.
    const delay = Math.min(Math.max(at - this.clock(), 0), 0x7fffffff);
    this._timer = this.timers.setTimeout(() => this.run(false), delay);
  }
}
