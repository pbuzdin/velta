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
  irohXferEnabled, THRESHOLD, routeLabel, CAPABILITY_KEY, peerCapabilityKey, emailReason,
  planRoute, routeText, peerDomains, EMAIL_MAX, offerFailedText, splitFileName, fileKind,
} from "./iroh-xfer.js";
import { svg, P } from "./icons.js";
import { fileUrl } from "./media.js";
import { diagnosticsSink } from "./diagnostics.js";
import { t } from "./i18n.js";
import { escapeHtml } from "./format.js";
import { withTimeout } from "./load-retry.js";

let env = null;  // { core, invoke } — invoke null in the PWA
let transport = null;
let metadataFn = null;       // async () => get_server_metadata | null
let hooks = null;            // { sendText, sendFile, lastSent, openHttp }
let lastSent = null;         // the card message transport.send just mailed
let account = "0";
let selfChat = null;         // Saved Messages chat id (cached per account)
let sweepTimer = null;
const cardState = new Map(); // ticket hash -> { outgoing?, mine?, chatId, path?, asked?, done?, error? }
const CARDS_MAX = 300;
const SWEEP_MS = 5 * 60 * 1000;

// Send waits on the pre-send route. get_server_metadata waits on core locks
// an IO restart holds for 30 s and hangs on a dead network; the shell answers
// xfer_health within ~11 s; xfer_offer copies, seals and hashes the file, so
// its bound grows by offerPerMbMs per MB (~10 MB/s worst case). A stalled
// call must time out here, never turn Send into a no-op.
export const WAIT_MS = Object.freeze({ metaMs: 4000, peerMs: 4000, healthMs: 12000, offerMs: 120000, offerPerMbMs: 100 });
let limits = { ...WAIT_MS }; // per initXferUi; tests pass short ones
let metaCache = { at: 0, value: null, ttl: 0 };
const META_TTL = 5 * 60 * 1000;
const META_RETRY_MS = 20 * 1000;
async function relayMeta() {
  if (metaCache.value !== null && Date.now() - metaCache.at < metaCache.ttl) return metaCache.value;
  let value = null;
  try { value = await withTimeout(metadataFn?.() ?? Promise.resolve(null), limits.metaMs, "get_server_metadata"); }
  catch { /* stalled or failed: no relay known this time, ask again soon */ }
  metaCache = { at: Date.now(), value, ttl: value ? META_TTL : META_RETRY_MS };
  return value;
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
    if (st.done || st.asked || st.error) keep[h] = { chatId: st.chatId, path: st.path, asked: st.asked, done: st.done, error: st.error, outgoing: st.outgoing || undefined, size: st.size, name: st.name || undefined, dashFailed: st.dashFailed || undefined };
  }
  cardsStore().save(keep);
}

/** True when the contact has proved it runs Velta with the transfer: core
 *  patch #31 stored the time of its last encrypted, signed message carrying
 *  Chat-Velta-Xfer. Unknown contacts (and Delta Chat) get email. */
export async function peerCanXfer(contactId) {
  if (contactId == null || !env?.core?.getConfig) return false;
  try { return !!(await withTimeout(env.core.getConfig(peerCapabilityKey(contactId)), limits.peerMs, "get_config")); } catch { return false; }
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
  if (!(Number(size) > THRESHOLD)) return { handled: false };
  const can = oneToOne && !!env?.invoke && await peerCanXfer(contactId);
  // #489 diagnostics: say why a large file went by email.
  const why = emailReason({ size, oneToOne, proven: can, enabled: irohXferEnabled(), available: !!(transport && env?.invoke) });
  if (why) { sink("info", `sent ${name} (${fmtSize(size)}) by email: ${why}`); return { handled: false }; }
  const r = await transport.send({ chatId, file: { path, name, size }, oneToOne, peerIsVelta: true });
  if (r.route === "none") {
    sink("error", `offer failed and ${name} (${fmtSize(size)}) is too big for email — not sent: ${r.error}`);
    health = { at: 0, value: null }; // check again before the next try
    return { handled: true, failed: "too-big", error: offerFailedText(r.error), msg: null };
  }
  if (r.via === "offer-failed") {
    sink("error", `offer failed — mailed instead: ${r.error}`);
    health = { at: 0, value: null };
    return { handled: true, fellBack: true, msg: hooks?.lastSent?.() || null };
  }
  else if (r.via === "policy") sink("info", `sent ${name} (${fmtSize(size)}) by email: policy`);
  else if (r.route === "iroh") {
    // The sender has the bytes: keep the staged path so the outgoing card
    // previews (and opens in the lightbox) like the receiver's does — and
    // persist it NOW: saveCards only runs on fetch/ask/resend events, and a
    // restart before any of those would drop the path and kill the preview.
    cardState.set(r.hash, { outgoing: true, mine: true, chatId, name, path, done: true });
    saveCards();
    sink("info", `offered ${name} (${fmtSize(size)}) for direct fetch`);
  }
  return { handled: true, msg: hooks?.lastSent?.() || null };
}

const safeFileUrl = (p) => { try { return fileUrl(p); } catch { return "#"; } };
const ERRORS = {
  "too-big": () => t("Too big to send by email. Send it again when you are both online."),
  "too-big-recv": () => t("Too large for email: ask the sender to resend while you are both online."),
  interrupted: () => t("Velta Dash transfer interrupted."),
  "no-space": () => t("Not enough free space to receive this file."),
  "too-large": () => t("This file is too large to receive."),
  missing: () => t("The file is no longer available."),
};
function stateText(st) {
  if (st.error && ERRORS[st.error]) return ERRORS[st.error]();
  if (st.asked && !st.done) return st.dashFailed ? t("Couldn't fetch via Velta Dash: asked for the email copy") : t("Asked for the email copy");
  if (st.outgoing) return st.mailed ? t("Sent by email") : routeLabel("iroh");
  if (st.done) return t("Received with Velta Dash");
  if (st.pct != null) return t("Fetching via Velta Dash {n}%", { n: st.pct });
  if (st.receiving) return t("Waiting for sender…");
  return t("Receiving file…");
}
/** An ERRORS sentence: fully visible on the timestamp row, may wrap (#519). */
function isErrorState(st) {
  return !!(st.error && ERRORS[st.error]);
}
/** A card still waiting on something (sender, fetch): shows the busy ring. */
function isBusy(st) {
  return !st.outgoing && !st.done && !st.error && !st.asked && (!!st.receiving || st.pct != null);
}
/** Incoming card that failed over Dash and can try again (both online). */
function canRetry(st) {
  return !st.outgoing && !st.done && !st.receiving && !!env?.invoke && (st.error === "interrupted" || st.error === "too-big-recv");
}
/** The "ask" button shows on incoming cards not yet received or asked, and
 *  on outgoing cards on a device that has no copy (the sender's other
 *  device, or the PWA). */
/** The path a file took, as a small badge: Dash, or the email fallback.
 *  Unknown (still receiving, or the sender's other device) shows none. */
function routeOf(st) {
  if (st.mailed || st.asked) return "email";
  if ((st.outgoing && st.mine) || st.done) return "dash";
  return null;
}
function routeBadgeHtml(st) {
  const r = routeOf(st);
  if (!r) return "";
  const label = r === "dash" ? t("Dash") : t("Email fallback");
  return `<span class="xfer-route" data-route="${r}">${r === "dash" ? svg(P.dash) : svg(P.mail)}<span>${escapeHtml(label)}</span></span>`;
}
function canAsk(st) {
  if (st.error === "too-big-recv" || (st.size != null && st.size > EMAIL_MAX)) return false;
  return !st.path && !st.asked && !st.done && (!st.outgoing || !st.mine);
}

// Media a fetched card can preview: images open in the image lightbox,
// videos in the player lightbox — never in a browser window. The ticket
// carries no thumbnail, so the preview only exists once st.path is there.
const IMG_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;
const VID_RE = /\.(?:mp4|mov|mkv|avi|webm|m4v|3gp)$/i;
function mediaKind(nameOrPath) {
  const s = String(nameOrPath || "");
  return IMG_RE.test(s) ? "image" : VID_RE.test(s) ? "video" : null;
}

let lightbox = null; // { image(src, caption), video(src, caption), folder(path, name) } — chat-view wires ui.js
/** Wire the lightbox openers + Show in folder (chat-view owns the ui.js imports). */
export function setXferLightboxOpener(fn) { lightbox = fn; }

/** The preview a fetched image/video card leads with, wrapped in a button
 *  that opens the lightbox. Media without a local copy (the sender's other
 *  device, tickets from before the fetch) says so on the tile instead of
 *  staying silent. Documents keep the Open link. */
function previewHtml(hash, name, st) {
  const kind = mediaKind(name || st.path);
  if (!kind) return "";
  if (!st.path) return `<span class="xfer-preview xfer-preview-dead">${escapeHtml(t("Preview unavailable"))}</span>`;
  const url = escapeAttr(safeFileUrl(st.path));
  // #t=0.001 seeks to the first frame so preload=metadata paints it instead
  // of an empty tile.
  const media = kind === "image"
    ? `<img class="xfer-preview" src="${url}" loading="lazy" alt="">`
    : `<video class="xfer-preview" src="${url}#t=0.001" preload="metadata" muted playsinline></video><span class="xfer-play" aria-hidden="true">${svg(P.playFilled)}</span>`;
  return `<button type="button" class="xfer-preview-btn" data-xfer-view="${escapeAttr(hash)}">${media}</button>`;
}

/** Lightbox open for a fetched media card (preview or Open click). */
function openInLightbox(hash) {
  const st = cardState.get(hash);
  if (!st?.path || typeof document === "undefined") return;
  const name = st.name || "";
  const kind = mediaKind(name || st.path);
  if (!kind) return;
  const src = safeFileUrl(st.path);
  if (lightbox) (kind === "image" ? lightbox.image : lightbox.video)(src, name);
  else window.open(src, "_blank", "noopener"); // unwired (tests/PWA): old behavior
}

/** Open a fetched DOCUMENT (#519): http(s) — the loopback media server,
 *  blobfile.localhost, convertFileSrc — rides the shell's openHttp (desktop
 *  opener plugin; wry swallows window.open); other schemes take the browser
 *  default the old anchor got. Never open_document: a Dash file is not a
 *  core blob, and the sealed accounts/xfer-in/ path would hand the OS
 *  ciphertext. The URL is computed here, at click time — it is never an
 *  href in the bubble. */
function openFile(hash) {
  const st = cardState.get(hash);
  if (!st?.path) return;
  const url = safeFileUrl(st.path);
  if (/^https?:/i.test(url) && typeof hooks.openHttp === "function") hooks.openHttp(url);
  else window.open(url, "_blank", "noopener");
}

/** Desktop: reveal the fetched file's decrypted copy in the file manager. */
function showInFolder(hash) {
  const st = cardState.get(hash);
  if (st?.path && lightbox?.folder) lightbox.folder(st.path, st.name || "");
}

/** Type tile icons for the card (#519): closed map, all 24px outline
 *  currentColor glyphs, already decorative. No letter fallback. */
const KIND_ICONS = { video: "video", audio: "mic", image: "photo", archive: "archive", file: "file" };

/**
 * Render hook for the message bubble: a VXFER1 file card becomes a file row
 * (#519) — 44px type tile (or the media preview, which replaces it), a
 * one-line name that keeps its extension, a size row (size, Dash chip,
 * actions), and a foot row where the status sentence shares the timestamp
 * with .msg-meta (chat-view fills the slot). The fallback request line stays
 * a quiet label. Null = not ours, render as usual.
 */
export function xferCardHtml(text) {
  const card = parseFileCard(text);
  if (card) {
    const st = cardState.get(card.tk.hash) || {};
    const preview = previewHtml(card.tk.hash, card.name, st);
    const kind = KIND_ICONS[fileKind(card.name)] || "file";
    const lead = preview || `<span class="xfer-glyph" aria-hidden="true">${svg(P[kind])}</span>`;
    const { base, ext } = splitFileName(card.name);
    const actions = actionsHtml(card.tk.hash, card.name, st);
    const err = isErrorState(st);
    return `<span class="xfer-card${preview ? " is-media" : ""}" data-xfer="${escapeAttr(card.tk.hash)}">${lead}` +
      `<span class="xfer-name" title="${escapeAttr(card.name)}"><span class="xfer-name-base">${escapeHtml(base)}</span><span class="xfer-name-ext">${escapeHtml(ext)}</span></span>` +
      `<span class="xfer-sub"><span class="xfer-meta">${escapeHtml(fmtSize(card.size))}</span>${routeBadgeHtml(st)}${actions}</span></span>` +
      `<span class="xfer-foot"><span class="xfer-state${isBusy(st) ? " is-busy" : ""}${err ? " is-error" : ""}" role="status">${escapeHtml(stateText(st))}</span><span class="xfer-meta-slot"></span></span>`;
  }
  if (parseResendRequest(text)) return `<span class="xfer-state">${escapeHtml(t("Asked for the email copy"))}</span>`;
  return null;
}

function actionsHtml(hash, name, st) {
  if (st.path) {
    // Media: the preview itself is the open control (the picture opens the
    // image, .xfer-play opens the video) — no caption open button (#519).
    // Desktop adds Show in folder (the shell reveals the decrypted copy).
    if (mediaKind(name || st.path)) {
      const folder = env?.invoke ? `<button type="button" class="xfer-folder btn-text" data-xfer-folder="${escapeAttr(hash)}">${escapeHtml(t("Show in folder"))}</button>` : "";
      return folder;
    }
    // Documents: Open is a button — an action, not navigation. The URL is
    // computed at click time from cardState (data-xfer-open); never an href.
    return `<button type="button" class="xfer-open btn-text" data-xfer-open="${escapeAttr(hash)}">${escapeHtml(t("Open"))}</button>`;
  }
  let out = "";
  if (canRetry(st)) out += `<button type="button" class="xfer-retry btn-text" data-xfer-retry="${escapeAttr(hash)}">${escapeHtml(t("Retry"))}</button>`;
  if (canAsk(st) && cardState.has(hash)) out += `<button type="button" class="xfer-ask btn-text" data-xfer-ask="${escapeAttr(hash)}">${escapeHtml(t("Ask for the email copy"))}</button>`;
  return out;
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
    if (known) { if (known.chatId == null) known.chatId = chatId; if (!known.outgoing && !known.text) known.text = text; if (known.size == null) known.size = card.size; if (!known.name) known.name = card.name; return; }
    if (outgoing) { cardState.set(hash, { outgoing: true, mine: transport.pending.has(hash), chatId, name: card.name }); return; }
    const st = { outgoing: false, chatId, size: card.size, name: card.name, text };
    cardState.set(hash, st);
    const expired = Number(card.tk.exp) * 1000 <= Date.now();
    if (!env.invoke && expired) { if (card.size > EMAIL_MAX) st.error = "too-big-recv"; return; } // PWA, old card: the sender mails expired offers itself
    startFetch(hash, 0);
    return;
  }
  if (parseResendRequest(text)) handleResend(chatId, text, outgoing);
}

/** Auto-retries (resume from the partial) after a broken or stalled
 *  stream, then the card shows Retry. */
export const RETRY_DELAYS_MS = [5000, 15000, 45000];
const peerCache = new Map(); // chatId -> mail domains of the 1:1 contact
async function peersOf(chatId) {
  if (peerCache.has(chatId)) return peerCache.get(chatId);
  let doms = [];
  try {
    const chat = await env.core?.getChat?.(chatId);
    const c = chat?.contactId != null ? await env.core?.getContact?.(chat.contactId) : null;
    doms = peerDomains([c?.addr, ...(c?.addrs || [])]);
  } catch {}
  peerCache.set(chatId, doms);
  return doms;
}
function startFetch(hash, attempt) {
  const st = cardState.get(hash);
  if (!st || st.done || !st.text) return;
  const name = parseFileCard(st.text)?.name || "file";
  st.error = undefined;
  st.receiving = !!env.invoke;
  st.pct = undefined;
  refresh(hash);
  sink("info", env.invoke ? `fetching ${name} (${fmtSize(st.size)}) via Velta Dash${attempt ? ` (retry ${attempt})` : ""}` : `asking for the email copy of ${name} (no Dash here)`);
  (async () => transport.receive({ chatId: st.chatId, text: st.text, peers: env.invoke ? await peersOf(st.chatId) : [] }))().then((r) => {
    const cur = cardState.get(hash);
    if (!cur) return;
    cur.receiving = false;
    cur.pct = undefined;
    if (r?.path) { cur.path = r.path; cur.done = true; sink("info", `received ${name} via Velta Dash`); }
    else if (r?.asked) { cur.asked = true; cur.dashFailed = r.code !== "no-iroh"; sink(r.code === "no-iroh" ? "info" : "error", `asked for the email copy (${r.error || r.code || "unknown"})`); }
    else if (r?.tooBig) { cur.error = "too-big-recv"; sink("error", `Dash fetch failed and ${name} is too big for email (${r.error || r.code})`); }
    else if (r?.code === "no-space" || r?.code === "too-large") { cur.error = r.code; sink("error", `fetch refused: ${r.error}`); }
    else if (r?.error) {
      if (attempt < RETRY_DELAYS_MS.length) {
        sink("info", `fetch interrupted — resuming in ${RETRY_DELAYS_MS[attempt] / 1000} s (${r.error})`);
        cur.receiving = true;
        setTimeout(() => startFetch(hash, attempt + 1), RETRY_DELAYS_MS[attempt])?.unref?.();
      } else { cur.error = "interrupted"; sink("error", `fetch interrupted ${attempt + 1} times — tap Retry (${r.error})`); }
    }
    saveCards();
    refresh(hash);
  }).catch((e) => {
    const cur = cardState.get(hash);
    if (cur) { cur.receiving = false; cur.error = "interrupted"; saveCards(); refresh(hash); }
    sink("error", `fetch crashed: ${e?.message || e}`);
  });
}

/** Card action: try the Dash fetch again (resumes the partial). */
export function retryFetch(hash) {
  const st = cardState.get(hash);
  if (st && canRetry(st)) startFetch(hash, 0);
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

/** Paint one mounted (or detached) card element from cardState (#519).
 *  State lives in .xfer-foot; the route badge and actions append into
 *  .xfer-sub after the size; fetched media swaps the type tile for a
 *  preview. Legacy classes from an older paint get cleaned up. */
function paintCard(card, st) {
  const hash = card.getAttribute("data-xfer");
  const el = card.querySelector(".xfer-state");
  if (el) {
    el.textContent = stateText(st);
    el.classList.toggle("is-busy", isBusy(st));
    el.classList.toggle("is-error", isErrorState(st));
  }
  const sub = card.querySelector(".xfer-sub");
  const name = st.name || card.querySelector(".xfer-name-base")?.textContent || "";
  // Fetched media swaps the file-type tile for a preview that opens the
  // lightbox (the render path already has it; refresh catches the card
  // that finished while on screen).
  const want = previewHtml(hash, name, st);
  const have = card.querySelector(".xfer-preview-btn");
  if (want && !have) {
    card.querySelector(".xfer-glyph")?.remove();
    card.insertAdjacentHTML("afterbegin", want);
    card.classList.add("is-media");
  } else if (!want && have) {
    have.remove();
  }
  if (sub) {
    for (const old of card.querySelectorAll(".xfer-route, .xfer-actions, .xfer-open, .xfer-ask, .xfer-retry, .xfer-folder")) old.remove();
    sub.insertAdjacentHTML("beforeend", routeBadgeHtml(st) + actionsHtml(hash, name, st));
  }
}

/** Repaint every Dash card under `root`, mounted or not — the history
 *  cache-hit path calls this before the scroller measures the row, so a
 *  fetch that finished off-screen remounts as Received with Open. */
export function paintXferIn(root) {
  if (typeof document === "undefined" || !root?.querySelectorAll) return;
  for (const card of root.querySelectorAll("[data-xfer]")) paintCard(card, cardState.get(card.getAttribute("data-xfer")) || {});
}

function refresh(hash) {
  if (typeof document === "undefined") return; // node tests: state assertions only
  const st = cardState.get(hash) || {};
  for (const card of document.querySelectorAll(`[data-xfer="${hash}"]`)) {
    paintCard(card, st);
    // The scroller notify (#519): percent ticks and steady states must not
    // fire it (overflow-anchor: none makes a spurious notify a scroll
    // jump). The first paint stores the height — renderItem's own measure
    // covers it. Only an integer height change dispatches, and the wrap
    // mutation above happens in this same turn, before the read.
    const h = card.offsetHeight;
    if (!h || !card.isConnected) continue;
    const prev = card.dataset.xferH;
    if (prev == null) { card.dataset.xferH = String(h); continue; }
    if (prev !== String(h)) {
      card.dataset.xferH = String(h);
      card.dispatchEvent(new CustomEvent("velta-row-resized", { bubbles: true }));
    }
  }
}

/** Switches the per-account state (pending offers, card states, caches). */
function useAccount(id) {
  account = String(id ?? "0");
  selfChat = null;
  metaCache = { at: 0, value: null };
  peerCache.clear();
  health = { at: 0, value: null };
  resendSeen.clear();
  loadCards();
  transport?.setStore?.(jsonStore(`velta-xfer-pending:${account}`));
}

/** Wire once from boot: shell handles + the composer's send hooks. In the
 *  PWA (no invoke) the transport has no iroh: cards ask for the email copy. */
export function initXferUi({ core, invoke, sendText, sendFile, metadata, listen, openHttp, timeouts = {} }) {
  if (transport) return; // never re-init
  env = { core, invoke: invoke || null };
  limits = { ...WAIT_MS, ...timeouts };
  metadataFn = metadata || (async () => null);
  hooks = { sendText, sendFile, lastSent: () => lastSent, openHttp };
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
      // A stalled offer (endpoint lock held) rejects here: the transport then
      // mails the file, or reports too-big instead of waiting forever.
      offer: (path, relay, name, size) => withTimeout(invoke("xfer_offer", { path, relay, name }),
        limits.offerMs + Math.ceil((Number(size) || 0) / 1048576) * limits.offerPerMbMs, "xfer_offer"),
      fetch: (ticket, relay, peers) => invoke("xfer_fetch", { ticket, relay, peers: peers?.length ? peers : null }),
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
    if (m && e?.type === "incoming-msg" && !(m.from === 1 || m.out === true)) maybeEcho(m).catch(() => {});
  };
  // Fetch progress from the shell: "Fetching via Velta Dash 34%".
  const lis = listen || (typeof window !== "undefined" ? window.__TAURI__?.event?.listen?.bind(window.__TAURI__.event) : null);
  if (invoke && lis) {
    try { Promise.resolve(lis("xfer-progress", (ev) => xferProgressEvent(ev?.payload ?? ev))).catch(() => {}); } catch {}
  }
  core?.addEventListener?.("incoming-msg", onMsg);
  core?.addEventListener?.("msg-updated", onMsg);
  core?.addEventListener?.("account-changed", (e) => { useAccount(e?.detail?.accountId ?? core.accountId); announce(); runSweep(); });
  // The drawer toggle flips the pref: announce the new state (core adds or
  // drops the capability header on the next encrypted message).
  if (typeof window !== "undefined") window.addEventListener?.("velta-dash", () => announce());
  announce();
  if (invoke) {
    runSweep();
    if (typeof setInterval === "function" && !sweepTimer) { sweepTimer = setInterval(runSweep, SWEEP_MS); sweepTimer?.unref?.(); }
  }
  if (typeof document !== "undefined") {
    document.addEventListener("click", (e) => {
      const retry = e.target.closest?.("[data-xfer-retry]");
      if (retry) { retryFetch(retry.getAttribute("data-xfer-retry")); return; }
      const view = e.target.closest?.("[data-xfer-view]");
      if (view) { openInLightbox(view.getAttribute("data-xfer-view")); return; }
      const folder = e.target.closest?.("[data-xfer-folder]");
      if (folder) { showInFolder(folder.getAttribute("data-xfer-folder")); return; }
      const open = e.target.closest?.("[data-xfer-open]");
      if (open) {
        // Selection mode: the row listener toggled selection and returned
        // without stopPropagation — do not also open (#519).
        if (open.closest(".msg-row")?.classList.contains("selectable")) return;
        openFile(open.getAttribute("data-xfer-open"));
        return;
      }
      const ask = e.target.closest?.("[data-xfer-ask]");
      if (!ask) return;
      const hash = ask.getAttribute("data-xfer-ask");
      askForEmailCopy(hash);
    });
    // A preview the webview cannot decode (codec, evicted file) degrades to
    // a placeholder tile instead of a broken-image glyph. error does not
    // bubble; capture catches it for imgs and videos alike.
    document.addEventListener("error", (e) => {
      const el = e.target;
      if (!el?.classList?.contains("xfer-preview")) return;
      el.closest(".xfer-preview-btn")?.querySelector(".xfer-play")?.remove();
      el.replaceWith(Object.assign(document.createElement("span"), { className: "xfer-preview xfer-preview-dead", textContent: t("Preview unavailable") }));
    }, true);
  }
}

/** The card's "Ask for the email copy" action. */
export function askForEmailCopy(hash) {
  const st = cardState.get(hash);
  return st && canAsk(st) ? askEmailCopy(hash, st) : Promise.resolve();
}

/** Shell progress event {hash, done, size}: percent on the card. */
const lastPaint = new Map();
export function xferProgressEvent(p) {
  const st = p && cardState.get(p.hash);
  if (!st || st.outgoing || st.done || !(Number(p.size) > 0)) return;
  st.receiving = true;
  st.pct = Math.min(99, Math.floor((Number(p.done) * 100) / Number(p.size)));
  const now = Date.now();
  if (now - (lastPaint.get(p.hash) || 0) < 250) return; // a few repaints a second
  lastPaint.set(p.hash, now);
  refresh(p.hash);
}

/**
 * Capability echo (#470): proof is one-way — the header rides only on our
 * normal messages, so a peer we only receive from never sees our badge.
 * When a proven 1:1 peer's message arrives, answer once a week with an empty
 * reaction: a hidden, encrypted message core stamps with the header.
 */
export const ECHO_EVERY_MS = 7 * 86400000;
const echoing = new Set();
async function maybeEcho(m) {
  if (!env?.invoke || !irohXferEnabled() || !env.core?.clearReaction) return;
  const contactId = Number(m.fromContact?.id ?? m.fromId);
  if (!(contactId > 9) || m.id == null) return; // real contacts only (ids <= 9 are special)
  const key = `velta-xfer-told:${account}:${contactId}`;
  const told = Number(lsGet(key) || 0);
  if (Date.now() - told < ECHO_EVERY_MS || echoing.has(key)) return;
  echoing.add(key);
  try {
    const chat = await env.core.getChat?.(m.chatId);
    if (chat?.chatType !== "Single" || Number(chat.contactId) !== contactId) return;
    if (!await peerCanXfer(contactId)) return; // they run Dash: tell them we do too
    await announce();
    await env.core.clearReaction(m.id);
    lsSet(key, String(Date.now()));
    sink("info", `told contact ${contactId} this device runs Velta Dash`);
  } finally { echoing.delete(key); }
}
function lsGet(k) { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } }
function lsSet(k, v) { try { globalThis.localStorage?.setItem(k, v); } catch {} }

/**
 * Pre-send route for the composer (#470): {route, reason, text}. A live
 * check of the shell endpoint and its relay connection (cached 20 s) —
 * Dash only when the receiver can actually reach this phone.
 */
let health = { at: 0, value: null };
async function dashHealth() {
  if (!env?.invoke) return null;
  if (health.value && Date.now() - health.at < 20000) return health.value;
  let v;
  try { v = await withTimeout(env.invoke("xfer_health", { relay: advertisedRelay(await relayMeta()) }), limits.healthMs, "xfer_health"); }
  // The shell answers within ~11 s even when the endpoint cannot start, so
  // a timeout here means it is stuck: Dash is down (and says why), not
  // "unchecked" — trying it anyway was the silent two-minute Send.
  catch (e) { v = { ready: false, relay: null, relayConnected: false, error: /rpc timeout/.test(String(e?.message || e)) ? "timeout" : String(e?.message || e) }; }
  if (v?.ready === false || v?.error) sink("warning", `Velta Dash unavailable: ${v.error || (v.relay && !v.relayConnected ? "not connected to the Dash relay" : "endpoint down")}`);
  // Only a healthy answer is cached: after a failure the next attach asks again.
  health = { at: v?.ready && !v.error ? Date.now() : 0, value: v };
  return v;
}
export async function planSend({ size, oneToOne, contactId, peerName = "" }) {
  const proven = oneToOne && !!env?.invoke && await peerCanXfer(contactId);
  const base = { size, oneToOne, proven, enabled: irohXferEnabled(), available: !!(transport && env?.invoke) };
  let plan = planRoute(base);
  if (plan.route === "dash") plan = planRoute({ ...base, health: await dashHealth() });
  return { ...plan, text: routeText(plan, peerName) };
}

/** Test hook: run one sweep now. */
export const _sweepNow = runSweep;
