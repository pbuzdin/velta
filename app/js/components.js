// components.js — Progressive Web Components built on Elena (@elenajs/core)
import { Elena, html, unsafeHTML } from "../vendor/elena.js";
import { formatListTime, timeAgo } from "./mock-core.js";
import { fileUrl, mediaFallbackUrl } from "./media.js";
import { ensurePoster } from "./poster.js";
import { diagnosticsSink } from "./diagnostics.js";
import { avatarBackgroundUrl, fingerprintFor, cachedFingerprint, fingerprintGroups } from "./avatar.js";

const AVATAR_SVG = `<svg viewBox="0 0 24 24" style="width:55%;height:55%"><path d="M12 4l2.2 4.7 5 .6-3.7 3.4 1 4.9-4.5-2.6-4.5 2.6 1-4.9L4.8 9.3l5-.6z" fill="currentColor"/></svg>`;
const DEVICE_SVG = `<svg viewBox="0 0 24 24" style="width:55%;height:55%"><rect x="5" y="3" width="14" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="17.5" r="1.2" fill="currentColor"/></svg>`;

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
    if (this.h && this.childElementCount === 0) {
      delete this.D;
      delete this.F;
      this.N?.();
    }
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
    return (this.name || "?").trim().split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w[0] || "")).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  }

  render() {
    const s = Number(this.size) || 46;
    const special = specialKind(this.kind);
    const style = `width:${s}px;height:${s}px;font-size:${Math.round(s * 0.38)}px;` +
      (special ? "" : `background:${this.color || "#777"};`);
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
        const bg = groups ? avatarBackgroundUrl({ groups, badge: false }) : "";
        return html`<div class="${cls}" style="${style}${bg ? `background-image:url('${bg}');background-size:100% 100%;` : ""}" aria-hidden="true"><span class="velta-avatar-photo"><img class="velta-avatar-img" src="${this.avatar}" alt="" loading="lazy"></span></div>`;
      }
      return html`<div class="${cls}" style="${style}" aria-hidden="true">${this.initials()}<img class="velta-avatar-img" src="${this.avatar}" alt="" loading="lazy"></div>`;
    }
    // GPG-fingerprint identity tile for photo-less single contacts:
    // equal-height color matrix with the fingerprint glyph on a dark badge,
    // as a CSS background (no child nodes — see avatarBackgroundUrl).
    if (!special && this.kind === "single") {
      const groups = fingerprintGroups(cachedFingerprint(Number(this["contact-id"])));
      const bg = groups ? avatarBackgroundUrl({ groups, badge: true }) : "";
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

/* ---------- <velta-video> — click-to-load video player ---------- */
// Every mounted <video> starts a decoder pipeline and issues media range
// requests for content the user may never play; in a multi-video chat that
// is decode churn, memory, and (over the asset protocol) seek requests we
// know can fail. Rows render a static placeholder instead; the real
// <video> element is created on tap and dropped again when the virtual
// scroller unmounts the row.
const PLAY_SVG = `<svg viewBox="0 0 24 24" style="width:100%;height:100%;display:block"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>`;
const VIDEO_FAIL_SVG = `<svg viewBox="0 0 24 24" style="width:100%;height:100%;display:block"><path d="M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

class VeltaVideo extends Elena(HTMLElement) {
  static tagName = "velta-video";
  static props = ["src", "duration", "name", "file", "size"];

  src = "";
  duration = "";
  name = "Video";
  file = "";   // raw file path — poster extraction source (src is a served URL)
  size = "";   // pre-formatted file size for the corner badge
  poster = ""; // cached WebP frame URL, resolved lazily
  #active = false;
  #posterRetries = 0; // poster img load attempts (survives Elena img swaps)
  #posterKicked = false;
  #failed = false;
  #lastSrc = null;

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
        if (!this.#active && this.src && !this.#failed) {
          e.stopPropagation(); // play - don't bubble into row selection/menu
          // Playback happens in the fullscreen video lightbox (wired via
          // setVideoLightboxOpener - components.js must not import ui.js);
          // inline bubble play is the fallback when no opener is wired.
          if (videoLightboxOpener) {
            videoLightboxOpener(this.src, this.name || "Video");
          } else {
            this.#active = true;
            this.requestUpdate();
          }
        }
      });
    }
    this.#kickPoster();
  }

  // Rows are virtualized, so being connected means being on screen: extract
  // (or read the cached) poster exactly once per file. The extraction reads
  // the file through the scoped Rust command — not the media URL — so it
  // never touches the range-broken serving path on Android.
  #kickPoster() {
    if (this.#posterKicked || this.poster || !this.file || !this.src) return;
    this.#posterKicked = true;
    diagnosticsSink.append("info", `poster kick: ${this.file}`);
    ensurePoster(this.file)
      .then((url) => {
        if (!url) diagnosticsSink.append("error", `poster kick: no url for ${this.file}`);
        if (url && this.isConnected && !this.#active) {
          this.poster = url;
          this.requestUpdate();
        }
      })
      .catch((e) => diagnosticsSink.append("error", `poster kick failed: ${e?.message || e}`));
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
    }
    const img = this.querySelector?.("img.velta-video-poster");
    if (img && !img.dataset.errBound) {
      img.dataset.errBound = "1";
      // Poster shape reservation: when the core had no dimensions the outer
      // .msg-video box carries no style (CSS fixed-band fallback). Once the
      // poster decodes we know the real shape — patch the box to it and tell
      // the chat view (delegated listener) the row height changed, or the
      // virtual scroller's layout math goes stale (same contract as
      // link-preview notifyHeight).
      img.addEventListener("load", () => {
        if (!img.naturalWidth || !img.naturalHeight) return;
        const host = this.closest?.(".msg-video");
        if (host && !host.style.aspectRatio) {
          host.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
          host.style.height = `min(${img.naturalHeight}px, 45vh, 260px)`;
          host.style.maxWidth = "100%";
          this.dispatchEvent(new CustomEvent("velta-row-resized", { bubbles: true }));
        }
      });
      // A broken poster must never shadow the plain placeholder. The asset
      // protocol occasionally fails a first request after launch (observed
      // net error, then 200 on retry). Elena re-renders replace the img
      // element, so the attempt counter lives HERE (component), not on the
      // img dataset - retries survive element swaps. 3 attempts, 1s backoff.
      img.addEventListener("error", () => {
        this.#posterRetries = (this.#posterRetries || 0) + 1;
        if (this.#posterRetries <= 3 && this.poster) {
          setTimeout(() => {
            if (this.isConnected && this.poster) {
              const fresh = this.querySelector?.("img.velta-video-poster");
              if (fresh) fresh.src = this.poster; // re-assign even if same URL
            }
          }, 1000);
        } else if (this.poster) {
          this.poster = ""; // give up: black band + play button (min-height)
          this.requestUpdate();
        }
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
      return html`<button type="button" class="velta-video-ph" aria-label="${this.ariaLabel()}">
        ${this.poster ? html`<img class="velta-video-poster" src="${this.poster}" alt="" decoding="async">` : ""}
        <span class="velta-video-play">${unsafeHTML(PLAY_SVG)}</span>
        ${this.size ? html`<span class="velta-video-size">${this.size}</span>` : ""}
        ${dur ? html`<span class="velta-video-dur">${dur}</span>` : ""}
      </button>`;
    }
    return html`<video controls autoplay playsinline preload="metadata" src="${this.src}"></video>`;
  }
}
VeltaVideo.define();

// Open-shackle lock, shown only on chats that can carry unencrypted mail
// (classic-email contacts), i.e. chat.isEncrypted === false. Encrypted chats
// show no lock at all — e2e is the default there, not something to celebrate.
const OPEN_LOCK_SVG = `<svg class="ci-lock open" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 017.6-1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
// Local (P2P) chats ride QUIC/TLS with the peer identity pinned by pairing —
// encrypted, so instead of the open lock they carry this wifi mark.
export const WIFI_SVG = `<svg class="ci-wifi" viewBox="0 0 24 24"><path d="M2.5 9.5a14 14 0 0119 0M5.5 13a9.5 9.5 0 0113 0M8.5 16.5a5 5 0 017 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="19.5" r="1.4" fill="currentColor"/></svg>`;
// Chat-name badge: p2p wifi replaces the open lock. (Core 2.61.0 stopped
// tracking contact verification — the old verified rosette is gone.)
const nameBadgesFor = c =>
  c.isP2p ? WIFI_SVG : c.kind === "single" && !c.encrypted ? OPEN_LOCK_SVG : "";
const PIN_SVG = `<svg class="ci-pin" viewBox="0 0 24 24"><path d="M9 4h6l1 7 3 3v2h-6v5l-1 1-1-1v-5H5v-2l3-3z" fill="currentColor"/></svg>`;
const MUTE_SVG = `<svg class="ci-mute" viewBox="0 0 24 24"><path d="M12 3a5 5 0 00-5 5v3l-2 4h14l-2-4V8a5 5 0 00-5-5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const TICK1 = `<svg class="ci-ticks" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Double check from Delta Chat desktop — fill-based, airier than the old
// stroked pair. 735×490 aspect; CSS boxes keep it centered via default meet.
const TICK2 = `<svg class="ci-ticks" viewBox="0 0 735 490"><g fill="currentColor"><path d="m143 340-92-92-51 50 122 122 22 23L489 98l-52-52z" transform="translate(0 1)"/><path d="M51 248 0 298l122 122 22 23L489 98l-52-52-294 294z" transform="translate(246 2)"/></g></svg>`;

// Dotted ring for in-flight sends — spins via the .ticks-spin CSS rule.
const SENDING_RING = [["12", "4"], ["17.7", "6.3"], ["20", "12"], ["17.7", "17.7"], ["12", "20"], ["6.3", "17.7"], ["4", "12"], ["6.3", "6.3"]]
  .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.7" fill="currentColor"/>`)
  .join("");

export function ticksSvg(state, cls = "ci-ticks") {
  if (state === "pending") return `<svg class="${cls} ticks-spin" viewBox="0 0 24 24">${SENDING_RING}</svg>`;
  if (state === "failed") return ""; // the bubble shows a resend button instead
  if (state === "sent") return TICK1.replace('ci-ticks', cls);
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
    const ticks = c.lastFrom === 1 && c.lastState ? ticksSvg(c.lastState) : "";
    const last = c.draft
      ? `<span class="draft">Draft:</span> ${escapeHtml(c.draft)}`
      : c.kind === "deaddrop"
        ? `<span class="draft">Contact request:</span> ${escapeHtml(c.lastMsg || "tap to accept")}`
        : c.lastMsg ? escapeHtml(c.lastMsg) : "";
    return html`
      <div class="chat-item${this.active !== null && this.active !== undefined && this.getAttribute("active") !== null ? " active" : ""}" role="option">
        ${unsafeHTML(`<velta-avatar name="${escapeAttr(c.name)}" color="${c.avatarColor || ""}" kind="${c.kind}" size="48"${c.contactId ? ` contact-id="${c.contactId}"` : ""}${c.avatar ? ` avatar="${escapeAttr(fileUrl(c.avatar))}"` : ""}></velta-avatar>`)}
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
    if (c.kind === "group") return c.memberCount ? `${c.memberCount} members` : "…";
    if (c.kind === "channel") return `${(c.memberCount || 0).toLocaleString()} subscribers`;
    if (c.kind === "saved") return "your personal space";
    if (c.kind === "device") return "local device messages";
    if (c.contact) {
      if (c.contact.bot) return "bot";
      if (c.contact.online) return { online: true, text: "online" };
      // lastSeen null = never seen (core sends 0) — no honest status line.
      if (!c.contact.lastSeen) return "";
      return "last seen " + timeAgo(c.contact.lastSeen);
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
        ${unsafeHTML(`<velta-avatar name="${escapeAttr(c.name)}" color="${c.avatarColor || ""}" kind="${c.kind}" size="42"${c.contactId ? ` contact-id="${c.contactId}"` : ""}${c.avatar ? ` avatar="${escapeAttr(fileUrl(c.avatar))}"` : ""}></velta-avatar>`)}
      </div>
      <div class="chat-head-text">
        <div class="cht-name"><span class="cht-name-text">${c.name}</span>${unsafeHTML(nameBadgesFor(c))}</div>
        <div class="cht-status${online ? " online" : ""}">${stText}</div>
      </div>`;
  }
}
VeltaChatHead.define();

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
export function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
