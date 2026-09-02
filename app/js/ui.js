// ui.js — popup/menu/modal/drawer/toast helpers (plain DOM, no framework)
import { escapeHtml, escapeAttr } from "./components.js";
import { fileUrl } from "./media.js";

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

/* ---------- Settings drawer ---------- */
export function buildDrawer({ account, backend, onAddAccount, onToggleTheme, onOpenChat, onInvite, onToggleMock, onEditProfile, theme }) {
  const drawer = document.createElement("div");
  drawer.className = "drawer";
  drawer.id = "drawer";
  drawer.innerHTML = `
    <div class="drawer-head">
      <button class="icon-btn drawer-close" data-act="close" title="Close" aria-label="Close menu"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>
      <dc-avatar name="${escapeHtml(account.displayName)}" color="${escapeAttr(account.color || "#777")}" size="56"${account.avatar ? ` avatar="${escapeAttr(fileUrl(account.avatar))}"` : ""}></dc-avatar>
      <div>
        <div class="drawer-name">${escapeHtml(account.displayName)}</div>
        <div class="drawer-addr">${escapeHtml(account.addr)}</div>
        <div class="drawer-addr">relay: ${escapeHtml(account.relay)}</div>
        ${backend ? `<div class="drawer-addr" style="opacity:.65">backend: ${escapeHtml(backend)}</div>` : ""}
      </div>
    </div>
    <div class="drawer-items">
      <button class="ctx-item" data-act="saved"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span>Saved Messages</span></button>
      <button class="ctx-item" data-act="edit-profile"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20a8 8 0 0116 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15.5 15.5l4 4M19.5 15.5l-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Edit profile</span></button>
      <button class="ctx-item" data-act="invite"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="1" fill="currentColor"/><rect x="3" y="13" width="8" height="8" rx="1" fill="currentColor"/></svg><span>Invite friends (QR)</span></button>
      <div class="drawer-sec">Settings</div>
      <button class="ctx-item" data-act="theme"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 109 9c0-1.5-1.2-2.6-2.6-2.6h-1.9a2.5 2.5 0 01-2.5-2.5V5.1C14 4 13.3 3 12 3z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16.5" cy="10.5" r="1.2" fill="currentColor"/></svg><span>${theme === "dark" ? "Light theme" : "Dark theme"}</span></button>
      <button class="ctx-item" data-act="add-account"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20a8 8 0 0116 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19 5v4M21 7h-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Add account (chatmail)</span></button>
      <button class="ctx-item" data-act="mock"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9h6v6H9z" fill="currentColor"/></svg><span>${localStorage.getItem("velta-mock") === "1" ? "Exit mock mode" : "Enter mock mode"}</span></button>
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
    if (act === "edit-profile") onEditProfile?.();
    if (act === "add-account") onAddAccount();
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
      <div class="ep-avatar"><dc-avatar size="84"></dc-avatar></div>
      <div class="ep-avatar-actions">
        <button class="btn-text" data-ep="pick">Change picture</button>
        <button class="btn-text" data-ep="remove" style="display:none">Remove photo</button>
      </div>
      <input class="text-field" maxlength="64" autocomplete="off" spellcheck="false" aria-label="Username" placeholder="Your name">`;
    const input = body.querySelector("input");
    const preview = body.querySelector("dc-avatar");
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
// account: when set (self invite), the user's color-coded avatar is overlaid
// in the QR center — the core reserves a clear circle there for exactly that.
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
      // Overlay the user's color-coded avatar on the clear circle the core
      // leaves in the QR center (design space 515x630, circle center at
      // 50% / 43.65% of the rendered svg). Intentionally initials-on-color:
      // that is the "color-coded avatar" identity tile, not the photo.
      if (account && svg) {
        box.insertAdjacentHTML("beforeend",
          `<div class="qr-self"><dc-avatar name="${escapeHtml(account.displayName || "?")}" color="${escapeAttr(account.color || "#777")}" size="120"></dc-avatar></div>`);
      }
    })
    .catch(err => {
      body.querySelector(".qr-box").innerHTML =
        `<div class="qr-loading">Couldn't create the invite:<br>${escapeHtml(String(err?.message || err))}</div>`;
    });
}

async function showAbout() {
  // Keep the fallback in sync with tauri.conf.json; prefer the runtime
  // version so the About dialog always matches the built app.
  let version = "1.1.12";
  try {
    const tauri = window.__TAURI__;
    if (tauri?.app?.getVersion) version = await tauri.app.getVersion();
    else if (tauri?.core?.invoke) version = await tauri.core.invoke("plugin:app|version");
  } catch {}
  showModal({
    title: "About Velta",
    body: `
      <div class="info-row"><span class="k">App</span><span class="v">Velta ${version}</span></div>
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


/* ---------- Fullscreen image lightbox (pinch to zoom) ---------- */
export function openImageLightbox(src, caption = "") {
  closeAllPopups();
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.innerHTML = `
    <div class="lightbox-bar">
      <span class="lightbox-cap"></span>
      <button class="lightbox-close" aria-label="Close">✕</button>
    </div>
    <div class="lightbox-stage"><img class="lightbox-img" alt=""></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector(".lightbox-cap").textContent = caption;
  const img = overlay.querySelector(".lightbox-img");
  const stage = overlay.querySelector(".lightbox-stage");
  img.src = src;

  let scale = 1, tx = 0, ty = 0;
  let startDist = 0, startScale = 1, startX = 0, startY = 0, startTx = 0, startTy = 0;
  let touched = false, lastTap = 0, tapTimer = 0;

  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
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
