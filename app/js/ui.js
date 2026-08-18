// ui.js — popup/menu/modal/drawer/toast helpers (plain DOM, no framework)
import { escapeHtml } from "./components.js";

const popups = () => document.getElementById("popups");

let activeDrawer = null; // set by buildDrawer, closed by closeAllPopups

export function closeAllPopups() {
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
  close.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  const doClose = () => { overlay.remove(); onClose?.(); };
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
    const { close } = showModal({ title, body: `<p style="font-size:15px;line-height:1.45">${escapeHtml(text)}</p>`, foot });
    cancel.addEventListener("click", () => { close(); resolve(false); });
    ok.addEventListener("click", () => { close(); resolve(true); });
  });
}

/* ---------- Settings drawer ---------- */
export function buildDrawer({ account, backend, onAddAccount, onToggleTheme, onOpenChat, onInvite, theme }) {
  const drawer = document.createElement("div");
  drawer.className = "drawer";
  drawer.id = "drawer";
  drawer.innerHTML = `
    <div class="drawer-head">
      <button class="icon-btn drawer-close" data-act="close" title="Close" aria-label="Close menu"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>
      <dc-avatar name="${escapeHtml(account.displayName)}" color="${account.color}" size="56"></dc-avatar>
      <div>
        <div class="drawer-name">${escapeHtml(account.displayName)}</div>
        <div class="drawer-addr">${escapeHtml(account.addr)}</div>
        <div class="drawer-addr">relay: ${escapeHtml(account.relay)}</div>
        ${backend ? `<div class="drawer-addr" style="opacity:.65">backend: ${escapeHtml(backend)}</div>` : ""}
      </div>
    </div>
    <div class="drawer-items">
      <button class="ctx-item" data-act="saved"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span>Saved Messages</span></button>
      <button class="ctx-item" data-act="invite"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="1" fill="currentColor"/><rect x="3" y="13" width="8" height="8" rx="1" fill="currentColor"/></svg><span>Invite friends (QR)</span></button>
      <div class="drawer-sec">Settings</div>
      <button class="ctx-item" data-act="theme"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 109 9c0-1.5-1.2-2.6-2.6-2.6h-1.9a2.5 2.5 0 01-2.5-2.5V5.1C14 4 13.3 3 12 3z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16.5" cy="10.5" r="1.2" fill="currentColor"/></svg><span>${theme === "dark" ? "Light theme" : "Dark theme"}</span></button>
      <button class="ctx-item" data-act="add-account"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20a8 8 0 0116 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19 5v4M21 7h-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Add account (chatmail)</span></button>
      <button class="ctx-item" data-act="about"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10v6M12 7v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg><span>About Velta</span></button>
    </div>`;
  document.body.appendChild(drawer);

  const overlay = document.createElement("div");
  overlay.className = "pop-overlay transparent";
  overlay.style.display = "none";
  overlay.addEventListener("pointerdown", close);
  popups().appendChild(overlay);

  function open() { drawer.classList.add("open"); overlay.style.display = "block"; }
  function close() {
    drawer.classList.remove("open");
    // the overlay may already be gone (wiped by closeAllPopups) — guard it
    if (overlay.isConnected) overlay.style.display = "none";
  }
  activeDrawer = { close };

  drawer.addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    close();
    if (act === "theme") onToggleTheme();
    if (act === "saved") onOpenChat("saved");
    if (act === "invite") onInvite?.();
    if (act === "add-account") onAddAccount();
    if (act === "about") showAbout();
  });

  return { open, close, el: drawer, overlayEl: overlay };
}

// Invite modal with a real SecureJoin QR rendered by the core.
// provider: async () => ({ svg, link })
export function showInvite(provider, { title = "Invite to Delta Chat", group = false } = {}) {
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
      body.querySelector(".qr-box").innerHTML = svg || "<div class='qr-loading'>QR unavailable</div>";
      body.querySelector(".invite-link").textContent = link;
    })
    .catch(err => {
      body.querySelector(".qr-box").innerHTML =
        `<div class="qr-loading">Couldn't create the invite:<br>${escapeHtml(String(err?.message || err))}</div>`;
    });
}

function showAbout() {
  showModal({
    title: "About Velta",
    body: `
      <div class="info-row"><span class="k">App</span><span class="v">Velta 1.1.0</span></div>
      <div class="info-row"><span class="k">Core</span><span class="v">deltachat-core-rust 2.59.0</span></div>
      <div class="info-row"><span class="k">Transport</span><span class="v">chatmail relays (IMAP/SMTP)</span></div>
      <div class="info-row"><span class="k">Encryption</span><span class="v">OpenPGP, end-to-end</span></div>
      <div class="info-row"><span class="k">UI stack</span><span class="v">Elena progressive web components</span></div>
      <div class="enc-note"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>No phone number needed. No central servers. Your messages travel through email relays you choose, encrypted end to end.</span></div>`,
  });
}

/* ---------- Emoji pop ---------- */
const EMOJIS = ["😀","😄","😂","🤣","😊","😍","😘","😎","🤔","🙃","😴","😭","😅","🥹","😇","🤗","👍","👎","👏","🙏","💪","🤝","❤️","🔥","🎉","✨","💯","🚀","🌟","🍕","☕","🎵","📌","✅","❌","⚡","🌍","🐧","🤖","👀","💡","🧠","🫶","😮","🥳","😤","🫠"];

export function showEmojiPop(anchorBtn, onPick) {
  closeAllPopups();
  const pop = document.createElement("div");
  pop.className = "emoji-pop";
  for (const e of EMOJIS) {
    const b = document.createElement("button");
    b.textContent = e;
    b.addEventListener("click", () => { onPick(e); closeAllPopups(); });
    pop.appendChild(b);
  }
  const overlay = document.createElement("div");
  overlay.className = "pop-overlay transparent";
  overlay.addEventListener("pointerdown", closeAllPopups);
  popups().append(overlay, pop);
  const r = anchorBtn.getBoundingClientRect();
  pop.style.right = Math.max(8, innerWidth - r.right - 40) + "px";
  pop.style.bottom = (innerHeight - r.top + 10) + "px";
}
