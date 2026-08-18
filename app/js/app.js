// app.js — Delta Web bootstrap: chat list, navigation, modals, PWA
import { createCore, probeService } from "./transport.js";
import "./components.js";
import { escapeHtml, escapeAttr } from "./components.js";
import { ChatView } from "./chat-view.js";
import { buildDrawer, showModal, showContextMenu, toast, closeAllPopups, confirmModal, showInvite } from "./ui.js";

function appLog(msg) {
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke || tauri?.invoke;
    if (invoke) invoke("js_log", { msg }).catch(() => {});
  } catch {}
  console.log("[velta]", msg);
}

window.addEventListener("error", e => appLog(`JS error: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", e => appLog(`JS unhandled rejection: ${e.reason?.stack || e.reason}`));

// Show what we're doing from the very first paint — createCore() below can
// take a moment while it probes for the background service.
const $ = (id) => document.getElementById(id);
{
  const el = $("conn-status");
  if (el) { el.dataset.state = "connecting"; $("conn-label").textContent = "Checking for background service…"; }
}

// In the Tauri shell, show sidecar startup progress while the core is being located.
let lastSidecarStatus = null;
if (window.__TAURI__) {
  const tauri = window.__TAURI__;
  const invoke = tauri.core?.invoke || tauri.invoke;
  const event = tauri.event || tauri;
  const listen = event.listen ? event.listen.bind(event) : tauri.listen.bind(tauri);

  function applySidecarStatus(status) {
    lastSidecarStatus = status;
    const el = $("conn-status"), label = $("conn-label");
    if (!el || !label) return;
    if (status.running) {
      label.textContent = status.stage === "ready" ? "Core ready · connecting…" : "Starting local core…";
      el.title = `Delta Chat sidecar is ${status.stage || "starting"}`;
    } else {
      el.dataset.state = "mock";
      label.textContent = status.error ? `Sidecar failed: ${status.error}` : `Sidecar: ${status.stage || "stopped"}`;
      el.title = status.error ? `Delta Chat sidecar failed: ${status.error}` : "Delta Chat sidecar is not running";
    }
  }

  try {
    listen("dc-sidecar-status", ev => applySidecarStatus(ev.payload));
    invoke("get_sidecar_status").then(applySidecarStatus);
  } catch (e) {
    console.warn("[delta-web] sidecar status setup failed:", e);
  }
}

const core = await createCore();
updateConnStatus();

/* ---------------- connection status pill ---------------- */
function updateConnStatus(connectedOverride) {
  const el = $("conn-status"), label = $("conn-label");
  if (!el || !core.backend) return;
  const connected = connectedOverride ?? core.backend.connected;
  const stateName = core.backend.kind === "mock" ? "mock" : connected ? "online" : "offline";
  el.dataset.state = stateName;

  if (core.backend.kind === "mock" && lastSidecarStatus) {
    const s = lastSidecarStatus;
    if (s.running) {
      label.textContent = s.stage === "ready" ? "Core ready but not responding" : "Starting local core…";
      el.title = "The Delta Chat sidecar started, but the frontend could not handshake with it. Check velta.log for details.";
    } else {
      label.textContent = s.error ? `Sidecar failed: ${s.error}` : `Sidecar: ${s.stage || "stopped"}`;
      el.title = s.error ? `Delta Chat sidecar failed: ${s.error}` : "Delta Chat sidecar is not running";
    }
    return;
  }

  label.textContent =
    core.backend.kind === "mock" ? "Demo mode — no local core"
    : connected ? `Connected · ${core.backend.label}`
    : `Disconnected · ${core.backend.label}`;
  el.title = core.backend.kind === "mock"
    ? "No background deltachat core found. Tap to check again, or install the Delta Core service app."
    : connected ? "PWA is connected to the background deltachat core"
    : "Lost connection to the background core. Tap to reconnect.";
}

addEventListener("dc-core-status", e => {
  if (core.backend) core.backend.connected = !!e.detail.connected;
  updateConnStatus();
});

// Socket opened but the core never answered RPC → almost always an old or
// crashed service build. Say so explicitly instead of silently demo-ing.
addEventListener("dc-core-init-failed", e => {
  if (e.detail.backend === "websocket") {
    toast("Found the background service, but it didn't answer — restart the Delta Core service (or update it if it's an older build)", 6000);
  }
});

// Tap the pill while in demo mode or disconnected to re-check for the service.
let rechecking = false;
async function recheckService() {
  if (rechecking) return;
  const el = $("conn-status");
  if (!el || (el.dataset.state !== "mock" && el.dataset.state !== "offline")) return;
  rechecking = true;
  el.dataset.state = "connecting";
  $("conn-label").textContent = "Checking for background service…";
  try {
    if (core.backend?.kind === "mock") {
      if (lastSidecarStatus) {
        // Tauri desktop: explain why the local sidecar is not being used
        const s = lastSidecarStatus;
        if (s.error) {
          toast(`Local core sidecar failed: ${s.error}`, 6000);
        } else if (s.running) {
          toast("Sidecar started but the core handshake timed out — the sidecar may still be initializing. Try restarting Velta.", 6000);
        } else {
          toast(`Local core sidecar is ${s.stage || "not running"}. Try reinstalling Velta.`, 6000);
        }
      } else {
        // PWA / no Tauri sidecar: probe the background service APK
        const found = await probeService();
        if (found) {
          toast("Background service found — switching to the real core…", 2000);
          setTimeout(() => location.reload(), 900);
        } else {
          toast("No background service reachable — is the Delta Core service app running?", 4000);
        }
      }
    } else {
      // websocket backend that lost its connection → reconnect in place
      const ok = await core.reconnect?.();
      if (ok) {
        core.backend.connected = true;
        toast("Reconnected to the local Delta Chat core", 2500);
        refreshChatList();
      } else {
        toast("Still can't reach the background service — is it running?", 4000);
      }
    }
  } finally {
    rechecking = false;
    updateConnStatus();
  }
}

const state = {
  account: null,
  chats: [],
  activeChatId: null,
  query: "",
  theme: localStorage.getItem("dw-theme") || "dark",
};

/* ---------------- theme ---------------- */
applyTheme();
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]').content = state.theme === "dark" ? "#0f0f14" : "#ffffff";
  localStorage.setItem("dw-theme", state.theme);
}
function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme();
  rebuildDrawer();
}

/* ---------------- chat list ---------------- */
async function refreshChatList() {
  try {
    state.chats = await core.getChatList({ query: state.query });
    renderChatList();
  } catch (err) {
    appLog(`refreshChatList error: ${err.message}`);
  }
}

function renderChatList() {
  const list = $("chat-list");
  list.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const chat of state.chats) {
    const item = document.createElement("dc-chat-item");
    item.setData(chat);
    if (chat.id === state.activeChatId) item.setAttribute("active", "");
    item.addEventListener("click", () => openChat(chat.id));
    item.addEventListener("contextmenu", e => {
      e.preventDefault();
      chatContextMenu(chat, e.clientX, e.clientY);
    });
    frag.appendChild(item);
  }
  if (!state.chats.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "text-align:center;color:var(--text-dim);padding:30px 16px;font-size:14.5px";
    empty.textContent = state.query ? "No chats found" : "No chats yet — start a new one";
    frag.appendChild(empty);
  }
  list.appendChild(frag);
}

function chatContextMenu(chat, x, y) {
  const icons = {
    pin: `<svg viewBox="0 0 24 24"><path d="M9 4h6l1 7 3 3v2h-6v5l-1 1-1-1v-5H5v-2l3-3z" fill="currentColor"/></svg>`,
    mute: `<svg viewBox="0 0 24 24"><path d="M12 3a5 5 0 00-5 5v3l-2 4h14l-2-4V8a5 5 0 00-5-5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
    archive: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 9v11h14V9M10 13h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    read: `<svg viewBox="0 0 24 24"><path d="M3 13l4 4L17 7M10 15l2 2 8-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };
  showContextMenu([
    { label: chat.pinned ? "Unpin" : "Pin to top", icon: icons.pin, onClick: () => core.setChatFlags(chat.id, { pinned: !chat.pinned }) },
    { label: chat.muted ? "Unmute" : "Mute notifications", icon: icons.mute, onClick: () => core.setChatFlags(chat.id, { muted: !chat.muted }) },
    chat.unread > 0 ? { label: "Mark as read", icon: icons.read, onClick: () => core.markRead(chat.id) } : null,
    "-",
    { label: chat.archived ? "Unarchive" : "Archive", icon: icons.archive, onClick: () => core.setChatFlags(chat.id, { archived: !chat.archived }) },
    { label: "Delete chat", icon: icons.trash, danger: true, onClick: async () => {
      if (await confirmModal("Delete chat", `Delete "${chat.name}" and all its messages?`)) {
        await core.deleteMessages(chat.id, (await core.getMessages(chat.id, { limit: 100000 })).messages.map(m => m.id));
        if (state.activeChatId === chat.id) closeChat();
        refreshChatList();
      }
    } },
  ].filter(Boolean), x, y);
}

/* ---------------- chat open/close ---------------- */
let chatView;

async function openChat(chatId) {
  const chat = await core.getChat(chatId);
  if (chat.kind === "deaddrop") {
    const ok = await confirmModal("Contact request", `"${chat.name}" wants to start a conversation with you. Accept it to read the messages and reply.`, "Accept", false);
    if (ok) {
      await core.acceptChat(chatId);
      toast("Contact request accepted");
      await refreshChatList();
      return openChat(chatId); // now a normal chat — open it
    }
    return;
  }
  state.activeChatId = chatId;
  $("no-chat").hidden = true;
  $("chat-view").hidden = false;
  document.querySelector(".app").classList.add("chat-open");
  const head = document.createElement("dc-chat-head");
  head.setData(chat);
  $("chat-head-info").replaceChildren(head);
  head.addEventListener("click", () => showChatInfo(chat));
  // Real member count for groups (the chatlist item doesn't carry it)
  if ((chat.kind === "group" || chat.kind === "channel") && core.getChatMembers) {
    core.getChatMembers(chatId).then(members => {
      if (state.activeChatId !== chatId) return;
      chat.memberCount = members.length;
      head.setData(chat);
    }).catch(() => {});
  }
  await chatView.open(chatId);
  renderChatList();
}

function closeChat() {
  chatView?.stopLive();
  state.activeChatId = null;
  $("chat-view").hidden = true;
  $("no-chat").hidden = false;
  document.querySelector(".app").classList.remove("chat-open");
  renderChatList();
}

function showChatInfo(chat) {
  const encNote = chat.encrypted
    ? `<div class="enc-note"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>Messages in this chat are end-to-end encrypted automatically.</span></div>` : "";
  const contactRows = chat.contact ? `
    <div class="info-row"><span class="k">Address</span><span class="v">${escapeHtml(chat.contact.addr)}</span></div>
    <div class="info-row"><span class="k">Verified</span><span class="v">${chat.contact.verified ? "Yes ✓" : "No"}</span></div>` : "";
  const isGroup = chat.kind === "group" || chat.kind === "channel";
  const body = document.createElement("div");
  body.innerHTML = `
    <div style="display:flex;justify-content:center;padding:8px 0 14px">
      <dc-avatar name="${escapeHtml(chat.name)}" color="${chat.avatarColor || "#777"}" kind="${chat.kind}" size="84"></dc-avatar>
    </div>
    ${encNote}
    ${isGroup ? `<div class="info-row"><span class="k">Members</span><span class="v" data-member-count>…</span></div>
      <div class="modal-list" data-member-list style="max-height:240px;overflow:auto"></div>` : ""}
    ${contactRows}
    <div class="info-row"><span class="k">Notifications</span><span class="v">${chat.muted ? "Muted" : "On"}</span></div>
    <div class="info-row"><span class="k">Transport</span><span class="v">chatmail relay · ${escapeHtml(state.account.relay)}</span></div>`;
  showModal({ title: chat.name, body });

  if (isGroup && core.getChatMembers) {
    core.getChatMembers(chat.id).then(members => {
      const count = body.querySelector("[data-member-count]");
      const list = body.querySelector("[data-member-list]");
      if (count) count.textContent = members.length.toLocaleString();
      if (list) {
        for (const m of members) {
          const row = document.createElement("div");
          row.className = "info-row";
          row.innerHTML = `<span class="k" style="color:${escapeAttr(m.color || "#888")}">${escapeHtml(m.name)}</span><span class="v">${escapeHtml(m.addr || "")}</span>`;
          list.appendChild(row);
        }
      }
    }).catch(() => {
      const count = body.querySelector("[data-member-count]");
      if (count) count.textContent = "unavailable";
    });
  }
}

/* ---------------- chat head menu ---------------- */
function bindChatHeadMenu() {
  $("btn-chat-menu").addEventListener("click", e => {
    const chat = state.chats.find(c => c.id === state.activeChatId);
    if (!chat) return;
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu([
      { label: "Chat info", onClick: () => showChatInfo(chat) },
      ...(chat.kind === "group" ? [{ label: "Group invite QR", onClick: () =>
        showInvite(inviteQrProvider(chat.id), { title: chat.name, group: true }) }] : []),
      { label: chat.muted ? "Unmute" : "Mute", onClick: () => core.setChatFlags(chat.id, { muted: !chat.muted }) },
      { label: chat.pinned ? "Unpin" : "Pin", onClick: () => core.setChatFlags(chat.id, { pinned: !chat.pinned }) },
      "-",
      { label: "Clear history", danger: true, onClick: async () => {
        if (await confirmModal("Clear history", "Delete all messages in this chat?")) {
          const { messages } = await core.getMessages(chat.id, { limit: 100000 });
          await core.deleteMessages(chat.id, messages.map(m => m.id));
        }
      } },
    ], r.right - 220, r.bottom + 6);
  });
  $("btn-back").addEventListener("click", closeChat);
  $("btn-chat-search").addEventListener("click", () => {
    const input = document.createElement("input");
    input.className = "text-field";
    input.placeholder = "Search in loaded messages…";
    const results = document.createElement("div");
    results.className = "modal-list";
    const wrap = document.createElement("div");
    wrap.append(input, results);
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      results.replaceChildren();
      if (q.length < 2) return;
      const hits = chatView.items.filter(i => i.type === "msg" && i.msg.text?.toLowerCase().includes(q)).slice(-12);
      for (const h of hits) {
        const b = document.createElement("button");
        b.className = "ctx-item";
        b.innerHTML = `<span><b>${escapeHtml(h.msg.fromContact?.name || "")}</b>: ${escapeHtml(h.msg.text.slice(0, 80))}</span>`;
        b.addEventListener("click", () => { closeAllPopups(); chatView._jumpToMessage(h.msg.id); });
        results.appendChild(b);
      }
      if (!hits.length) results.innerHTML = `<p style="color:var(--text-dim);font-size:14px;padding:8px 0">Nothing found in loaded history.</p>`;
    });
    showModal({ title: "Search in chat", body: wrap });
    setTimeout(() => input.focus(), 50);
  });
}

/* ---------------- new chat / forward ---------------- */
async function pickContactModal(title, multi = false) {
  const contacts = await core.getContacts();
  return new Promise(resolve => {
    const list = document.createElement("div");
    list.className = "modal-list";
    const selected = new Set();
    for (const c of contacts) {
      const item = document.createElement("dc-chat-item");
      item.setData({
        id: "c" + c.id, name: c.name, kind: "single", avatarColor: c.color,
        verified: c.verified, encrypted: true, lastMsg: c.addr, lastTs: 0,
        unread: 0, pinned: false, muted: false,
      });
      item.addEventListener("click", () => {
        if (!multi) { close(); resolve([c]); return; }
        if (selected.has(c.id)) selected.delete(c.id); else selected.add(c.id);
        item.style.background = selected.has(c.id) ? "var(--bg-active)" : "";
        ok.disabled = !selected.size;
      });
      list.appendChild(item);
    }
    const foot = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn-text"; ok.textContent = multi ? "Create" : "OK";
    ok.disabled = true;
    foot.append(cancel, ok);
    const { close } = showModal({ title, body: list, foot, onClose: () => resolve(null) });
    cancel.addEventListener("click", () => { close(); resolve(null); });
    ok.addEventListener("click", () => { close(); resolve(contacts.filter(c => selected.has(c.id))); });
  });
}

async function newChatFlow() {
  const r = document.getElementById("btn-new-chat").getBoundingClientRect();
  showContextMenu([
    { label: "New chat", onClick: async () => {
      const picked = await pickContactModal("New chat");
      if (picked) {
        const id = await core.createChat(picked[0].name, [picked[0].id], "single");
        await refreshChatList();
        openChat(id);
      }
    } },
    { label: "New group", onClick: async () => {
      const picked = await pickContactModal("Add group members", true);
      if (picked) {
        const name = prompt("Group name:", "New group") || "New group";
        const id = await core.createChat(name, picked.map(c => c.id), "group");
        await refreshChatList();
        openChat(id);
      }
    } },
    { label: "Join chat via invite link", onClick: joinFlow },
    { label: "Add account via invite link", onClick: addAccountFlow },
  ], r.left, r.top - 170);
}

function addAccountFlow() {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:4px">Paste a chatmail invite link (<code>dcaccount:</code>) or scan a QR code in the Delta Chat app to add another profile.</p>
    <input class="text-field" placeholder="dcaccount:https://nine.testrun.org/new" id="invite-input">`;
  const foot = document.createElement("div");
  const cancel = document.createElement("button");
  cancel.className = "btn-text"; cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "btn-text"; ok.textContent = "Add account";
  foot.append(cancel, ok);
  const { close } = showModal({ title: "Add account", body, foot });
  cancel.addEventListener("click", close);
  ok.addEventListener("click", async () => {
    const v = body.querySelector("#invite-input").value.trim();
    if (!v.startsWith("dcaccount:")) { toast("That doesn't look like a dcaccount: link"); return; }
    close();
    await addAccountFromInvite(v);
  });
}

// Configure a profile from a dcaccount: relay invite link (deeplink or manual).
async function addAccountFromInvite(link) {
  if (!core.addAccountWithQr) {
    toast("No background service available — install the Delta Core service app to add relay accounts", 5000);
    return;
  }
  toast("Creating account on relay…", 2500);
  try {
    await core.addAccountWithQr(link);
    state.account = await core.getAccount();
    rebuildDrawer();
    await refreshChatList();
    toast(`Account ready: ${state.account.addr || "chatmail profile"}`, 3500);
  } catch (err) {
    toast("Invite failed: " + err.message, 4500);
  }
}

/* ---------------- deeplinks ----------------
   Supported entry points:
     • web+dcaccount: protocol handler → index.html?qr=dcaccount:…
     • ?dcaccount=dcaccount:…  or  #dcaccount=dcaccount:…
     • #/addrelay/<urlencoded dcaccount link>
   Only acts when a real background core is available; in demo mode it
   tells the user to install the service instead. */
function extractInviteLink(rawUrl = location.href) {
  let url;
  try { url = new URL(rawUrl, location.href); } catch { return null; }
  let link = url.searchParams.get("qr") || url.searchParams.get("dcaccount");
  if (!link && url.hash) {
    const h = url.hash.slice(1);
    if (h.startsWith("dcaccount=")) link = decodeURIComponent(h.slice(10));
    else if (h.startsWith("/addrelay/")) link = decodeURIComponent(h.slice(10));
    else if (h.startsWith("dcaccount:")) link = h;
  }
  if (link && !link.startsWith("dcaccount:") && /^https?:\/\//.test(link)) link = "dcaccount:" + link;
  return link && link.startsWith("dcaccount:") ? link : null;
}

// i.delta.chat securejoin invite (1:1 or group), passed via
// ?invite= / #invite= — note the fragment never leaves the device.
function extractJoinLink(rawUrl = location.href) {
  let url;
  try { url = new URL(rawUrl, location.href); } catch { return null; }
  let link = url.searchParams.get("invite");
  if (!link && url.hash.startsWith("#invite=")) {
    link = decodeURIComponent(url.hash.slice(8));
  }
  return link && /^https:\/\/i\.delta\.chat\//.test(link) ? link : null;
}

async function handleDeeplinkFromUrl(rawUrl, { clearUrl = false } = {}) {
  const joinLink = extractJoinLink(rawUrl);
  const link = extractInviteLink(rawUrl);
  if (!joinLink && !link) return;
  // clean the URL so a reload doesn't re-run the invite
  if (clearUrl) history.replaceState(null, "", location.pathname);
  if (joinLink) await joinFromInvite(joinLink);
  if (link) await addAccountFromInvite(link);
}

async function handleDeeplink() {
  await handleDeeplinkFromUrl(location.href, { clearUrl: true });
}

// Runtime URL changes (e.g. user navigates to an invite link in the webview)
addEventListener("hashchange", () => handleDeeplink());

async function forwardFlow(msgIds) {
  const list = document.createElement("div");
  list.className = "modal-list";
  const targets = state.chats.filter(c => !["deaddrop", "device"].includes(c.kind));
  for (const chat of targets) {
    const item = document.createElement("dc-chat-item");
    item.setData(chat);
    item.addEventListener("click", async () => {
      close();
      await core.forwardMessages(state.activeChatId, msgIds, chat.id);
      chatView.exitSelection();
      toast(`Forwarded to ${chat.name}`);
      refreshChatList();
    });
    list.appendChild(item);
  }
  const { close } = showModal({ title: "Forward to…", body: list });
}

/* ---------------- drawer ---------------- */
let drawer;
function rebuildDrawer() {
  drawer?.el.remove();
  drawer?.overlayEl?.remove();
  drawer = buildDrawer({
    account: state.account,
    backend: core.backend?.label || "unknown backend",
    theme: state.theme,
    onToggleTheme: toggleTheme,
    onAddAccount: addAccountFlow,
    onInvite: () => showInvite(inviteQrProvider(null)),
    onOpenChat: async kind => {
      if (kind === "saved") {
        const chats = await core.getChatList({ query: "" });
        const saved = chats.find(c => c.kind === "saved");
        if (saved) openChat(saved.id);
      }
    },
  });
}

// QR invite provider: real SecureJoin QR rendered by the core
// (chatId=null → self contact invite; group id → verified group invite).
function inviteQrProvider(chatId) {
  return async () => {
    if (!core.getInviteQr) throw new Error("invites need the real core — not available in demo mode");
    const { svg, text } = await core.getInviteQr(chatId);
    return { svg, link: text };
  };
}

// Join a 1:1 or group chat from an i.delta.chat invite link / QR text.
async function joinFromInvite(link) {
  if (!core.secureJoin) {
    toast("Joining chats needs the background core — not available in demo mode", 4500);
    return;
  }
  toast("Joining — verifying contact…", 3000);
  try {
    const chatId = await core.secureJoin(link);
    await refreshChatList();
    openChat(chatId);
    toast("Joined — the verification handshake runs in the background", 4000);
  } catch (err) {
    toast("Join failed: " + err.message, 4500);
  }
}

function joinFlow() {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5;margin-bottom:4px">Paste an invite link (<code>https://i.delta.chat/#…</code>) — works for both 1:1 contacts and group chats.</p>
    <input class="text-field" placeholder="https://i.delta.chat/#DD1F…" id="join-input">`;
  const foot = document.createElement("div");
  const cancel = document.createElement("button");
  cancel.className = "btn-text"; cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "btn-text"; ok.textContent = "Join";
  foot.append(cancel, ok);
  const { close } = showModal({ title: "Join chat via invite link", body, foot });
  cancel.addEventListener("click", close);
  ok.addEventListener("click", () => {
    const v = body.querySelector("#join-input").value.trim();
    if (!/^https:\/\/i\.delta\.chat\//.test(v) && !/^OPENPGP4FPR:/i.test(v)) {
      toast("That doesn't look like an i.delta.chat invite link"); return;
    }
    close();
    joinFromInvite(v);
  });
}

/* ---------------- onboarding (real core only) ---------------- */
// Accepts "example.com", "https://example.com", "example.com/new" or a full
// dcaccount: link and normalizes to dcaccount:https://<host>/new.
function normalizeRelayLink(raw) {
  let s = (raw || "").trim();
  if (!s) return null;
  if (/^dcaccount:/i.test(s)) return s; // full invite link pasted as-is
  s = s.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?$/i.test(s)) return null;
  return `dcaccount:https://${s}/new`;
}

function showOnboarding() {
  const body = document.createElement("div");
  body.innerHTML = `
    <p style="font-size:14.5px;line-height:1.5">Enter a <b>chatmail</b> relay address — an instant end-to-end encrypted profile will be created for you. No email or password needed.</p>
    <input class="text-field" id="ob-relay" placeholder="Relay address — e.g. nine.testrun.org" autocomplete="off" inputmode="url" autocapitalize="none">
    <ul class="ob-steps" id="ob-steps"></ul>`;
  const foot = document.createElement("div");
  const ok = document.createElement("button");
  ok.className = "btn-text"; ok.textContent = "Create account";
  foot.appendChild(ok);
  showModal({ title: "Welcome to Velta", body, foot });

  const input = body.querySelector("#ob-relay");
  const stepsEl = body.querySelector("#ob-steps");

  const addStep = (text) => {
    stepsEl.querySelectorAll("li.active").forEach(li => { li.classList.remove("active"); li.classList.add("done"); });
    const li = document.createElement("li");
    li.className = "active";
    li.innerHTML = `<span class="step-ico"></span><span>${escapeHtml(text)}</span>`;
    stepsEl.appendChild(li);
  };
  const finishSteps = (ok_) => {
    stepsEl.querySelectorAll("li.active").forEach(li => { li.classList.remove("active"); li.classList.add(ok_ ? "done" : "failed"); });
  };

  ok.addEventListener("click", async () => {
    const raw = input.value;
    const link = normalizeRelayLink(raw);
    if (!link) { toast(raw.trim() ? "That doesn't look like a relay address" : "Enter a relay address"); return; }
    const host = link.replace(/^dcaccount:https:\/\//i, "").replace(/\/new.*$/, "");

    ok.disabled = true; ok.classList.add("btn-loading"); ok.textContent = "Creating…";
    input.disabled = true;
    stepsEl.replaceChildren();
    addStep(`Attempting to connect to relay at ${host}`);

    // Friendly phase lines driven by the core's ConfigureProgress (0..1000).
    const phases = [
      [1,   `Relay found at ${host}`],
      [200, "Requesting new account credentials"],
      [450, "Generating encryption keys"],
      [750, "Finalizing account"],
    ];
    let phaseIdx = 0;
    const onProg = (e) => {
      const p = e.detail?.progress || 0;
      while (phaseIdx < phases.length && p >= phases[phaseIdx][0]) {
        addStep(phases[phaseIdx][1]);
        phaseIdx++;
      }
    };
    core.addEventListener("configure-progress", onProg);
    try {
      await core.configureWithQr(link);
      addStep("Account created — welcome!");
      finishSteps(true);
      state.account = await core.getAccount();
      setTimeout(() => {
        closeAllPopups();
        rebuildDrawer();
        refreshChatList();
        toast(`Account created on ${host}`, 3000);
      }, 900);
    } catch (err) {
      finishSteps(false);
      addStep("Setup failed: " + (err.message || err));
      finishSteps(false);
      ok.disabled = false; ok.classList.remove("btn-loading"); ok.textContent = "Retry";
      input.disabled = false;
    } finally {
      core.removeEventListener("configure-progress", onProg);
    }
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    appLog("boot: getAccount");
    state.account = await core.getAccount();
    appLog(`boot: account ${state.account.addr} configured=${state.account.configured}`);

    // Onboarding: real core without configured account → ask for credentials
    if (core.configureWithCredentials && state.account.configured === false) {
      appLog("boot: showing onboarding");
      showOnboarding();
    }

    appLog("boot: init chatView");
    chatView = new ChatView(core, {
      onChatsChanged: refreshChatList,
      onForward: forwardFlow,
    });

    appLog("boot: refreshChatList");
    await refreshChatList();
    appLog("boot: rebuildDrawer");
    rebuildDrawer();

    appLog("boot: bind ui");
    $("btn-menu").addEventListener("click", () => drawer.open());
    $("btn-new-chat").addEventListener("click", newChatFlow);
    bindChatHeadMenu();

    let searchTimer;
    $("search").addEventListener("input", e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = e.target.value; refreshChatList(); }, 160);
    });

    core.addEventListener("incoming-msg", () => refreshChatList());
    core.addEventListener("msgs-changed", () => refreshChatList());
    core.addEventListener("chat-updated", () => refreshChatList());
    // Fallback: refresh the chat list periodically so contact requests and newly
    // arrived chats appear even if core events are delayed or dropped.
    setInterval(() => { refreshChatList(); }, 4000);

    addEventListener("dc-core-disconnected", () => {
      toast("Lost connection to local Delta Chat core — is the service running?", 4500);
    });

    appLog("boot: updateConnStatus");
    updateConnStatus();
    $("conn-status").addEventListener("click", recheckService);
    appLog("boot: handleDeeplink");
    await handleDeeplink();

    // Tauri runtime deep links (OS-level invite links and second-instance args)
    try {
      const tauri = window.__TAURI__;
      if (tauri?.core?.invoke) {
        const initial = await tauri.core.invoke("get_initial_deeplink");
        if (initial) await handleDeeplinkFromUrl(initial);
      }
      if (tauri?.event?.listen) {
        tauri.event.listen("deeplink", ev => { if (ev.payload) handleDeeplinkFromUrl(ev.payload); });
      }
    } catch (err) {
      console.warn("Tauri deep-link setup failed:", err);
    }

    // diagnostic hook: ?openchat=<id> opens a chat directly after boot
    const autoOpen = new URLSearchParams(location.search).get("openchat");
    if (autoOpen && !isNaN(+autoOpen)) openChat(+autoOpen);

    // PWA: service worker + install prompt
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    let deferredPrompt;
    addEventListener("beforeinstallprompt", e => {
      e.preventDefault();
      deferredPrompt = e;
      toast("Velta can be installed — use your browser's install option", 4000);
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { chatView.exitSelection(); closeAllPopups(); }
    });
    appLog("boot: done");
  } catch (err) {
    appLog(`boot FAILED: ${err?.message || err}\n${err?.stack || ""}`);
    toast(`Startup error: ${err?.message || err}`, 8000);
    throw err;
  }
}

boot();
