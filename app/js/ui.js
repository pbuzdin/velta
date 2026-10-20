// ui.js — popup/menu/modal/drawer/toast helpers (plain DOM, no framework)
import { escapeHtml, escapeAttr, ticksSvg } from "./components.js";
import { shouldNotifyIncoming } from "./notify-policy.js";
import { fileUrl } from "./media.js";
import { linkPreviewMode, setLinkPreviewMode, LINK_PREVIEW_LABELS, LINK_PREVIEW_IP_WARNING } from "./link-preview.js";
import { trackingStripEnabled, setTrackingStripEnabled } from "./trackers.js";
import { APP_VERSION } from "./version.gen.js";
import { formatSplashVersion } from "./format.js";
import { searchEmoji } from "./emoji.js";
import { isAndroid, isTauri, tauriInvoke } from "./tauri.js";
import { collectDeviceInfo, formatDeviceInfo, measureSafeArea } from "./device-info.js";
import { canShareLink, shareLink } from "./qr-actions.js";
import { MD_HINT, MD_REENABLED_NOTE, DL_LIMIT_HINT, mdLabel } from "./multidevice.js";

const popups = () => document.getElementById("popups");

// Popover API: Chromium 114+ and Safari 17+. macOS 10.15/11 stay on the overlay.
export function popoverSupported() {
  return typeof HTMLElement === "function" && Object.prototype.hasOwnProperty.call(HTMLElement.prototype, "popover");
}

// #toasts is popover=manual so it paints above lightbox and full-screen overlays.
// Re-show after each of those opens; the newest top-layer entry would cover it.
export function raiseToasts() {
  const box = document.getElementById("toasts");
  if (!box || !popoverSupported() || !box.childElementCount) return;
  try {
    if (!box.hasAttribute("popover")) box.setAttribute("popover", "manual");
    if (!box.matches(":popover-open")) box.showPopover();
  } catch { box.removeAttribute("popover"); }
}

function hideToastsIfEmpty() {
  const box = document.getElementById("toasts");
  if (!box || !popoverSupported() || box.childElementCount) return;
  try { if (box.matches(":popover-open")) box.hidePopover(); } catch {}
}

let activeDrawer = null; // set by buildDrawer, closed by closeAllPopups
let activeModalClose = null;
let modalReplacing = false; // a showModal→closeAllPopups pair is mid-flight — skip the history consume

// House close icon: bold stroke to match the other icon buttons (the
// unicode ✕ renders hairline-thin). Used by modals, the image lightbox, the
// HTML/full-message overlay, and toasts.
export const CLOSE_SVG =
  '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

export function closeAllPopups() {
  activeModalClose?.();
  popups().replaceChildren();
  // the drawer lives outside #popups — close it explicitly, otherwise an
  // open drawer whose overlay was just wiped becomes impossible to dismiss
  activeDrawer?.close();
}

// Under the interface scale (zoom on <html>) rects, clientX and innerWidth
// are viewport px but a px written to style is multiplied by the zoom, so
// positions computed from them must be divided back (or menus land off-screen).
export function uiZoom() {
  return parseFloat(globalThis.document?.documentElement?.style?.zoom) || 1;
}

function placeMenu(menu, x, y) {
  const r = menu.getBoundingClientRect(), z = uiZoom();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 10)) / z + "px";
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 10)) / z + "px";
}

// #136: a menu button that turns into a close (X) button while its menu is
// open. A second tap closes the menu; any other close (outside tap, Esc, a
// pick, Android Back, closeAllPopups) restores the icon — the menu element's
// removal from the DOM is the single signal. `open(e)` returns the menu.
export const MENU_CLOSE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
export function bindMenuToggle(btn, open, { closeLabel = "Close menu" } = {}) {
  const st = { menu: null, obs: null, wasOpen: false, icon: null, label: null, title: null };
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  const restore = () => {
    if (!st.menu) return;
    st.obs?.disconnect();
    st.menu = null; st.obs = null;
    btn.innerHTML = st.icon;
    if (st.label != null) btn.setAttribute("aria-label", st.label);
    if (st.title != null) btn.title = st.title;
    btn.setAttribute("aria-expanded", "false");
    btn.classList.remove("menu-open");
  };
  // Popover light-dismiss hides the menu on pointerup of the same tap that
  // hits the button (before click); pointerdown still sees it open, so the
  // click closes instead of reopening.
  btn.addEventListener("pointerdown", () => { st.wasOpen = !!st.menu; }, true);
  btn.addEventListener("click", (e) => {
    const wasOpen = st.wasOpen || !!st.menu;
    st.wasOpen = false;
    if (wasOpen) { if (st.menu) closeAllPopups(); restore(); return; }
    const menu = open(e);
    if (!menu || !menu.isConnected) return;
    st.icon = btn.innerHTML; st.label = btn.getAttribute("aria-label"); st.title = btn.getAttribute("title");
    st.menu = menu;
    btn.innerHTML = MENU_CLOSE_SVG;
    btn.setAttribute("aria-label", closeLabel);
    btn.title = closeLabel;
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("menu-open");
    const root = menu.parentNode;
    st.obs = new MutationObserver(() => { if (!menu.isConnected) restore(); });
    st.obs.observe(root, { childList: true });
    menu.addEventListener("toggle", (ev) => { if (ev.newState === "closed") restore(); });
  });
  return { isOpen: () => !!st.menu, restore };
}

export function showContextMenu(items, x, y) {
  closeAllPopups();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const it of items) {
    if (it === "-") {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctx-item" + (it.danger ? " danger" : "") + (it.pressed ? " pressed" : "");
    if (it.pressed !== undefined) b.setAttribute("aria-pressed", it.pressed ? "true" : "false");
    if (it.ariaLabel) b.setAttribute("aria-label", it.ariaLabel);
    b.innerHTML = (it.icon || "") + "<span>" + escapeHtml(it.label) + "</span>";
    b.addEventListener("click", () => { closeAllPopups(); it.onClick?.(); });
    menu.appendChild(b);
  }
  openLightDismiss(menu);
  placeMenu(menu, x, y);
  return menu;
}

// Light-dismiss popup in #popups: a native auto popover (removed when it
// closes) where supported, else behind a transparent overlay that closes
// on any outside tap. Returns true when shown as a popover.
function openLightDismiss(el) {
  if (popoverSupported()) {
    el.popover = "auto";
    el.addEventListener("toggle", (e) => {
      if (e.newState === "closed") el.remove();
    });
    popups().append(el);
    try { el.showPopover(); return true; }
    catch { el.removeAttribute("popover"); el.remove(); }
  }
  const overlay = document.createElement("div");
  overlay.className = "pop-overlay transparent";
  overlay.addEventListener("pointerdown", closeAllPopups);
  overlay.addEventListener("contextmenu", e => { e.preventDefault(); closeAllPopups(); });
  popups().append(overlay, el);
  return false;
}

// Consecutive items that share `pair` sit on one row (at most two).
// A danger item is its own full-width row. "-" is dropped.
export function messageSheetRows(items) {
  const rows = [];
  for (const it of items) {
    if (it === "-") continue;
    const prev = rows.at(-1);
    if (it.pair && !it.danger && prev?.pair === it.pair && prev.items.length < 2) prev.items.push(it);
    else rows.push({ pair: it.pair || "", full: !!it.danger, items: [it] });
  }
  return rows;
}

function sheetAction(it) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ctx-item" + (it.danger ? " danger" : "");
  b.innerHTML = (it.icon || "") + "<span>" + escapeHtml(it.short || it.label) + "</span>";
  b.addEventListener("click", () => { closeAllPopups(); it.onClick?.(); });
  return b;
}

// Mobile message menu: emoji grid, then related actions in two columns.
// The last reaction cell opens a searchable tray and does not send a reaction.
export function showMessageSheet({ reactions = [], selected = null, onReact, items }) {
  closeAllPopups();
  const menu = document.createElement("div");
  menu.className = "ctx-menu msg-sheet";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Message actions");
  const grab = document.createElement("div");
  grab.className = "msg-sheet-grab";
  grab.setAttribute("aria-hidden", "true");
  menu.append(grab);

  if (reactions.length) {
    const reacts = document.createElement("div");
    reacts.className = "msg-reacts";
    const shown = selected && !reactions.includes(selected) ? [selected, ...reactions.slice(0, -1)] : reactions;
    for (const emoji of shown) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "msg-react" + (emoji === selected ? " mine" : "");
      b.textContent = emoji;
      b.setAttribute("aria-pressed", emoji === selected ? "true" : "false");
      b.setAttribute("aria-label", emoji === selected ? `Remove reaction ${emoji}` : emoji);
      b.addEventListener("click", () => { closeAllPopups(); onReact?.(emoji); });
      reacts.append(b);
    }
    const more = document.createElement("button");
    more.type = "button";
    more.className = "msg-react msg-react-more";
    more.setAttribute("aria-label", "More emoji");
    more.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 14.2c1.2 1.1 2.5 1.6 4 1.6s2.8-.5 4-1.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/></svg>`;
    const tray = document.createElement("div");
    tray.className = "msg-emoji-tray";
    tray.hidden = true;
    const back = document.createElement("button");
    back.type = "button";
    back.className = "msg-emoji-back";
    back.textContent = "Back";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "text-field";
    search.placeholder = "Search emoji";
    search.setAttribute("aria-label", "Search emoji");
    search.autocomplete = "off";
    const grid = document.createElement("div");
    grid.className = "msg-emoji-grid";
    const paint = () => {
      const found = searchEmoji(search.value);
      grid.replaceChildren();
      if (!found.length) {
        const empty = document.createElement("div");
        empty.className = "msg-emoji-empty";
        empty.textContent = "No emoji";
        grid.append(empty);
        return;
      }
      for (const e of found) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "msg-emoji";
        b.textContent = e.emoji;
        b.setAttribute("aria-label", e.name);
        b.addEventListener("click", () => { closeAllPopups(); onReact?.(e.emoji); });
        grid.append(b);
      }
    };
    search.addEventListener("input", paint);
    more.addEventListener("click", () => {
      reacts.hidden = true;
      tray.hidden = false;
      paint();
      search.focus();
    });
    back.addEventListener("click", () => {
      search.value = "";
      tray.hidden = true;
      reacts.hidden = false;
    });
    tray.append(back, search, grid);
    reacts.append(more);
    menu.append(reacts, tray);
  }

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  for (const row of messageSheetRows(items)) {
    const wrap = document.createElement("div");
    wrap.className = row.full ? "msg-row-full" : "msg-pair";
    if (row.pair) wrap.dataset.pair = row.pair;
    for (const it of row.items) wrap.append(sheetAction(it));
    actions.append(wrap);
  }
  menu.append(actions);

  const overlay = document.createElement("div");
  overlay.className = "pop-overlay";
  overlay.addEventListener("pointerdown", closeAllPopups);
  overlay.addEventListener("contextmenu", e => { e.preventDefault(); closeAllPopups(); });
  popups().append(overlay, menu);
  return menu;
}

export function showStickerPicker({ getStickers, onPick }) {
  closeAllPopups();
  const pop = document.createElement("div");
  pop.className = "sticker-pop";
  const grid = document.createElement("div");
  grid.className = "sticker-grid";
  grid.innerHTML = `<div class="sticker-note">Loading…</div>`;
  pop.append(grid);
  openLightDismiss(pop);
  Promise.resolve(getStickers()).then((collections) => {
    grid.replaceChildren();
    let n = 0;
    for (const [name, paths] of Object.entries(collections || {})) {
      if (!Array.isArray(paths) || !paths.length) continue;
      const head = document.createElement("div");
      head.className = "sticker-coll";
      head.textContent = name;
      grid.append(head);
      for (const p of paths) {
        const t = document.createElement("button");
        t.type = "button";
        t.className = "sticker-tile";
        // MockCore ships emoji placeholders ("mock:😀") — real files go
        // through the regular media URL chain.
        if (String(p).startsWith("mock:")) t.textContent = p.slice(5);
        else t.innerHTML = `<img src="${escapeAttr(fileUrl(p))}" alt="" loading="lazy">`;
        t.addEventListener("click", () => { closeAllPopups(); onPick(p); });
        grid.append(t);
        n++;
      }
    }
    if (!n) grid.innerHTML = `<div class="sticker-note">No stickers yet.<br>Long-press a sticker you received and choose “Save sticker”.</div>`;
  }).catch(() => {
    grid.innerHTML = `<div class="sticker-note">Couldn't load stickers.</div>`;
  });
  return pop;
}

// Modal footer as a fragment (its buttons become direct children of
// .modal-foot -> one-row flex): a Cancel-style button plus an optional
// action button. okType "submit" pairs with showModal({ form: true }).
export function footButtons(okLabel = null, { cancelLabel = "Cancel", okType = "button", okClass = "btn-text" } = {}) {
  const foot = document.createDocumentFragment();
  const button = (text, type, className) => {
    const b = document.createElement("button");
    b.type = type;
    b.className = className;
    b.textContent = text;
    return b;
  };
  const cancel = button(cancelLabel, "button", "btn-text");
  const ok = okLabel == null ? null : button(okLabel, okType, okClass);
  foot.append(...(ok ? [cancel, ok] : [cancel]));
  return { foot, cancel, ok };
}

export function showModal({ title, body, foot, onClose, compact = false, form = false }) {
  // Android BACK must close a modal, not exit the app: the modal rides a
  // history entry (same contract as the lightbox). When a modal replaces
  // another, the entry is reused — history.back() is async, so a
  // back-here-push-there pair would race and lose the replacement's entry.
  modalReplacing = true;
  closeAllPopups();
  modalReplacing = false;
  const overlay = document.createElement("div");
  overlay.className = "pop-overlay";
  const modal = document.createElement("div");
  // compact: keep the floating card even on phones (confirmations); the
  // default grows to the full viewport on narrow screens (task modals).
  modal.className = compact ? "modal modal-compact" : "modal";
  const head = document.createElement("div");
  head.className = "modal-head";
  head.innerHTML = `<div class="modal-title">${escapeHtml(title)}</div>`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-btn";
  close.innerHTML = CLOSE_SVG;
  let closed = false;
  const doClose = () => {
    if (closed) return;
    closed = true;
    if (activeModalClose === doClose) activeModalClose = null;
    window.removeEventListener("popstate", onModalPop);
    // Consume our history entry — skipped when the pop already happened
    // (the BACK that fired onModalPop consumed it for us), and skipped when
    // a replacing showModal reuses this entry (modalReplacing).
    if (history.state?.velta === "modal" && !modalReplacing) history.back();
    overlay.remove();
    onClose?.();
  };
  const onModalPop = () => doClose();
  activeModalClose = doClose;
  close.addEventListener("click", doClose);
  head.appendChild(close);
  const bodyEl = document.createElement("div");
  bodyEl.className = "modal-body";
  if (typeof body === "string") bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  modal.append(head);
  // A prompt form wraps body + foot so Enter submits. The close button stays
  // outside the form. display is a column so the body still scrolls.
  let formEl = null;
  if (form) {
    formEl = document.createElement("form");
    formEl.addEventListener("submit", e => e.preventDefault());
    modal.append(formEl);
  }
  const parent = formEl || modal;
  parent.append(bodyEl);
  if (foot) {
    const f = document.createElement("div");
    f.className = "modal-foot";
    if (typeof foot === "string") f.innerHTML = foot; else f.append(foot);
    parent.append(f);
  }
  overlay.appendChild(modal);
  overlay.addEventListener("pointerdown", e => { if (e.target === overlay) doClose(); });
  popups().appendChild(overlay);
  if (history.state?.velta !== "modal") history.pushState({ velta: "modal" }, "");
  window.addEventListener("popstate", onModalPop);
  raiseToasts();
  return { close: doClose, modal, form: formEl };
}

// Full-width bar pinned above the composer / bottom action bar (see
// .toasts in main.css; z-index rides above modal overlays). One line with
// ellipsis; when the text overflows, a chip appears and opening the toast
// pauses the auto-hide timer (closing resumes). The open pane shows the
// full text plus a copy button. Every toast has a close icon.
// opts.danger: red timer bar (errToast).
export function toast(text, ms = 2200, opts = {}) {
  const box = document.getElementById("toasts");
  const duration = Math.max(800, ms || 2200);
  // <details>/<summary>: the collapsed one-liner is the summary, the open
  // pane carries the full text and the copy button. Native toggle gives the
  // expand/collapse + disclosure semantics without JS state; JS adds the
  // timer (pause while open), copy, close, and the overflow-gated chip.
  const el = document.createElement("details");
  el.className = "toast" + (opts.danger ? " danger" : "");
  const summary = document.createElement("summary");
  summary.className = "toast-summary";
  const textEl = document.createElement("span");
  textEl.className = "toast-text";
  textEl.textContent = String(text);
  const timerBar = document.createElement("span");
  timerBar.className = "toast-timer";
  const chip = document.createElement("span");
  chip.className = "toast-chip"; chip.hidden = true;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button"; closeBtn.className = "toast-close"; closeBtn.setAttribute("aria-label", "Close"); closeBtn.innerHTML = CLOSE_SVG;
  summary.append(timerBar, textEl, chip, closeBtn);
  const moreText = document.createElement("div");
  moreText.className = "toast-more-text";
  moreText.textContent = String(text);
  const copyBtn = document.createElement("button");
  copyBtn.type = "button"; copyBtn.className = "toast-copy"; copyBtn.textContent = "Copy";
  const more = document.createElement("div");
  more.className = "toast-more";
  more.append(moreText, copyBtn);
  el.append(summary, more);
  box.appendChild(el);
  while (box.children.length > 3 && box.firstElementChild) box.firstElementChild.remove();
  raiseToasts();

  const clickLabel = (() => {
    try { return matchMedia("(hover: hover) and (pointer: fine)").matches ? "Click" : "Tap"; } catch { return "Tap"; }
  })();

  const dismiss = () => { el.remove(); hideToastsIfEmpty(); };
  if (typeof opts.undo === "function") {
    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "toast-undo";
    undoBtn.textContent = "Undo";
    undoBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      opts.undo();
      dismiss();
    });
    summary.insertBefore(undoBtn, closeBtn);
  }
  // opts.action = { label, run }: one extra button (e.g. "Turn off again").
  if (opts.action && typeof opts.action.run === "function") {
    const actBtn = document.createElement("button");
    actBtn.type = "button";
    actBtn.className = "toast-undo toast-action";
    actBtn.textContent = String(opts.action.label || "OK");
    actBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      opts.action.run();
      dismiss();
    });
    summary.insertBefore(actBtn, closeBtn);
  }
  timerBar.style.animationDuration = duration + "ms";
  timerBar.addEventListener("animationend", dismiss);
  closeBtn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); dismiss(); });
  copyBtn.addEventListener("click", async e => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
    } catch {}
  });

  // Expandable only when the text actually overflows one line (the
  // scrollWidth read forces layout synchronously). Re-checked once web
  // fonts settle - the first measurement can use fallback metrics that
  // fit, while the real font lands wider. One-line toasts block the native
  // summary toggle: there is nothing more to show.
  let expandable = false;
  const measureChip = () => {
    try {
      if (textEl.scrollWidth > textEl.clientWidth + 1) expandable = true;
    } catch {}
    if (expandable) chip.textContent = `${clickLabel} to ${el.open ? "collapse" : "expand"}`;
    else chip.hidden = true;
  };
  measureChip();
  document.fonts?.ready?.then(() => measureChip());
  // Clicking a toast toggles its dismissal timer (pause/resume). Expandable
  // toasts get this from the native expand/collapse toggle; one-liners have
  // nothing to expand, so the click pauses directly - otherwise they vanish
  // mid-read (the frozen timer bar shows the paused state).
  let paused = false;
  summary.addEventListener("click", e => {
    if (expandable) return; // native toggle path: open pauses, collapse resumes
    e.preventDefault();
    paused = !paused;
    setTimer(!paused);
  });
  el.addEventListener("toggle", () => {
    // open = paused; closed = timer resumes
    setTimer(!el.open);
    chip.textContent = `${clickLabel} to ${el.open ? "collapse" : "expand"}`;
  });
  const setTimer = (running) => { timerBar.style.animationPlayState = running ? "running" : "paused"; };
}

export function confirmModal(title, text, okLabel = "Delete", danger = true) {
  return new Promise(resolve => {
    const foot = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn-text"; ok.textContent = okLabel;
    if (danger) ok.style.color = "var(--danger)";
    foot.append(cancel, ok);
    const { close } = showModal({ title, body: `<p style="font-size:15px;line-height:1.45">${escapeHtml(text)}</p>`, foot, compact: true, onClose: () => resolve(false) });
    cancel.addEventListener("click", close);
    ok.addEventListener("click", () => { resolve(true); close(); });
  });
}

// Delete confirmation like the official Delta Chat desktop client: always a
// "Delete for me" action, plus "Delete for everyone" when the core supports
// it for this selection (self-sent, encrypted messages). Resolves "me",
// "everyone" or null when cancelled/closed.
export function confirmDeleteMessagesModal(count, canForAll) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const body = document.createElement("div");
    body.innerHTML = `<p style="font-size:15px;line-height:1.45">${count === 1 ? "Delete this message?" : `Delete ${count} messages?`}</p>`;
    const foot = document.createElement("div");
    const mk = (label, value) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-text";
      b.textContent = label;
      if (value) b.style.color = "var(--danger)";
      b.addEventListener("click", () => { finish(value); close(); });
      return b;
    };
    foot.append(mk("Cancel", null), mk("Delete for me", "me"));
    if (canForAll) foot.append(mk("Delete for everyone", "everyone"));
    const { close } = showModal({ title: "Delete messages", body, foot, onClose: () => finish(null) });
  });
}

/* ---------- Version info (drawer footer + About) ---------- */
// Fallback only: the live core version is fetched via get_system_info in
// app.js boot and pushed here with setCoreVersionDisplay (the running
// sidecar/in-process core is the source of truth, not this constant).
let CORE_VERSION = "2.64.0";

export function setCoreVersionDisplay(v) {
  if (!v) return;
  CORE_VERSION = String(v).replace(/^v/, "");
  document.querySelectorAll('[data-v="core"]').forEach((el) => { el.textContent = CORE_VERSION; });
  // Splash version line (#127) keeps the same core string once it is known.
  const splash = document.getElementById("splash");
  if (splash) fillSplashVersion(splash);
}
/* ---------- Update check (drawer banner + menu-button nudge) ---------- */
// The latest release version lives in a version.txt asset attached to every
// GitHub release (written by release.yml from tauri.conf.json). On Tauri the
// check runs shell-side (get_latest_version command — shell HTTP is not
// CSP-bound and the hardcoded URL there is the app's only GitHub reach);
// the direct fetch is the PWA/browser fallback.
const UPDATE_CHECK_URL = "https://github.com/pbuzdin/velta/releases/latest/download/version.txt";
const updateApkUrl = (v) => `https://github.com/pbuzdin/velta/releases/download/v${v}/Velta-${v}-arm64.apk`;

let updateInfo = null; // { version, url } while an update is available

function isNewerVersion(remote, current) {
  const parse = (s) => String(s).trim().replace(/^v/, "").split(/[.+-]/).slice(0, 3).map(Number);
  const a = parse(remote), b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// Fire-and-forget from boot(); offline or a failed check just means no banner.
export async function checkForUpdate() {
  let remote;
  try {
    const tauri = window.__TAURI__;
    if (tauri?.core?.invoke) {
      // Shell-side: no CORS, and CSP carries no github hosts (AGENTS.md §8).
      remote = (await tauri.core.invoke("get_latest_version")) || "";
    } else {
      const res = await fetch(UPDATE_CHECK_URL, { cache: "no-store" });
      if (!res.ok) return;
      remote = (await res.text()).trim();
    }
  } catch { return; }
  if (!remote) return;
  const current = await getAppVersion();
  if (!isNewerVersion(remote, current)) return;
  updateInfo = { version: remote, url: updateApkUrl(remote) };
  document.getElementById("bar-menu")?.classList.add("update");
  renderUpdateBanner();
}

// Inserted before the drawer foot so it stays pinned at the drawer's bottom
// (drawer-items scrolls, foot and banner do not). Re-runs on rebuildDrawer.
function renderUpdateBanner() {
  if (!updateInfo) return;
  document.getElementById("bar-menu")?.classList.add("update");
  const drawer = document.getElementById("drawer");
  const foot = drawer?.querySelector(".drawer-foot");
  if (!foot || drawer.querySelector(".update-banner")) return;
  const banner = document.createElement("div");
  banner.className = "update-banner";
  const text = document.createElement("span");
  text.className = "update-banner-text";
  text.innerHTML = `<strong>Velta ${escapeHtml(updateInfo.version)}</strong> is available`;
  const btn = document.createElement("button");
  btn.className = "update-banner-btn";
  btn.type = "button";
  const prog = document.createElement("progress");
  prog.className = "update-progress";
  prog.max = 100;
  prog.id = "update-progress";
  prog.hidden = true;
  btn.setAttribute("aria-describedby", "update-progress");
  // Desktop installer installs get the one-click path (updater plugin);
  // Android sideloads and the PWA still go through the system browser.
  const desktop = !isAndroid() && window.__TAURI__?.core?.invoke;
  btn.textContent = desktop ? "Update" : "Download APK";
  btn.addEventListener("click", async () => {
    if (desktop) return selfUpdate(btn);
    const tauri = window.__TAURI__;
    // #60: Android — download in-app with progress, hand the APK straight
    // to the system installer (FileProvider, no browser detour).
    if (tauri?.core?.invoke && isAndroid()) {
      return inAppApkUpdate(btn, tauri);
    }
    if (tauri?.core?.invoke) {
      tauri.core.invoke("plugin:opener|open_url", { url: updateInfo.url })
        .catch(() => window.open(updateInfo.url, "_blank", "noopener"));
    } else {
      window.open(updateInfo.url, "_blank", "noopener");
    }
  });
  banner.append(text, btn, prog);
  foot.before(banner);
}

// #60: stream the APK through the shell (download_update emits
// update-download progress events) and launch the installer. If a previous
// download already completed this session, "Install" jumps straight to the
// installer. Falls back to the browser path when the shell lacks the
// commands (older install) or the download fails.
async function inAppApkUpdate(btn, tauri) {
  btn.disabled = true;
  const setPct = (received, total) => {
    const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
    btn.textContent = total
      ? `Downloading… ${pct}%`
      : `Downloading… ${(received / 1048576).toFixed(1)} MB`;
    const bar = btn.parentElement?.querySelector("progress");
    if (!bar) return;
    bar.hidden = false;
    if (total) bar.value = pct;
    else bar.removeAttribute("value");
  };
  const listen = tauri.event?.listen?.bind(tauri.event);
  let unlisten = null;
  const fallbackToBrowser = () => {
    tauri.core.invoke("plugin:opener|open_url", { url: updateInfo.url })
      .catch(() => window.open(updateInfo.url, "_blank", "noopener"));
  };
  try {
    if (listen) unlisten = await listen("update-download", (e) => {
      const { received = 0, total = 0 } = e.payload || {};
      setPct(received, total);
    });
    if (!updateInfo.apkPath) {
      setPct(0, 0);
      updateInfo.apkPath = await tauri.core.invoke("download_update", { version: updateInfo.version });
    }
    btn.textContent = "Opening installer…";
    await tauri.core.invoke("install_update", { path: updateInfo.apkPath });
    btn.textContent = "Install";
  } catch {
    updateInfo.apkPath = null;
    fallbackToBrowser();
  }
  btn.disabled = false;
  if (unlisten) unlisten();
}

// One-click Windows self-update: the updater plugin verifies the minisign
// signature, runs the NSIS installer and process.relaunch() restarts into the
// new version. All download traffic is shell-side — the renderer only talks
// plugin IPC (CSP carries no github hosts).
async function selfUpdate(btn) {
  const tauri = window.__TAURI__;
  btn.disabled = true;
  try {
    const update = await tauri.updater.check();
    if (!update?.available) {
      btn.textContent = "No update";
      btn.disabled = false;
      return;
    }
    let total = 0, got = 0, lastPct = -1;
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength || 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        const pct = total ? Math.round((got / total) * 100) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          btn.textContent = pct ? `Downloading ${pct}%` : "Downloading…";
          const bar = btn.parentElement?.querySelector("progress");
          if (bar) { bar.hidden = false; if (total) bar.value = pct; else bar.removeAttribute("value"); }
        }
      } else if (ev.event === "Finished") btn.textContent = "Installing…";
    });
    btn.textContent = "Restarting…";
    await tauri.process.relaunch(); // replaces the process — never resolves on success
  } catch (err) {
    console.error("self-update failed", err);
    toast("Update failed: " + (err?.message || err));
    btn.textContent = "Retry update";
    btn.disabled = false;
  }
}

const THEME_LABELS = { auto: "Auto", dark: "Dark", light: "Light", brutal: "Brutal" };

// Interface scale — a coherent whole-UI zoom for users on huge system font
// scales ("pensioner mode") whose WebView text-only zoom breaks the px-sized
// layout. Persisted in localStorage["velta-ui-scale"] and applied pre-paint
// by the inline script in index.html <head>.
export const UI_SCALES = [["0.85", "Small"], ["1", "Normal"], ["1.15", "Large"]];
export function uiScaleValue() {
  try { return localStorage.getItem("velta-ui-scale") || "1"; } catch { return "1"; }
}
export function uiScaleLabel() {
  return (UI_SCALES.find(([s]) => s === uiScaleValue()) || UI_SCALES[1])[1];
}
export function applyUiScale() {
  let v = "1";
  try { v = localStorage.getItem("velta-ui-scale") || "1"; } catch {}
  const root = document.documentElement.style;
  if (v === "1") { root.removeProperty("zoom"); root.removeProperty("--ui-zoom"); }
  else { root.zoom = v; root.setProperty("--ui-zoom", v); }
  // CSS zoom changes neither offset sizes nor the window size, so the virtual
  // scroller's ResizeObserver never fires and it keeps heights measured in the
  // old scale — re-layouts then mix coordinate spaces and blank the list.
  // A resize event runs its "viewport changed" path: drop measured heights, re-measure.
  window.dispatchEvent(new Event("resize"));
}
export function setUiScale(v) {
  try {
    if (v === "1") localStorage.removeItem("velta-ui-scale");
    else localStorage.setItem("velta-ui-scale", v);
  } catch {}
  applyUiScale();
}

export async function getAppVersion() {
  try {
    const tauri = window.__TAURI__;
    if (tauri?.app?.getVersion) return await tauri.app.getVersion();
    if (tauri?.core?.invoke) return await tauri.core.invoke("plugin:app|version");
  } catch {}
  return APP_VERSION;
}

// Cache name is the service worker version: velta-vNN, or velta-pwa-<hash>.
export async function getSwVersion() {
  try {
    const keys = await caches.keys();
    const m = keys.map(k => /^velta-(v\d+|pwa-[0-9a-f]{12})$/.exec(k)).find(Boolean);
    if (m) return m[1];
  } catch {}
  return null;
}

// Tauri framework version (not the app version).
export async function getTauriVersion() {
  try {
    const v = await window.__TAURI__?.app?.getTauriVersion?.();
    if (v) return v;
  } catch {}
  return null;
}

export async function fillSplashVersion(el) {
  const slot = el?.querySelector?.("[data-splash-ver]");
  if (!slot) return;
  const [app, tauri, sw] = await Promise.all([getAppVersion(), getTauriVersion(), getSwVersion()]);
  slot.textContent = formatSplashVersion({ app, core: CORE_VERSION, tauri, sw });
}

/* ---------- disclosure menus ---------- */
// Progressive enhancement for a <details> used as a dropdown: the platform
// opens and closes it (summary tap, Enter/Space) and exposes the expanded
// state; this only adds the dismissals a menu needs. Listeners go on while
// open, from the async "toggle" event, so the opening tap can never close it
// again. Returns an unwire function.
export function wireDisclosure(details, { doc = document } = {}) {
  const onPointer = e => { if (!details.contains(e.target)) details.open = false; };
  const onKey = e => {
    if (e.key !== "Escape" || !details.open) return;
    e.stopPropagation();
    details.open = false;
    details.querySelector("summary")?.focus();
  };
  const unwire = () => {
    doc.removeEventListener("pointerdown", onPointer, true);
    doc.removeEventListener("keydown", onKey, true);
  };
  const onToggle = () => {
    unwire();
    if (!details.open) return;
    doc.addEventListener("pointerdown", onPointer, true);
    doc.addEventListener("keydown", onKey, true);
  };
  details.addEventListener("toggle", onToggle);
  return () => { details.removeEventListener("toggle", onToggle); unwire(); };
}

/* ---------- Chat appearance (drawer section) ---------- */
// Message text size, bubble corners, accent color, hyphenation — per device
// in localStorage; storage, clamping, color derivation and the :root wiring
// live in js/chat-appearance.js (a classic pre-paint script, like
// ui-scale.js), exposed as globalThis.VeltaChatAppearance. Everything applies
// live through CSS custom properties: never rebuildDrawer() on these inputs.
function chatAppearanceApi() { return globalThis.VeltaChatAppearance || null; }
const pxText = v => `${String(v).replace(/\.0$/, "")} px`;
// Stock corner radius of the current theme (main.css --radius-bubble): the
// brutal theme ships 6px, the others 14px. "Unset" means that value.
const themeRadius = () => (document.documentElement.dataset.theme === "brutal" ? 6 : 14);
export function chatAppearanceHtml() {
  const A = chatAppearanceApi();
  if (!A) return "";
  const st = A.read();
  const radius = st.radius == null ? themeRadius() : st.radius;
  const preset = A.PRESETS.find(([c]) => c === st.accent);
  const custom = st.accent && !preset ? st.accent : "";
  // The custom-color ring is drawn from the same PRESETS (one source of hex).
  const ringCols = A.PRESETS.map(([c]) => c).filter(Boolean);
  const caRainbow = `conic-gradient(${[...ringCols, ringCols[0]].join(", ")})`;
  const swatches = A.PRESETS.map(([c, label]) => `<label class="ca-swatch"${c ? ` style="--sw: ${c}"` : " data-default"} title="${escapeAttr(label)}"><input type="radio" name="ca-accent" value="${c || ""}" aria-label="${escapeAttr(label)}"${(c || null) === (st.accent && preset ? st.accent : null) && !custom ? " checked" : ""}></label>`).join("");
  return `<details class="drawer-details" data-chat-appearance>
        <summary><svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 011 1v9a1 1 0 01-1 1h-9l-5 4v-4H4a1 1 0 01-1-1V6a1 1 0 011-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M7 9.5h7M7 12.5h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Chat appearance</span></summary>
        <div class="ca-panel">
          <div class="ca-preview" role="group" aria-label="Preview">
            <div class="msg-row"><div class="bubble"><div class="msg-sender">Ada</div><div class="msg-quote"><span class="q-name">You</span><span class="q-text">Are we still on for tonight?</span></div><div class="msg-text" lang="en">Yes! Bring the hyperparameter notes.</div><span class="msg-meta"><span>12:41</span></span></div></div>
            <div class="msg-row out"><div class="bubble"><div class="msg-text" lang="en">Great, see you at 8. Map: <a href="#" tabindex="-1">example.org</a></div><span class="msg-meta"><span>12:42</span><span class="ticks-slot">${ticksSvg("read", "ticks")}</span></span></div></div>
          </div>
          <div class="ca-field">
            <label for="ca-font">Message text size</label>
            <output for="ca-font" data-ca-font-out>${pxText(st.fontSize)}</output>
          </div>
          <input type="range" id="ca-font" class="ca-range" data-ca-font min="${A.FONT_MIN}" max="${A.FONT_MAX}" step="0.5" value="${st.fontSize}" aria-valuetext="${pxText(st.fontSize)}">
          <div class="ca-field">
            <label for="ca-radius">Message corners</label>
            <output for="ca-radius" data-ca-radius-out>${pxText(radius)}</output>
          </div>
          <input type="range" id="ca-radius" class="ca-range" data-ca-radius min="${A.RADIUS_MIN}" max="${A.RADIUS_MAX}" step="1" value="${radius}" aria-valuetext="${pxText(radius)}">
          <fieldset class="ca-accent" data-ca-accent>
            <legend>Accent color</legend>
            <div class="ca-swatches">${swatches}<label class="ca-swatch ca-custom" title="Custom color" style="--ca-rainbow: ${caRainbow}"><input type="color" data-ca-custom aria-label="Custom accent color" value="${custom || "#3fa34d"}"${custom ? " data-active" : ""}></label></div>
          </fieldset>
          <div class="bar-opts-hint" data-ca-accent-hint>Links, buttons, switches and your own bubbles. Text colors adjust to stay readable in light and dark. Brutal keeps its own colors.</div>
          <label class="scale-opt"><input type="checkbox" role="switch" data-ca-hyphens${st.hyphens ? " checked" : ""}><span>Hyphenate long words (English, Russian)</span></label>
          <div class="ca-actions"><button type="button" class="btn-text" data-ca-reset>Reset to defaults</button></div>
        </div>
      </details>`;
}
// Wires the section (once per drawer build). onChange(state) is for callers
// that need to react; the virtual scroller re-measures on the resize event.
export function wireChatAppearance(root, { onChange } = {}) {
  const A = chatAppearanceApi();
  const sec = root?.querySelector?.("[data-chat-appearance]");
  if (!A || !sec) return;
  const font = sec.querySelector("[data-ca-font]"), radius = sec.querySelector("[data-ca-radius]");
  const fontOut = sec.querySelector("[data-ca-font-out]"), radiusOut = sec.querySelector("[data-ca-radius-out]");
  const custom = sec.querySelector("[data-ca-custom]"), hyph = sec.querySelector("[data-ca-hyphens]");
  let resizeT = 0;
  const relayout = () => {
    clearTimeout(resizeT);
    // Bubble heights change with the text size/corners: let the chat's
    // virtual scroller drop its measured heights (same path as applyUiScale).
    resizeT = setTimeout(() => window.dispatchEvent(new Event("resize")), 120);
  };
  const commit = (patch, layout) => {
    const st = A.apply(A.write(patch));
    onChange?.(st);
    if (layout) relayout();
    return st;
  };
  const sync = st => {
    const r = st.radius == null ? themeRadius() : st.radius;
    font.value = String(st.fontSize); radius.value = String(r);
    fontOut.textContent = pxText(st.fontSize); font.setAttribute("aria-valuetext", pxText(st.fontSize));
    radiusOut.textContent = pxText(r); radius.setAttribute("aria-valuetext", pxText(r));
    const preset = A.PRESETS.some(([c]) => c === st.accent);
    for (const rb of sec.querySelectorAll('input[name="ca-accent"]')) rb.checked = preset && (rb.value || null) === st.accent;
    custom.toggleAttribute("data-active", !!st.accent && !preset);
    if (st.accent && !preset) custom.value = st.accent;
    hyph.checked = st.hyphens;
  };
  font.addEventListener("input", () => {
    const v = A.clampFont(font.value);
    fontOut.textContent = pxText(v); font.setAttribute("aria-valuetext", pxText(v));
    commit({ fontSize: v }, true);
  });
  radius.addEventListener("input", () => {
    const v = A.clampRadius(radius.value);
    radiusOut.textContent = pxText(v); radius.setAttribute("aria-valuetext", pxText(v));
    // Back at the theme's stock radius = unset, so a later theme switch
    // (brutal 6px vs 14px) keeps each theme's own corners.
    commit({ radius: v === themeRadius() ? null : v }, true);
  });
  sec.querySelector("[data-ca-accent]").addEventListener("change", e => {
    if (e.target?.name !== "ca-accent") return;
    custom.removeAttribute("data-active");
    commit({ accent: e.target.value || null });
  });
  custom.addEventListener("input", () => {
    for (const rb of sec.querySelectorAll('input[name="ca-accent"]')) rb.checked = false;
    custom.setAttribute("data-active", "");
    commit({ accent: custom.value });
  });
  hyph.addEventListener("change", () => commit({ hyphens: hyph.checked }));
  sec.querySelector("[data-ca-reset]").addEventListener("click", () => {
    const st = A.apply(A.reset());
    sync(st);
    onChange?.(st);
    relayout();
    toast("Chat appearance reset");
  });
}

/* ---------- Settings drawer ---------- */
// Notification-switch storage semantics: most keys are default-on ("0" =
// off, absent = on); "mentions" and "bgforce" are default-off ("1" = on).
function notifyChecked(storageKey) {
  const v = localStorage.getItem(storageKey);
  if (storageKey === "velta-notify-mentions" || storageKey === "velta-notify-bgforce") return v === "1";
  return v !== "0";
}

const IS_ANDROID = isAndroid();

export function buildDrawer({ account, onProfileManagement, onSetTheme, onOpenChat, onInvite, onProfile, onEditProfile, onInviteDomains, onWsRelays, p2pAvailable = false, p2pOn = false, onP2pToggle, onRelays, accounts = [], currentAccountId = null, onAccountTap, theme, barHidden = [], onBarToggle, catsHidden = [], onCatToggle, mediaQuality = "0", onMediaQuality, downloadLimit = "0", onDownloadLimit, onReadReceipts, onLowBatteryToggle, multiDeviceState = "loading", multiDeviceReenabled = false, onMultiDevice, onMultiDeviceKeep, onDrawerOpen, identityBackupAvailable = false, onIdentityBackup, onTunnel = null, tunnelLabel = "", onDiagnostics = null, onPushSection = null, onWebPushSection = null, backendKind = null, onExportSettings = null }) {
  const inTauri = isTauri();
  const drawer = document.createElement("div");
  drawer.className = "drawer";
  drawer.id = "drawer";
  drawer.innerHTML = `
    <div class="drawer-head">
      <velta-avatar data-act="profile" style="cursor:pointer" name="${escapeHtml(account.displayName)}" color="${escapeAttr(account.color || "#777")}" size="56" contact-id="1" addr="${escapeAttr(account.addr || "")}"${account.avatar ? ` avatar="${escapeAttr(fileUrl(account.avatar))}"` : ""}></velta-avatar>
      <div>
        <div class="drawer-name">${escapeHtml(account.displayName)}</div>
        <div class="drawer-links">
          <button type="button" data-act="edit-profile">Edit profile</button>
          ${accounts.length ? `<details class="acct-switch" data-acct-switch>
            <summary data-act="switch-account">Switch account<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
            <div class="acct-pop" role="group" aria-label="Accounts">
            ${accounts.map(a => `<button type="button" class="ctx-item" data-act="account" data-account="${escapeAttr(a.id)}"${a.id === currentAccountId ? ' aria-current="true"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20a8 8 0 0116 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>${a.id === currentAccountId ? `<path d="M8.5 12.5l2.5 2.5 5-5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : ""}</svg><span>${escapeHtml(a.name || a.addr)}${a.id === currentAccountId ? " · current" : ""}</span></button>`).join("")}
            </div>
          </details>` : ""}
        </div>
      </div>
    </div>
    <div class="drawer-items">
      <button type="button" class="ctx-item" data-act="saved"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span>Saved Messages</span></button>
      <button type="button" class="ctx-item" data-act="invite"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="1" fill="currentColor"/><rect x="3" y="13" width="8" height="8" rx="1" fill="currentColor"/></svg><span>Invite friends (QR)</span></button>
      ${p2pAvailable || p2pOn ? `<label class="ctx-item"><svg viewBox="0 0 24 24"><path d="M2.5 9.5a14 14 0 0119 0M5.5 13a9.5 9.5 0 0113 0M8.5 16.5a5 5 0 017 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="19.5" r="1.4" fill="currentColor"/></svg><span>Local chat: ${p2pOn ? "on" : "off"}</span><input type="checkbox" role="switch" data-toggle="p2p"${p2pOn ? " checked" : ""}></label>` : ""}
      ${p2pAvailable && p2pOn ? `<label class="ctx-item" title="Show when someone in a local chat is typing, and let them see when you are. Hints are live only and never stored."><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="16" cy="12" r="1.2" fill="currentColor"/></svg><span>Typing indicator: ${localStorage.getItem("velta-p2p-typing") !== "0" ? "on" : "off"}</span><input type="checkbox" role="switch" data-toggle="p2p-typing"${localStorage.getItem("velta-p2p-typing") !== "0" ? " checked" : ""}></label>` : ""}
      <div class="drawer-sec">Settings</div>
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 109 9c0-1.5-1.2-2.6-2.6-2.6h-1.9a2.5 2.5 0 01-2.5-2.5V5.1C14 4 13.3 3 12 3z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16.5" cy="10.5" r="1.2" fill="currentColor"/></svg><span data-theme-summary>Theme: ${THEME_LABELS[theme] || "Auto"}</span></summary>
        <fieldset class="scale-opts" data-theme-opts>
          <legend class="vh">Theme</legend>
          ${Object.entries(THEME_LABELS).map(([v, label]) => `<label class="scale-opt"><input type="radio" name="app-theme" value="${v}"${v === theme ? " checked" : ""}><span>${label}</span></label>`).join("")}
        </fieldset>
      </details>
      ${chatAppearanceHtml()}
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><path d="M5 19L11.2 5h1.6L19 19M7.2 15h9.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16.5 5.5L21 10M21 5.5L16.5 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span data-scale-summary>Interface scale: ${uiScaleLabel()}</span></summary>
        <fieldset class="scale-opts" data-scale-opts>
          <legend class="vh">Interface scale</legend>
          ${UI_SCALES.map(([v, label]) => `<label class="scale-opt"><input type="radio" name="ui-scale" value="${v}"${v === uiScaleValue() ? " checked" : ""}><span>${label}</span></label>`).join("")}
        </fieldset>
      </details>
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><rect x="3" y="17" width="18" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 17v-4m6 4V9m6 8V5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Bottom bar buttons</span></summary>
        <fieldset class="scale-opts" data-bar-opts>
          <legend class="vh">Bottom bar buttons</legend>
          ${[["chats", "Chats"], ["contacts", "Contacts"], ["calls", "Calls"], ["qr", "QR code"]].map(([key, label]) => `<label class="scale-opt"><input type="checkbox" role="switch" data-bar-key="${key}"${barHidden.includes(key) ? "" : " checked"}><span>${label}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint">Menu button is always visible.</div>
      </details>
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Chat categories</span></summary>
        <fieldset class="scale-opts" data-cat-opts>
          <legend class="vh">Chat categories</legend>
          ${[["people", "People"], ["groups", "Groups"], ["channels", "Channels"], ["bots", "Bots"], ["system", "System"]].map(([key, label]) => `<label class="scale-opt"><input type="checkbox" role="switch" data-cat-key="${key}"${catsHidden.includes(key) ? "" : " checked"}><span>${label}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint">"All" is always visible.</div>
      </details>
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.7 21a2 2 0 01-3.4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Notifications</span></summary>
        <fieldset class="scale-opts" data-notify-opts>
          <legend class="vh">Notifications</legend>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="notifications"${notifyChecked("velta-notify") ? " checked" : ""}><span>Notifications</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="mentions"${notifyChecked("velta-notify-mentions") ? " checked" : ""}><span>Replies only (skip the rest)</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="text"${notifyChecked("velta-notify-text") ? " checked" : ""}><span>Show message content</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="system"${notifyChecked("velta-notify-system") ? " checked" : ""}><span>System notification for new messages</span></label>
          ${IS_ANDROID ? `
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="vibration"${notifyChecked("velta-notify-vibration") ? " checked" : ""}><span>Vibration</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="sounds"${notifyChecked("velta-notify-sounds") ? " checked" : ""}><span>In-chat sounds</span></label>` : ""}
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="calls"${notifyChecked("velta-notify-calls") ? " checked" : ""}><span>Calls</span></label>
          ${IS_ANDROID ? `
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="bg"${notifyChecked("velta-notify-bg") ? " checked" : ""}><span>Use background connection</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="bgforce"${notifyChecked("velta-notify-bgforce") ? " checked" : ""}><span>Force background connection</span></label>
          <div class="bar-opts-hint">Force keeps background fetching alive under battery restrictions (asks Android for exemption).</div>` : ""}
        </fieldset>
        <div class="bar-opts-hint">Per-chat muting lives in each chat's info sheet.</div>
      </details>
      ${IS_ANDROID && onPushSection ? `<details class="drawer-details" data-push-section>
        <summary><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10m0 0l-4-4m4 4l4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 15v4h14v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span data-push-summary>Push notifications</span></summary>
        <div data-push-body><div class="bar-opts-hint">Loading…</div></div>
      </details>` : ""}
      ${!IS_ANDROID && onWebPushSection ? `<details class="drawer-details" data-webpush-section>
        <summary><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10m0 0l-4-4m4 4l4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 15v4h14v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span data-webpush-summary>Push notifications</span></summary>
        <div data-webpush-body><div class="bar-opts-hint">Loading…</div></div>
      </details>` : ""}
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Image quality</span></summary>
        <fieldset class="scale-opts" data-mq-opts>
          <legend class="vh">Image quality</legend>
          ${[["0", "Standard (compress to 940 KB)"], ["1", "Compact (compress to 130 KB)"]].map(([value, label]) => `<label class="scale-opt"><input type="radio" name="media-quality" data-mq-value="${value}"${value === mediaQuality ? " checked" : ""}><span>${label}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint">Large photos only — smaller images are sent unchanged.</div>
        <div class="scale-opts">
          <label class="scale-opt"><input type="checkbox" role="switch" data-compress-photos${localStorage.getItem("velta-compress-photos") === "0" ? "" : " checked"}><span>Compress photos to save relay space</span></label>
        </div>
        <div class="bar-opts-hint">Big JPEG/WebP photos are re-encoded as smaller WebP before sending, when that saves at least 10%. This also removes location and camera info from those photos. Animated images, transparent images, small photos and files are never changed.</div>
      </details>
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="4" y="17" width="16" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>Auto-download limit</span></summary>
        <fieldset class="scale-opts" data-dl-opts>
          <legend class="vh">Auto-download limit</legend>
          ${[["0", "No limit (default)"], ["655360", "640 KB"], ["5242880", "5 MB"], ["26214400", "25 MB"]].map(([value, label]) => `<label class="scale-opt"><input type="radio" name="download-limit" data-dl-value="${value}"${value === downloadLimit ? " checked" : ""}><span>${label}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint" data-dl-hint>${escapeHtml(DL_LIMIT_HINT)}</div>
      </details>
      <button type="button" class="ctx-item" data-act="profile-management"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20a8 8 0 0116 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19 5v4M21 7h-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Profile management…</span></button>
      <button type="button" class="ctx-item" data-act="relays"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>Relays of this profile…</span></button>
      ${onTunnel ? `<button type="button" class="ctx-item" data-act="tunnel"><svg viewBox="0 0 24 24"><path d="M3 20V11a9 9 0 0118 0v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 20v-7a4 4 0 018 0v7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>DNS tunnel: ${escapeHtml(tunnelLabel)}</span></button>` : ""}
      ${onWsRelays ? `<button type="button" class="ctx-item" data-act="ws-relays"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>WebSocket relays</span></button>` : ""}
      ${identityBackupAvailable ? `<button type="button" class="ctx-item" data-act="identity-backup"><svg viewBox="0 0 24 24"><circle cx="8" cy="14" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 11l8-8M17 5l3 3M14 8l2.5 2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Identity backup…</span></button>` : ""}
      <button type="button" class="ctx-item" data-act="invite-domains"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>Invite link domains</span></button>
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Link previews: ${LINK_PREVIEW_LABELS[linkPreviewMode()]}</span></summary>
        <fieldset class="scale-opts" data-lp-opts>
          <legend class="vh">Link previews</legend>
          ${[["off", "Off"], ["picture", "Send a picture"], ["fetch", "Load on this device"]].map(([value, label]) => `<label class="scale-opt"><input type="radio" name="link-preview-mode" data-lp-value="${value}"${value === linkPreviewMode() ? " checked" : ""}><span>${label}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint">Send a picture attaches a snapshot; other people do not open the site. ${LINK_PREVIEW_IP_WARNING}</div>
      </details>
      <label class="ctx-item" title="Drops utm and click-id parameters when you paste or open a link. Undo brings them back."><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20l5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Strip tracking from links: ${trackingStripEnabled() ? "on" : "off"}</span><input type="checkbox" role="switch" data-toggle="strip-trackers"${trackingStripEnabled() ? " checked" : ""}></label>
      <label class="ctx-item"><svg viewBox="0 0 24 24"><path d="M20 5v6a2 2 0 01-2 2H5m0 0l4-4m-4 4l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Send on Enter: ${localStorage.getItem("velta-send-enter") === "0" ? "off" : "on"}</span><input type="checkbox" role="switch" data-toggle="send-enter"${localStorage.getItem("velta-send-enter") === "0" ? "" : " checked"}></label>
      <label class="ctx-item" title="Off also stops seen-status sync between your own devices"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 12a8 8 0 0114-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 12a8 8 0 01-14 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Show and send read receipts: ${localStorage.getItem("velta-mdns") === "0" ? "off" : "on"}</span><input type="checkbox" role="switch" data-toggle="read-receipts"${localStorage.getItem("velta-mdns") === "0" ? "" : " checked"}></label>
      <label class="ctx-item" title="Copies messages you send to your other devices and syncs state between them"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="14" y="6" width="7" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>Multi-device: ${mdLabel(multiDeviceState)}</span><input type="checkbox" role="switch" data-toggle="multidevice"${multiDeviceState === "on" ? " checked" : ""}${multiDeviceState === "on" || multiDeviceState === "off" ? "" : ' aria-checked="mixed"'}></label>
      <div class="bar-opts-hint ctx-hint" data-md-hint>${escapeHtml(MD_HINT)}</div>
      <div class="bar-opts-hint ctx-hint md-note" data-md-note${multiDeviceReenabled ? "" : " hidden"}><span>${escapeHtml(MD_REENABLED_NOTE)}</span> <span class="md-note-acts"><button type="button" class="btn-text" data-md-off>Turn off again</button><button type="button" class="btn-text" data-md-keep>Keep on</button></span></div>
      ${IS_ANDROID ? `<label class="ctx-item" title="While the phone is under 10% and off the charger, your latest message in each chat gets a 🪫 reaction so the other side knows replies may stop. Recipients see it as a normal reaction; other clients show the emoji only."><svg viewBox="0 0 24 24"><rect x="2.5" y="8" width="16.5" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21.5 10.5v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="4.5" y="10" width="3.5" height="4" rx="0.5" fill="currentColor"/></svg><span>Low-battery marker: ${localStorage.getItem("velta-low-battery-react") === "1" ? "on" : "off"}</span><input type="checkbox" role="switch" data-toggle="low-battery"${localStorage.getItem("velta-low-battery-react") === "1" ? " checked" : ""}></label>` : ""}
      <label class="ctx-item"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 20h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Remember scroll position in chats: ${localStorage.getItem("velta-remember-scroll") === "0" ? "off" : "on"}</span><input type="checkbox" role="switch" data-toggle="remember-scroll"${localStorage.getItem("velta-remember-scroll") === "0" ? "" : " checked"}></label>
      <label class="ctx-item"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9h6v6H9z" fill="currentColor"/></svg><span>Demo mode: ${localStorage.getItem("velta-mock") === "1" ? "on" : "off"}</span><input type="checkbox" role="switch" data-toggle="demo"${localStorage.getItem("velta-mock") === "1" ? " checked" : ""}></label>
      ${onExportSettings ? `<button type="button" class="ctx-item" data-act="export-settings" title="Sends your Velta preferences as one text message to Saved Messages, so another device can apply them. No relays, keys or addresses."><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 7v6m0-6l-2.5 2.5M12 7l2.5 2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Export settings to Saved Messages</span></button>` : ""}
      <button type="button" class="ctx-item" data-act="about"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10v6M12 7v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg><span>About Velta</span></button>
    </div>
    <div class="drawer-foot" data-versions>
      <div class="drawer-ver"><span>Velta</span><span data-v="app">…</span></div>
      <div class="drawer-ver"><span>Chatmail core</span><span data-v="core">${CORE_VERSION}</span></div>
      ${inTauri ? `<div class="drawer-ver"><span>Tauri</span><span data-v="tauri">…</span></div>` : ""}
      ${inTauri ? "" : `<div class="drawer-ver"><span>Service worker</span><span data-v="sw">…</span></div>`}
    </div>`;
  document.body.appendChild(drawer);
  // #140: Android push section fills itself on open (push-settings.js).
  const pushSec = drawer.querySelector("[data-push-section]");
  if (pushSec) onPushSection?.(pushSec);
  // Web Push (wasm PWA): docs/agents/web-push.md.
  const webPushSec = drawer.querySelector("[data-webpush-section]");
  if (webPushSec) onWebPushSection?.(webPushSec);

  // Update banner lives at the drawer's bottom, above the version foot.
  renderUpdateBanner();

  // Fill the async parts of the footer once the drawer exists.
  (async () => {
    const box = drawer.querySelector("[data-versions]");
    if (!box) return;
    box.querySelector('[data-v="app"]').textContent = await getAppVersion();
    const tv = await getTauriVersion();
    if (tv) box.querySelector('[data-v="tauri"]').textContent = tv;
    else box.querySelector('[data-v="tauri"]')?.closest(".drawer-ver")?.remove();
    if (!inTauri) {
      const el = box.querySelector('[data-v="sw"]');
      const paint = async () => {
        const sw = await getSwVersion();
        if (sw) el.textContent = sw;
        else if (el.textContent === "…") el.textContent = "not registered";
      };
      await paint();
      // Drawer is built during boot. The PWA worker is registered on window
      // load and its cache appears only after install, so the first read is
      // often empty. Paint again once that worker is active.
      if (!/^(?:v\d+|pwa-[0-9a-f]{12})$/.test(el.textContent)) {
        navigator.serviceWorker?.ready.then(() => paint()).catch(() => {});
      }
    }
  })();

  const overlay = document.createElement("div");
  overlay.className = "pop-overlay transparent drawer-overlay";
  overlay.style.display = "none";
  // Taps that start on the drawer's own toggle button are skipped: the
  // button's click handler owns that toggle. Closing on pointerdown raced
  // the click on touch devices (the WebView retargets the click to the
  // just-uncovered button) — menu closed and instantly reopened.
  overlay.addEventListener("pointerdown", e => {
    if (e.target?.closest?.("#bar-menu")) return;
    close();
  });
  popups().appendChild(overlay);

  // Account switcher: a native <details> disclosure, so the summary opens it
  // with no JS (tap, Enter, Space). wireDisclosure only adds the closing:
  // outside tap, Escape, and a pick (the drawer click handler closes it).
  const acctSwitch = drawer.querySelector("[data-acct-switch]");
  const unwireAcct = acctSwitch ? wireDisclosure(acctSwitch) : () => {};

  // Interface scale radios (inside the spoiler): apply live, keep the
  // summary label in sync. Radios have no data-act, so the drawer stays open.
  drawer.querySelector("[data-scale-opts]")?.addEventListener("change", e => {
    const v = e.target?.value;
    if (!v) return;
    setUiScale(v);
    const summary = drawer.querySelector("[data-scale-summary]");
    if (summary) summary.textContent = `Interface scale: ${uiScaleLabel()}`;
    toast(`Interface scale: ${uiScaleLabel()}`);
  });

  // Theme radios: "auto" follows the system preference (app.js listens for
  // changes while auto). Apply in place — no drawer rebuild.
  drawer.querySelector("[data-bar-opts]")?.addEventListener("change", e => {
    const key = e.target?.dataset?.barKey;
    if (!key || !onBarToggle) return;
    onBarToggle(key, e.target.checked);
  });
  drawer.querySelector("[data-cat-opts]")?.addEventListener("change", e => {
    const key = e.target?.dataset?.catKey;
    if (!key || !onCatToggle) return;
    onCatToggle(key, e.target.checked);
  });
  drawer.querySelector("[data-notify-opts]")?.addEventListener("change", e => {
    const key = e.target?.dataset?.notifyKey;
    if (!key) return;
    // localStorage mirrors each switch for the page's own gates; the full
    // set is also pushed to the shell (set_notify_prefs) where the Android
    // background poller and the Kotlin channel/fetch layers read it.
    const storageKeys = {
      notifications: "velta-notify",
      mentions: "velta-notify-mentions",
      text: "velta-notify-text",
      system: "velta-notify-system",
      vibration: "velta-notify-vibration",
      sounds: "velta-notify-sounds",
      calls: "velta-notify-calls",
      bg: "velta-notify-bg",
      bgforce: "velta-notify-bgforce",
    };
    const storageKey = storageKeys[key];
    if (storageKey) {
      // Default-off keys ("mentions", "bgforce") store "1" when checked;
      // default-on keys store "0" when unchecked; absent = default.
      const defaultOff = key === "mentions" || key === "bgforce";
      if (defaultOff) {
        if (e.target.checked) localStorage.setItem(storageKey, "1");
        else localStorage.removeItem(storageKey);
      } else if (e.target.checked) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, "0");
      }
    }
    if (key === "bgforce" && e.target.checked) {
      const invoke = tauriInvoke();
      invoke?.("request_battery_exemption")?.catch?.(() => {});
    }
    if (key === "bg" && !e.target.checked) {
      toast("Background connection off — messages arrive when you open Velta");
    }
    const invoke = tauriInvoke();
    const prefs = {
      enabled: localStorage.getItem("velta-notify") !== "0",
      mentions_only: localStorage.getItem("velta-notify-mentions") === "1",
      show_content: localStorage.getItem("velta-notify-text") !== "0",
      system_new_msgs: localStorage.getItem("velta-notify-system") !== "0",
      vibration: localStorage.getItem("velta-notify-vibration") !== "0",
      in_chat_sounds: localStorage.getItem("velta-notify-sounds") !== "0",
      calls: localStorage.getItem("velta-notify-calls") !== "0",
      use_bg_connection: localStorage.getItem("velta-notify-bg") !== "0",
      force_bg_connection: localStorage.getItem("velta-notify-bgforce") === "1",
    };
    invoke?.("set_notify_prefs", { prefs })?.catch?.(() => {});
  });
  drawer.querySelector("[data-compress-photos]")?.addEventListener("change", e => {
    const on = e.target.checked;
    if (on) localStorage.removeItem("velta-compress-photos");
    else localStorage.setItem("velta-compress-photos", "0");
    toast(`Photo compression ${on ? "on" : "off"}`);
  });
  drawer.querySelector("[data-mq-opts]")?.addEventListener("change", e => {
    const value = e.target?.dataset?.mqValue;
    if (!value || !onMediaQuality) return;
    onMediaQuality(value);
  });
  drawer.querySelector('[data-toggle="read-receipts"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    if (on) localStorage.removeItem("velta-mdns");
    else localStorage.setItem("velta-mdns", "0");
    setToggleUi("read-receipts", "Show and send read receipts", on);
    onReadReceipts?.(on);
    toast(`Read receipts ${on ? "on" : "off"}`);
  });
  // Indeterminate (loading / failed read) can't be expressed in markup;
  // app.js repaints it via paintMultiDevice once the core answers.
  const mdBox = drawer.querySelector('[data-toggle="multidevice"]');
  if (mdBox && multiDeviceState !== "on" && multiDeviceState !== "off") mdBox.indeterminate = true;
  mdBox?.addEventListener("change", async e => {
    const on = e.target.checked;
    e.target.indeterminate = false;
    e.target.removeAttribute("aria-checked");
    setToggleUi("multidevice", "Multi-device", on);
    const ok = await onMultiDevice?.(on);
    if (ok === false && e.target.isConnected) setToggleUi("multidevice", "Multi-device", !on);
    else if (ok !== false) toast(`Multi-device ${on ? "on" : "off"}`);
  });
  drawer.querySelector("[data-md-off]")?.addEventListener("click", async e => {
    e.preventDefault();
    const ok = await onMultiDevice?.(false, { quick: true });
    if (ok !== false) {
      setToggleUi("multidevice", "Multi-device", false);
      toast("Multi-device off");
    }
  });
  drawer.querySelector("[data-md-keep]")?.addEventListener("click", e => {
    e.preventDefault();
    onMultiDeviceKeep?.();
  });
  drawer.querySelector('[data-toggle="low-battery"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    localStorage.setItem("velta-low-battery-react", on ? "1" : "0");
    setToggleUi("low-battery", "Low-battery marker", on);
    onLowBatteryToggle?.(on);
    toast(`Low-battery marker ${on ? "on" : "off"}`);
  });
  drawer.querySelector("[data-dl-opts]")?.addEventListener("change", e => {
    const value = e.target?.dataset?.dlValue;
    if (!value || !onDownloadLimit) return;
    onDownloadLimit(value);
  });
  wireChatAppearance(drawer);
  drawer.querySelector("[data-theme-opts]")?.addEventListener("change", e => {
    const v = e.target?.value;
    if (!v || !THEME_LABELS[v]) return;
    onSetTheme?.(v);
    const summary = drawer.querySelector("[data-theme-summary]");
    if (summary) summary.textContent = `Theme: ${THEME_LABELS[v]}`;
    toast(`Theme: ${THEME_LABELS[v]}`);
  });

  // Outside tap closes the drawer. Capture phase, so it wins over whatever
  // lives under the tap; the transparent overlay (z 50) still swallows the
  // click so nothing under the drawer activates. Belt and suspenders: the
  // document listener works even where the overlay doesn't get the event.
  // Taps starting on #bar-menu are skipped (same toggle race as above) —
  // the button's own click toggles.
  const onDocPointer = e => {
    if (e.target?.closest?.("#bar-menu")) return;
    if (!drawer.contains(e.target)) close();
  };

  function open() {
    onDrawerOpen?.();
    drawer.classList.add("open");
    overlay.style.display = "block";
    document.addEventListener("pointerdown", onDocPointer, true);
    // lets the list-bar Menu button flip its icon to a cross while open
    document.dispatchEvent(new CustomEvent("velta-drawer", { detail: { open: true } }));
  }
  function close() {
    drawer.classList.remove("open");
    if (acctSwitch) acctSwitch.open = false;
    // the overlay may already be gone (wiped by closeAllPopups) — guard it
    if (overlay.isConnected) overlay.style.display = "none";
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.dispatchEvent(new CustomEvent("velta-drawer", { detail: { open: false } }));
  }
  activeDrawer = { close };

  // Setting checkboxes (Local chat / Strip tracking /
  // Send on Enter / Remember scroll position / Demo mode): the checkbox is the state indicator, the span keeps the
  // human-readable "Name: on/off" form. The rows are labels, not data-act
  // buttons — a click must only flip the checkbox, never close the drawer.
  const setToggleUi = (key, label, on) => {
    const row = drawer.querySelector(`[data-toggle="${key}"]`);
    if (row) row.checked = on;
    const span = drawer.querySelector(`[data-toggle="${key}"]`)?.closest(".ctx-item")?.querySelector("span");
    if (span) span.textContent = `${label}: ${on ? "on" : "off"}`;
  };

  drawer.querySelector('[data-toggle="p2p"]')?.addEventListener("change", e => {
    setToggleUi("p2p", "Local chat", e.target.checked);
    onP2pToggle?.(); // flips the real state and rebuilds the drawer
  });
  drawer.querySelector('[data-toggle="p2p-typing"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    if (on) localStorage.removeItem("velta-p2p-typing");
    else localStorage.setItem("velta-p2p-typing", "0");
    setToggleUi("p2p-typing", "Typing indicator", on);
    toast(`Typing indicator ${on ? "on" : "off"}`);
  });
  drawer.querySelector("[data-lp-opts]")?.addEventListener("change", e => {
    const input = e.target.closest?.("[data-lp-value]") || e.target;
    const mode = input?.dataset?.lpValue;
    if (!mode || mode === linkPreviewMode()) return;
    setLinkPreviewMode(mode);
    const summary = drawer.querySelector("[data-lp-opts]")?.closest("details")?.querySelector("summary span");
    if (summary) summary.textContent = `Link previews: ${LINK_PREVIEW_LABELS[mode]}`;
    toast(`Link previews: ${LINK_PREVIEW_LABELS[mode]}`);
  });
  drawer.querySelector('[data-toggle="strip-trackers"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    setTrackingStripEnabled(on);
    setToggleUi("strip-trackers", "Strip tracking from links", on);
    toast(`Strip tracking from links ${on ? "on" : "off"}`);
  });
  drawer.querySelector('[data-toggle="send-enter"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    if (on) localStorage.removeItem("velta-send-enter");
    else localStorage.setItem("velta-send-enter", "0");
    setToggleUi("send-enter", "Send on Enter", on);
    const composer = document.getElementById("composer-input");
    if (composer) composer.enterKeyHint = on ? "send" : "enter";
    toast(`Send on Enter ${on ? "on" : "off"}`);
  });
  // Remember scroll position in chats (issue #18, default ON per #70):
  // unset or "1" = on, "0" = off; ChatView reads it on every open/close.
  drawer.querySelector('[data-toggle="remember-scroll"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    if (on) localStorage.removeItem("velta-remember-scroll");
    else localStorage.setItem("velta-remember-scroll", "0");
    setToggleUi("remember-scroll", "Remember scroll position in chats", on);
    toast(`Remember scroll position in chats ${on ? "on" : "off"}`);
  });
  drawer.querySelector('[data-toggle="demo"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    localStorage.setItem("velta-mock", on ? "1" : "0");
    setToggleUi("demo", "Demo mode", on);
    toast(`Demo mode ${on ? "on" : "off"} — reloading`);
    setTimeout(() => location.reload(), 600);
  });

  drawer.addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    // The <summary> toggles natively; the drawer stays open.
    if (act === "switch-account") return;
    close();
    if (act === "saved") onOpenChat("saved");
    if (act === "invite") onInvite?.();
    if (act === "profile") onProfile?.();
    if (act === "edit-profile") onEditProfile?.();
    if (act === "profile-management") onProfileManagement?.();
    if (act === "account") onAccountTap?.(btn.dataset.account);
    if (act === "relays") onRelays?.();
    if (act === "ws-relays") onWsRelays?.();
    if (act === "invite-domains") onInviteDomains?.();
    if (act === "tunnel") onTunnel?.();
    if (act === "identity-backup") onIdentityBackup?.();
    if (act === "about") showAbout({ onDiagnostics, backendKind });
    if (act === "export-settings") onExportSettings?.();
  });

  // Rebuilds (rebuildDrawer) discard this drawer: drop the document
  // listeners an open drawer or switcher still holds.
  function destroy() {
    unwireAcct();
    document.removeEventListener("pointerdown", onDocPointer, true);
  }
  return { open, close, destroy, el: drawer, overlayEl: overlay, acctSwitch };
}

// Profile editor — edits the display name, the avatar picture and the
// description in one modal (issue #16).
// pickImage: async () => ({ path, url } | null), provided by the caller
// (Tauri file dialog on desktop, content-URI copy on Android, data-URL in
// demo mode). Resolves with
//   { name, avatar: "keep" | "remove" | { path }, description }
// — or null on cancel. contactId/kind shape the avatar preview (self contact
// by default; group editors pass contactId: 0 + kind: "group"); title
// overrides the heading.
export function showEditProfile({ name, avatarUrl, color, pickImage, contactId = 1, kind = "", title = "Edit profile", description = "" }) {
  return new Promise(resolve => {
    let picked = null;   // { path } once a new picture is chosen
    let removed = false; // "Remove photo" tapped
    const body = document.createElement("div");
    body.className = "edit-profile";
    body.innerHTML = `
      <div class="ep-avatar"><velta-avatar size="84"${contactId ? ` contact-id="${contactId}"` : ""}${kind ? ` kind="${kind}"` : ""}></velta-avatar></div>
      <div class="ep-avatar-actions">
        <button type="button" class="btn-text" data-ep="pick">Change picture</button>
        <button type="button" class="btn-text" data-ep="remove" style="display:none">Remove photo</button>
      </div>
      <input class="text-field" maxlength="64" autocomplete="off" spellcheck="false" aria-label="Name" placeholder="Your name">
      <textarea class="text-field ep-desc" rows="3" spellcheck="false" aria-label="Description" placeholder="Description"></textarea>`;
    const input = body.querySelector("input");
    const descTa = body.querySelector(".ep-desc");
    descTa.value = description || "";
    const preview = body.querySelector("velta-avatar");
    const removeBtn = body.querySelector('[data-ep="remove"]');
    preview.setAttribute("color", color || "#777");
    const refreshPreview = () => {
      const url = removed ? "" : (picked ? (picked.url ?? fileUrl(picked.path)) : avatarUrl);
      if (url) preview.setAttribute("avatar", url);
      else preview.removeAttribute("avatar");
      preview.setAttribute("name", input.value || "?");
      removeBtn.style.display = (url || picked) ? "" : "none";
    };
    input.value = name || "";
    refreshPreview();

    removeBtn.addEventListener("click", () => { removed = true; picked = null; refreshPreview(); });
    const pickBtn = body.querySelector('[data-ep="pick"]');
    pickBtn.addEventListener("click", async () => {
      // capture the element — event.currentTarget is null after await
      pickBtn.disabled = true;
      try {
        const res = await pickImage?.();
        if (res) { picked = res; removed = false; refreshPreview(); }
      } catch (err) {
        toast("Couldn't load picture: " + (err.message || err), 4000);
      } finally {
        pickBtn.disabled = false;
      }
    });
    input.addEventListener("input", refreshPreview);

    const foot = document.createElement("div");
    foot.className = "edit-profile-foot";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "btn-text btn-primary"; save.textContent = "Save";
    foot.append(cancel, save);

    // first settlement wins — close() fires onClose, which must not win
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const { close, form } = showModal({ title, body, foot, form: true,
      onClose: () => finish(null) });
    input.focus();
    input.select();
    const submit = () => {
      const value = {
        name: input.value.trim(),
        avatar: removed ? "remove" : (picked || "keep"),
        description: descTa.value.trim(),
      };
      save.disabled = true; input.disabled = true; descTa.disabled = true;
      // settle before close — close() fires onClose, which must not win
      finish(value);
      close();
    };
    form.addEventListener("submit", submit);
    cancel.addEventListener("click", () => { close(); finish(null); });
  });
}

// Invite modal with a real SecureJoin QR rendered by the core.
// provider: async () => ({ svg, link })
// account: when set (self invite), the Velta logo is overlaid in the QR
// center — the core reserves a clear circle there for exactly that.
export function showInvite(provider, { title = "Invite to Delta Chat", group = false, account = null } = {}) {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5">${group
      ? "Anyone scanning this code can join this group — the joiner is verified end-to-end automatically."
      : "Anyone scanning this code with Delta Chat can reach you with verified end-to-end encryption."}</p>
    <div class="qr-box"><div class="qr-loading">Generating QR code…</div></div>
    <div class="invite-link" style="word-break:break-all"></div>
    <div style="text-align:center;margin-top:6px"><button type="button" class="btn-text" data-copy>Copy invite link</button></div>`;
  showModal({ title, body });
  body.querySelector("[data-copy]").addEventListener("click", () => {
    const link = body.querySelector(".invite-link").textContent;
    navigator.clipboard?.writeText(link).then(() => toast("Invite link copied"));
  });
  provider()
    .then(({ svg, link }) => {
      const box = body.querySelector(".qr-box");
      box.innerHTML = svg || "<div class='qr-loading'>QR unavailable</div>";
      body.querySelector(".invite-link").textContent = link;
      // Overlay the Velta logo on the clear circle the core leaves in the
      // QR center (design space 515x630, circle center at 50% / 43.65% of
      // the rendered svg).
      if (account && svg) {
        box.insertAdjacentHTML("beforeend",
          `<div class="qr-self"><img src="./icons/v-logo.svg" alt=""></div>`);
      }
    })
    .catch(err => {
      body.querySelector(".qr-box").innerHTML =
        `<div class="qr-loading">Couldn't create the invite:<br>${escapeHtml(String(err?.message || err))}</div>`;
    });
}

async function showAbout({ onDiagnostics = null, backendKind = null } = {}) {
  // Prefer the runtime version so the About dialog always matches the built
  // app; the core version is the pinned core/ workspace version.
  const version = await getAppVersion();
  let foot;
  if (onDiagnostics) {
    // Logs stay reachable from the drawer even when the chat list (where the
    // Diagnostics chat normally sits) fails to render.
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-text";
    btn.dataset.openDiagnostics = "";
    btn.textContent = "Open diagnostics log";
    btn.addEventListener("click", () => { about.close(); onDiagnostics(); });
    foot = btn;
  }
  const about = showModal({
    title: "About Velta",
    foot,
    body: `
      <div class="info-row"><span class="k">App</span><span class="v">Velta ${escapeHtml(version)}</span></div>
      <div class="info-row"><span class="k">Core</span><span class="v">deltachat-core-rust ${CORE_VERSION}</span></div>
      <div class="info-row"><span class="k">Transport</span><span class="v">chatmail relays (IMAP/SMTP)</span></div>
      <div class="info-row"><span class="k">Encryption</span><span class="v">OpenPGP, end-to-end</span></div>
      <div class="info-row"><span class="k">UI stack</span><span class="v">Elena progressive web components</span></div>
      <div class="enc-note"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>No phone number needed. No central servers. Your messages travel through email relays you choose, encrypted end to end.</span></div>
      <details class="device-info" data-device-info>
        <summary>Show device info</summary>
        <pre class="device-info-text" data-device-info-text></pre>
        <div class="device-info-actions">
          <button type="button" class="btn-text" data-device-copy>Copy</button>
          <button type="button" class="btn-text" data-device-share hidden>Share</button>
        </div>
      </details>`,
  });
  // Device info for bug reports — collected when opened (viewport, orientation
  // and insets are live values), no personal identifiers (device-info.js).
  const det = about.modal.querySelector("[data-device-info]");
  const pre = det.querySelector("[data-device-info-text]");
  let tauriVersion = null;
  const fill = () => {
    pre.textContent = formatDeviceInfo(collectDeviceInfo({
      window, navigator, screen,
      appVersion: version, coreVersion: CORE_VERSION, tauriVersion,
      tauri: isTauri(), android: isAndroid(), backendKind,
      uiScale: uiScaleValue(), theme: document.documentElement.dataset.theme || "auto",
      safeArea: measureSafeArea(document),
    }));
  };
  det.addEventListener("toggle", () => {
    if (!det.open) return;
    fill();
    getTauriVersion().then(v => { if (v && v !== tauriVersion) { tauriVersion = v; fill(); } }, () => {});
  });
  det.querySelector("[data-device-copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      toast("Device info copied");
    } catch (err) { toast("Couldn't copy: " + (err?.message || err)); }
  });
  const shareBtn = det.querySelector("[data-device-share]");
  const webShare = typeof navigator.share === "function" ? o => navigator.share(o) : null;
  shareBtn.hidden = !canShareLink({ ua: navigator.userAgent, hasInvoke: !!tauriInvoke(), hasWebShare: !!webShare });
  shareBtn.addEventListener("click", async () => {
    try {
      await shareLink(pre.textContent, { ua: navigator.userAgent, invoke: tauriInvoke(), webShare, title: "Velta device info" });
    } catch (err) { toast("Couldn't share: " + (err?.message || err)); }
  });
}

/* ---------- Emoji pop ---------- */
/* ---------- Fullscreen image lightbox (pinch to zoom) ---------- */
// Overlay/BACK convention (same as the HTML viewer and webxdc overlay):
// open pushes a {velta:"lightbox"} history entry, so Android BACK pops it and
// popstate tears the overlay down — BACK returns to the chat history instead
// of leaving the chat. ✕/Esc/tap closes consume the entry via history.back()
// (skipped when the pop already happened). Reopening while open replaces the
// overlay and reuses the current entry — history.back() is async, so
// back-then-push would race and lose it.
let lightboxEl = null, lightboxOnKey = null;

function teardownLightbox(consumeEntry) {
  if (!lightboxEl) return;
  const el = lightboxEl;
  lightboxEl = null;
  document.removeEventListener("keydown", lightboxOnKey, true);
  lightboxOnKey = null;
  el.remove();
  if (consumeEntry && history.state?.velta === "lightbox") history.back();
}

window.addEventListener("popstate", () => teardownLightbox(false));

export function openImageLightbox(src, caption = "") {
  closeAllPopups();
  teardownLightbox(false);
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.innerHTML = `
    <div class="lightbox-bar">
      <span class="lightbox-cap"></span>
      <button type="button" class="lightbox-close" aria-label="Close" title="Close"></button>
    </div>
    <div class="lightbox-stage"><img class="lightbox-img" decoding="async" alt=""></div>`;
  overlay.querySelector(".lightbox-close").innerHTML = CLOSE_SVG;
  document.body.appendChild(overlay);
  raiseToasts();
  overlay.querySelector(".lightbox-cap").textContent = caption;
  const img = overlay.querySelector(".lightbox-img");
  const stage = overlay.querySelector(".lightbox-stage");
  img.src = src;
  lightboxEl = overlay;
  if (history.state?.velta !== "lightbox") history.pushState({ velta: "lightbox" }, "");

  let scale = 1, tx = 0, ty = 0;
  let startDist = 0, startScale = 1, startX = 0, startY = 0, startTx = 0, startTy = 0;
  let touched = false, lastTap = 0, tapTimer = 0;

  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };

  const close = () => teardownLightbox(true);
  lightboxOnKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", lightboxOnKey, true);
  overlay.querySelector(".lightbox-close").addEventListener("click", close);

  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  stage.addEventListener("touchstart", e => {
    touched = true;
    if (e.touches.length === 2) {
      startDist = dist(e.touches);
      startScale = scale;
    } else if (e.touches.length === 1) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTx = tx; startTy = ty;
    }
  }, { passive: true });

  stage.addEventListener("touchmove", e => {
    e.preventDefault();
    if (e.touches.length === 2 && startDist > 0) {
      scale = Math.min(8, Math.max(1, startScale * dist(e.touches) / startDist));
      if (scale <= 1.02) { scale = 1; tx = 0; ty = 0; }
      apply();
    } else if (e.touches.length === 1 && scale > 1) {
      tx = startTx + (e.touches[0].clientX - startX);
      ty = startTy + (e.touches[0].clientY - startY);
      apply();
    }
  }, { passive: false });

  stage.addEventListener("touchend", e => {
    if (e.touches.length === 0) {
      startDist = 0;
      if (scale <= 1.02 && !touched) return;
      // single quick tap on the image closes; double tap toggles zoom
      const now = Date.now();
      if (now - lastTap < 300) {
        clearTimeout(tapTimer);
        lastTap = 0;
        if (scale > 1) reset();
        else { scale = 2.5; apply(); }
      } else {
        lastTap = now;
        tapTimer = setTimeout(() => { if (lastTap && scale <= 1.02) close(); }, 320);
      }
      touched = false;
    }
  });

  // desktop: wheel zoom, dblclick toggle, Esc/✕ close
  stage.addEventListener("wheel", e => {
    e.preventDefault();
    scale = Math.min(8, Math.max(1, scale * (e.deltaY < 0 ? 1.15 : 0.87)));
    if (scale <= 1.02) { scale = 1; tx = 0; ty = 0; }
    apply();
  }, { passive: false });
  stage.addEventListener("dblclick", () => {
    if (scale > 1) reset(); else { scale = 2.5; apply(); }
  });
  stage.addEventListener("click", e => {
    if (scale <= 1.02 && !e.isTrusted === false && e.detail === 1) close();
  });
}

// Video lightbox: same shell as the image lightbox (bar + close + history
// entry), stage hosts a <video controls autoplay>. No pinch-zoom - the
// player's own controls cover it. Click on the video does NOT close
// (it toggles play/pause natively); close = button/Esc/BACK.
export function openVideoLightbox(src, caption = "") {
  closeAllPopups();
  teardownLightbox(false);
  const overlay = document.createElement("div");
  overlay.className = "lightbox lightbox-video";
  overlay.innerHTML = `
    <div class="lightbox-bar">
      <span class="lightbox-cap"></span>
      <button type="button" class="lightbox-close" aria-label="Close" title="Close"></button>
    </div>
    <div class="lightbox-stage"><video class="lightbox-video" controls autoplay playsinline></video></div>`;
  overlay.querySelector(".lightbox-close").innerHTML = CLOSE_SVG;
  document.body.appendChild(overlay);
  raiseToasts();
  overlay.querySelector(".lightbox-cap").textContent = caption;
  const video = overlay.querySelector("video");
  video.src = src;
  lightboxEl = overlay;
  if (history.state?.velta !== "lightbox") history.pushState({ velta: "lightbox" }, "");

  const close = () => teardownLightbox(true);
  lightboxOnKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", lightboxOnKey, true);
  overlay.querySelector(".lightbox-close").addEventListener("click", close);
  // the video's own clicks toggle play/pause - never bubble into stage close
  video.addEventListener("click", e => e.stopPropagation());
}

/* ---------- incoming-message notifications ---------- */
// Callers own which message is new; this decides whether the user is looking
// and bridges to the platform notification. Android notifications are posted
// by Rust — the page does not toast there (a second plain card on the
// plugin default channel). Desktop WebView2 leaves document.hidden false
// when the window is minimized or unfocused, so those states toast too.
let lastNotifyAt = 0;
function logNotify(msg) {
  try {
    const invoke = tauriInvoke();
    if (invoke) invoke("js_log", { msg }).catch(() => {});
  } catch {}
}
export function notifyIncoming(title, body, info = {}) {
  const tauri = window.__TAURI__;
  if (tauri) return notifyIncomingTauri(tauri, title, body, info);
  return notifyIncomingWeb(title, body, info);
}

// Drawer + privacy gates shared by both platforms. Returns null = stay
// silent, otherwise the (possibly redacted) preview body.
function notifyGateBody(body) {
  // Drawer master switch (default on). Desktop path only — on Android the
  // Rust background poller posts notifications while this page is frozen
  // and cannot run this gate.
  if (localStorage.getItem("velta-notify") === "0") return null;
  // "System notification for new messages" OFF: no OS toast.
  if (localStorage.getItem("velta-notify-system") === "0") return null;
  // "Mentions only": skip messages that neither @mention anyone nor name
  // the user.
  if (localStorage.getItem("velta-notify-mentions") === "1") {
    const lower = (body || "").toLowerCase();
    if (!lower.includes("@")) return null;
  }
  // Privacy toggle: drop the message text from the preview (the chat and
  // sender names stay).
  if (localStorage.getItem("velta-notify-text") === "0") {
    body = "New message";
  }
  return body;
}

// Tauri shell: the Android page stays quiet (Rust posts the one
// MessagingStyle card); desktop WebView2 toasts through notify_incoming.
function notifyIncomingTauri(tauri, title, body, info) {
  const android = isAndroid();
  if (android) return;
  const gated = notifyGateBody(body);
  if (gated === null) return;
  const send = () => {
    const now = Date.now();
    if (now - lastNotifyAt < 4000) return;
    lastNotifyAt = now;
    const invoke = tauri.core?.invoke || tauri.invoke;
    invoke("notify_incoming", {
      title,
      body: gated,
      chatName: info.chatName || null,
      senderName: info.senderName || null,
      senderAvatar: info.senderAvatar || null,
      // Windows toast activation opens this chat (issue #20).
      accountId: info.accountId ?? null,
      chatId: info.chatId ?? null,
    }).catch((err) => logNotify(`notify_incoming failed: ${err}`));
  };
  const consider = (minimized, focused) => {
    if (shouldNotifyIncoming({
      tauri: true,
      android: false,
      hidden: !!document.hidden,
      minimized: !!minimized,
      focused,
    })) send();
  };
  // Hidden already decides it. The window check below is the desktop case
  // where the page stays marked visible.
  if (document.hidden) {
    consider(false, true);
    return;
  }
  let win;
  try {
    win = tauri.window?.getCurrentWindow?.();
  } catch (err) {
    logNotify(`notifyIncoming window: ${err}`);
    return;
  }
  if (!win?.isMinimized || !win?.isFocused) return;
  Promise.all([win.isMinimized(), win.isFocused()]).then(([minimized, focused]) => {
    consider(minimized, focused);
  }).catch((err) => logNotify(`notifyIncoming window state: ${err}`));
}

// PWA / plain browser: post through the service worker so the toast still
// fires while the tab is hidden (new Notification() from a hidden page is
// throttled hard). The notificationclick side lives in the generated sw.js;
// it focuses a client and hands over {accountId, chatId} via postMessage.
async function notifyIncomingWeb(title, body, info) {
  const gated = notifyGateBody(body);
  if (gated === null) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!shouldNotifyIncoming({
    web: true,
    hidden: !!document.hidden,
    focused: document.hasFocus(),
  })) return;
  const now = Date.now();
  if (now - lastNotifyAt < 4000) return;
  lastNotifyAt = now;
  const payload = {
    body: gated,
    tag: `velta-${info.accountId ?? 0}-${info.chatId ?? 0}`,
    renotify: true,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { accountId: info.accountId ?? null, chatId: info.chatId ?? null },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, payload);
    else new Notification(title, payload);
  } catch (err) {
    console.warn("showNotification failed:", err);
  }
}
