// ui.js — popup/menu/modal/drawer/toast helpers (plain DOM, no framework)
import { escapeHtml, escapeAttr } from "./components.js";
import { fileUrl } from "./media.js";

const popups = () => document.getElementById("popups");

let activeDrawer = null; // set by buildDrawer, closed by closeAllPopups
let activeModalClose = null;

// House close icon: bold stroke to match the other icon buttons (the
// unicode ✕ renders hairline-thin). Used by modals, the image lightbox and
// the HTML/full-message overlay.
export const CLOSE_SVG =
  '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

export function closeAllPopups() {
  activeModalClose?.();
  popups().replaceChildren();
  // the drawer lives outside #popups — close it explicitly, otherwise an
  // open drawer whose overlay was just wiped becomes impossible to dismiss
  activeDrawer?.close();
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
    b.className = "ctx-item" + (it.danger ? " danger" : "");
    b.innerHTML = (it.icon || "") + "<span>" + escapeHtml(it.label) + "</span>";
    b.addEventListener("click", () => { closeAllPopups(); it.onClick?.(); });
    menu.appendChild(b);
  }
  const overlay = document.createElement("div");
  overlay.className = "pop-overlay transparent";
  overlay.addEventListener("pointerdown", closeAllPopups);
  overlay.addEventListener("contextmenu", e => { e.preventDefault(); closeAllPopups(); });
  popups().append(overlay, menu);
  // keep on screen
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 10) + "px";
  menu.style.top = Math.min(y, innerHeight - r.height - 10) + "px";
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
  const overlay = document.createElement("div");
  overlay.className = "pop-overlay transparent";
  overlay.addEventListener("pointerdown", closeAllPopups);
  overlay.addEventListener("contextmenu", e => { e.preventDefault(); closeAllPopups(); });
  popups().append(overlay, pop);
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

export function showModal({ title, body, foot, onClose }) {
  closeAllPopups();
  const overlay = document.createElement("div");
  overlay.className = "pop-overlay";
  const modal = document.createElement("div");
  modal.className = "modal";
  const head = document.createElement("div");
  head.className = "modal-head";
  head.innerHTML = `<div class="modal-title">${escapeHtml(title)}</div>`;
  const close = document.createElement("button");
  close.className = "icon-btn";
  close.innerHTML = CLOSE_SVG;
  let closed = false;
  const doClose = () => {
    if (closed) return;
    closed = true;
    if (activeModalClose === doClose) activeModalClose = null;
    overlay.remove();
    onClose?.();
  };
  activeModalClose = doClose;
  close.addEventListener("click", doClose);
  head.appendChild(close);
  const bodyEl = document.createElement("div");
  bodyEl.className = "modal-body";
  if (typeof body === "string") bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  modal.append(head, bodyEl);
  if (foot) {
    const f = document.createElement("div");
    f.className = "modal-foot";
    if (typeof foot === "string") f.innerHTML = foot; else f.appendChild(foot);
    modal.appendChild(f);
  }
  overlay.appendChild(modal);
  overlay.addEventListener("pointerdown", e => { if (e.target === overlay) doClose(); });
  popups().appendChild(overlay);
  return { close: doClose, modal };
}

export function toast(text, ms = 2200) {
  const box = document.getElementById("toasts");
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .25s"; setTimeout(() => t.remove(), 260); }, ms);
}

export function confirmModal(title, text, okLabel = "Delete", danger = true) {
  return new Promise(resolve => {
    const foot = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn-text"; ok.textContent = okLabel;
    if (danger) ok.style.color = "var(--danger)";
    foot.append(cancel, ok);
    const { close } = showModal({ title, body: `<p style="font-size:15px;line-height:1.45">${escapeHtml(text)}</p>`, foot, onClose: () => resolve(false) });
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
let CORE_VERSION = "2.60.0";

export function setCoreVersionDisplay(v) {
  if (!v) return;
  CORE_VERSION = String(v).replace(/^v/, "");
  document.querySelectorAll('[data-v="core"]').forEach((el) => { el.textContent = CORE_VERSION; });
}
const FALLBACK_APP_VERSION = "1.4.22";

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
  // Desktop installer installs get the one-click path (updater plugin);
  // Android sideloads and the PWA still go through the system browser.
  const desktop = !/android/i.test(navigator.userAgent) && window.__TAURI__?.core?.invoke;
  btn.textContent = desktop ? "Update" : "Download APK";
  btn.addEventListener("click", () => {
    if (desktop) return selfUpdate(btn);
    const tauri = window.__TAURI__;
    if (tauri?.core?.invoke) {
      tauri.core.invoke("plugin:opener|open_url", { url: updateInfo.url })
        .catch(() => window.open(updateInfo.url, "_blank", "noopener"));
    } else {
      window.open(updateInfo.url, "_blank", "noopener");
    }
  });
  banner.append(text, btn);
  foot.before(banner);
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
        if (pct !== lastPct) { lastPct = pct; btn.textContent = pct ? `Downloading ${pct}%` : "Downloading…"; }
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
  if (v === "1") document.documentElement.style.removeProperty("zoom");
  else document.documentElement.style.zoom = v;
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

async function getAppVersion() {
  try {
    const tauri = window.__TAURI__;
    if (tauri?.app?.getVersion) return await tauri.app.getVersion();
    if (tauri?.core?.invoke) return await tauri.core.invoke("plugin:app|version");
  } catch {}
  return FALLBACK_APP_VERSION;
}

// The app-shell cache name (velta-vNN) doubles as the service worker version.
async function getSwVersion() {
  try {
    const keys = await caches.keys();
    const m = keys.map(k => /^velta-(v\d+)$/.exec(k)).find(Boolean);
    if (m) return m[1];
  } catch {}
  return null;
}

// Tauri framework version (not the app version).
async function getTauriVersion() {
  try {
    const v = await window.__TAURI__?.app?.getTauriVersion?.();
    if (v) return v;
  } catch {}
  return null;
}

/* ---------- Settings drawer ---------- */
export function buildDrawer({ account, onAddAccount, onSecondDevice, onSetTheme, onOpenChat, onInvite, onToggleMock, onProfile, onEditProfile, onInviteDomains, p2pAvailable = false, p2pOn = false, onP2pToggle, onRelays, accounts = [], currentAccountId = null, onAccountTap, theme, barHidden = [], onBarToggle }) {
  const isTauri = !!window.__TAURI__;
  const drawer = document.createElement("div");
  drawer.className = "drawer";
  drawer.id = "drawer";
  drawer.innerHTML = `
    <div class="drawer-head">
      <velta-avatar data-act="profile" style="cursor:pointer" name="${escapeHtml(account.displayName)}" color="${escapeAttr(account.color || "#777")}" size="56" contact-id="1"${account.avatar ? ` avatar="${escapeAttr(fileUrl(account.avatar))}"` : ""}></velta-avatar>
      <div>
        <div class="drawer-name">${escapeHtml(account.displayName)}</div>
        <div class="drawer-links">
          <button type="button" data-act="edit-profile">Edit profile</button>
          ${accounts.length ? `<button type="button" data-act="switch-account">Switch account<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <div class="acct-pop" data-acct-pop hidden>
            ${accounts.map(a => `<button class="ctx-item" data-act="account" data-account="${escapeAttr(a.id)}"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20a8 8 0 0116 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>${a.id === currentAccountId ? `<path d="M8.5 12.5l2.5 2.5 5-5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : ""}</svg><span>${escapeHtml(a.name || a.addr)}${a.id === currentAccountId ? " · current" : ""}</span></button>`).join("")}
          </div>` : ""}
        </div>
      </div>
    </div>
    <div class="drawer-items">
      <button class="ctx-item" data-act="saved"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span>Saved Messages</span></button>
      <button class="ctx-item" data-act="invite"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="1" fill="currentColor"/><rect x="3" y="13" width="8" height="8" rx="1" fill="currentColor"/></svg><span>Invite friends (QR)</span></button>
      ${p2pAvailable ? `<button class="ctx-item" data-act="p2p-toggle"><svg viewBox="0 0 24 24"><path d="M2.5 9.5a14 14 0 0119 0M5.5 13a9.5 9.5 0 0113 0M8.5 16.5a5 5 0 017 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="19.5" r="1.4" fill="currentColor"/></svg><span>Local chat: ${p2pOn ? "on" : "off"}</span></button>` : ""}
      <div class="drawer-sec">Settings</div>
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 109 9c0-1.5-1.2-2.6-2.6-2.6h-1.9a2.5 2.5 0 01-2.5-2.5V5.1C14 4 13.3 3 12 3z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16.5" cy="10.5" r="1.2" fill="currentColor"/></svg><span data-theme-summary>Theme: ${THEME_LABELS[theme] || "Auto"}</span></summary>
        <div class="scale-opts" data-theme-opts>
          ${Object.entries(THEME_LABELS).map(([v, label]) => `<label class="scale-opt"><input type="radio" name="app-theme" value="${v}"${v === theme ? " checked" : ""}><span>${label}</span></label>`).join("")}
        </div>
      </details>
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><path d="M5 19L11.2 5h1.6L19 19M7.2 15h9.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16.5 5.5L21 10M21 5.5L16.5 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span data-scale-summary>Interface scale: ${uiScaleLabel()}</span></summary>
        <div class="scale-opts" data-scale-opts>
          ${UI_SCALES.map(([v, label]) => `<label class="scale-opt"><input type="radio" name="ui-scale" value="${v}"${v === uiScaleValue() ? " checked" : ""}><span>${label}</span></label>`).join("")}
        </div>
      </details>
      <details class="drawer-details">
        <summary><svg viewBox="0 0 24 24"><rect x="3" y="17" width="18" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 17v-4m6 4V9m6 8V5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Bottom bar buttons</span></summary>
        <div class="scale-opts" data-bar-opts>
          ${[["chats", "Chats"], ["contacts", "Contacts"], ["calls", "Calls"], ["qr", "QR code"]].map(([key, label]) => `<label class="scale-opt"><input type="checkbox" data-bar-key="${key}"${barHidden.includes(key) ? "" : " checked"}><span>${label}</span></label>`).join("")}
        </div>
        <div class="bar-opts-hint">Menu button is always visible.</div>
      </details>
      <button class="ctx-item" data-act="add-account"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20a8 8 0 0116 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19 5v4M21 7h-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Add profile…</span></button>
      <button class="ctx-item" data-act="second-device"><svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="11" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="16" y="8" width="5.5" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>Add a second device…</span></button>
      <button class="ctx-item" data-act="relays"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>Relays of this profile…</span></button>
      <button class="ctx-item" data-act="invite-domains"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>Invite link domains</span></button>
      <button class="ctx-item" data-act="mock"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9h6v6H9z" fill="currentColor"/></svg><span>${localStorage.getItem("velta-mock") === "1" ? "Exit mock mode" : "Enter mock mode"}</span></button>
      <button class="ctx-item" data-act="about"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10v6M12 7v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg><span>About Velta</span></button>
    </div>
    <div class="drawer-foot" data-versions>
      <div class="drawer-ver"><span>Velta</span><span data-v="app">…</span></div>
      <div class="drawer-ver"><span>Chatmail core</span><span data-v="core">${CORE_VERSION}</span></div>
      ${isTauri ? `<div class="drawer-ver"><span>Tauri</span><span data-v="tauri">…</span></div>` : ""}
      ${isTauri ? "" : `<div class="drawer-ver"><span>Service worker</span><span data-v="sw">…</span></div>`}
    </div>`;
  document.body.appendChild(drawer);

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
    if (!isTauri) {
      const sw = await getSwVersion();
      box.querySelector('[data-v="sw"]').textContent = sw || "not registered";
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

  const acctPop = drawer.querySelector("[data-acct-pop]");

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
    drawer.classList.add("open");
    overlay.style.display = "block";
    document.addEventListener("pointerdown", onDocPointer, true);
    // lets the list-bar Menu button flip its icon to a cross while open
    document.dispatchEvent(new CustomEvent("velta-drawer", { detail: { open: true } }));
  }
  function close() {
    drawer.classList.remove("open");
    if (acctPop) acctPop.hidden = true;
    // the overlay may already be gone (wiped by closeAllPopups) — guard it
    if (overlay.isConnected) overlay.style.display = "none";
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.dispatchEvent(new CustomEvent("velta-drawer", { detail: { open: false } }));
  }
  activeDrawer = { close };

  drawer.addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "switch-account") { acctPop.hidden = !acctPop.hidden; return; }
    close();
    if (act === "saved") onOpenChat("saved");
    if (act === "invite") onInvite?.();
    if (act === "p2p-toggle") onP2pToggle?.();
    if (act === "profile") onProfile?.();
    if (act === "edit-profile") onEditProfile?.();
    if (act === "add-account") onAddAccount();
    if (act === "second-device") onSecondDevice?.();
    if (act === "account") onAccountTap?.(btn.dataset.account);
    if (act === "relays") onRelays?.();
    if (act === "invite-domains") onInviteDomains?.();
    if (act === "mock") onToggleMock();
    if (act === "about") showAbout();
  });

  return { open, close, el: drawer, overlayEl: overlay };
}

// Profile editor — edits the display name and the avatar picture.
// pickImage: async () => ({ path, url } | null), provided by the caller
// (Tauri file dialog on desktop, content-URI copy on Android, data-URL in
// demo mode). Resolves with
//   { name, avatar: "keep" | "remove" | { path } }  — or null on cancel.
export function showEditProfile({ name, avatarUrl, color, pickImage }) {
  return new Promise(resolve => {
    let picked = null;   // { path } once a new picture is chosen
    let removed = false; // "Remove photo" tapped
    const body = document.createElement("div");
    body.className = "edit-profile";
    body.innerHTML = `
      <div class="ep-avatar"><velta-avatar size="84" contact-id="1"></velta-avatar></div>
      <div class="ep-avatar-actions">
        <button class="btn-text" data-ep="pick">Change picture</button>
        <button class="btn-text" data-ep="remove" style="display:none">Remove photo</button>
      </div>
      <input class="text-field" maxlength="64" autocomplete="off" spellcheck="false" aria-label="Username" placeholder="Your name">`;
    const input = body.querySelector("input");
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
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.className = "btn-text btn-primary"; save.textContent = "Save";
    foot.append(cancel, save);

    // first settlement wins — close() fires onClose, which must not win
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const { close } = showModal({ title: "Edit profile", body, foot,
      onClose: () => finish(null) });
    input.focus();
    input.select();
    const submit = () => {
      const value = {
        name: input.value.trim(),
        avatar: removed ? "remove" : (picked || "keep"),
      };
      save.disabled = true; input.disabled = true;
      // settle before close — close() fires onClose, which must not win
      finish(value);
      close();
    };
    save.addEventListener("click", submit);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
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
    <div style="text-align:center;margin-top:6px"><button class="btn-text" data-copy>Copy invite link</button></div>`;
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

async function showAbout() {
  // Prefer the runtime version so the About dialog always matches the built
  // app; the core version is the pinned core/ workspace version.
  const version = await getAppVersion();
  showModal({
    title: "About Velta",
    body: `
      <div class="info-row"><span class="k">App</span><span class="v">Velta ${escapeHtml(version)}</span></div>
      <div class="info-row"><span class="k">Core</span><span class="v">deltachat-core-rust ${CORE_VERSION}</span></div>
      <div class="info-row"><span class="k">Transport</span><span class="v">chatmail relays (IMAP/SMTP)</span></div>
      <div class="info-row"><span class="k">Encryption</span><span class="v">OpenPGP, end-to-end</span></div>
      <div class="info-row"><span class="k">UI stack</span><span class="v">Elena progressive web components</span></div>
      <div class="enc-note"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>No phone number needed. No central servers. Your messages travel through email relays you choose, encrypted end to end.</span></div>`,
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
      <button class="lightbox-close" aria-label="Close" title="Close"></button>
    </div>
    <div class="lightbox-stage"><img class="lightbox-img" decoding="async" alt=""></div>`;
  overlay.querySelector(".lightbox-close").innerHTML = CLOSE_SVG;
  document.body.appendChild(overlay);
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

/* ---------- incoming-message notifications ---------- */
// Callers own the policy (who/when — they know which message is new); this is
// the platform bridge plus a burst throttle. No-op outside the Tauri shell or
// while the window is visible (the user is looking at the app).
let lastNotifyAt = 0;
export function notifyIncoming(title, body, info = {}) {
  if (!window.__TAURI__ || !document.hidden) return;
  const now = Date.now();
  if (now - lastNotifyAt < 4000) return;
  lastNotifyAt = now;
  const t = window.__TAURI__;
  const invoke = t.core?.invoke || t.invoke;
  invoke("notify_incoming", {
    title,
    body,
    chatName: info.chatName || null,
    senderName: info.senderName || null,
    senderAvatar: info.senderAvatar || null,
  }).catch(() => {});
}
