// diagnostics.js — local-only startup/core log presented as a device chat.
export const DIAGNOSTICS_CHAT_ID = -9007199254740991;

// Verbose tracing (poll ticks, scroller calls, media URLs, event dumps).
// Off by default: at the old cadences this alone produced megabytes of
// console output and js_log IPC per hour. Enable with
// localStorage.setItem("velta-debug", "1") or ?debug in the URL.
export const VELTA_DEBUG = (() => {
  try {
    return localStorage.getItem("velta-debug") === "1" || new URLSearchParams(location.search).has("debug");
  } catch { return false; }
})();

export function debugLog(msg) {
  if (!VELTA_DEBUG) return;
  console.log("[velta]", msg);
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) invoke("js_log", { msg }).catch(() => {});
  } catch {}
}
debugLog.enabled = VELTA_DEBUG;

// Global sink so deep UI code (media loading, attachments) can surface
// diagnostic lines into the Velta Diagnostics chat, where they are visible
// via a simple screencap — no adb root or logcat needed.
export const diagnosticsSink = {
  append(level, text) {
    if (window.__veltaDiagnostics) window.__veltaDiagnostics.append(level, text);
  },
};

export class DiagnosticsStore extends EventTarget {
  constructor() {
    super();
    this.messages = [];
    this.nextId = 1;
    this.append("info", "Velta UI loaded");
  }

  append(level, text) {
    const message = {
      id: this.nextId++,
      chatId: DIAGNOSTICS_CHAT_ID,
      kind: "service",
      viewtype: "text",
      level,
      from: 0,
      text: `[${String(level).toUpperCase()}] ${text}`,
      ts: Date.now(),
      state: "read",
      fromContact: { id: 0, name: "Velta", color: "#5aa2e6" },
    };
    // Collapse identical consecutive entries (e.g. "Event polling failed"
    // repeating every 250ms while the core is busy): keep one row and a
    // counter instead of churning the store and the chat-list item. The
    // visible text is unchanged, so no "changed" event is needed here.
    const last = this.messages[this.messages.length - 1];
    if (last && last.text === message.text) {
      last.count = (last.count || 1) + 1;
      last.ts = message.ts;
      return last;
    }
    message.count = 1;
    this.messages.push(message);
    if (this.messages.length > 300) this.messages.splice(0, this.messages.length - 300);
    this.dispatchEvent(new CustomEvent("changed", { detail: message }));
    return message;
  }

  getChat() {
    const last = this.messages[this.messages.length - 1];
    return {
      id: DIAGNOSTICS_CHAT_ID,
      name: "Velta Diagnostics",
      kind: "device",
      pinned: true,
      muted: true,
      archived: false,
      verified: false,
      encrypted: false,
      unread: 0,
      avatarColor: "#5aa2e6",
      lastMsg: last?.text || "Startup diagnostics",
      lastTs: last?.ts || Date.now(),
      lastFrom: null,
      lastState: "received",
      memberCount: 0,
    };
  }
}

// Console-style row (Chrome DevTools look) for a diagnostics entry, shared by
// the direct renderer in app.js and chat-view's fallback path. Each row is a
// left-aligned monospace pill with a hover copy-to-clipboard button in its
// top-right corner.
const LEVEL_EMOJI = { error: "❌", warning: "⚠️", info: "ℹ️" };

const COPY_SVG =
  '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V5a2 2 0 012-2h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export function diagnosticRow(message) {
  const row = document.createElement("div");
  row.className = "msg-row service";
  row.dataset.msgid = message.id;
  const bubble = document.createElement("div");
  bubble.className = "service-msg";
  const emoji = LEVEL_EMOJI[message.level] || "ℹ️";
  const text = String(message.text).replace(/^\[[A-Z]+\] /, "");
  bubble.textContent =
    `${new Date(message.ts).toLocaleTimeString()}  ${emoji} ${text}` +
    (message.count > 1 ? ` ×${message.count}` : "");
  const copy = document.createElement("button");
  copy.className = "diag-copy";
  copy.title = "Copy to clipboard";
  copy.setAttribute("aria-label", "Copy to clipboard");
  copy.innerHTML = COPY_SVG;
  copy.addEventListener("click", async e => {
    e.stopPropagation();
    const done = ok => {
      copy.textContent = ok ? "✓" : "✗";
      setTimeout(() => { copy.innerHTML = COPY_SVG; }, 1200);
    };
    try {
      await navigator.clipboard.writeText(message.text);
      done(true);
    } catch {
      done(false);
    }
  });
  row.appendChild(bubble);
  row.appendChild(copy);
  return row;
}
