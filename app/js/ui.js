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
import { videoPosKey, videoResumeSeconds, rememberVideoPos } from "./video-pos.js";
import { t, currentLang, setLang, LANGS, translateTree } from "./i18n.js";
import { markLangCardDone } from "./lang-cards.js";
import { ICON, LOOP_SVG, P, svg } from "./icons.js";
import { mountInviteDomains } from "./invite-domains.js";

const popups = () => document.getElementById("popups");

// Popover API: Chromium 114+ and Safari 17+. macOS 10.15/11 stay on the overlay.
// "Name: on/off" row text for drawer toggles; the state words are keys too.
function toggleText(label, state) {
  return t("{label}: {state}", { label: t(label), state: state === "…" ? "…" : t(state) });
}

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
  ICON.close;

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
export const MENU_CLOSE_SVG = ICON.close;
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

// Monochrome smiley that expands the quick-reaction row into the tray.
const SMILEY_SVG = ICON.smiley;

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
    if (it.ariaLabel) b.setAttribute("aria-label", t(it.ariaLabel));
    b.innerHTML = (it.icon || "") + "<span>" + escapeHtml(t(it.label || "")) + "</span>";
    b.addEventListener("click", () => { closeAllPopups(); it.onClick?.(); });
    menu.appendChild(b);
  }
  openLightDismiss(menu);
  placeMenu(menu, x, y);
  return menu;
}

// Message action bar (desktop): the message menu as a wrapping chip row —
// quick-reaction emoji chips (smiley opens the searchable tray) followed by
// icon+label action chips. Light-dismiss like any popup, but positioned
// against the message: right-aligned above the bubble's top edge, flipping
// below when that would clip the viewport top. `anchor` is the bubble rect;
// `scrollEl` closes the bar when the chat scrolls (it does not follow).
// Returns a close() that also unwires the scroll listener.
export function showActionBar({ items, reactions = [], selected = null, onReact, anchor = null, own = false, scrollEl = null, onClosed = null }) {
  closeAllPopups();
  const bar = document.createElement("div");
  bar.className = "ctx-menu msg-action-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", t("Message actions"));
  // Two rows: quick-reaction emoji on top, action chips below. The smiley
  // swaps both for the searchable tray; Back restores them.
  const reacts = document.createElement("div");
  reacts.className = "msg-bar-reacts";
  const chips = document.createElement("div");
  chips.className = "msg-bar-chips";
  const shown = selected && !reactions.includes(selected) ? [selected, ...reactions.slice(0, -1)] : reactions;
  for (const emoji of shown) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "msg-bar-react" + (emoji === selected ? " mine" : "");
    b.textContent = emoji;
    b.setAttribute("aria-pressed", emoji === selected ? "true" : "false");
    b.setAttribute("aria-label", emoji === selected ? t("Remove reaction {emoji}", { emoji }) : emoji);
    b.addEventListener("click", () => { close(); onReact?.(emoji); });
    reacts.append(b);
  }
  let tray = null;
  if (reactions.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "msg-bar-react msg-bar-more";
    more.setAttribute("aria-label", t("More emoji"));
    more.innerHTML = SMILEY_SVG;
    tray = buildEmojiTray({
      onReact,
      onBack: () => { tray.hidden = true; reacts.hidden = false; chips.hidden = false; },
    });
    more.addEventListener("click", () => {
      reacts.hidden = true;
      chips.hidden = true;
      tray.hidden = false;
      tray.open();
    });
    reacts.append(more);
  }
  for (const it of items) {
    if (it === "-") continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "msg-bar-chip" + (it.danger ? " danger" : "");
    if (it.ariaLabel) b.setAttribute("aria-label", t(it.ariaLabel));
    b.title = t(it.label || "");
    b.innerHTML = (it.icon || "") + "<span>" + escapeHtml(t(it.short || it.label || "")) + "</span>";
    b.addEventListener("click", () => { close(); it.onClick?.(); });
    chips.append(b);
  }
  if (tray) bar.append(reacts, chips, tray);
  else bar.append(chips);
  // Dismissal must not depend on the popover's own light dismiss: it has
  // proven unreliable in occluded windows. Outside pointerdown (capture —
  // ahead of any overlay), Escape and a chat scroll all close; close() is
  // idempotent and also runs from chip clicks and the popover toggle.
  const close = () => {
    closeAllPopups();
    scrollEl?.removeEventListener("scroll", onScroll);
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onDocKey, true);
    onClosed?.();
  };
  const onScroll = () => close();
  const onDocPointer = (e) => {
    if (bar.isConnected && !bar.contains(e.target) && !e.target.closest?.(".msg-hover-more")) close();
  };
  const onDocKey = (e) => { if (e.key === "Escape") close(); };
  scrollEl?.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("pointerdown", onDocPointer, true);
  document.addEventListener("keydown", onDocKey, true);
  // The popover light-dismiss, when it fires, must also reach close().
  bar.addEventListener("toggle", (e) => { if (e.newState === "closed") close(); });
  openLightDismiss(bar);
  const r = bar.getBoundingClientRect();
  const vw = globalThis.innerWidth || 1024;
  // Own (.out) bubbles right-align the bar to their edge; received bubbles
  // left-align it — the bar never swings over the chat list.
  let left;
  if (anchor && !own) left = Math.max(8, Math.min(anchor.left, vw - r.width - 8));
  else {
    left = anchor ? anchor.right - r.width : (vw - r.width) / 2;
    left = Math.max(8, Math.min(left, vw - r.width - 8));
  }
  let top = anchor ? anchor.top - r.height - 6 : 120;
  if (top < 8 && anchor) top = anchor.bottom + 6;
  bar.style.left = Math.round(left) + "px";
  bar.style.top = Math.round(top) + "px";
  return close;
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

// Phone message menu layout (Firefox-style): every non-danger action is a
// tile in a 3-column grid (2 under 340px, CSS), in the given order, so no
// half-empty pair rows. Danger items (Delete) follow as full-width rows.
// "-" is dropped.
export function messageSheetRows(items) {
  const tiles = [];
  const danger = [];
  for (const it of items) {
    if (it === "-") continue;
    (it.danger ? danger : tiles).push(it);
  }
  return { tiles, danger };
}

// Arrow keys move focus between grid tiles; columns come from the live grid.
export function gridNeighbor(index, count, cols, key) {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[key];
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (step == null) return index;
  const next = index + step;
  return next < 0 || next >= count ? index : next;
}

function sheetAction(it) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ctx-item" + (it.danger ? " danger" : "");
  b.innerHTML = (it.icon || "") + "<span>" + escapeHtml(t(it.short || it.label)) + "</span>";
  b.addEventListener("click", () => { closeAllPopups(); it.onClick?.(); });
  return b;
}

// Mobile message menu: emoji grid, then related actions in two columns.
// The last reaction cell opens a searchable tray and does not send a reaction.
// Searchable emoji tray: Back + search field + grid of matches. Shared by the
// reaction row (sheet / old-style menus) and the bubble action bar. `onBack`
// hides nothing itself — the caller owns the toggle; Back clears the search
// first. `tray.open()` paints the grid and focuses the field.
export function buildEmojiTray({ onReact, onBack } = {}) {
  const tray = document.createElement("div");
  tray.className = "msg-emoji-tray";
  tray.hidden = true;
  const back = document.createElement("button");
  back.type = "button";
  back.className = "msg-emoji-back";
  back.innerHTML = ICON.arrowLeft + "<span>" + escapeHtml(t("Back")) + "</span>";
  back.setAttribute("aria-label", t("Back"));
  const search = document.createElement("input");
  search.type = "search";
  search.className = "text-field";
  search.placeholder = t("Search emoji");
  search.setAttribute("aria-label", t("Search emoji"));
  search.autocomplete = "off";
  const grid = document.createElement("div");
  grid.className = "msg-emoji-grid";
  const paint = () => {
    const found = searchEmoji(search.value);
    grid.replaceChildren();
    if (!found.length) {
      const empty = document.createElement("div");
      empty.className = "msg-emoji-empty";
      empty.textContent = t("No emoji");
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
  // Arrow keys: from search, Down enters the grid; inside it they walk it.
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { const f = grid.querySelector(".msg-emoji"); if (f) { e.preventDefault(); f.focus(); } }
  });
  grid.addEventListener("keydown", (e) => {
    const cells = [...grid.querySelectorAll(".msg-emoji")];
    const i = cells.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length);
    if (e.key === "ArrowUp" && i < cols) { e.preventDefault(); search.focus(); return; }
    const j = gridNeighbor(i, cells.length, cols, e.key);
    if (j !== i) { e.preventDefault(); cells[j].focus(); cells[j].scrollIntoView?.({ block: "nearest" }); }
  });
  back.addEventListener("click", () => { search.value = ""; onBack?.(); });
  tray.append(back, search, grid);
  tray.open = () => { paint(); search.focus(); };
  return tray;
}

// Reaction row + expandable searchable emoji tray, shared by the mobile
// message sheet and the desktop context menu: one row of quick reactions
// ending in a monochrome smiley that swaps the row for Back + search + grid.
// Caller appends { reacts, tray } in that order (tray starts hidden).
export function buildReactionRow({ reactions, selected = null, onReact, onMore = null }) {
  const reacts = document.createElement("div");
  reacts.className = "msg-reacts";
  const shown = selected && !reactions.includes(selected) ? [selected, ...reactions.slice(0, -1)] : reactions;
  for (const emoji of shown) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "msg-react" + (emoji === selected ? " mine" : "");
    b.textContent = emoji;
    b.setAttribute("aria-pressed", emoji === selected ? "true" : "false");
    b.setAttribute("aria-label", emoji === selected ? t("Remove reaction {emoji}", { emoji }) : emoji);
    b.addEventListener("click", () => { closeAllPopups(); onReact?.(emoji); });
    reacts.append(b);
  }
  const more = document.createElement("button");
  more.type = "button";
  more.className = "msg-react msg-react-more";
  more.setAttribute("aria-label", t("More emoji"));
  more.innerHTML = SMILEY_SVG;
  const tray = buildEmojiTray({
    onReact,
    onBack: () => { tray.hidden = true; reacts.hidden = false; },
  });
  more.addEventListener("click", () => {
    if (onMore) { onMore(tray); return; }
    reacts.hidden = true;
    tray.hidden = false;
    tray.open();
  });
  reacts.append(more);
  return { reacts, tray };
}

// Drag-to-dismiss for bottom sheets: decide on release. Closes past 30% of
// the sheet height or on a fast downward flick (px/ms).
export const SHEET_CLOSE_FRACTION = 0.3;
export const SHEET_FLICK_SPEED = 0.5;
export function sheetDragDecision(dy, height, velocity) {
  if (dy <= 0) return "snap";
  if (dy >= height * SHEET_CLOSE_FRACTION) return "close";
  return velocity >= SHEET_FLICK_SPEED && dy > 12 ? "close" : "snap";
}

// Starts on the handle or the sheet's top strip (48px). Follows the finger
// downward only. A tap stays a tap: the drag engages after 6px of downward
// movement, and only then is the click that ends the gesture swallowed.
export function bindSheetDrag(sheet, handle, close, { topZone = 48 } = {}) {
  let start = null;
  const reduce = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const setY = (y, animate) => {
    sheet.style.transition = animate && !reduce() ? "transform .18s ease-out" : "none";
    sheet.style.transform = y > 0 ? `translateY(${y}px)` : "";
  };
  sheet.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    const top = sheet.getBoundingClientRect().top;
    if (!handle.contains(e.target) && e.clientY - top > topZone) return;
    start = { id: e.pointerId, y: e.clientY, t: e.timeStamp, lastY: e.clientY, lastT: e.timeStamp, v: 0, dragging: false };
  });
  sheet.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = e.clientY - start.y;
    if (!start.dragging) {
      if (dy < 6) return;
      start.dragging = true;
      try { sheet.setPointerCapture(e.pointerId); } catch {}
    }
    const dt = Math.max(1, e.timeStamp - start.lastT);
    start.v = (e.clientY - start.lastY) / dt;
    start.lastY = e.clientY; start.lastT = e.timeStamp;
    setY(Math.max(0, dy), false);
    e.preventDefault();
  });
  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const s = start;
    start = null;
    if (!s.dragging) return;
    // Swallow the click this gesture would fire on an emoji or tile.
    sheet.addEventListener("click", ev => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
    const dy = Math.max(0, e.clientY - s.y);
    const cancelled = e.type === "pointercancel";
    if (!cancelled && sheetDragDecision(dy, sheet.getBoundingClientRect().height, s.v) === "close") {
      if (reduce()) { close(); return; }
      setY(sheet.getBoundingClientRect().height, true);
      setTimeout(close, 180);
    } else {
      setY(0, true);
    }
  };
  sheet.addEventListener("pointerup", end);
  sheet.addEventListener("pointercancel", end);
}

// Inline delete confirm (phone sheet): the Delete row becomes Cancel /
// Delete for me / Delete for everyone (only when the modal would offer it).
export function deleteConfirmChoices(canForAll) {
  const c = [{ label: "Cancel", value: null, icon: "close" }, { label: "Delete for me", value: "me", danger: true, icon: "trash" }];
  if (canForAll) c.push({ label: "Delete for everyone", value: "everyone", danger: true, icon: "trash" });
  return c;
}

function showInlineDeleteConfirm(wrap, deleteBtn, { canForAll, onChoose }) {
  const row = document.createElement("div");
  row.className = "msg-del-confirm";
  // Two choices sit icon-beside-label; three stack icon over label.
  row.dataset.count = String(deleteConfirmChoices(canForAll).length);
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", t("Delete messages"));
  const buttons = deleteConfirmChoices(canForAll).map(c => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctx-item" + (c.danger ? " danger" : "");
    b.innerHTML = (ICON[c.icon] || "") + "<span>" + escapeHtml(t(c.label)) + "</span>";
    b.addEventListener("click", () => {
      if (c.value == null) {
        row.replaceWith(deleteBtn);
        deleteBtn.focus();
        return;
      }
      closeAllPopups();
      onChoose(c.value);
    });
    return b;
  });
  row.append(...buttons);
  deleteBtn.replaceWith(row);
  wrap.classList.add("confirming");
  buttons[0].focus();
}

// Two rows of six: 11 quick reactions + the "more" smiley.
export const SHEET_QUICK_REACTIONS = 11;

function openSheetPicker(menu, tray) {
  menu.style.height = menu.getBoundingClientRect().height + "px";
  menu.classList.add("picking");
  tray.hidden = false;
  tray.open();
}

function closeSheetPicker(menu, tray) {
  menu.classList.remove("picking");
  menu.style.height = "";
  tray.hidden = true;
  menu.querySelector(".msg-react-more")?.focus();
}

// Escape in the sheet: leaves the picker first, closes on the next press.
export function sheetEscapeAction(picking) {
  return picking ? "back" : "close";
}

export function showMessageSheet({ reactions = [], selected = null, onReact, items, links = [], onOpenLink }) {
  closeAllPopups();
  const menu = document.createElement("div");
  menu.className = "ctx-menu msg-sheet";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", t("Message actions"));
  const grab = document.createElement("button");
  grab.type = "button";
  grab.className = "msg-sheet-grab";
  grab.setAttribute("aria-label", t("Close menu"));
  grab.addEventListener("click", () => closeAllPopups());
  menu.append(grab);
  bindSheetDrag(menu, grab, closeAllPopups);

  // Phone sheet: exactly two rows of quick reactions (11 + the smiley).
  // The smiley swaps the whole sheet body for the picker at the sheet's
  // current height (no resize, no modal); Back / Escape return to the menu.
  let picker = null;
  if (reactions.length) {
    const quick = reactions.slice(0, SHEET_QUICK_REACTIONS);
    const { reacts, tray } = buildReactionRow({
      reactions: quick, selected, onReact,
      onMore: (tr) => openSheetPicker(menu, tr),
    });
    tray.classList.add("msg-sheet-picker");
    picker = tray;
    menu.append(reacts, tray);
  }

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const { tiles, danger } = messageSheetRows(items);
  if (tiles.length) {
    const grid = document.createElement("div");
    grid.className = "msg-grid";
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", t("Message actions"));
    const buttons = tiles.map(it => {
      const b = sheetAction(it);
      b.classList.add("msg-tile");
      return b;
    });
    grid.append(...buttons);
    grid.addEventListener("keydown", (e) => {
      const i = buttons.indexOf(document.activeElement);
      if (i < 0) return;
      const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length);
      const j = gridNeighbor(i, buttons.length, cols, e.key);
      if (j !== i || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        buttons[j].focus();
      }
    });
    actions.append(grid);
  }
  for (const it of danger) {
    const wrap = document.createElement("div");
    wrap.className = "msg-row-full";
    if (it.inlineConfirm) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctx-item danger";
      b.innerHTML = (it.icon || "") + "<span>" + escapeHtml(t(it.short || it.label)) + "</span>";
      b.addEventListener("click", () => showInlineDeleteConfirm(wrap, b, it.inlineConfirm));
      wrap.append(b);
    } else {
      wrap.append(sheetAction(it));
    }
    actions.append(wrap);
  }
  menu.append(actions);

  // "Show links" (#161 mobile): every link in the message as real <a href>
  // anchors, so the WebView's own long-press menu (open / copy address /
  // share) works on each. Tap still opens through the app.
  if (links.length) {
    const det = document.createElement("details");
    det.className = "msg-links";
    const sum = document.createElement("summary");
    sum.textContent = links.length > 1 ? t("Show links ({n})", { n: links.length }) : t("Show links");
    const list = document.createElement("div");
    list.className = "msg-links-list";
    for (const url of links) {
      const a = document.createElement("a");
      a.href = url;
      a.textContent = url.replace(/^https?:\/\//i, "");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        closeAllPopups();
        onOpenLink?.(url);
      });
      list.append(a);
    }
    det.append(sum, list);
    menu.append(det);
  }

  const overlay = document.createElement("div");
  overlay.className = "pop-overlay";
  overlay.addEventListener("pointerdown", closeAllPopups);
  overlay.addEventListener("contextmenu", e => { e.preventDefault(); closeAllPopups(); });
  popups().append(overlay, menu);
  if (picker) {
    // buildEmojiTray's onBack restores the inline row; in the sheet the
    // whole body comes back instead.
    picker.querySelector(".msg-emoji-back")?.addEventListener("click", () => closeSheetPicker(menu, picker));
    const onKey = (e) => {
      if (!menu.isConnected) { window.removeEventListener("keydown", onKey, true); return; }
      if (e.key !== "Escape") return;
      if (sheetEscapeAction(menu.classList.contains("picking")) === "back") {
        e.stopPropagation(); e.preventDefault();
        picker.querySelector("input").value = "";
        closeSheetPicker(menu, picker);
      }
    };
    window.addEventListener("keydown", onKey, true);
  }
  return menu;
}

export function showStickerPicker({ getStickers, onPick }) {
  closeAllPopups();
  const pop = document.createElement("div");
  pop.className = "sticker-pop";
  const grid = document.createElement("div");
  grid.className = "sticker-grid";
  grid.innerHTML = `<div class="sticker-note">${escapeHtml(t("Loading…"))}</div>`;
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
    if (!n) grid.innerHTML = `<div class="sticker-note">${t("No stickers yet.<br>Long-press a sticker you received and choose “Save sticker”.")}</div>`;
  }).catch(() => {
    grid.innerHTML = `<div class="sticker-note">${escapeHtml(t("Couldn't load stickers."))}</div>`;
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
    b.textContent = t(text);
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
  head.innerHTML = `<div class="modal-title">${escapeHtml(t(title || ""))}</div>`;
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
  const sticky = opts.sticky === true;
  const duration = sticky ? 0 : Math.max(800, ms || 2200);
  // <details>/<summary>: the collapsed one-liner is the summary, the open
  // pane carries the full text and the copy button. Native toggle gives the
  // expand/collapse + disclosure semantics without JS state; JS adds the
  // timer (pause while open), copy, close, and the overflow-gated chip.
  const el = document.createElement("details");
  el.className = "toast" + (opts.danger ? " danger" : "") + (sticky ? " toast-sticky" : "");
  const summary = document.createElement("summary");
  summary.className = "toast-summary";
  const textEl = document.createElement("span");
  textEl.className = "toast-text";
  textEl.textContent = t(String(text));
  const timerBar = document.createElement("span");
  timerBar.className = "toast-timer";
  const chip = document.createElement("span");
  chip.className = "toast-chip"; chip.hidden = true;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button"; closeBtn.className = "toast-close"; closeBtn.setAttribute("aria-label", t("Close")); closeBtn.innerHTML = CLOSE_SVG;
  summary.append(...(sticky ? [] : [timerBar]), textEl, chip, closeBtn);
  const moreText = document.createElement("div");
  moreText.className = "toast-more-text";
  moreText.textContent = t(String(text));
  const copyBtn = document.createElement("button");
  copyBtn.type = "button"; copyBtn.className = "toast-copy"; copyBtn.textContent = t("Copy");
  const more = document.createElement("div");
  more.className = "toast-more";
  more.append(moreText, copyBtn);
  el.append(summary, more);
  box.appendChild(el);
  // A sticky notice (the PWA reload) sits outside the cap and is never the one dropped.
  const ordinary = () => [...box.children].filter((n) => !n.classList.contains("toast-sticky"));
  while (ordinary().length > 3) ordinary()[0].remove();
  raiseToasts();

  const clickLabel = (() => {
    try { return matchMedia("(hover: hover) and (pointer: fine)").matches ? "Click" : "Tap"; } catch { return "Tap"; }
  })();
  const chipPhrase = () => clickLabel === "Click"
    ? (el.open ? t("Click to collapse") : t("Click to expand"))
    : (el.open ? t("Tap to collapse") : t("Tap to expand"));

  const dismiss = () => { el.remove(); hideToastsIfEmpty(); };
  if (typeof opts.undo === "function") {
    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "toast-undo";
    undoBtn.textContent = t("Undo");
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
    actBtn.textContent = t(String(opts.action.label || "OK"));
    actBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      opts.action.run();
      dismiss();
    });
    summary.insertBefore(actBtn, closeBtn);
  }
  if (!sticky) {
    timerBar.style.animationDuration = duration + "ms";
    timerBar.addEventListener("animationend", dismiss);
  }
  closeBtn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); dismiss(); });
  copyBtn.addEventListener("click", async e => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(text));
      copyBtn.textContent = t("Copied");
      setTimeout(() => { copyBtn.textContent = t("Copy"); }, 1200);
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
    if (expandable) chip.textContent = chipPhrase();
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
    chip.textContent = chipPhrase();
  });
  const setTimer = (running) => { timerBar.style.animationPlayState = running ? "running" : "paused"; };
}

export function confirmModal(title, text, okLabel = t("Delete"), danger = true) {
  return new Promise(resolve => {
    const foot = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-text"; cancel.textContent = t("Cancel");
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn-text"; ok.textContent = t(okLabel);
    if (danger) ok.style.color = "var(--danger)";
    foot.append(cancel, ok);
    const { close } = showModal({ title, body: `<p style="font-size:15px;line-height:1.45;white-space:pre-line">${escapeHtml(t(text))}</p>`, foot, compact: true, onClose: () => resolve(false) });
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
    body.innerHTML = `<p style="font-size:15px;line-height:1.45">${count === 1 ? t("Delete this message?") : t("Delete {n} messages?", { n: count })}</p>`;
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
    foot.append(mk(t("Cancel"), null), mk(t("Delete for me"), "me"));
    if (canForAll) foot.append(mk(t("Delete for everyone"), "everyone"));
    const { close } = showModal({ title: "Delete messages", body, foot, onClose: () => finish(null) });
  });
}

/* ---------- Version info (drawer footer + About) ---------- */
// Fallback only: the live core version is fetched via get_system_info in
// app.js boot and pushed here with setCoreVersionDisplay (the running
// sidecar/in-process core is the source of truth, not this constant).
let CORE_VERSION = "2.66.0";

export function setCoreVersionDisplay(v) {
  if (!v) return;
  CORE_VERSION = String(v).replace(/^v/, "");
  document.querySelectorAll('[data-v="core"]').forEach((el) => { el.textContent = CORE_VERSION; });
  // Splash version line (#127) keeps the same core string once it is known.
  const splash = document.getElementById("splash");
  if (splash) fillSplashVersion(splash);
}
/* ---------- Update check (drawer banner + menu-button nudge) ---------- */
// Tauri reads GitHub version.txt in the shell (get_latest_version). The page
// must not: that CDN sends no CORS header, and CSP connect-src has no github
// host. The browser reads same-origin /version.txt (release.yml copies it).
const UPDATE_CHECK_URL = "/version.txt";
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
  text.innerHTML = t("{version} is available", { version: `<strong>Velta ${escapeHtml(updateInfo.version)}</strong>` });
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
  btn.textContent = desktop ? t("Update") : t("Download APK");
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
      ? t("Downloading… {n}%", { n: pct })
      : t("Downloading… {mb} MB", { mb: (received / 1048576).toFixed(1) });
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
    btn.textContent = t("Opening installer…");
    await tauri.core.invoke("install_update", { path: updateInfo.apkPath });
    btn.textContent = t("Install");
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
      btn.textContent = t("No update");
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
          btn.textContent = pct ? t("Downloading {n}%", { n: pct }) : t("Downloading…");
          const bar = btn.parentElement?.querySelector("progress");
          if (bar) { bar.hidden = false; if (total) bar.value = pct; else bar.removeAttribute("value"); }
        }
      } else if (ev.event === "Finished") btn.textContent = t("Installing…");
    });
    btn.textContent = t("Restarting…");
    await tauri.process.relaunch(); // replaces the process — never resolves on success
  } catch (err) {
    console.error("self-update failed", err);
    toast(t("Update failed: ") + (err?.message || err));
    btn.textContent = t("Retry update");
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
  const swatches = A.PRESETS.map(([c, label]) => `<label class="ca-swatch"${c ? ` style="--sw: ${c}"` : " data-default"} title="${escapeAttr(t(label))}"><input type="radio" name="ca-accent" value="${c || ""}" aria-label="${escapeAttr(t(label))}"${(c || null) === (st.accent && preset ? st.accent : null) && !custom ? " checked" : ""}></label>`).join("");
  return `<details class="drawer-details" data-chat-appearance>
        <summary>${ICON.chatAppearance}<span>${escapeHtml(t("Chat appearance"))}</span></summary>
        <div class="ca-panel">
          <div class="ca-preview" role="group" aria-label="${escapeHtml(t("Preview"))}">
            <div class="msg-row"><div class="bubble"><div class="msg-sender">Ada</div><div class="msg-quote"><span class="q-name">${escapeHtml(t("You"))}</span><span class="q-text">${escapeHtml(t("Are we still on for tonight?"))}</span></div><div class="msg-text" lang="en">${escapeHtml(t("Yes! Bring the hyperparameter notes."))}</div><span class="msg-meta"><span>12:41</span></span></div></div>
            <div class="msg-row out"><div class="bubble"><div class="msg-text" lang="en">${escapeHtml(t("Great, see you at 8. Map:"))} <a href="#" tabindex="-1">example.org</a></div><span class="msg-meta"><span>12:42</span><span class="ticks-slot">${ticksSvg("read", "ticks")}</span></span></div></div>
          </div>
          <div class="ca-field">
            <label for="ca-font">${escapeHtml(t("Message text size"))}</label>
            <output for="ca-font" data-ca-font-out>${pxText(st.fontSize)}</output>
          </div>
          <input type="range" id="ca-font" class="ca-range" data-ca-font min="${A.FONT_MIN}" max="${A.FONT_MAX}" step="0.5" value="${st.fontSize}" aria-valuetext="${pxText(st.fontSize)}">
          <div class="ca-field">
            <label for="ca-radius">${escapeHtml(t("Message corners"))}</label>
            <output for="ca-radius" data-ca-radius-out>${pxText(radius)}</output>
          </div>
          <input type="range" id="ca-radius" class="ca-range" data-ca-radius min="${A.RADIUS_MIN}" max="${A.RADIUS_MAX}" step="1" value="${radius}" aria-valuetext="${pxText(radius)}">
          <fieldset class="ca-accent" data-ca-accent>
            <legend>${escapeHtml(t("Accent color"))}</legend>
            <div class="ca-swatches">${swatches}<label class="ca-swatch ca-custom" title="${escapeHtml(t("Custom color"))}" style="--ca-rainbow: ${caRainbow}"><input type="color" data-ca-custom aria-label="${escapeHtml(t("Custom accent color"))}" value="${custom || "#3fa34d"}"${custom ? " data-active" : ""}></label></div>
          </fieldset>
          <div class="bar-opts-hint" data-ca-accent-hint>${escapeHtml(t("Links, buttons, switches and your own bubbles. Text colors adjust to stay readable in light and dark. Brutal keeps its own colors."))}</div>
          <label class="scale-opt"><input type="checkbox" role="switch" data-ca-hyphens${st.hyphens ? " checked" : ""}><span>${escapeHtml(t("Hyphenate long words (English, Russian)"))}</span></label>
          <div class="ca-actions"><button type="button" class="btn-text" data-ca-reset>${escapeHtml(t("Reset to defaults"))}</button></div>
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
    toast(t("Chat appearance reset"));
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

export function buildDrawer({ account, onProfileManagement, onSetTheme, onOpenChat, onInvite, onProfile, onEditProfile, onInviteDomains, onWsRelays, p2pAvailable = false, p2pOn = false, onP2pToggle, onRelays, accounts = [], currentAccountId = null, onAccountTap, theme, barHidden = [], onBarToggle, catsHidden = [], onCatToggle, mediaQuality = "0", onMediaQuality, downloadLimit = "0", onDownloadLimit, onReadReceipts, onLowBatteryToggle, multiDeviceState = "loading", multiDeviceReenabled = false, onMultiDevice, onMultiDeviceKeep, onDrawerOpen, identityBackupAvailable = false, onIdentityBackup, onTunnel = null, tunnelLabel = "", onWsTransport = null, wsTransportLabel = "", onDiagnostics = null, onPushSection = null, onWebPushSection = null, backendKind = null, onExportSettings = null, onScheduled = null }) {
  const inTauri = isTauri();
  const androidApp = IS_ANDROID && inTauri;
  const drawer = document.createElement("div");
  drawer.className = "drawer";
  drawer.id = "drawer";
  drawer.innerHTML = `
    <div class="drawer-head">
      <velta-avatar data-act="profile" style="cursor:pointer" name="${escapeHtml(account.displayName)}" color="${escapeAttr(account.color || "#777")}" size="56" contact-id="1" addr="${escapeAttr(account.addr || "")}"${account.avatar ? ` avatar="${escapeAttr(fileUrl(account.avatar))}"` : ""}></velta-avatar>
      <div>
        <div class="drawer-name">${escapeHtml(account.displayName)}</div>
        <div class="drawer-links">
          <button type="button" data-act="edit-profile">${t("Edit profile")}</button>
          <details class="acct-switch" data-acct-switch>
            <summary data-act="switch-account">Accounts${ICON.chevronDown}</summary>
            <div class="acct-pop" role="group" aria-label="Accounts" data-i18n-aria="Accounts">
            ${accounts.map(a => `<button type="button" class="ctx-item" data-act="account" data-account="${escapeAttr(a.id)}"${a.id === currentAccountId ? ' aria-current="true"' : ""}>${svg(P.profile + (a.id === currentAccountId ? P.checkInner : ""))}<span>${escapeHtml(a.name || a.addr)}${a.id === currentAccountId ? " · current" : ""}</span></button>`).join("")}
            <div class="ctx-sep"></div>
            <button type="button" class="ctx-item" data-act="profile-management">${ICON.profileAdd}<span>${t("Profile management…")}</span></button>
            </div>
          </details>
        </div>
      </div>
    </div>
    <div class="drawer-items">
      <button type="button" class="ctx-item" data-act="saved">${ICON.bookmark}<span>${t("Saved Messages")}</span></button>
      <button type="button" class="ctx-item" data-act="invite">${ICON.invite}<span>${t("Invite friends (QR)")}</span></button>
      ${p2pAvailable || p2pOn ? `<label class="ctx-item">${LOOP_SVG}<span class="ctx-stack"><span data-lbl>${escapeHtml(toggleText("Velta Loop", p2pOn ? "on" : "off"))}</span><span class="ctx-sub">${t("Local chat on the same network")}</span></span><input type="checkbox" role="switch" data-toggle="p2p"${p2pOn ? " checked" : ""}></label>` : ""}
      ${p2pAvailable && p2pOn ? `<label class="ctx-item" title="${escapeHtml(t("Show when someone in a local chat is typing, and let them see when you are. Hints are live only and never stored."))}">${ICON.typing}<span>${escapeHtml(toggleText("Typing indicator", localStorage.getItem("velta-p2p-typing") !== "0" ? "on" : "off"))}</span><input type="checkbox" role="switch" data-toggle="p2p-typing"${localStorage.getItem("velta-p2p-typing") !== "0" ? " checked" : ""}></label>` : ""}
      <div class="drawer-sec">${t("Settings")}</div>
      <details class="drawer-details">
        <summary>${ICON.palette}<span data-theme-summary>${t("{label}: {state}", { label: t("Theme"), state: t(THEME_LABELS[theme] || "Auto") })}</span></summary>
        <fieldset class="scale-opts" data-theme-opts>
          <legend class="vh">${t("Theme")}</legend>
          ${Object.entries(THEME_LABELS).map(([v, label]) => `<label class="scale-opt"><input type="radio" name="app-theme" value="${v}"${v === theme ? " checked" : ""}><span>${t(label)}</span></label>`).join("")}
        </fieldset>
      </details>
      <details class="drawer-details">
        <summary>${ICON.language}<span data-lang-summary>${t("{label}: {state}", { label: t("Language"), state: (LANGS.find(([v]) => v === currentLang()) || LANGS[0])[1] })}</span></summary>
        <fieldset class="scale-opts" data-lang-opts>
          <legend class="vh">${t("Language")}</legend>
          ${LANGS.map(([v, name]) => `<label class="scale-opt"><input type="radio" name="ui-lang" value="${v}"${v === currentLang() ? " checked" : ""}><span>${name}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint">${t("The app reloads to apply the language. Untranslated text stays in English.")}</div>
      </details>
      ${chatAppearanceHtml()}
      <details class="drawer-details">
        <summary>${ICON.textSize}<span data-scale-summary>${t("{label}: {state}", { label: t("Interface scale"), state: t(uiScaleLabel()) })}</span></summary>
        <fieldset class="scale-opts" data-scale-opts>
          <legend class="vh">${t("Interface scale")}</legend>
          ${UI_SCALES.map(([v, label]) => `<label class="scale-opt"><input type="radio" name="ui-scale" value="${v}"${v === uiScaleValue() ? " checked" : ""}><span>${t(label)}</span></label>`).join("")}
        </fieldset>
      </details>
      <details class="drawer-details">
        <summary>${ICON.bottomBar}<span>${t("Bottom bar buttons")}</span></summary>
        <fieldset class="scale-opts" data-bar-opts>
          <legend class="vh">${t("Bottom bar buttons")}</legend>
          ${[["chats", "Chats"], ["contacts", "Contacts"], ["calls", "Calls"], ["qr", "QR code"]].map(([key, label]) => `<label class="scale-opt"><input type="checkbox" role="switch" data-bar-key="${key}"${barHidden.includes(key) ? "" : " checked"}><span>${t(label)}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint">${t("Menu button is always visible.")}</div>
      </details>
      <details class="drawer-details">
        <summary>${ICON.sortLines}<span>${t("Chat categories")}</span></summary>
        <fieldset class="scale-opts" data-cat-opts>
          <legend class="vh">${t("Chat categories")}</legend>
          ${[["unread", "Unread"], ["people", "People"], ["groups", "Groups"], ["channels", "Channels"], ["bots", "Bots"], ["system", "System"]].map(([key, label]) => `<label class="scale-opt"><input type="checkbox" role="switch" data-cat-key="${key}"${catsHidden.includes(key) ? "" : " checked"}><span>${t(label)}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint">${t("\"All\" is always visible.")}</div>
      </details>
      <details class="drawer-details">
        <summary>${ICON.notifications}<span>${t("Notifications")}</span></summary>
        <fieldset class="scale-opts" data-notify-opts>
          <legend class="vh">${t("Notifications")}</legend>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="notifications"${notifyChecked("velta-notify") ? " checked" : ""}><span>${t("Notifications")}</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="mentions"${notifyChecked("velta-notify-mentions") ? " checked" : ""}><span>${t("Replies only (skip the rest)")}</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="mutedmentions"${notifyChecked("velta-notify-muted-mentions") ? " checked" : ""}><span>${t("Notify me when mentioned in muted chats")}</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="text"${notifyChecked("velta-notify-text") ? " checked" : ""}><span>${t("Show message content")}</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="system"${notifyChecked("velta-notify-system") ? " checked" : ""}><span>${t("System notification for new messages")}</span></label>
          ${androidApp ? `
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="vibration"${notifyChecked("velta-notify-vibration") ? " checked" : ""}><span>${t("Vibration")}</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="sounds"${notifyChecked("velta-notify-sounds") ? " checked" : ""}><span>${t("In-chat sounds")}</span></label>` : ""}
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="calls"${notifyChecked("velta-notify-calls") ? " checked" : ""}><span>${t("Calls")}</span></label>
          ${androidApp ? `
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="bg"${notifyChecked("velta-notify-bg") ? " checked" : ""}><span>${t("Use background connection")}</span></label>
          <label class="scale-opt"><input type="checkbox" role="switch" data-notify-key="bgforce"${notifyChecked("velta-notify-bgforce") ? " checked" : ""}><span>${t("Force background connection")}</span></label>
          <div class="bar-opts-hint">${t("Force keeps background fetching alive under battery restrictions (asks Android for exemption).")}</div>
          <div class="bar-opts-hint"><a class="bat-dkma" href="https://dontkillmyapp.com/" data-dkma>${t("Phone still stops Velta? Extra steps for your phone")}</a></div>` : ""}
        </fieldset>
        <div class="bar-opts-hint">${t("Per-chat muting lives in each chat's info sheet.")}</div>
      </details>
      ${androidApp && onPushSection ? `<details class="drawer-details" data-push-section>
        <summary>${ICON.downloadTray}<span data-push-summary>${t("Push notifications")}</span></summary>
        <div data-push-body><div class="bar-opts-hint">${t("Loading…")}</div></div>
      </details>` : ""}
      ${onWebPushSection && !androidApp ? `<details class="drawer-details" data-webpush-section>
        <summary>${ICON.downloadTray}<span data-webpush-summary>${t("Push notifications")}</span></summary>
        <div data-webpush-body><div class="bar-opts-hint">${t("Loading…")}</div></div>
      </details>` : ""}
      <details class="drawer-details">
        <summary>${ICON.imageQuality}<span>${t("Image quality")}</span></summary>
        <fieldset class="scale-opts" data-mq-opts>
          <legend class="vh">${t("Image quality")}</legend>
          ${[["0", "Standard (compress to 940 KB)"], ["1", "Compact (compress to 130 KB)"]].map(([value, label]) => `<label class="scale-opt"><input type="radio" name="media-quality" data-mq-value="${value}"${value === mediaQuality ? " checked" : ""}><span>${t(label)}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint">${t("Large photos only — smaller images are sent unchanged.")}</div>
        <div class="scale-opts">
          <label class="scale-opt"><input type="checkbox" role="switch" data-compress-photos${localStorage.getItem("velta-compress-photos") === "0" ? "" : " checked"}><span>${t("Compress photos to save relay space")}</span></label>
        </div>
        <div class="bar-opts-hint">${t("Big JPEG/WebP photos are re-encoded as smaller WebP before sending, when that saves at least 10%. This also removes location and camera info from those photos. Animated images, transparent images, small photos and files are never changed.")}</div>
      </details>
      <details class="drawer-details">
        <summary>${ICON.downloadBar}<span>${t("Auto-download limit")}</span></summary>
        <fieldset class="scale-opts" data-dl-opts>
          <legend class="vh">${t("Auto-download limit")}</legend>
          ${[["0", "No limit (default)"], ["1048576", "1 MB"], ["5242880", "5 MB"], ["26214400", "25 MB"]].map(([value, label]) => `<label class="scale-opt"><input type="radio" name="download-limit" data-dl-value="${value}"${value === downloadLimit ? " checked" : ""}><span>${t(label)}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint" data-dl-hint>${escapeHtml(t(DL_LIMIT_HINT))}</div>
      </details>
      <button type="button" class="ctx-item" data-act="profile-management">${ICON.profileAdd}<span>${t("Profile management…")}</span></button>
      <button type="button" class="ctx-item" data-act="relays">${ICON.globe}<span>${t("Relays of this profile…")}</span></button>
      ${onTunnel ? `<button type="button" class="ctx-item" data-act="tunnel">${ICON.tunnel}<span>${escapeHtml(t("DNS tunnel:"))} ${escapeHtml(tunnelLabel)}</span></button>` : ""}
      ${onWsTransport ? `<button type="button" class="ctx-item" data-act="ws-transport">${ICON.wsTransport}<span>${t("{label}: {state}", { label: t("WebSocket transport"), state: escapeHtml(wsTransportLabel) })}</span></button>` : ""}
      ${onWsRelays ? `<button type="button" class="ctx-item" data-act="ws-relays">${ICON.globe}<span>${t("WebSocket relays")}</span></button>` : ""}
      ${identityBackupAvailable ? `<button type="button" class="ctx-item" data-act="identity-backup">${ICON.key}<span>${t("Identity backup…")}</span></button>` : ""}
      <button type="button" class="ctx-item" data-act="invite-domains">${ICON.globe}<span>${t("Invite link domains")}</span></button>
      ${inTauri ? `<details class="drawer-details">
        <summary>${ICON.link}<span>${t("{label}: {state}", { label: t("Link previews"), state: t(LINK_PREVIEW_LABELS[linkPreviewMode()]) })}</span></summary>
        <fieldset class="scale-opts" data-lp-opts>
          <legend class="vh">${t("Link previews")}</legend>
          ${[["off", "Off"], ["picture", "Send a picture"], ["fetch", "Load on this device"]].map(([value, label]) => `<label class="scale-opt"><input type="radio" name="link-preview-mode" data-lp-value="${value}"${value === linkPreviewMode() ? " checked" : ""}><span>${t(label)}</span></label>`).join("")}
        </fieldset>
        <div class="bar-opts-hint">${t("Send a picture attaches a snapshot; other people do not open the site.")} ${t(LINK_PREVIEW_IP_WARNING)}</div>
      </details>` : ""}
      <label class="ctx-item" title="${escapeHtml(t("Drops utm and click-id parameters when you paste or open a link. Undo brings them back."))}">${ICON.cleanLink}<span>${escapeHtml(toggleText("Strip tracking from links", trackingStripEnabled() ? "on" : "off"))}</span><input type="checkbox" role="switch" data-toggle="strip-trackers"${trackingStripEnabled() ? " checked" : ""}></label>
      <label class="ctx-item">${ICON.enterKey}<span>${escapeHtml(toggleText("Send on Enter", localStorage.getItem("velta-send-enter") === "0" ? "off" : "on"))}</span><input type="checkbox" role="switch" data-toggle="send-enter"${localStorage.getItem("velta-send-enter") === "0" ? "" : " checked"}></label>
      <label class="ctx-item" title="${escapeHtml(t("Off also stops seen-status sync between your own devices"))}">${ICON.tick2}<span>${escapeHtml(toggleText("Show and send read receipts", localStorage.getItem("velta-mdns") === "0" ? "off" : "on"))}</span><input type="checkbox" role="switch" data-toggle="read-receipts"${localStorage.getItem("velta-mdns") === "0" ? "" : " checked"}></label>
      <label class="ctx-item" title="${escapeHtml(t("Copies messages you send to your other devices and syncs state between them"))}">${ICON.devices}<span>${escapeHtml(toggleText("Multi-device", mdLabel(multiDeviceState)))}</span><input type="checkbox" role="switch" data-toggle="multidevice"${multiDeviceState === "on" ? " checked" : ""}${multiDeviceState === "on" || multiDeviceState === "off" ? "" : ' aria-checked="mixed"'}></label>
      <div class="bar-opts-hint ctx-hint" data-md-hint>${escapeHtml(t(MD_HINT))}</div>
      <div class="bar-opts-hint ctx-hint md-note" data-md-note${multiDeviceReenabled ? "" : " hidden"}><span>${escapeHtml(t(MD_REENABLED_NOTE))}</span> <span class="md-note-acts"><button type="button" class="btn-text" data-md-off>${t("Turn off again")}</button><button type="button" class="btn-text" data-md-keep>${t("Keep on")}</button></span></div>
      ${androidApp ? `<label class="ctx-item" title="${escapeHtml(t("While the phone is under 10% and off the charger, your latest message in each chat gets a 🪫 reaction so the other side knows replies may stop. Recipients see it as a normal reaction; other clients show the emoji only."))}">${ICON.battery}<span>${escapeHtml(toggleText("Low-battery marker", localStorage.getItem("velta-low-battery-react") === "1" ? "on" : "off"))}</span><input type="checkbox" role="switch" data-toggle="low-battery"${localStorage.getItem("velta-low-battery-react") === "1" ? " checked" : ""}></label>` : ""}
      <label class="ctx-item">${ICON.download}<span>${escapeHtml(toggleText("Remember scroll position in chats", localStorage.getItem("velta-remember-scroll") === "0" ? "off" : "on"))}</span><input type="checkbox" role="switch" data-toggle="remember-scroll"${localStorage.getItem("velta-remember-scroll") === "0" ? "" : " checked"}></label>
      <label class="ctx-item">${ICON.demo}<span>${escapeHtml(toggleText("Demo mode", localStorage.getItem("velta-mock") === "1" ? "on" : "off"))}</span><input type="checkbox" role="switch" data-toggle="demo"${localStorage.getItem("velta-mock") === "1" ? " checked" : ""}></label>
      ${onExportSettings ? `<button type="button" class="ctx-item" data-act="export-settings" title="${escapeHtml(t("Sends your Velta preferences as one text message to Saved Messages, so another device can apply them. No relays, keys or addresses."))}">${ICON.bookmarkExport}<span>${t("Export settings to Saved Messages")}</span></button>` : ""}
      ${onScheduled ? `<button type="button" class="ctx-item" data-act="scheduled">${ICON.clock}<span>${t("Scheduled messages")}</span></button>` : ""}
      <button type="button" class="ctx-item" data-act="about">${ICON.info}<span>${t("About Velta")}</span></button>
    </div>
    <div class="drawer-foot" data-versions>
      <div class="drawer-ver"><span>Velta</span><span data-v="app">…</span></div>
      <div class="drawer-ver"><span>${t("Chatmail core")}</span><span data-v="core">${CORE_VERSION}</span></div>
      ${inTauri ? `<div class="drawer-ver"><span>Tauri</span><span data-v="tauri">…</span></div>` : ""}
      ${inTauri ? "" : `<div class="drawer-ver"><span>${t("Service worker")}</span><span data-v="sw">…</span></div>`}
    </div>`;
  translateTree(drawer);
  const acctLabel = drawer.querySelector("[data-act=switch-account]");
  if (acctLabel?.firstChild?.nodeType === 3) acctLabel.firstChild.nodeValue = t("Accounts");
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
        else if (el.textContent === "…") el.textContent = t("not registered");
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
    if (summary) summary.textContent = `${t("{label}: {state}", { label: t("Interface scale"), state: t(uiScaleLabel()) })}`;
    toast(`${t("{label}: {state}", { label: t("Interface scale"), state: t(uiScaleLabel()) })}`);
  });
  drawer.querySelector("[data-lang-opts]")?.addEventListener("change", e => {
    const v = e.target?.value;
    if (!v || v === currentLang()) return;
    setLang(v);
    markLangCardDone(); // a switch ends the language cards (lang-cards.js)
    location.reload();
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
  // dontkillmyapp.com page for this phone's maker (Build.MANUFACTURER).
  drawer.querySelector("[data-dkma]")?.addEventListener("click", async e => {
    e.preventDefault();
    let maker = "";
    try { maker = await tauriInvoke()?.("device_maker"); } catch {}
    const { dontKillMyAppUrl } = await import("./battery-prompt.js");
    const { openInAppBrowser } = await import("./inapp-browser.js");
    openInAppBrowser(dontKillMyAppUrl(maker));
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
      mutedmentions: "velta-notify-muted-mentions",
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
      toast(t("Background connection off — messages arrive when you open Velta"));
    }
    const invoke = tauriInvoke();
    const prefs = {
      enabled: localStorage.getItem("velta-notify") !== "0",
      mentions_only: localStorage.getItem("velta-notify-mentions") === "1",
      mentions_in_muted: localStorage.getItem("velta-notify-muted-mentions") !== "0",
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
    toast(toggleText("Photo compression", on ? "on" : "off"));
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
    toast(toggleText("Read receipts", on ? "on" : "off"));
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
    else if (ok !== false) toast(toggleText("Multi-device", on ? "on" : "off"));
  });
  drawer.querySelector("[data-md-off]")?.addEventListener("click", async e => {
    e.preventDefault();
    const ok = await onMultiDevice?.(false, { quick: true });
    if (ok !== false) {
      setToggleUi("multidevice", "Multi-device", false);
      toast(t("Multi-device off"));
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
    toast(toggleText("Low-battery marker", on ? "on" : "off"));
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
    if (summary) summary.textContent = `${t("{label}: {state}", { label: t("Theme"), state: t(THEME_LABELS[v]) })}`;
    toast(`${t("{label}: {state}", { label: t("Theme"), state: t(THEME_LABELS[v]) })}`);
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
    const span = drawer.querySelector(`[data-toggle="${key}"]`)?.closest(".ctx-item")?.querySelector("[data-lbl], span");
    if (span) span.textContent = toggleText(label, on ? "on" : "off");
  };

  drawer.querySelector('[data-toggle="p2p"]')?.addEventListener("change", e => {
    setToggleUi("p2p", "Velta Loop", e.target.checked);
    onP2pToggle?.(); // flips the real state and rebuilds the drawer
  });
  drawer.querySelector('[data-toggle="p2p-typing"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    if (on) localStorage.removeItem("velta-p2p-typing");
    else localStorage.setItem("velta-p2p-typing", "0");
    setToggleUi("p2p-typing", "Typing indicator", on);
    toast(toggleText("Typing indicator", on ? "on" : "off"));
  });
  drawer.querySelector("[data-lp-opts]")?.addEventListener("change", e => {
    const input = e.target.closest?.("[data-lp-value]") || e.target;
    const mode = input?.dataset?.lpValue;
    if (!mode || mode === linkPreviewMode()) return;
    setLinkPreviewMode(mode);
    const summary = drawer.querySelector("[data-lp-opts]")?.closest("details")?.querySelector("summary span");
    if (summary) summary.textContent = t("Link previews: {mode}", { mode: LINK_PREVIEW_LABELS[mode] });
    toast(t("Link previews: {mode}", { mode: LINK_PREVIEW_LABELS[mode] }));
  });
  drawer.querySelector('[data-toggle="strip-trackers"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    setTrackingStripEnabled(on);
    setToggleUi("strip-trackers", "Strip tracking from links", on);
    toast(toggleText("Strip tracking from links", on ? "on" : "off"));
  });
  drawer.querySelector('[data-toggle="send-enter"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    if (on) localStorage.removeItem("velta-send-enter");
    else localStorage.setItem("velta-send-enter", "0");
    setToggleUi("send-enter", "Send on Enter", on);
    const composer = document.getElementById("composer-input");
    if (composer) composer.enterKeyHint = on ? "send" : "enter";
    toast(toggleText("Send on Enter", on ? "on" : "off"));
  });
  // Remember scroll position in chats (issue #18, default ON per #70):
  // unset or "1" = on, "0" = off; ChatView reads it on every open/close.
  drawer.querySelector('[data-toggle="remember-scroll"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    if (on) localStorage.removeItem("velta-remember-scroll");
    else localStorage.setItem("velta-remember-scroll", "0");
    setToggleUi("remember-scroll", "Remember scroll position in chats", on);
    toast(toggleText("Remember scroll position in chats", on ? "on" : "off"));
  });
  drawer.querySelector('[data-toggle="demo"]')?.addEventListener("change", e => {
    const on = e.target.checked;
    localStorage.setItem("velta-mock", on ? "1" : "0");
    setToggleUi("demo", "Demo mode", on);
    toast(toggleText("Demo mode", on ? "on" : "off") + " — " + t("reloading"));
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
    if (act === "ws-transport") onWsTransport?.();
    if (act === "invite-domains") onInviteDomains?.();
    if (act === "tunnel") onTunnel?.();
    if (act === "identity-backup") onIdentityBackup?.();
    if (act === "about") showAbout({ onDiagnostics, backendKind });
    if (act === "export-settings") onExportSettings?.();
    if (act === "scheduled") onScheduled?.();
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
export function showEditProfile({ name, avatarUrl, color, pickImage, contactId = 1, kind = "", title = t("Edit profile"), description = "" }) {
  return new Promise(resolve => {
    let picked = null;   // { path } once a new picture is chosen
    let removed = false; // "Remove photo" tapped
    const body = document.createElement("div");
    body.className = "edit-profile";
    body.innerHTML = `
      <div class="ep-avatar"><velta-avatar size="84"${contactId ? ` contact-id="${contactId}"` : ""}${kind ? ` kind="${kind}"` : ""}></velta-avatar></div>
      <div class="ep-avatar-actions">
        <button type="button" class="btn-text" data-ep="pick">${escapeHtml(t("Change picture"))}</button>
        <button type="button" class="btn-text" data-ep="remove" style="display:none">${escapeHtml(t("Remove photo"))}</button>
      </div>
      <input class="text-field" maxlength="64" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(t("Name"))}" placeholder="${escapeHtml(t("Your name"))}">
      <textarea class="text-field ep-desc" rows="3" spellcheck="false" aria-label="${escapeHtml(t("Description"))}" placeholder="${escapeHtml(t("Description"))}"></textarea>`;
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
        toast(t("Couldn't load picture: ") + (err.message || err), 4000);
      } finally {
        pickBtn.disabled = false;
      }
    });
    input.addEventListener("input", refreshPreview);

    const foot = document.createElement("div");
    foot.className = "edit-profile-foot";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-text"; cancel.textContent = t("Cancel");
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "btn-text btn-primary"; save.textContent = t("Save");
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
export const inviteCanShare = () => typeof navigator !== "undefined" && canShareLink({ ua: navigator.userAgent, hasInvoke: !!tauriInvoke(), hasWebShare: typeof navigator.share === "function" });

/** Native share of an invite/chat link ("<text>: <link>"): Android shell
 *  share_text, else Web Share; failures toast, a dismissed sheet is silent.
 *  Callers render the button only when inviteCanShare(). */
export async function shareInviteLink(link, text) {
  if (!link) return;
  try {
    await shareLink(link, { ua: navigator.userAgent, invoke: tauriInvoke(), webShare: typeof navigator.share === "function" ? o => navigator.share(o) : null, title: text, text: `${text}: ${link}` });
  } catch (err) { toast(t("Couldn't share the link: ") + (err?.message || err), 4000, { danger: true }); }
}

export function showInvite(provider, { title = t("Invite to Velta"), group = false, account = null } = {}) {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5">${group
      ? t("Anyone scanning this code can join this group — the joiner is verified end-to-end automatically.")
      : t("Anyone scanning this code with Velta can reach you with verified end-to-end encryption.")}</p>
    <div data-domain-tabs></div>
    <div class="qr-box"><div class="qr-loading">${escapeHtml(t("Generating QR code…"))}</div></div>
    <div class="invite-link" style="word-break:break-all"></div>
    <div style="display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:4px;margin-top:6px"><button type="button" class="btn-text" data-copy>${ICON.copy}<span>${escapeHtml(t("Copy invite link"))}</span></button>${inviteCanShare() ? `<button type="button" class="btn-text" data-share aria-label="${escapeAttr(t("Share invite link"))}" disabled>${ICON.share}<span>${escapeHtml(t("Share"))}</span></button>` : ""}</div>`;
  showModal({ title, body });
  // Native share sheet: Android shell share_text, else Web Share (WebView2,
  // Safari, PWA). No path → no button (inviteCanShare).
  body.querySelector("[data-share]")?.addEventListener("click", () => {
    const link = body.querySelector(".invite-link").textContent;
    shareInviteLink(link, group ? t("Join {name} on Velta", { name: title }) : t("Chat with me on Velta"));
  });
  body.querySelector("[data-copy]").addEventListener("click", () => {
    const link = body.querySelector(".invite-link").textContent;
    navigator.clipboard?.writeText(link).then(() => toast(t("Invite link copied")));
  });
  provider()
    .then(({ svg, link }) => {
      const box = body.querySelector(".qr-box");
      const sb = body.querySelector("[data-share]"); if (sb) sb.disabled = !link;
      // Domain pills (invite-domains.js): i.delta.chat keeps the core card,
      // velta.cc/join/? (the default) and mirrors get a plain QR that already
      // carries the Velta logo.
      mountInviteDomains(body.querySelector("[data-domain-tabs]"), { svg, link }, (qr, l, isDefault) => {
        box.innerHTML = qr || "<div class='qr-loading'>QR unavailable</div>";
        body.querySelector(".invite-link").textContent = l;
        // Overlay the Velta logo on the clear circle the core leaves in the
        // QR center (design space 515x630, circle center at 50% / 43.65% of
        // the rendered svg).
        if (account && qr && isDefault) {
          box.insertAdjacentHTML("beforeend",
            `<div class="qr-self"><img src="./icons/v-logo.svg" alt=""></div>`);
        }
      });
    })
    .catch(err => {
      body.querySelector(".qr-box").innerHTML =
        `<div class="qr-loading">${escapeHtml(t("Couldn't create the invite:"))}<br>${escapeHtml(String(err?.message || err))}</div>`;
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
    btn.textContent = t("Open diagnostics log");
    btn.addEventListener("click", () => { about.close(); onDiagnostics(); });
    foot = btn;
  }
  const about = showModal({
    title: "About Velta",
    foot,
    body: `
      <div class="info-row"><span class="k">${escapeHtml(t("App"))}</span><span class="v">Velta ${escapeHtml(version)}</span></div>
      <div class="info-row"><span class="k">${escapeHtml(t("Core"))}</span><span class="v">deltachat-core-rust ${CORE_VERSION}</span></div>
      <div class="info-row"><span class="k">${escapeHtml(t("Transport"))}</span><span class="v">${escapeHtml(t("chatmail relays (IMAP/SMTP)"))}</span></div>
      <div class="info-row"><span class="k">${escapeHtml(t("Encryption"))}</span><span class="v">${escapeHtml(t("OpenPGP, end-to-end"))}</span></div>
      <div class="info-row"><span class="k">${escapeHtml(t("UI stack"))}</span><span class="v">${escapeHtml(t("Elena progressive web components"))}</span></div>
      <details class="device-info" data-device-info>
        <summary>${escapeHtml(t("Show device info"))}</summary>
        <pre class="device-info-text" data-device-info-text></pre>
        <div class="device-info-actions">
          <button type="button" class="btn-text" data-device-copy>${escapeHtml(t("Copy"))}</button>
          <button type="button" class="btn-text" data-device-share hidden>${escapeHtml(t("Share"))}</button>
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
      toast(t("Device info copied"));
    } catch (err) { toast(t("Couldn't copy: ") + (err?.message || err)); }
  });
  const shareBtn = det.querySelector("[data-device-share]");
  const webShare = typeof navigator.share === "function" ? o => navigator.share(o) : null;
  shareBtn.hidden = !canShareLink({ ua: navigator.userAgent, hasInvoke: !!tauriInvoke(), hasWebShare: !!webShare });
  shareBtn.addEventListener("click", async () => {
    try {
      await shareLink(pre.textContent, { ua: navigator.userAgent, invoke: tauriInvoke(), webShare, title: t("Velta device info") });
    } catch (err) { toast(t("Couldn't share: ") + (err?.message || err)); }
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
      <button type="button" class="lightbox-close" aria-label="Close" title="Close" data-i18n-label="Close"></button>
    </div>
    <div class="lightbox-stage"><img class="lightbox-img" decoding="async" alt=""></div>`;
  translateTree(overlay);
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

const VIDEO_POS_KEY = "velta-video-pos";
const VIDEO_RATE_KEY = "velta-video-rate";
const VIDEO_RATES = [0.5, 1, 1.25, 1.5, 2];

function loadVideoPos(src) {
  try {
    const all = JSON.parse(localStorage.getItem(VIDEO_POS_KEY) || "{}");
    return all && typeof all === "object" ? all[videoPosKey(src)] : 0;
  } catch { return 0; }
}

function saveVideoPos(src, seconds) {
  const key = videoPosKey(src);
  if (!key) return;
  try {
    const all = JSON.parse(localStorage.getItem(VIDEO_POS_KEY) || "{}");
    localStorage.setItem(VIDEO_POS_KEY, JSON.stringify(rememberVideoPos(all, key, seconds)));
  } catch {}
}

function savedVideoRate() {
  try {
    const n = Number(localStorage.getItem(VIDEO_RATE_KEY));
    if (VIDEO_RATES.includes(n)) return n;
  } catch {}
  return 1;
}

// Video lightbox: same shell as the image lightbox (bar + close + history
// entry), stage hosts a <video controls autoplay>. No pinch-zoom - the
// player's own controls cover it. Click on the video does NOT close
// (it toggles play/pause natively); close = button/Esc/BACK.
// Stretch fills the screen (cover, aspect kept). Speed is the last choice.
// Position is saved per file and restored on the next open.
export function openVideoLightbox(src, caption = "") {
  closeAllPopups();
  teardownLightbox(false);
  const rate = savedVideoRate();
  const overlay = document.createElement("div");
  overlay.className = "lightbox lightbox-video";
  overlay.innerHTML = `
    <div class="lightbox-bar">
      <span class="lightbox-cap"></span>
      <span class="lightbox-tools">
        <button type="button" class="lightbox-stretch" aria-pressed="false" aria-label="Stretch" title="Stretch" data-i18n="Stretch" data-i18n-label="Stretch">Stretch</button>
        <select class="lightbox-speed" aria-label="Playback speed" data-i18n-aria="Playback speed">${VIDEO_RATES.map((r) => `<option value="${r}"${r === rate ? " selected" : ""}>${r}×</option>`).join("")}</select>
        <button type="button" class="lightbox-close" aria-label="Close" title="Close" data-i18n-label="Close"></button>
      </span>
    </div>
    <div class="lightbox-stage"><video class="lightbox-video" controls autoplay playsinline></video></div>`;
  translateTree(overlay);
  overlay.querySelector(".lightbox-close").innerHTML = CLOSE_SVG;
  document.body.appendChild(overlay);
  raiseToasts();
  overlay.querySelector(".lightbox-cap").textContent = caption;
  const video = overlay.querySelector("video");
  video.playbackRate = rate;
  video.src = src;
  lightboxEl = overlay;
  if (history.state?.velta !== "lightbox") history.pushState({ velta: "lightbox" }, "");

  // Ignore a currentTime under 1s. A pause before the resume seek would
  // otherwise wipe the bookmark. 0 is written only once playback is past that.
  const commit = () => {
    if (!(video.duration > 0)) return;
    const t = video.currentTime;
    const keep = videoResumeSeconds(t, video.duration);
    if (keep) saveVideoPos(src, keep);
    else if (t >= 1) saveVideoPos(src, 0);
  };
  video.addEventListener("loadedmetadata", () => {
    const t = videoResumeSeconds(loadVideoPos(src), video.duration);
    if (t) video.currentTime = t;
  });
  let savedAt = 0;
  video.addEventListener("timeupdate", () => {
    const now = Date.now();
    if (now - savedAt < 2000) return;
    savedAt = now;
    commit();
  });
  video.addEventListener("pause", commit);

  const close = () => teardownLightbox(true);
  lightboxOnKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", lightboxOnKey, true);
  overlay.querySelector(".lightbox-close").addEventListener("click", close);
  overlay.querySelector(".lightbox-stretch").addEventListener("click", () => {
    const on = overlay.classList.toggle("is-stretch");
    overlay.querySelector(".lightbox-stretch").setAttribute("aria-pressed", on ? "true" : "false");
  });
  overlay.querySelector(".lightbox-speed").addEventListener("change", (e) => {
    const n = Number(e.target.value);
    if (!VIDEO_RATES.includes(n)) return;
    video.playbackRate = n;
    try { localStorage.setItem(VIDEO_RATE_KEY, String(n)); } catch {}
  });
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
// Cheap pre-check for the 4 s toast throttle: callers skip all per-message
// notification work (focus/permission/window queries, muted lookups) while
// a toast was just shown.
export function notifyThrottled(now = Date.now()) {
  return now - lastNotifyAt < 4000;
}

export function notifyIncoming(title, body, info = {}) {
  if (notifyThrottled()) return;
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
    body = t("New message");
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
  if (notifyThrottled()) return; // before the focus/permission checks
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
