// typing.js — composer side of the typing indicator (local chat).
//
// The composer calls ping() on every keystroke with text in the box and
// stop() when the box empties, a message is sent or the chat changes. The
// sender turns that into at most one "typing" hint per REPEAT_MS while the user
// keeps typing, and one "stopped" hint after IDLE_MS of silence. Pure logic:
// the transport (`send(on)`) and the clock/timers are injected.

export const REPEAT_MS = 3000;  // never send "typing" more often than this
export const IDLE_MS = 5000;    // no keystroke for this long -> "stopped"
export const SHOW_TTL_MS = 6000; // receiver: a hint expires this long after the last one

export class TypingSender {
  constructor({ send, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this._send = send;
    this._now = now;
    // Chromium's timer natives throw "Illegal invocation" when called as an
    // instance method (foreign `this`); bind so the this._setTimer calls below
    // work in WebView2/Android.
    this._setTimer = setTimer.bind(globalThis);
    this._clearTimer = clearTimer.bind(globalThis);
    this._active = false;
    this._lastSent = 0;
    this._idle = null;
  }

  get active() { return this._active; }

  ping() {
    const t = this._now();
    if (!this._active || t - this._lastSent >= REPEAT_MS) {
      this._active = true;
      this._lastSent = t;
      this._emit(true);
    }
    this._clearTimer(this._idle);
    this._idle = this._setTimer(() => this.stop(), IDLE_MS);
  }

  stop() {
    this._clearTimer(this._idle);
    this._idle = null;
    if (!this._active) return;
    this._active = false;
    this._emit(false);
  }

  _emit(on) {
    try {
      const r = this._send(on);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch { /* a hint is never worth an error */ }
  }
}

// "Anna is typing…" / "Anna and Ben are typing…" / "Anna, Ben and Cal are typing…"
export function typingText(names) {
  const n = names.filter(Boolean);
  if (!n.length) return "";
  if (n.length === 1) return `${n[0]} is typing…`;
  if (n.length === 2) return `${n[0]} and ${n[1]} are typing…`;
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]} are typing…`;
}
