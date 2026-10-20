// p2p.js — Local chat: serverless 1:1 E2E chat over iroh, engine in the
// Tauri shell (src-tauri/src/p2p.rs). Available only inside the Tauri app —
// the plain-browser PWA has no iroh endpoint to talk to.

import { showModal, footButtons, toast, notifyIncoming } from "./ui.js";
import { escapeHtml } from "./format.js";
import { acquireCode } from "./qr-scan.js";
import { diagnosticsSink } from "./diagnostics.js";
import { createLocalGroup, groupAddMember, groupPickerModel, findDuplicateGroup, lcGroupName, GROUP_MAX_OTHERS, GROUP_NAME_MAX } from "./local-chat.js";

const TICKET_PREFIX = "VELTAP2P1:";

export function p2pAvailable() {
  const t = window.__TAURI__;
  return !!(t && (t.core?.invoke || t.invoke));
}

// Local chat preference, persisted by the WebView. Disabled by default —
// opting in starts the engine; off hides the drawer entry and keeps the
// engine stopped (endpoint released, no beacons, no retries).
export function p2pEnabled() {
  try { return localStorage.getItem("velta-p2p") === "1"; } catch { return false; }
}

export async function setP2pEnabled(enabled) {
  try { localStorage.setItem("velta-p2p", enabled ? "1" : "0"); } catch {}
  if (p2pAvailable()) {
    await tauriInvoke()("p2p_set_enabled", { enabled });
    if (enabled) ensureListener();
  }
  diagnosticsSink.append("info", `Local chat ${enabled ? "enabled" : "disabled"}`);
}

function tauriInvoke() {
  const t = window.__TAURI__;
  return (t.core?.invoke || t.invoke).bind(t.core || t);
}

/* ---------------- event wiring (installed once) ---------------- */

let listening = false;
let pairRequestOpen = false;

// Pairing requests arrive as engine events and must be answerable whether or
// not the hub is open, so the listener is installed at startup. Kept below
// the module state so `listening` is initialized before use. The Rust side
// boots with the engine stopped; opting in is what starts it.
if (p2pAvailable() && p2pEnabled()) {
  tauriInvoke()("p2p_set_enabled", { enabled: true }).catch(() => {});
  ensureListener();
}

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
  if (ev.kind === "error") {
    // Engine-side errors (connect timeouts on background retries) land in the
    // Diagnostics chat, not toasts: several queued connects can fail at once
    // and toasting each one produced toast storms. The diagnostics store
    // collapses identical consecutive entries into a counted row. Errors the
    // user caused reach them through the pairing/chat modals instead.
    const peer = ev.peerId ? ` (${shortId(ev.peerId)})` : "";
    diagnosticsSink.append("warning", `Local chat${peer}: ${ev.message || "error"}`);
  }
  if (ev.kind === "message") notifyIncoming(ev.name || "Local chat", (ev.text || "").slice(0, 120));
  // Group text: "<group> · <sender>" as the title, like a relay group.
  if (ev.kind === "group-message") {
    notifyIncoming(`${lcGroupName(ev.gid)} · ${ev.name || "member"}`, (ev.text || "").slice(0, 120));
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
        <p class="p2p-hint"><b>${escapeHtml(name || "A device")}</b> (${shortId(peerId)}) wants to
        pair with this device for Local chat — direct end-to-end-encrypted messages between
        devices on the same network.</p>
        <p class="p2p-hint" style="opacity:.75">Pair only if you recognize this device.</p>`;
      const { foot, cancel: deny, ok } = footButtons("Pair", { cancelLabel: "Deny", okClass: "btn-text btn-primary" });
      const { close, modal } = showModal({ title: "Pairing request", body, foot, onClose: () => resolve(false) });
      modal.classList.add("pair-request");
      deny.addEventListener("click", () => { resolve(false); close(); });
      ok.addEventListener("click", () => { resolve(true); close(); });
    });
    await tauriInvoke()("p2p_approve_pair", { nodeId: peerId, accept: accepted })
      .catch(err => toast(String(err?.message || err)));
  } finally {
    pairRequestOpen = false;
  }
}

/* ---------------- pairing ---------------- */

export async function pairNearbyFlow(invoke, id) {
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
}

function shortId(nodeId) {
  const s = String(nodeId || "");
  return s.length > 16 ? s.slice(0, 8) + "…" + s.slice(-4) : s;
}

/* ---------------- invite / add contact ---------------- */

export async function showInviteModal(invoke, renderQr) {
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="p2p-hint">On the other device open <b>Local chat → Add contact</b> and scan this
    code (or paste it). Both devices must be on the same Wi-Fi network. Scanning the code is
    what establishes the end-to-end encryption trust.</p>
    <div class="qr-box"><div class="qr-loading">Generating invite…</div></div>
    <div class="invite-link" style="word-break:break-all;font-size:12px;opacity:.7"></div>
    <div style="text-align:center;margin-top:6px"><button type="button" class="btn-text" data-copy>Copy code</button></div>`;
  showModal({ title: "My invite code", body });
  const ticket = await invoke("p2p_create_invite");
  body.querySelector(".invite-link").textContent = ticket;
  const svg = await renderQr(ticket).catch(() => null);
  const box = body.querySelector(".qr-box");
  if (box.isConnected) {
    // The core's QR reserves a clear circle in the middle — brand it with
    // the Velta logo (same overlay as the relay invite QR in ui.js).
    box.innerHTML = (svg || "<div class='qr-loading'>QR unavailable — copy the code instead</div>")
      + `<div class="qr-self qr-self-center"><img src="./icons/v-logo.svg" alt=""></div>`;
  }
  body.querySelector("[data-copy]").addEventListener("click", () => {
    navigator.clipboard?.writeText(ticket).then(() => toast("Invite code copied"));
  });
}

export async function addContact(invoke) {
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
}

function openPairingModal() {
  const body = document.createElement("div");
  body.innerHTML = `
    <div data-step class="p2p-hint">Preparing…</div>
    <progress class="pair-bar" data-bar max="100" aria-label="Pairing"></progress>`;
  const { close } = showModal({ title: "Pairing", body });
  const stepEl = body.querySelector("[data-step]");
  const bar = body.querySelector("[data-bar]");
  const setStep = (text, pct) => {
    if (stepEl) stepEl.textContent = text;
    if (bar && pct != null) bar.value = pct;
  };
  return {
    setStep,
    close,
    fail: err => {
      if (bar) bar.classList.add("is-fail");
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

/* ---------------- create-group modal ---------------- */

// Name + up to 3 paired peers. Offline peers and peers on the old protocol
// are listed but disabled, with the reason. Resolves to the new chat id
// ("p2pg:<gid>") or null when cancelled.
export async function showCreateGroupModal(invoke) {
  const status = await invoke("p2p_status");
  const model = groupPickerModel(status);
  return new Promise(resolve => {
    const picked = new Set();
    const body = document.createElement("div");
    const rows = model.peers.map(p => `
      <label class="p2p-row" style="${p.disabled ? "opacity:.55;cursor:default" : ""}">
        <input type="checkbox" data-pick="${escapeHtml(p.id)}"${p.disabled ? " disabled" : ""}>
        <span class="p2p-row-name">${escapeHtml(p.name)}</span>
        ${p.disabled ? `<span class="p2p-row-queued">${escapeHtml(p.reason)}</span>` : ""}
      </label>`).join("");
    body.innerHTML = `
      <input class="text-field" data-gname maxlength="${GROUP_NAME_MAX}" placeholder="Group name" autocomplete="off">
      <p class="p2p-hint" style="margin-top:10px">Pick up to ${GROUP_MAX_OTHERS} paired devices —
        <b data-count>0/${GROUP_MAX_OTHERS}</b>. Everyone must be online to be added now;
        you can't add people later in this version.</p>
      ${model.peers.length ? `<div class="p2p-rows">${rows}</div>`
        : `<div class="p2p-empty">No paired devices yet. Pair with another Velta device first.</div>`}
      ${model.atLimit ? `<p class="p2p-hint" style="color:var(--danger)">You already have ${model.active} active groups (the maximum). Leave one first.</p>` : ""}
      <p class="p2p-hint" data-warn style="opacity:.8" hidden></p>`;
    const { foot, cancel, ok } = footButtons("Create");
    let busy = false;
    const nameEl = body.querySelector("[data-gname]");
    const countEl = body.querySelector("[data-count]");
    const warnEl = body.querySelector("[data-warn]");
    const sync = () => {
      const full = picked.size >= GROUP_MAX_OTHERS;
      for (const cb of body.querySelectorAll("[data-pick]")) {
        const p = model.peers.find(x => x.id === cb.dataset.pick);
        cb.disabled = !!p?.disabled || (full && !picked.has(cb.dataset.pick));
      }
      countEl.textContent = `${picked.size}/${GROUP_MAX_OTHERS}`;
      const dup = picked.size ? findDuplicateGroup(status, [...picked]) : null;
      warnEl.hidden = !dup;
      if (dup) warnEl.textContent = `You already have a group "${dup.name}" with exactly these people. You can still create another.`;
      ok.disabled = busy || model.atLimit || !picked.size || !nameEl.value.trim();
    };
    for (const cb of body.querySelectorAll("[data-pick]")) {
      cb.addEventListener("change", () => {
        if (cb.checked) picked.add(cb.dataset.pick); else picked.delete(cb.dataset.pick);
        sync();
      });
    }
    nameEl.addEventListener("input", sync);
    let done = false;
    const { close } = showModal({
      title: "New local group", body, foot,
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    cancel.addEventListener("click", () => close());
    ok.addEventListener("click", async () => {
      if (ok.disabled) return;
      busy = true; sync();
      try {
        const id = await createLocalGroup(nameEl.value.trim(), [...picked]);
        done = true; close(); resolve(id);
      } catch (err) {
        busy = false; sync();
        toast("Couldn't create the group: " + String(err?.message || err));
      }
    });
    sync();
    setTimeout(() => nameEl.focus(), 0);
  });
}

// Add paired devices to a group the user created: same rules as the create
// modal (online, protocol 2), limited to the free slots of the 5-member cap.
// Resolves to the number of members added, or null when cancelled.
export async function showAddMembersModal(invoke, gid) {
  const status = await invoke("p2p_status");
  const group = (status.groups || []).find(g => g.gid === gid);
  if (!group) throw new Error("This group no longer exists");
  const inGroup = new Set((group.members || []).map(m => m.id));
  const slots = Math.max(0, GROUP_MAX_OTHERS + 1 - inGroup.size);
  const model = groupPickerModel(status);
  const peers = model.peers.filter(p => !inGroup.has(p.id));
  return new Promise(resolve => {
    const picked = new Set();
    const body = document.createElement("div");
    const rows = peers.map(p => `
      <label class="p2p-row" style="${p.disabled ? "opacity:.55;cursor:default" : ""}">
        <input type="checkbox" data-pick="${escapeHtml(p.id)}"${p.disabled ? " disabled" : ""}>
        <span class="p2p-row-name">${escapeHtml(p.name)}</span>
        ${p.disabled ? `<span class="p2p-row-queued">${escapeHtml(p.reason)}</span>` : ""}
      </label>`).join("");
    body.innerHTML = `
      <p class="p2p-hint">A local group holds up to ${GROUP_MAX_OTHERS + 1} devices, you included.
        ${slots ? `You can add <b data-count>0/${slots}</b> more.` : "It is full."}
        New members see messages sent from now on.</p>
      ${peers.length ? `<div class="p2p-rows">${rows}</div>`
        : `<div class="p2p-empty">No other paired devices. Pair with a device first (Local chat → Add contact).</div>`}`;
    const { foot, cancel, ok } = footButtons("Add");
    const countEl = body.querySelector("[data-count]");
    let busy = false, done = false;
    const sync = () => {
      const full = picked.size >= slots;
      for (const cb of body.querySelectorAll("[data-pick]")) {
        const p = peers.find(x => x.id === cb.dataset.pick);
        cb.disabled = !!p?.disabled || (full && !picked.has(cb.dataset.pick));
      }
      if (countEl) countEl.textContent = `${picked.size}/${slots}`;
      ok.disabled = busy || !picked.size;
    };
    for (const cb of body.querySelectorAll("[data-pick]")) {
      cb.addEventListener("change", () => {
        if (cb.checked) picked.add(cb.dataset.pick); else picked.delete(cb.dataset.pick);
        sync();
      });
    }
    const { close } = showModal({
      title: "Add to group", body, foot,
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    cancel.addEventListener("click", () => close());
    ok.addEventListener("click", async () => {
      if (ok.disabled) return;
      busy = true; sync();
      let added = 0;
      try {
        for (const id of picked) { await groupAddMember(gid, id); added++; }
      } catch (err) {
        toast("Couldn't add: " + String(err?.message || err));
      }
      done = true; close(); resolve(added);
    });
    sync();
  });
}
