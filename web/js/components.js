// components.js — Progressive Web Components built on Elena (@elenajs/core)
import { Elena, html, unsafeHTML } from "../vendor/elena.js";
import { formatListTime, timeAgo, timeTag, formatDuration } from "./format.js";
import { fileUrl, mediaFallbackUrl } from "./media.js";
import { diagnosticsSink } from "./diagnostics.js";
import { avatarBackgroundUrl, fingerprintFor, cachedFingerprint, cachedFingerprintIsDerived, fingerprintGroups } from "./avatar.js";
import { avatarFill } from "./name-color.js";
import { P, svg, labelled } from "./icons.js";
import { t } from "./i18n.js";

const AVATAR_SVG = svg(P.avatarStar, "", 'style="width:55%;height:55%"');
const DEVICE_SVG = svg(P.device, "", 'style="width:55%;height:55%"');

/* ---------- <velta-avatar> ---------- */
function specialKind(kind) { return kind === "saved" || kind === "device"; }
class VeltaAvatar extends Elena(HTMLElement) {
  static tagName = "velta-avatar";
  static props = ["name", "color", "kind", "size", "avatar", "contact-id", "addr"];

  name = "?";
  color = "#777";
  kind = "single";
  size = "46";
  avatar = "";
  addr = ""; // no default → Elena warns once per instance on every render
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
    this._heal();
    // The same diff runs on every in-place re-render of the HOST (a chat
    // item's setData/requestUpdate, chat head refresh): the host's template
    // holds a bare <velta-avatar>, so the diff strips our tile while we stay
    // connected and none of our attributes change, i.e. nothing re-renders
    // us. The row was left with an empty, zero-width avatar. Watch our own
    // children and heal whenever a diff empties us (microtask, before paint).
    if (!this._healObserver && typeof MutationObserver !== "undefined") {
      this._healObserver = new MutationObserver(() => this._heal());
    }
    this._healObserver?.observe(this, { childList: true });
    // Identity tiles need the contact's fingerprint — resolve it once per
    // contact and re-render when it arrives (initials show until then).
    // Photo contacts need it too: the photo is padded onto the color matrix.
    if (!specialKind(this.kind) && Number(this["contact-id"]) >= 1) {
      fingerprintFor(Number(this["contact-id"]), this.addr)
        .then((fpr) => { if (fpr && this.isConnected) this.requestUpdate(); })
        .catch(() => {});
    }
    // Bind the img wiring on first connect too: updated() fires only on
    // re-renders, and a first render that never gets a follow-up update
    // (fingerprint already cached) stayed unbound — its img shimmered
    // forever. rAF = after Elena's synchronous first render, before paint.
    requestAnimationFrame(() => this._bindImg());
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    this._healObserver?.disconnect();
  }

  // Re-render through Elena's first-render path when we are connected,
  // already hydrated, but empty (see connectedCallback).
  _heal() {
    if (!this.isConnected || !this.h || this.childElementCount !== 0) return;
    delete this.D;
    delete this.F;
    this.N?.();
    this._bindImg();
  }

  willUpdate() {
    if (this.#lastAvatar !== this.avatar) {
      this.#lastAvatar = this.avatar;
      this.#avatarFailed = false;
    }
  }

  updated() {
    this._bindImg();
  }

  // Idempotent per img node (dataset guard): error fallback + shimmer stop.
  _bindImg() {
    const img = this.querySelector?.("img.velta-avatar-img");
    if (!img || img.dataset.errBound) return;
    img.dataset.errBound = "1";
    img.addEventListener("error", () => {
      this.#avatarFailed = true;
      this.requestUpdate();
    });
    // Skeleton shimmer: stop it the moment the bytes decode — a background
    // left in place would shimmer forever under a transparent-PNG avatar.
    const loaded = () => img.classList.add("loaded");
    if (img.complete && img.naturalWidth > 0) loaded();
    else img.addEventListener("load", loaded, { once: true });
  }

  initials() {
    // \p{L}\p{N} with the u flag: any Unicode letter or digit — a Cyrillic
    // (or CJK, etc.) name must not fall through to the "?" tile (#151).
    return (this.name || "?").trim().split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w[0] || "")).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  }

  render() {
    const s = Number(this.size) || 46;
    const special = specialKind(this.kind);
    const style = `width:${s}px;height:${s}px;font-size:${Math.round(s * 0.38)}px;` +
      (special ? "" : `background:${avatarFill(this.color || "#777")};`);
    const cls = "velta-avatar-tile" + (special ? " saved" : "") + (!special && this.kind === "single" ? " identity" : "");
    // The initials stay underneath as the loading/failure fallback; the img
    // is absolutely positioned and covers them once it decodes.
    if (!special && this.avatar && !this.#avatarFailed) {
      if (this.kind === "single") {
        // Photo padded onto the contact's color matrix — the grid always
        // stays visible around it (plain color until the fingerprint
        // resolves). Grid rides as a CSS background: no SVG child nodes.
        // Single-quoted url(): the encoded SVG contains no raw quotes.
        const groups = fingerprintGroups(cachedFingerprint(Number(this["contact-id"])));
        const bg = groups ? avatarBackgroundUrl({ groups, badge: false, mono: cachedFingerprintIsDerived(Number(this["contact-id"])) }) : "";
        return html`<div class="${cls}" style="${style}${bg ? `background-image:url('${bg}');background-size:100% 100%;` : ""}" aria-hidden="true"><span class="velta-avatar-photo"><img class="velta-avatar-img" src="${this.avatar}" alt="" loading="lazy"></span></div>`;
      }
      return html`<div class="${cls}" style="${style}" aria-hidden="true">${this.initials()}<img class="velta-avatar-img" src="${this.avatar}" alt="" loading="lazy"></div>`;
    }
    // GPG-fingerprint identity tile for photo-less single contacts:
    // equal-height color matrix with the fingerprint glyph on a dark badge,
    // as a CSS background (no child nodes — see avatarBackgroundUrl).
    if (!special && this.kind === "single") {
      const groups = fingerprintGroups(cachedFingerprint(Number(this["contact-id"])));
      const bg = groups ? avatarBackgroundUrl({ groups, badge: true, mono: cachedFingerprintIsDerived(Number(this["contact-id"])) }) : "";
      if (bg) return html`<div class="${cls}" style="${style}background-image:url('${bg}');background-size:100% 100%;" aria-hidden="true"></div>`;
    }
    const inner = this.kind === "saved" ? unsafeHTML(AVATAR_SVG)
      : this.kind === "device" ? unsafeHTML(DEVICE_SVG)
      : this.initials();
    return html`<div class="${cls}" style="${style}" aria-hidden="true">${inner}</div>`;
  }
}
VeltaAvatar.define();

// Video playback route: chat-view.js injects ui.js's openVideoLightbox here
// (components.js must not import ui.js - ui imports this module). When
// unwired, <velta-video> falls back to inline bubble playback.
let videoLightboxOpener = null;
export function setVideoLightboxOpener(fn) { videoLightboxOpener = fn; }
// Chat swipes set this so the click a WebView still fires on finger-up
// does not also open the lightbox (#139).
let gestureSwipeAt = 0;
export function noteGestureSwipe() { gestureSwipeAt = Date.now(); }
export function gestureSwipeRecent(now = Date.now()) { return now - gestureSwipeAt < 400; }

/* ---------- <velta-video> — click-to-load video player ---------- */
// Every mounted <video> starts a decoder pipeline and issues media range
// requests for content the user may never play; in a multi-video chat that
// is decode churn, memory, and (over the asset protocol) seek requests we
// know can fail. Rows render a static placeholder instead; the real
// <video> element is created on tap and dropped again when the virtual
// scroller unmounts the row.
const PLAY_SVG = svg(P.videoPlay, "", 'style="width:100%;height:100%;display:block"');
const VIDEO_FAIL_SVG = svg(P.trash, "", 'style="width:100%;height:100%;display:block"');

class VeltaVideo extends Elena(HTMLElement) {
  static tagName = "velta-video";
  static props = ["src", "duration", "name", "file", "size"];

  src = "";
  duration = "";
  name = "Video";
  file = "";   // raw file path — fallback URL source (src is a served URL)
  size = "";   // pre-formatted file size for the corner badge
  #failed = false;
  #lastSrc = null;
  #shaped = false; // host box already patched to the real aspect

  connectedCallback() {
    super.connectedCallback?.();
    // Self-heal (same Elena diff quirk as VeltaAvatar): a re-render pass can
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
        if (gestureSwipeRecent()) { e.preventDefault(); e.stopPropagation(); return; }
        if (!this.#failed && this.src) {
          e.stopPropagation(); // play - don't bubble into row selection/menu
          // Playback happens in the fullscreen video lightbox (wired via
          // setVideoLightboxOpener - components.js must not import ui.js);
          // inline controls are the fallback when no opener is wired.
          if (videoLightboxOpener) {
            videoLightboxOpener(this.src, this.name || "Video");
          }
        }
      });
    }
  }

  willUpdate() {
    if (this.#lastSrc !== this.src) {
      this.#lastSrc = this.src;
      this.#failed = false;
      this.#shaped = false;
    }
  }

  updated() {
    const v = this.querySelector?.("video");
    if (v && !v.dataset.errBound) {
      v.dataset.errBound = "1";
      // Native controls only when no lightbox opener is wired (raw fallback
      // — inline playback with seek/pause). With the opener the single play
      // affordance is the centered overlay below; native controls would add
      // a second button (on Android a large centered one).
      v.controls = !videoLightboxOpener;
      // Centered play affordance: visible while paused (incl. frame 0),
      // hidden while playing — the native controls stay for seek/pause.
      const card = v.parentElement;
      v.addEventListener("play", () => card?.classList.add("playing"));
      v.addEventListener("pause", () => card?.classList.remove("playing"));
      v.addEventListener("error", () => {
        // parkMedia clears src and load()s so an off-screen row drops its
        // decoder; that fires error. Not a load failure.
        if (v.dataset.parkedSrc || !v.getAttribute("src")) return;
        // WebView2's media stack bypasses custom-protocol interception even
        // when images through the same scheme load, so a blobfile src can
        // fail here on an otherwise healthy setup — swap to the legacy chain
        // (media HTTP server / asset protocol) once before giving up.
        const fb = mediaFallbackUrl(this.file);
        if (fb && this.src && this.src !== fb && this.dataset.fallback !== "1") {
          this.dataset.fallback = "1";
          this.src = fb; // willUpdate clears #failed; re-render replays
          this.requestUpdate();
          return;
        }
        this.#failed = true;
        this.requestUpdate();
        diagnosticsSink.append("error", `video "${this.name}" failed to load`);
      });
      // Shape the host box from the real video dimensions once metadata
      // arrives (native preload — replaces the poster-extraction pipeline):
      // portrait/landscape videos get their true aspect instead of the
      // 260px fixed band. Telling the chat view keeps the virtual scroller's
      // math fresh (same contract as link-preview notifyHeight).
      v.addEventListener("loadedmetadata", () => {
        if (this.#shaped || !v.videoWidth || !v.videoHeight) return;
        this.#shaped = true;
        const host = this.closest?.(".msg-video");
        if (host && !host.style.aspectRatio) {
          host.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
          host.style.height = `min(${v.videoHeight}px, 45vh, 260px)`;
          host.style.maxWidth = "100%";
          this.dispatchEvent(new CustomEvent("velta-row-resized", { bubbles: true }));
        }
      });
    }
  }

  ariaLabel() {
    return "Play " + (this.name || "Video");
  }

  render() {
    if (this.#failed) {
      return html`<div class="media-fail"><div class="media-fail-ico">${unsafeHTML(VIDEO_FAIL_SVG)}</div><div>${escapeHtml(t("Video can't be played"))}</div></div>`;
    }
    // Native preload as the poster: metadata + a first-frame fetch via the
    // #t fragment paints frame 0 with no extraction pipeline at all. The
    // click handler above routes taps to the lightbox; no `controls` here —
    // Android WebView draws its own large centered play button on controls
    // videos, which stacked on top of the overlay below (two play buttons
    // near the same spot). The no-opener fallback re-adds them in updated().
    const d = Number(this.duration) || 0;
    const dur = d > 0 ? formatDuration(d) : "";
    return html`<div class="velta-video-card">
      <video preload="metadata" playsinline src="${this.src}${this.src.includes("#") ? "" : "#t=0.1"}"></video>
      <span class="velta-video-play">${unsafeHTML(PLAY_SVG)}</span>
      ${this.size ? html`<span class="velta-video-size">${this.size}</span>` : ""}
      ${dur ? html`<span class="velta-video-dur">${dur}</span>` : ""}
    </div>`;
  }
}
VeltaVideo.define();

// Open-shackle lock, shown only on chats that can carry unencrypted mail
// (classic-email contacts), i.e. chat.isEncrypted === false. Encrypted chats
// show no lock at all — e2e is the default there, not something to celebrate.
const OPEN_LOCK_SVG = labelled(svg(P.lockOpen, "ci-lock open"), t("Not encrypted"));
// Local (P2P) chats ride QUIC/TLS with the peer identity pinned by pairing —
// encrypted, so instead of the open lock they carry this wifi mark.
export const WIFI_SVG = svg(P.wifi, "ci-wifi");
// Chat-name badge: p2p wifi replaces the open lock. (Core 2.61.0 stopped
// tracking contact verification — the old verified rosette is gone.)
const nameBadgesFor = c =>
  c.isP2p ? WIFI_SVG : c.kind === "single" && !c.encrypted ? OPEN_LOCK_SVG : "";
const PIN_SVG = labelled(svg(P.pin, "ci-pin"), t("Pinned"));
const MUTE_SVG = labelled(svg(P.mute, "ci-mute"), t("Muted"));
const TICK1 = labelled(svg(P.tick1, "ci-ticks"), t("Sent"));
// Double check on the 24 grid, same stroke as the single tick.
const TICK2 = labelled(svg(P.tick2, "ci-ticks"), t("Seen"));

// Dotted ring for in-flight sends — spins via the .ticks-spin CSS rule.
const SENDING_RING = [["12", "4"], ["17.7", "6.3"], ["20", "12"], ["17.7", "17.7"], ["12", "20"], ["6.3", "17.7"], ["4", "12"], ["6.3", "6.3"]]
  .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.7" fill="currentColor"/>`)
  .join("");

export function ticksSvg(state, cls = "ci-ticks") {
  if (state === "pending") return `<svg role="img" aria-label="${escapeHtml(t("Sending"))}" focusable="false" class="${cls} ticks-spin" viewBox="0 0 24 24">${SENDING_RING}</svg>`;
  // Failed: a bold exclamation — squash-tolerant in the chat list's 3:2 tick
  // box (a circled icon would render as an ellipse). Colored red via CSS.
  if (state === "failed") return labelled(svg(P.failedMark, `${cls} failed`), t("Failed to send"));
  // Core semantics: OutDelivered = the RELAY accepted it (one check);
  // OutMdnRcvd = the recipient's client confirmed seen (two checks).
  if (state === "sent" || state === "delivered") return TICK1.replace('ci-ticks', cls);
  const read = state === "read" ? " read" : "";
  return TICK2.replace('ci-ticks', cls + read);
}

/* ---------- <velta-chat-item> ---------- */
class VeltaChatItem extends Elena(HTMLElement) {
  static tagName = "velta-chat-item";
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
    // "" (string), NOT null: Elena picks the conversion from typeof the
    // default — typeof null is "object", which made it JSON-parse every
    // attribute value, logging "Invalid JSON: c49" for the string ids the
    // pick/forward lists use. app.js reads the attribute back with
    // Number(...) so a string default is safe here too.
    this["chat-id"] = "";
    this["active"] = "";
  }

  setData(chat) {
    this.chat = chat;
    this.setAttribute("chat-id", chat.id);
    this.requestUpdate();
  }

  render() {
    const c = this.chat;
    if (!c) return html`<div></div>`;
    const nameBadges = nameBadgesFor(c);
    let right;
    if (c.unread > 0) right = `<span class="ci-badge${c.muted ? " muted" : ""}">${c.unread > 999 ? "999+" : c.unread}</span>`;
    else if (c.pinned) right = PIN_SVG;
    else if (c.muted) right = MUTE_SVG;
    else right = "";
    const ticks = !c.typingText && c.lastFrom === 1 && c.lastState ? ticksSvg(c.lastState) : "";
    const last = c.typingText
      ? `<span class="typing">${escapeHtml(c.typingText)}</span>`
      : c.draft
      ? `<span class="draft">Draft:</span> ${escapeHtml(c.draft)}`
      : c.kind === "deaddrop"
        ? `<span class="draft">${escapeHtml(t("Contact request:"))}</span> ${escapeHtml(c.lastMsg || t("tap to accept"))}`
        : c.lastMsg ? escapeHtml(c.lastMsg) : "";
    return html`
      <div class="chat-item${this.active !== null && this.active !== undefined && this.getAttribute("active") !== null ? " active" : ""}" role="option">
        ${unsafeHTML(`<velta-avatar name="${escapeAttr(c.name)}" color="${c.avatarColor || ""}" kind="${c.kind}" size="48"${c.contactId ? ` contact-id="${c.contactId}"` : ""}${c.contact?.addr ? ` addr="${escapeAttr(c.contact.addr)}"` : ""}${c.avatar ? ` avatar="${escapeAttr(fileUrl(c.avatar))}"` : ""}></velta-avatar>`)}
        <div class="ci-main">
          <div class="ci-top">
            <div class="ci-name">${c.name} ${unsafeHTML(nameBadges)}</div>
            <div class="ci-time">${c.lastTs ? unsafeHTML(timeTag(c.lastTs, formatListTime(c.lastTs))) : ""}</div>
          </div>
          <div class="ci-bottom">
            <div class="ci-last">${unsafeHTML(ticks)} ${unsafeHTML(last)}</div>
            ${unsafeHTML(right)}
          </div>
        </div>
      </div>`;
  }
}
VeltaChatItem.define();

/* ---------- <velta-chat-head> ---------- */
class VeltaChatHead extends Elena(HTMLElement) {
  static tagName = "velta-chat-head";
  static events = ["click"];

  chat = null;

  setData(chat) { this.chat = chat; this.requestUpdate(); }

  statusLine() {
    const c = this.chat;
    if (!c) return "";
    if (c.typingText) return { online: true, text: c.typingText };
    if (c.isP2pGroup) {
      if (c.readOnly) return t("no longer active");
      const n = c.memberCount || 0, on = c.onlineCount || 0;
      return n === 1 ? t("1 member · {online} online", { online: on }) : t("{n} members · {online} online", { n, online: on });
    }
    if (c.kind === "group") return c.memberCount ? (c.memberCount === 1 ? t("1 member") : t("{n} members", { n: c.memberCount })) : "…";
    if (c.kind === "channel") return (c.memberCount || 0) === 1 ? t("1 subscriber") : t("{n} subscribers", { n: (c.memberCount || 0).toLocaleString() });
    if (c.kind === "saved") return t("your personal space");
    if (c.kind === "device") return t("local device messages");
    if (c.contact) {
      if (c.contact.bot) return t("bot");
      if (c.contact.online) return { online: true, text: t("online") };
      // lastSeen null = never seen (core sends 0) — no honest status line.
      if (!c.contact.lastSeen) return "";
      return t("last seen {when}", { when: timeAgo(c.contact.lastSeen) });
    }
    return "";
  }

  render() {
    const c = this.chat;
    if (!c) return html`<div></div>`;
    const st = this.statusLine();
    const online = typeof st === "object" && st.online;
    const stText = typeof st === "object" ? st.text : st;
    const stHtml = (c.contact?.lastSeen && typeof st === "string" && st.startsWith("last seen"))
      ? timeTag(c.contact.lastSeen, st)
      : escapeHtml(stText);
    return html`
      <div class="chat-head-avatar">
        ${unsafeHTML(`<velta-avatar name="${escapeAttr(c.name)}" color="${c.avatarColor || ""}" kind="${c.kind}" size="42"${c.contactId ? ` contact-id="${c.contactId}"` : ""}${c.contact?.addr ? ` addr="${escapeAttr(c.contact.addr)}"` : ""}${c.avatar ? ` avatar="${escapeAttr(fileUrl(c.avatar))}"` : ""}></velta-avatar>`)}
      </div>
      <div class="chat-head-text">
        <div class="cht-name"><span class="cht-name-text">${c.name}</span>${unsafeHTML(nameBadgesFor(c))}</div>
        <div class="cht-status${online ? " online" : ""}">${unsafeHTML(stHtml)}</div>
      </div>`;
  }
}
VeltaChatHead.define();

// Imported for local use AND re-exported: a bare `export … from` creates no
// local binding, so every render that escapes (chat items, avatars) threw.
import { escapeHtml, escapeAttr } from "./format.js";
export { escapeHtml, escapeAttr };
