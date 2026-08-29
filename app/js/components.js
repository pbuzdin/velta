// components.js — Progressive Web Components built on Elena (@elenajs/core)
import { Elena, html, unsafeHTML } from "../vendor/elena.js";
import { formatListTime } from "./mock-core.js";

const AVATAR_SVG = `<svg viewBox="0 0 24 24" style="width:55%;height:55%"><path d="M12 4l2.2 4.7 5 .6-3.7 3.4 1 4.9-4.5-2.6-4.5 2.6 1-4.9L4.8 9.3l5-.6z" fill="currentColor"/></svg>`;
const DEVICE_SVG = `<svg viewBox="0 0 24 24" style="width:55%;height:55%"><rect x="5" y="3" width="14" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="17.5" r="1.2" fill="currentColor"/></svg>`;

/* ---------- <dc-avatar> ---------- */
class DcAvatar extends Elena(HTMLElement) {
  static tagName = "dc-avatar";
  static props = ["name", "color", "kind", "size"];

  name = "?";
  color = "#777";
  kind = "single";
  size = "46";

  initials() {
    return (this.name || "?").trim().split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w[0] || "")).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  }

  render() {
    const s = Number(this.size) || 46;
    const special = this.kind === "saved" || this.kind === "device";
    const style = `width:${s}px;height:${s}px;font-size:${Math.round(s * 0.38)}px;` +
      (special ? "" : `background:${this.color || "#777"};`);
    const cls = "dc-avatar-circle" + (special ? " saved" : "");
    const inner = this.kind === "saved" ? unsafeHTML(AVATAR_SVG)
      : this.kind === "device" ? unsafeHTML(DEVICE_SVG)
      : this.initials();
    return html`<div class="${cls}" style="${style}" aria-hidden="true">${inner}</div>`;
  }
}
DcAvatar.define();

const LOCK_SVG = `<svg class="ci-lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const VERIFIED_SVG = `<svg class="ci-verified" viewBox="0 0 24 24"><path d="M12 2l2.4 2.1 3.1-.4 1.1 3 3 1.1-.4 3.1L23.3 13l-2.1 2.4.4 3.1-3 1.1-1.1 3-3.1-.4L12 24l-2.4-2.1-3.1.4-1.1-3-3-1.1.4-3.1L.7 13l2.1-2.4-.4-3.1 3-1.1 1.1-3 3.1.4z" fill="currentColor" transform="scale(.92) translate(1,0)"/><path d="M8.5 12.5l2.5 2.5 4.5-5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PIN_SVG = `<svg class="ci-pin" viewBox="0 0 24 24"><path d="M9 4h6l1 7 3 3v2h-6v5l-1 1-1-1v-5H5v-2l3-3z" fill="currentColor"/></svg>`;
const MUTE_SVG = `<svg class="ci-mute" viewBox="0 0 24 24"><path d="M12 3a5 5 0 00-5 5v3l-2 4h14l-2-4V8a5 5 0 00-5-5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const TICK1 = `<svg class="ci-ticks" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const TICK2 = `<svg class="ci-ticks" viewBox="0 0 24 24"><path d="M3 13l4 4L17 7M10 15l2 2 8-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function ticksSvg(state, cls = "ci-ticks") {
  if (state === "pending") return `<svg class="${cls}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3.5 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  if (state === "sent") return TICK1.replace('ci-ticks', cls);
  const read = state === "read" ? " read" : "";
  return TICK2.replace('ci-ticks', cls + read);
}

/* ---------- <dc-chat-item> ---------- */
class DcChatItem extends Elena(HTMLElement) {
  static tagName = "dc-chat-item";
  static props = ["chat-id", "active"];
  static events = ["click"];

  chat = null;

  setData(chat) {
    this.chat = chat;
    this.setAttribute("chat-id", chat.id);
    this.requestUpdate();
  }

  render() {
    const c = this.chat;
    if (!c) return html`<div></div>`;
    const nameBadges =
      (c.encrypted && c.kind === "single" ? LOCK_SVG : "") +
      (c.verified ? VERIFIED_SVG : "");
    let right;
    if (c.unread > 0) right = `<span class="ci-badge${c.muted ? " muted" : ""}">${c.unread > 999 ? "999+" : c.unread}</span>`;
    else if (c.pinned) right = PIN_SVG;
    else if (c.muted) right = MUTE_SVG;
    else right = "";
    const ticks = c.lastFrom === 1 && c.lastState ? ticksSvg(c.lastState) : "";
    const last = c.draft
      ? `<span class="draft">Draft:</span> ${escapeHtml(c.draft)}`
      : c.kind === "deaddrop"
        ? `<span class="draft">Contact request:</span> ${escapeHtml(c.lastMsg || "tap to accept")}`
        : c.lastMsg ? escapeHtml(c.lastMsg) : "";
    return html`
      <div class="chat-item${this.active !== null && this.active !== undefined && this.getAttribute("active") !== null ? " active" : ""}" role="option">
        ${unsafeHTML(`<dc-avatar name="${escapeAttr(c.name)}" color="${c.avatarColor || ""}" kind="${c.kind}" size="48"></dc-avatar>`)}
        <div class="ci-main">
          <div class="ci-top">
            <div class="ci-name">${c.name} ${unsafeHTML(nameBadges)}</div>
            <div class="ci-time">${c.lastTs ? formatListTime(c.lastTs) : ""}</div>
          </div>
          <div class="ci-bottom">
            <div class="ci-last">${unsafeHTML(ticks)} ${unsafeHTML(last)}</div>
            ${unsafeHTML(right)}
          </div>
        </div>
      </div>`;
  }
}
DcChatItem.define();

/* ---------- <dc-chat-head> ---------- */
class DcChatHead extends Elena(HTMLElement) {
  static tagName = "dc-chat-head";
  static events = ["click"];

  chat = null;

  setData(chat) { this.chat = chat; this.requestUpdate(); }

  statusLine() {
    const c = this.chat;
    if (!c) return "";
    if (c.kind === "group") return c.memberCount ? `${c.memberCount} members` : "…";
    if (c.kind === "channel") return `${(c.memberCount || 0).toLocaleString()} subscribers`;
    if (c.kind === "saved") return "your personal space";
    if (c.kind === "device") return "local device messages";
    if (c.contact) {
      if (c.contact.bot) return "bot";
      if (c.contact.online) return { online: true, text: "online" };
      return "last seen " + formatListTime(c.contact.lastSeen || Date.now());
    }
    return "";
  }

  render() {
    const c = this.chat;
    if (!c) return html`<div></div>`;
    const st = this.statusLine();
    const online = typeof st === "object" && st.online;
    const stText = typeof st === "object" ? st.text : st;
    return html`
      <div class="chat-head-avatar">
        ${unsafeHTML(`<dc-avatar name="${escapeAttr(c.name)}" color="${c.avatarColor || ""}" kind="${c.kind}" size="42"></dc-avatar>`)}
      </div>
      <div class="chat-head-text">
        <div class="cht-name">${c.name} ${unsafeHTML(c.kind === "single" ? LOCK_SVG : "")}${unsafeHTML(c.verified ? VERIFIED_SVG : "")}</div>
        <div class="cht-status${online ? " online" : ""}">${stText}</div>
      </div>`;
  }
}
DcChatHead.define();

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
export function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
