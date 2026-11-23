// iroh-xfer-ui.js — UI glue for the automatic iroh file transfer (#470):
// routes composer file sends over the transport, renders file cards in
// bubbles (markdown hook), auto-fetches received files, handles the "ask
// for the email copy" fallback and the sender's resend request, and runs
// the sweep that mails expired offers. Pure logic lives in iroh-xfer.js;
// this module holds the DOM + shell glue.
//
// State that must survive a restart lives in localStorage per account:
//   velta-xfer-pending:<acct>  the sender's open offers (iroh-xfer.js)
//   velta-xfer-cards:<acct>    per-card receive state, so a reload neither
//                              fetches nor asks for the email copy twice.
import {
  createTransport, parseFileCard, parseResendRequest, resendRequestText, advertisedRelay, jsonStore,
  irohXferEnabled, THRESHOLD, routeLabel, CAPABILITY_KEY, peerCapabilityKey,
} from "./iroh-xfer.js";
import { fileUrl } from "./media.js";
import { diagnosticsSink } from "./diagnostics.js";
import { t } from "./i18n.js";
import { escapeHtml } from "./format.js";

let env = null;  // { core, invoke } — invoke null in the PWA
let transport = null;
let metadataFn = null;       // async () => get_server_metadata | null
let hooks = null;            // { sendText, sendFile, lastSent }
let metaCache = { at: 0, value: null };
let lastSent = null;         // the card message transport.send just mailed
let account = "0";
let selfChat = null;         // Saved Messages chat id (cached per account)
let sweepTimer = null;
const cardState = new Map(); // ticket hash -> { outgoing?, mine?, chatId, path?, asked?, done?, error? }
const CARDS_MAX = 300;
const SWEEP_MS = 5 * 60 * 1000;

const META_TTL = 5 * 60 * 1000;
async function relayMeta() {
  if (metaCache.value && Date.now() - metaCache.at < META_TTL) return metaCache.value;
  metaCache = { at: Date.now(), value: await (metadataFn?.() ?? Promise.resolve(null)).catch(() => null) };
  return metaCache.value;
}

// --- persisted card state -------------------------------------------------
const cardsStore = () => jsonStore(`velta-xfer-cards:${account}`);
function loadCards() {
  cardState.clear();
  for (const [h, st] of Object.entries(cardsStore().load())) if (st && typeof st === "object") cardState.set(h, st);
}
function saveCards() {
  const keep = {};
  for (const [h, st] of [...cardState].slice(-CARDS_MAX)) {
    if (st.done || st.asked || st.error) keep[h] = { chatId: st.chatId, path: st.path, asked: st.asked, done: st.done, error: st.error, outgoing: st.outgoing || undefined };
  }
  cardsStore().save(keep);
}

/** True when the contact has proved it runs Velta with the transfer: core
 *  patch #31 stored the time of its last encrypted, signed message carrying
 *  Chat-Velta-Xfer. Unknown contacts (and Delta Chat) get email. */
export async function peerCanXfer(contactId) {
  if (contactId == null || !env?.core?.getConfig) return false;
  try { return !!(await env.core.getConfig(peerCapabilityKey(contactId))); } catch { return false; }
}

/** This device announces the capability (core adds the header) while the
 *  Tauri shell can serve and the setting is on; the PWA never does. */
async function announce() {
  if (!env?.invoke || !env.core?.setConfig) return;
  try { await env.core.setConfig(CAPABILITY_KEY, irohXferEnabled() ? "1" : "0"); } catch {}
}

async function selfChatId() {
  if (selfChat != null) return selfChat;
  try { selfChat = await env?.core?.createChatByContactId?.(1); } catch {}
  return selfChat ?? null;
}

/**
 * Try to deliver one composer attachment over iroh. Returns {handled:false}
 * when the policy says email (caller sends the attachment normally);
 * handled when the transport fully delivered it — the iroh offer + mailed
 * file card, or the immediate email fallback after a failed offer.
 */
export async function maybeSend({ chatId, path, name, size, oneToOne, contactId }) {
  if (!transport || !env?.invoke || !oneToOne || !(Number(size) > THRESHOLD)) return { handled: false };
  const can = await peerCanXfer(contactId);
  if (!can) return { handled: false };
  const r = await transport.send({ chatId, file: { path, name, size }, oneToOne, peerIsVelta: true });
  if (r.via === "offer-failed") sink("error", `offer failed — mailed instead: ${r.error}`);
  else if (r.route === "iroh") { cardState.set(r.hash, { outgoing: true, mine: true, chatId }); sink("info", `offered ${name} (${fmtSize(size)}) for direct fetch`); }
  return { handled: true, msg: hooks?.lastSent?.() || null };
}

const safeFileUrl = (p) => { try { return fileUrl(p); } catch { return "#"; } };
const ERRORS = {
  "too-big": () => t("Too big to send by email. Send it again when you are both online."),
  "no-space": () => t("Not enough free space to receive this file."),
  "too-large": () => t("This file is too large to receive."),
  missing: () => t("The file is no longer available."),
};
function stateText(st) {
  if (st.error && ERRORS[st.error]) return ERRORS[st.error]();
  if (st.asked && !st.done) return t("Asked for the email copy");
  if (st.outgoing) return st.mailed ? t("Sent by email") : routeLabel("iroh");
  return st.done ? t("Received") : st.asked ? t("Asked for the email copy") : t("Receiving file…");
}
/** The "ask" button shows on incoming cards not yet received or asked, and
 *  on outgoing cards on a device that has no copy (the sender's other
 *  device, or the PWA). */
function canAsk(st) {
  return !st.path && !st.asked && !st.done && (!st.outgoing || !st.mine);
}

/**
 * Render hook for the message bubble: a VXFER1 file card becomes a compact
 * file bubble; the fallback request line becomes a quiet label. Null = not
 * ours, render as usual.
 */
export function xferCardHtml(text) {
  const card = parseFileCard(text);
  if (card) {
    const st = cardState.get(card.tk.hash) || {};
    const actions = st.path
      ? `<a class="xfer-open" href="${escapeAttr(safeFileUrl(st.path))}" target="_blank" rel="noopener">${escapeHtml(t("Open"))}</a>`
      : canAsk(st) && cardState.has(card.tk.hash)
        ? `<button type="button" class="xfer-ask btn-text" data-xfer-ask="${escapeAttr(card.tk.hash)}">${escapeHtml(t("Ask for the email copy"))}</button>`
        : "";
    return `<span class="xfer-card" data-xfer="${escapeAttr(card.tk.hash)}"><span class="xfer-glyph">${escapeHtml((card.name.split(".").pop()?.[0] || "f").toUpperCase())}</span>` +
      `<span class="xfer-name">${escapeHtml(card.name)}<span class="xfer-meta">${escapeHtml(fmtSize(card.size))}</span></span>` +
      `<span class="xfer-state" role="status">${escapeHtml(stateText(st))}</span>${actions}</span>`;
  }
  if (parseResendRequest(text)) return `<span class="xfer-state">${escapeHtml(t("Asked for the email copy"))}</span>`;
  return null;
}

const escapeAttr = escapeHtml;
function fmtSize(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
function sink(level, msg) {
  try { diagnosticsSink.append(level, `iroh xfer: ${msg}`); } catch {}
}

async function askEmailCopy(hash, st) {
  // An outgoing card on a device without the offer: the sender's device
  // with the copy listens in Saved Messages too.
  const to = st.outgoing ? await selfChatId() : st.chatId;
  if (to == null) return;
  st.asked = true;
  saveCards();
  refresh(hash);
  try { await hooks.sendText(to, resendRequestText(hash)); } catch (e) { st.asked = false; saveCards(); refresh(hash); sink("error", `could not ask for the email copy: ${e?.message || e}`); }
}

/** Bubble-render (and core event) side effect: first sight of an incoming
 *  card kicks its fetch (or, in the PWA, the email-copy request); first
 *  sight of a fallback request triggers the sender's email-out. */
export function noteCard(chatId, text, outgoing) {
  if (!transport) return;
  const card = parseFileCard(text);
  if (card) {
    const hash = card.tk.hash;
    const known = cardState.get(hash);
    if (known) { if (known.chatId == null) known.chatId = chatId; return; }
    if (outgoing) { cardState.set(hash, { outgoing: true, mine: transport.pending.has(hash), chatId }); return; }
    const st = { outgoing: false, chatId };
    cardState.set(hash, st);
    const expired = Number(card.tk.exp) * 1000 <= Date.now();
    if (!env.invoke && expired) return; // PWA, old card: the sender mails expired offers by itself; button stays
    sink("info", env.invoke ? `fetching ${card.name} (${fmtSize(card.size)}) directly from the sender` : `asking for the email copy of ${card.name} (no iroh here)`);
    if (env.invoke && card.size > 0) st.receiving = true;
    transport.receive({ chatId, text }).then((r) => {
      const cur = cardState.get(hash);
      if (!cur) return;
      cur.receiving = false;
      if (r?.path) { cur.path = r.path; cur.done = true; sink("info", `received ${card.name} over iroh`); }
      else if (r?.asked) { cur.asked = true; sink(r.code === "no-iroh" ? "info" : "error", `asked for the email copy (${r.error || r.code || "unknown"})`); }
      else if (r?.code === "no-space" || r?.code === "too-large") { cur.error = r.code; sink("error", `fetch refused: ${r.error}`); }
      else if (r?.error) sink("info", `fetch interrupted — will resume over iroh (${r.error})`);
      saveCards();
      refresh(hash);
    }).catch((e) => { sink("error", `fetch crashed: ${e?.message || e}`); });
    return;
  }
  if (parseResendRequest(text)) handleResend(chatId, text, outgoing);
}

const resendSeen = new Set();
async function handleResend(chatId, text, outgoing) {
  const self = await selfChatId();
  // A peer's request arrives incoming; the sender's own other device asks
  // from Saved Messages, where its message is outgoing.
  if (outgoing && chatId !== self) return;
  const key = `${chatId}:${parseResendRequest(text)}`;
  if (resendSeen.has(key)) return;
  resendSeen.add(key);
  try {
    const r = await transport.onResendRequest({ text, chatId, selfChatId: self });
    if (!r) return;
    const hash = parseResendRequest(text);
    const st = cardState.get(hash) || { outgoing: true, mine: true, chatId };
    if (r.error) { st.error = r.error; sink("error", `could not mail ${r.name}: ${r.error}`); }
    else { if (r.chatId !== self) st.mailed = true; sink("info", `fetch failed on the other end — mailed ${r.name}`); }
    cardState.set(hash, st);
    saveCards();
    refresh(hash);
  } catch (e) { resendSeen.delete(key); sink("error", `resend failed: ${e?.message || e}`); }
}

async function runSweep() {
  if (!transport) return;
  let evs = [];
  try { evs = await transport.sweep(); } catch (e) { sink("error", `sweep failed: ${e?.message || e}`); }
  for (const ev of evs) {
    const st = cardState.get(ev.hash) || { outgoing: true, mine: true, chatId: ev.chatId };
    if (ev.action === "mailed") { st.mailed = true; sink("info", `offer for ${ev.name} expired unfetched — mailed it`); }
    else if (ev.action === "too-big" || ev.action === "missing") { st.error = ev.action; sink("error", `offer for ${ev.name} expired unfetched and could not be mailed (${ev.action})`); }
    else sink("info", `withdrew the delivered offer for ${ev.name}`);
    cardState.set(ev.hash, st);
    refresh(ev.hash);
  }
  if (evs.length) saveCards();
}

function refresh(hash) {
  if (typeof document === "undefined") return; // node tests: state assertions only
  const st = cardState.get(hash) || {};
  for (const card of document.querySelectorAll(`[data-xfer="${hash}"]`)) {
    const el = card.querySelector(".xfer-state");
    if (el) el.textContent = stateText(st);
    const ask = card.querySelector(".xfer-ask");
    if (ask && !canAsk(st)) ask.remove();
    if (st.path && !card.querySelector(".xfer-open")) {
      const a = document.createElement("a");
      a.className = "xfer-open";
      a.href = safeFileUrl(st.path);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = t("Open");
      card.appendChild(a);
    }
  }
}

/** Switches the per-account state (pending offers, card states, caches). */
function useAccount(id) {
  account = String(id ?? "0");
  selfChat = null;
  metaCache = { at: 0, value: null };
  resendSeen.clear();
  loadCards();
  transport?.setStore?.(jsonStore(`velta-xfer-pending:${account}`));
}

/** Wire once from boot: shell handles + the composer's send hooks. In the
 *  PWA (no invoke) the transport has no iroh: cards ask for the email copy. */
export function initXferUi({ core, invoke, sendText, sendFile, metadata }) {
  if (transport) return; // never re-init
  env = { core, invoke: invoke || null };
  metadataFn = metadata || (async () => null);
  hooks = { sendText, sendFile, lastSent: () => lastSent };
  account = String(core?.accountId ?? "0");
  loadCards();
  let store = jsonStore(`velta-xfer-pending:${account}`);
  const proxy = { load: () => store.load(), save: (o) => store.save(o) };
  transport = createTransport({
    email: {
      sendFile: (chatId, f) => hooks.sendFile(chatId, f.path, f.name),
      sendText: async (chatId, text) => { const msg = await sendText(chatId, text); lastSent = msg; return msg; },
    },
    iroh: invoke ? {
      offer: (path, relay, name) => invoke("xfer_offer", { path, relay, name }),
      fetch: (ticket, relay) => invoke("xfer_fetch", { ticket, relay }),
      withdraw: (hash) => invoke("xfer_withdraw", { hash }),
      status: (hashes) => invoke("xfer_status", { hashes }),
    } : null,
    relay: async () => advertisedRelay(await relayMeta()),
    store: proxy,
  });
  transport.setStore = (s) => { store = s; transport.reload(); };
  // Messages handled even when their chat is not on screen: requests for
  // the email copy and incoming cards (fetch on arrival).
  const onMsg = (e) => {
    const m = e?.detail?.msg;
    if (m && typeof m.text === "string") noteCard(m.chatId ?? e.detail.chatId, m.text, m.from === 1 || m.out === true);
  };
  core?.addEventListener?.("incoming-msg", onMsg);
  core?.addEventListener?.("msg-updated", onMsg);
  core?.addEventListener?.("account-changed", (e) => { useAccount(e?.detail?.accountId ?? core.accountId); announce(); runSweep(); });
  announce();
  if (invoke) {
    runSweep();
    if (typeof setInterval === "function" && !sweepTimer) { sweepTimer = setInterval(runSweep, SWEEP_MS); sweepTimer?.unref?.(); }
  }
  if (typeof document !== "undefined") document.addEventListener("click", (e) => {
    const ask = e.target.closest?.("[data-xfer-ask]");
    if (!ask) return;
    const hash = ask.getAttribute("data-xfer-ask");
    askForEmailCopy(hash);
  });
}

/** The card's "Ask for the email copy" action. */
export function askForEmailCopy(hash) {
  const st = cardState.get(hash);
  return st && canAsk(st) ? askEmailCopy(hash, st) : Promise.resolve();
}

/** Test hook: run one sweep now. */
export const _sweepNow = runSweep;
