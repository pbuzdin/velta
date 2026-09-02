// components.js — Progressive Web Components built on Elena (@elenajs/core)
import { Elena, html, unsafeHTML } from "../vendor/elena.js";
import { formatListTime } from "./mock-core.js";
import { fileUrl } from "./media.js";
import { diagnosticsSink } from "./diagnostics.js";
import { buildAvatarSvg, fingerprintFor, cachedFingerprint, fingerprintGroups } from "./avatar.js";

const AVATAR_SVG = `<svg viewBox="0 0 24 24" style="width:55%;height:55%"><path d="M12 4l2.2 4.7 5 .6-3.7 3.4 1 4.9-4.5-2.6-4.5 2.6 1-4.9L4.8 9.3l5-.6z" fill="currentColor"/></svg>`;
const DEVICE_SVG = `<svg viewBox="0 0 24 24" style="width:55%;height:55%"><rect x="5" y="3" width="14" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="17.5" r="1.2" fill="currentColor"/></svg>`;

/* ---------- <dc-avatar> ---------- */
function specialKind(kind) { return kind === "saved" || kind === "device"; }
class DcAvatar extends Elena(HTMLElement) {
  static tagName = "dc-avatar";
  static props = ["name", "color", "kind", "size", "avatar", "contact-id", "addr"];

  name = "?";
  color = "#777";
  kind = "single";
  size = "46";
  avatar = "";
  #avatarFailed = false;
  #lastAvatar = null;

  constructor(...args) {
    super(...args);
    this["contact-id"] = null;
  }

  connectedCallback() {
    super.connectedCallback?.();
    // Self-heal: Elena's re-render diff compares live children against a
    // freshly parsed template clone — and a custom element inside a template
    // is bare (unhydrated), so a diff pass deletes our rendered circle and
    // leaves us connected but empty. Clearing Elena's render caches forces
    // the next N() through the full first-render path, restoring the circle.
    if (this.h && this.childElementCount === 0) {
      delete this.D;
      delete this.F;
      this.N?.();
    }
    // Identity tiles need the contact's fingerprint — resolve it once per
    // contact and re-render when it arrives (initials show until then).
    if (!specialKind(this.kind) && !this.avatar && Number(this["contact-id"]) >= 1) {
      fingerprintFor(Number(this["contact-id"]), this.addr)
        .then((fpr) => { if (fpr && this.isConnected) this.requestUpdate(); })
        .catch(() => {});
    }
  }

  willUpdate() {
    if (this.#lastAvatar !== this.avatar) {
      this.#lastAvatar = this.avatar;
      this.#avatarFailed = false;
    }
  }

  updated() {
    const img = this.querySelector?.("img.dc-avatar-img");
    if (img && !img.dataset.errBound) {
      img.dataset.errBound = "1";
      img.addEventListener("error", () => {
        this.#avatarFailed = true;
        this.requestUpdate();
      });
    }
  }

  initials() {
    return (this.name || "?").trim().split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w[0] || "")).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  }

  render() {
    const s = Number(this.size) || 46;
    const special = specialKind(this.kind);
    const style = `width:${s}px;height:${s}px;font-size:${Math.round(s * 0.38)}px;` +
      (special ? "" : `background:${this.color || "#777"};`);
    const cls = "dc-avatar-tile" + (special ? " saved" : "") + (!special && this.kind === "single" ? " identity" : "");
    // The initials stay underneath as the loading/failure fallback; the img
    // is absolutely positioned and covers them once it decodes.
    if (!special && this.avatar && !this.#avatarFailed) {
      return html`<div class="${cls}" style="${style}" aria-hidden="true">${this.initials()}<img class="dc-avatar-img" src="${this.avatar}" alt="" loading="lazy"></div>`;
    }
    // GPG-fingerprint identity tile for photo-less single contacts.
    if (!special && this.kind === "single") {
      const groups = fingerprintGroups(cachedFingerprint(Number(this["contact-id"])));
      const svg = groups ? buildAvatarSvg({ groups, size: s, radius: 0 }) : "";
      if (svg) return html`<div class="${cls}" style="${style}" aria-hidden="true">${unsafeHTML(svg)}</div>`;
    }
    const inner = this.kind === "saved" ? unsafeHTML(AVATAR_SVG)
      : this.kind === "device" ? unsafeHTML(DEVICE_SVG)
      : this.initials();
    return html`<div class="${cls}" style="${style}" aria-hidden="true">${inner}</div>`;
  }
}
DcAvatar.define();

/* ---------- <dc-video> — click-to-load video player ---------- */
// Every mounted <video> starts a decoder pipeline and issues media range
// requests for content the user may never play; in a multi-video chat that
// is decode churn, memory, and (over the asset protocol) seek requests we
// know can fail. Rows render a static placeholder instead; the real
// <video> element is created on tap and dropped again when the virtual
// scroller unmounts the row.
const PLAY_SVG = `<svg viewBox="0 0 24 24" style="width:100%;height:100%;display:block"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>`;
const VIDEO_FAIL_SVG = `<svg viewBox="0 0 24 24" style="width:100%;height:100%;display:block"><path d="M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

class DcVideo extends Elena(HTMLElement) {
  static tagName = "dc-video";
  static props = ["src", "duration", "name"];

  src = "";
  duration = "";
  name = "Video";
  #active = false;
  #failed = false;
  #lastSrc = null;

  connectedCallback() {
    super.connectedCallback?.();
    // Self-heal (same Elena diff quirk as DcAvatar): a re-render pass can
    // strip our rendered child while leaving us connected.
    if (this.h && this.childElementCount === 0) {
      delete this.D;
      delete this.F;
      this.N?.();
    }
    if (!this._clickBound) {
      this._clickBound = true;
      this.addEventListener("click", (e) => {
        // In selection mode the row owns the tap (toggle selection) — don't
        // hijack it for playback.
        if (this.closest(".msg-row")?.classList.contains("selectable")) return;
        if (!this.#active && this.src && !this.#failed) {
          e.stopPropagation(); // play — don't bubble into row selection/menu
          this.#active = true;
          this.requestUpdate();
        }
      });
    }
  }

  willUpdate() {
    if (this.#lastSrc !== this.src) {
      this.#lastSrc = this.src;
      this.#failed = false;
    }
  }

  updated() {
    const v = this.querySelector?.("video");
    if (v && !v.dataset.errBound) {
      v.dataset.errBound = "1";
      v.addEventListener("error", () => {
        this.#failed = true;
        this.requestUpdate();
        diagnosticsSink.append("error", `video "${this.name}" failed to load`);
      });
    }
  }

  ariaLabel() {
    return "Play " + (this.name || "video");
  }

  render() {
    if (this.#failed) {
      return html`<div class="media-fail"><div class="media-fail-ico">${unsafeHTML(VIDEO_FAIL_SVG)}</div><div>Video can't be played</div></div>`;
    }
    if (!this.#active || !this.src) {
      const d = Number(this.duration) || 0;
      const dur = d > 0 ? `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, "0")}` : "";
      return html`<button type="button" class="dc-video-ph" aria-label="${this.ariaLabel()}">
        <span class="dc-video-play">${unsafeHTML(PLAY_SVG)}</span>
        ${dur ? html`<span class="dc-video-dur">${dur}</span>` : ""}
      </button>`;
    }
    return html`<video controls autoplay playsinline preload="metadata" src="${this.src}"></video>`;
  }
}
DcVideo.define();

// Open-shackle lock, shown only on chats that can carry unencrypted mail
// (classic-email contacts), i.e. chat.isEncrypted === false. Encrypted chats
// show no lock at all — e2e is the default there, not something to celebrate.
const OPEN_LOCK_SVG = `<svg class="ci-lock open" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 017.6-1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const VERIFIED_SVG = `<svg class="ci-verified" viewBox="0 0 24 24"><path d="M12 2l2.4 2.1 3.1-.4 1.1 3 3 1.1-.4 3.1L23.3 13l-2.1 2.4.4 3.1-3 1.1-1.1 3-3.1-.4L12 24l-2.4-2.1-3.1.4-1.1-3-3-1.1.4-3.1L.7 13l2.1-2.4-.4-3.1 3-1.1 1.1-3 3.1.4z" fill="currentColor" transform="scale(.92) translate(1,0)"/><path d="M8.5 12.5l2.5 2.5 4.5-5" fill="none" stroke="#f4f4f4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
  // Elena reads prop defaults from instance fields; attribute-style prop
  // names ("chat-id") can't be declared as class fields, so install them in
  // the constructor — otherwise every attribute set logs a
  // "Prop has no default" warning, which during refresh storms was
  // hundreds of console messages per second.
  constructor(...args) {
    super(...args);
    this["chat-id"] = null;
    this["active"] = null;
  }

  setData(chat) {
    this.chat = chat;
    this.setAttribute("chat-id", chat.id);
    this.requestUpdate();
  }

  render() {
    const c = this.chat;
    if (!c) return html`<div></div>`;
    const nameBadges =
      (c.kind === "single" && !c.encrypted ? OPEN_LOCK_SVG : "") +
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
        ${unsafeHTML(`<dc-avatar name="${escapeAttr(c.name)}" color="${c.avatarColor || ""}" kind="${c.kind}" size="48"${c.contactId ? ` contact-id="${c.contactId}"` : ""}${c.avatar ? ` avatar="${escapeAttr(fileUrl(c.avatar))}"` : ""}></dc-avatar>`)}
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
        ${unsafeHTML(`<dc-avatar name="${escapeAttr(c.name)}" color="${c.avatarColor || ""}" kind="${c.kind}" size="42"${c.contactId ? ` contact-id="${c.contactId}"` : ""}></dc-avatar>`)}
      </div>
      <div class="chat-head-text">
        <div class="cht-name"><span class="cht-name-text">${c.name}</span>${unsafeHTML((c.kind === "single" && !c.encrypted ? OPEN_LOCK_SVG : "") + (c.verified ? VERIFIED_SVG : ""))}</div>
        <div class="cht-status${online ? " online" : ""}">${stText}</div>
      </div>`;
  }
}
DcChatHead.define();

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
export function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
