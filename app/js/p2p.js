// p2p.js — Local chat: serverless 1:1 E2E chat over iroh, engine in the
// Tauri shell (src-tauri/src/p2p.rs). Available only inside the Tauri app —
// the plain-browser PWA has no iroh endpoint to talk to.

import { showModal, toast, notifyIncoming } from "./ui.js";
import { acquireCode } from "./qr-scan.js";

const TICKET_PREFIX = "VELTAP2P1:";

export function p2pAvailable() {
  const t = window.__TAURI__;
  return !!(t && (t.core?.invoke || t.invoke));
}

function tauriInvoke() {
  const t = window.__TAURI__;
  return (t.core?.invoke || t.invoke).bind(t.core || t);
}

// Pairing requests arrive as engine events and must be answerable whether or
// not the hub is open, so the listener is installed at startup.
if (p2pAvailable()) ensureListener();

/* ---------------- event wiring (installed once) ---------------- */

let listening = false;
let activeChat = null; // { peerId, listEl }
let hub = null;        // { body, refresh }
let pairRequestOpen = false;

function ensureListener() {
  if (listening) return;
  listening = true;
  const t = window.__TAURI__;
  const ev = t.event || t;
  const listen = ev.listen ? ev.listen.bind(ev) : t.listen.bind(t);
  try {
    listen("p2p-event", e => handleEvent(e.payload).catch(() => {}));
  } catch (err) {
    console.warn("[p2p] event listener failed:", err);
  }
}

async function handleEvent(ev) {
  if (!ev?.kind) return;
  if (ev.kind === "pair-request") showPairRequest(ev.peerId, ev.name).catch(() => {});
  if (ev.kind === "pairing") toast(`Paired with ${ev.name || "a device"}`);
  if (ev.kind === "error") toast(ev.message || "Local chat error");
  if (ev.kind === "message") notifyIncoming(ev.name || "Local chat", (ev.text || "").slice(0, 120));
  if (hub && ["pairing", "presence", "nearby"].includes(ev.kind)) hub.refresh().catch(() => {});
  if (activeChat && ev.peerId === activeChat.peerId &&
      ["message", "ack", "presence"].includes(ev.kind)) {
    renderActiveChat().catch(() => {});
  }
}

// Inbound Nearby pairing request — the engine holds the connection until the
// user decides (or it times out server-side after 120 s).
async function showPairRequest(peerId, name) {
  if (pairRequestOpen) return; // one prompt at a time; further requests wait
  pairRequestOpen = true;
  try {
    const accepted = await new Promise(resolve => {
      const body = document.createElement("div");
      body.innerHTML = `
        <p class="p2p-hint"><b>${escapeHtml_(name || "A device")}</b> (${shortId(peerId)}) wants to
        pair with this device for Local chat — direct end-to-end-encrypted messages between
        devices on the same network.</p>
        <p class="p2p-hint" style="opacity:.75">Pair only if you recognize this device.</p>`;
      const foot = document.createElement("div");
      const deny = document.createElement("button");
      deny.className = "btn-text"; deny.textContent = "Deny";
      const ok = document.createElement("button");
      ok.className = "btn-text btn-primary"; ok.textContent = "Pair";
      foot.append(deny, ok);
      const { close } = showModal({ title: "Pairing request", body, foot, onClose: () => resolve(false) });
      deny.addEventListener("click", () => { resolve(false); close(); });
      ok.addEventListener("click", () => { resolve(true); close(); });
    });
    await tauriInvoke()("p2p_approve_pair", { nodeId: peerId, accept: accepted })
      .catch(err => toast(String(err?.message || err)));
  } finally {
    pairRequestOpen = false;
  }
}

/* ---------------- styles ---------------- */

function injectStyles() {
  if (document.getElementById("p2p-styles")) return;
  const s = document.createElement("style");
  s.id = "p2p-styles";
  s.textContent = `
    .p2p-hint { font-size: 14.5px; line-height: 1.5; }
    .p2p-rows { display: flex; flex-direction: column; gap: 2px; margin-top: 10px; }
    .p2p-row { display: flex; align-items: center; gap: 10px; padding: 10px 8px;
               border-radius: 10px; cursor: pointer; }
    .p2p-row:hover { background: rgba(127,127,127,.14); }
    .p2p-row-name { flex: 1; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .p2p-row-queued { font-size: 12px; opacity: .7; }
    .p2p-dot { width: 10px; height: 10px; border-radius: 50%; background: #7a7a85; flex: none; }
    .p2p-dot.on { background: #2ecc71; }
    .p2p-msgs { display: flex; flex-direction: column; gap: 6px; height: 46vh;
                overflow-y: auto; padding: 4px 2px; }
    .p2p-msg { display: flex; }
    .p2p-msg.out { justify-content: flex-end; }
    .p2p-bubble { max-width: 78%; padding: 8px 12px; border-radius: 14px;
                  background: rgba(127,127,127,.22); font-size: 14.5px; word-break: break-word; }
    .p2p-msg.out .p2p-bubble { background: rgba(76,141,255,.85); color: #fff; }
    .p2p-msg-meta { font-size: 10.5px; opacity: .65; margin-top: 2px; text-align: right; }
    .p2p-input-row { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
    .p2p-input-row input { flex: 1; }
    .p2p-empty { text-align: center; opacity: .6; padding: 22px 8px; font-size: 14px; line-height: 1.5; }`;
  document.head.appendChild(s);
}

/* ---------------- entry point (drawer) ---------------- */

export async function openP2p({ renderQr }) {
  if (!p2pAvailable()) {
    toast("Local chat needs the Velta app shell");
    return;
  }
  injectStyles();
  ensureListener();
  const invoke = tauriInvoke();

  let status = await invoke("p2p_status").catch(err => {
    toast(String(err?.message || err));
    return null;
  });
  if (!status) return;

  if (!status.name) {
    const name = await promptName();
    if (!name) return;
    await invoke("p2p_set_name", { name }).catch(err => toast(String(err?.message || err)));
    status = await invoke("p2p_status");
  }
  renderHub(invoke, renderQr, status);
}

function promptName() {
  return new Promise(resolve => {
    const body = document.createElement("div");
    body.innerHTML = `
      <p class="p2p-hint">Pick the name other devices will see for this device in Local chat.
      Local chat is end-to-end encrypted and works directly between devices on the same
      Wi-Fi network — no accounts, no servers.</p>
      <input class="text-field" maxlength="64" placeholder="Device name">`;
    const input = body.querySelector("input");
    const foot = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.className = "btn-text"; cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn-text"; ok.textContent = "Continue";
    foot.append(cancel, ok);
    const { close } = showModal({ title: "Welcome to Local chat", body, foot });
    const finish = value => { close(); resolve(value); };
    ok.addEventListener("click", () => { const v = input.value.trim(); if (v) finish(v); });
    cancel.addEventListener("click", () => finish(null));
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { const v = input.value.trim(); if (v) finish(v); }
    });
    setTimeout(() => input.focus(), 60);
  });
}

/* ---------------- hub: device list ---------------- */

function renderHub(invoke, renderQr, status) {
  const body = document.createElement("div");
  const { close, modal } = showModal({ title: "Local chat (beta)", body });
  if (hub?.refresh) hub.close?.();
  hub = {
    body,
    close,
    refresh: async () => {
      const st = await invoke("p2p_status");
      renderHubInto(body, invoke, renderQr, st, {
        openChat: id => openChatModal(invoke, id),
        pairNearby: id => pairNearbyFlow(invoke, id),
      });
    },
  };
  renderHubInto(body, invoke, renderQr, status, { openChat: id => openChatModal(invoke, id) });
  // Nearby list changes as devices come and go — poll lightly while open.
  const poll = setInterval(() => {
    if (!hub || hub.close !== close) { clearInterval(poll); return; }
    hub.refresh().catch(() => {});
  }, 4000);
  // If the hub modal was closed by the user, drop the refresh hook.
  const observer = new MutationObserver(() => {
    if (!modal.isConnected) { if (hub?.close === close) hub = null; observer.disconnect(); }
  });
  observer.observe(document.getElementById("popups") || document.body, { childList: true, subtree: false });
}

function renderHubInto(body, invoke, renderQr, status, actions) {
  const peers = status.peers || [];
  const nearby = status.nearby || [];
  const rows = peers.length
    ? `<div class="p2p-rows">${peers.map(p => `
        <div class="p2p-row" data-peer="${escapeHtml_(p.id)}">
          <span class="p2p-dot ${p.online ? "on" : ""}"></span>
          <span class="p2p-row-name">${escapeHtml_(p.name || p.id.slice(0, 12))}</span>
          ${p.queued ? `<span class="p2p-row-queued">${p.queued} queued</span>` : ""}
          ${!p.online ? `<button class="btn-text" data-retry="${escapeHtml_(p.id)}">Retry</button>` : ""}
        </div>`).join("")}
      </div>`
    : `<div class="p2p-empty">No contacts yet.<br>Pair with another Velta device on the same Wi-Fi network — exchange invite codes once, then chat directly, encrypted, with no servers in between.</div>`;
  const nearbyRows = nearby.length
    ? `<div class="p2p-rows">${nearby.map(n => `
        <div class="p2p-row" data-nearby="${escapeHtml_(n.id)}">
          <span class="p2p-dot on"></span>
          <span class="p2p-row-name">${escapeHtml_(n.name || n.id.slice(0, 12))}</span>
          <button class="btn-text" data-nearby-pair="${escapeHtml_(n.id)}">Pair</button>
        </div>`).join("")}</div>`
    : "";
  body.innerHTML = `
    <p class="p2p-hint">This device: <b>${escapeHtml_(status.name || "device")}</b>
      <span style="opacity:.55;font-size:12px">(${escapeHtml_(shortId(status.nodeId))})</span></p>
    <div style="display:flex;gap:10px;margin-top:8px">
      <button class="btn-text" data-invite>Show invite</button>
      <button class="btn-text" data-add>Add contact</button>
    </div>
    ${nearbyRows ? `<div class="p2p-hint" style="margin-top:10px;opacity:.75">Nearby — discovered on this network:</div>${nearbyRows}` : rows}`;
  body.querySelector("[data-invite]").addEventListener("click", () => showInviteModal(invoke, renderQr).catch(err => toast(String(err?.message || err))));
  body.querySelector("[data-add]").addEventListener("click", () => addContact(invoke).catch(err => toast(String(err?.message || err))));
  body.querySelectorAll(".p2p-row").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest("[data-retry]")) return;
      const id = row.dataset.peer;
      const peer = peers.find(p => p.id === id);
      actions.openChat(id, peer?.name);
    });
  });
  body.querySelectorAll("[data-retry]").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      await invoke("p2p_retry", { peerId: btn.dataset.retry }).catch(() => {});
      toast("Connecting…");
    });
  });
  body.querySelectorAll("[data-nearby-pair]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      actions.pairNearby(btn.dataset.nearbyPair);
    });
  });
  body.querySelectorAll(".p2p-row[data-nearby]").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest("[data-nearby-pair]")) return;
      actions.pairNearby(row.dataset.nearby);
    });
  });
}

async function pairNearbyFlow(invoke, id) {
  const { setStep, fail, close } = openPairingModal();
  setStep(`Requesting ${shortId(id)}… — the other device must approve`, 40);
  let peer;
  try {
    peer = await invoke("p2p_pair_nearby", { nodeId: id });
  } catch (err) {
    fail(String(err?.message || err));
    return;
  }
  close();
  toast(peer?.name ? `Paired with ${peer.name}` : "Paired");
  hub?.refresh?.().catch(() => {});
  openChatModal(invoke, id, peer?.name);
}

function escapeHtml_(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function shortId(nodeId) {
  const s = String(nodeId || "");
  return s.length > 16 ? s.slice(0, 8) + "…" + s.slice(-4) : s;
}

/* ---------------- invite / add contact ---------------- */

async function showInviteModal(invoke, renderQr) {
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="p2p-hint">On the other device open <b>Local chat → Add contact</b> and scan this
    code (or paste it). Both devices must be on the same Wi-Fi network. Scanning the code is
    what establishes the end-to-end encryption trust.</p>
    <div class="qr-box"><div class="qr-loading">Generating invite…</div></div>
    <div class="invite-link" style="word-break:break-all;font-size:12px;opacity:.7"></div>
    <div style="text-align:center;margin-top:6px"><button class="btn-text" data-copy>Copy code</button></div>`;
  showModal({ title: "My invite code", body });
  const ticket = await invoke("p2p_create_invite");
  body.querySelector(".invite-link").textContent = ticket;
  const svg = await renderQr(ticket).catch(() => null);
  const box = body.querySelector(".qr-box");
  if (box.isConnected) {
    box.innerHTML = svg || "<div class='qr-loading'>QR unavailable — copy the code instead</div>";
  }
  body.querySelector("[data-copy]").addEventListener("click", () => {
    navigator.clipboard?.writeText(ticket).then(() => toast("Invite code copied"));
  });
}

async function addContact(invoke) {
  const code = await acquireCode({
    title: "Add contact",
    hint: "Paste the invite code shown on the other device (Local chat → Show invite → Copy code).",
    validate: c => (c.startsWith(TICKET_PREFIX) ? null : "That doesn't look like a Velta local-chat invite code"),
  });
  if (!code) return;

  // Explicit pairing state machine — no silent failures: connect (up to 15 s)
  // → handshake → paired. Every failure lands on an explained error screen.
  const { setStep, fail, close } = openPairingModal();
  setStep("Connecting to the other device… (up to 15 s)", 30);
  let pct = 30;
  const creep = setInterval(() => {
    pct = Math.min(85, pct + 5);
    setStep("Connecting to the other device…", pct);
  }, 1000);
  let peer;
  try {
    peer = await invoke("p2p_accept_invite", { ticket: code });
  } catch (err) {
    clearInterval(creep);
    fail(String(err?.message || err));
    return;
  }
  clearInterval(creep);
  close();
  toast(peer?.name ? `Paired with ${peer.name}` : "Paired");
  hub?.refresh?.().catch(() => {});
  if (peer?.id) openChatModal(invoke, peer.id, peer.name);
}

function openPairingModal() {
  const body = document.createElement("div");
  body.innerHTML = `
    <div data-step class="p2p-hint">Preparing…</div>
    <div data-progress style="margin-top:10px;height:4px;border-radius:2px;background:rgba(127,127,127,.25);overflow:hidden">
      <div data-bar style="height:100%;width:30%;background:rgba(76,141,255,.9);border-radius:2px;transition:width .4s"></div>
    </div>`;
  const { close } = showModal({ title: "Pairing", body });
  const stepEl = body.querySelector("[data-step]");
  const bar = body.querySelector("[data-bar]");
  const setStep = (text, pct) => {
    if (stepEl) stepEl.textContent = text;
    if (bar && pct != null) bar.style.width = pct + "%";
  };
  return {
    setStep,
    close,
    fail: err => {
      if (bar) bar.style.background = "rgba(255,107,107,.9)";
      setStep(`✗ Pairing failed — ${err}`);
      const hints = document.createElement("div");
      hints.className = "p2p-hint";
      hints.style.marginTop = "10px";
      hints.style.opacity = ".8";
      hints.textContent =
        "Check: both devices on the same Wi-Fi network · the other device has Velta open on its invite screen · Windows Firewall allows Velta · the invite is recent (each \"Show invite\" invalidates the previous one).";
      body.appendChild(hints);
    },
  };
}

/* ---------------- chat modal ---------------- */

function openChatModal(invoke, peerId, name) {
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="p2p-msgs"><div class="p2p-empty">Loading…</div></div>
    <div class="p2p-input-row">
      <input class="text-field" placeholder="Message…" autocomplete="off">
      <button class="btn-text" data-send>Send</button>
    </div>`;
  const input = body.querySelector("input");
  const { close, modal } = showModal({
    title: `${name || shortId(peerId)} · local chat`,
    body,
    onClose: () => { if (activeChat?.peerId === peerId) activeChat = null; },
  });
  // Give the chat room more room than a default modal.
  modal.style.width = "min(640px, 96vw)";
  activeChat = { peerId, listEl: body.querySelector(".p2p-msgs") };

  const doSend = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
      await invoke("p2p_send", { peerId, text });
      renderActiveChat().catch(() => {});
    } catch (err) {
      toast(String(err?.message || err));
    }
  };
  body.querySelector("[data-send]").addEventListener("click", doSend);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); doSend(); }
  });
  renderActiveChat().catch(() => {});
}

async function renderActiveChat() {
  const chat = activeChat;
  if (!chat?.listEl || !chat.listEl.isConnected) return;
  const invoke = tauriInvoke();
  const [msgs, status] = await Promise.all([
    invoke("p2p_messages", { peerId: chat.peerId, limit: 200 }).catch(() => []),
    invoke("p2p_status").catch(() => null),
  ]);
  if (!chat.listEl.isConnected || activeChat !== chat) return;
  const peer = (status?.peers || []).find(p => p.id === chat.peerId);

  const list = chat.listEl;
  list.replaceChildren();
  if (!msgs.length) {
    list.innerHTML = `<div class="p2p-empty">No messages yet.<br>Messages to an offline device are delivered automatically when it comes back.</div>`;
  }
  for (const m of msgs) {
    const row = document.createElement("div");
    row.className = "p2p-msg " + (m.dir === "out" ? "out" : "in");
    const bubble = document.createElement("div");
    bubble.className = "p2p-bubble";
    bubble.textContent = m.text;
    const meta = document.createElement("div");
    meta.className = "p2p-msg-meta";
    const time = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    meta.textContent = m.dir === "out" ? `${time} · ${m.state}` : time;
    bubble.appendChild(meta);
    row.appendChild(bubble);
    list.appendChild(row);
  }
  if (peer && !peer.online && msgs.length) {
    const note = document.createElement("div");
    note.className = "p2p-empty";
    note.style.padding = "6px";
    note.textContent = peer.queued
      ? `${peer.name || "Peer"} is offline — ${peer.queued} message(s) waiting to be delivered`
      : `${peer.name || "Peer"} is offline`;
    list.appendChild(note);
  }
  list.scrollTop = list.scrollHeight;
}
