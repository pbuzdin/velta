// diagnostics.js — local-only startup/core log presented as a device chat.
export const DIAGNOSTICS_CHAT_ID = -9007199254740991;

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
      from: 0,
      text: `[${String(level).toUpperCase()}] ${text}`,
      ts: Date.now(),
      state: "read",
      fromContact: { id: 0, name: "Velta", color: "#5aa2e6" },
    };
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
