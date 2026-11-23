// iroh-xfer-ui.js — UI glue for the automatic iroh file transfer (#470
// phase 2): routes composer file sends over the transport, renders file
// cards in bubbles (markdown hook), auto-fetches received files, handles
// the "ask for the email copy" fallback and the sender's resend request.
// Pure logic lives in iroh-xfer.js; this module holds the DOM + shell glue.
import { createTransport, parseFileCard, parseResendRequest, advertisedRelay, THRESHOLD, routeLabel } from "./iroh-xfer.js";
import { fileUrl } from "./media.js";
import { diagnosticsSink } from "./diagnostics.js";
import { t } from "./i18n.js";
import { escapeHtml } from "./format.js";

let env = null;  // { invoke } — null outside the Tauri shell
let transport = null;
let metadataFn = null;       // async () => get_server_metadata | null
let hooks = null;            // { sendText, sendFile, lastSent }
let metaCache = { at: 0, value: null };
let lastSent = null;         // the card message transport.send just mailed
const cardState = new Map(); // ticket hash -> { outgoing?, chatId, path?, asked?, done? }

const META_TTL = 5 * 60 * 1000;
async function relayMeta() {
  if (metaCache.value && Date.now() - metaCache.at < META_TTL) return metaCache.value;
  metaCache = { at: Date.now(), value: await metadataFn().catch(() => null) };
  return metaCache.value;
}

/** True when the peer's chatmail relay advertises an iroh relay — the v1
 *  stand-in for "is a Velta peer" (#470 identity binding will replace it).
 *  Conservative: same-relay peers only; everyone else takes the email path. */
export async function peerIsVelta(peerAddr) {
  const meta = await relayMeta();
  if (!meta || !peerAddr) return false;
  const domain = String(peerAddr).split("@").pop().toLowerCase();
  return Object.entries(meta).some(([addr, m]) =>
    addr.toLowerCase().endsWith("@" + domain) && !!advertisedRelay({ [addr]: m }, addr));
}

/**
 * Try to deliver one composer attachment over iroh. Returns false when the
 * policy says email (caller sends the attachment normally); true when the
 * transport fully delivered it — the iroh offer + mailed file card, or the
 * immediate email fallback after a failed offer.
 */
export async function maybeSend({ chatId, path, name, size, oneToOne, peerAddr }) {
  if (!transport || !oneToOne || !(Number(size) > THRESHOLD)) return { handled: false };
  const r = await transport.send({ chatId, file: { path, name, size }, oneToOne, peerIsVelta: await peerIsVelta(peerAddr) });
  if (r.via === "offer-failed") sink("error", `offer failed — mailed instead: ${r.error}`);
  else if (r.route === "iroh") sink("info", `offered ${name} (${fmtSize(size)}) for direct fetch`);
  return { handled: true, msg: hooks?.lastSent?.() || null };
}

/**
 * Render hook for the message bubble: a VXFER1 file card becomes a compact
 * file bubble; the fallback request line becomes a quiet label. Null = not
 * ours, render as usual.
 */
const safeFileUrl = (p) => { try { return fileUrl(p); } catch { return "#"; } };

export function xferCardHtml(text) {
  const card = parseFileCard(text);
  if (card) {
    const st = cardState.get(card.tk.hash) || {};
    const state = st.outgoing
      ? escapeHtml(routeLabel("iroh"))
      : st.done ? escapeHtml(t("Received"))
        : st.asked ? escapeHtml(t("Asked for the email copy"))
          : escapeHtml(t("Receiving file…"));
    const actions = st.path
      ? `<a class="xfer-open" href="${escapeAttr(safeFileUrl(st.path))}" target="_blank" rel="noopener">${escapeHtml(t("Open"))}</a>`
      : !st.outgoing && !st.asked && !st.done
        ? `<button type="button" class="xfer-ask btn-text" data-xfer-ask="${escapeAttr(card.tk.hash)}">${escapeHtml(t("Ask for the email copy"))}</button>`
        : "";
    return `<span class="xfer-card" data-xfer="${escapeAttr(card.tk.hash)}"><span class="xfer-glyph">${escapeHtml((card.name.split(".").pop()?.[0] || "f").toUpperCase())}</span>` +
      `<span class="xfer-name">${escapeHtml(card.name)}<span class="xfer-meta">${escapeHtml(fmtSize(card.size))}</span></span>` +
      `<span class="xfer-state">${state}</span>${actions}</span>`;
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

/** Bubble-render side effect: first sight of a card kicks its fetch; first
 *  sight of a fallback request triggers the sender's email-out. */
export function noteCard(chatId, text, outgoing) {
  if (!transport) return;
  const card = parseFileCard(text);
  if (card) {
    const hash = card.tk.hash;
    if (cardState.has(hash)) return;
    if (outgoing) { cardState.set(hash, { outgoing, chatId }); return; }
    cardState.set(hash, { outgoing: false, chatId });
    sink("info", `fetching ${card.name} (${fmtSize(card.size)}) directly from the sender`);
    transport.receive({ chatId, text }).then((r) => {
      const st = cardState.get(hash);
      if (!st) return;
      if (r?.path) { st.path = r.path; st.done = true; sink("info", `received ${card.name} over iroh`); }
      else if (r?.asked) { st.asked = true; sink("error", `fetch failed — asked for the email copy (${r.error || "unknown"})`); }
      else if (r?.error) sink("info", `fetch interrupted — will resume over iroh (${r.error})`);
      refresh(hash);
    }).catch((e) => { sink("error", `fetch crashed: ${e?.message || e}`); });
    return;
  }
  if (parseResendRequest(text) && !outgoing) {
    transport.onResendRequest({ text }).then((name) => {
      if (name) sink("info", `fetch failed on the other end — mailed ${name}`);
    }).catch(() => {});
  }
}

function refresh(hash) {
  if (typeof document === "undefined") return; // node tests: state assertions only
  for (const el of document.querySelectorAll(`[data-xfer="${hash}"] .xfer-state`)) {
    const st = cardState.get(hash) || {};
    el.textContent = st.done ? t("Received") : st.asked ? t("Asked for the email copy") : t("Receiving file…");
    const card = el.closest(".xfer-card");
    const actions = card?.querySelector(".xfer-ask");
    if (actions && (st.asked || st.done || st.path)) actions.remove();
    if (st.path && card && !card.querySelector(".xfer-open")) {
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

/** Wire once from boot: shell handles + the composer's send hooks. */
export function initXferUi({ core, invoke, sendText, sendFile, metadata }) {
  if (!invoke || transport) return; // PWA / mock: no shell; never re-init
  env = { core, invoke };
  metadataFn = metadata || (async () => null);
  hooks = { sendText, sendFile, lastSent: () => lastSent };
  transport = createTransport({
    email: {
      sendFile: (chatId, f) => hooks.sendFile(chatId, f.path, f.name),
      sendText: async (chatId, text) => { const msg = await sendText(chatId, text); lastSent = msg; return msg; },
    },
    iroh: {
      offer: (path, relay) => invoke("xfer_offer", { path, relay }),
      fetch: (ticket, relay) => invoke("xfer_fetch", { ticket, relay }),
      withdraw: (hash) => invoke("xfer_withdraw", { hash }),
    },
    relay: async () => advertisedRelay(await relayMeta()),
  });
  if (typeof document !== "undefined") document.addEventListener("click", (e) => {
    const ask = e.target.closest("[data-xfer-ask]");
    if (!ask) return;
    const hash = ask.getAttribute("data-xfer-ask");
    const st = cardState.get(hash);
    if (st?.chatId != null) hooks.sendText(st.chatId, `VXFER-RESEND:${hash}`);
  });
}
