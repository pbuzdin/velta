import { t } from "./i18n.js";
// iroh-xfer.js — Velta Dash ("Dash"): automatic iroh file transfer for
// Velta ↔ Velta 1:1 chats (#470). Not Loop (local network) and not Beam
// (send to many); internal names stay "xfer". The engine is velta-app/src-tauri/src/xfer.rs (Tauri commands
// xfer_offer / xfer_fetch / xfer_withdraw); this module holds the policy and
// the message formats, pure so node tests cover them.
//
// Rule: a 1:1 attachment strictly over 6 MB goes over iroh when the setting
// is on (default) and the contact has proved it runs Velta with the transfer:
// core patch #31 records a Chat-Velta-Xfer header seen in a signed, encrypted
// message from them (ui.velta.xfer.peer.<id>). Everyone else — Delta Chat,
// unknown contacts — gets a normal email attachment. The ticket only names the chatmail relay's own advertised iroh
// relay — never n0's — and with none advertised the fetch is direct-only and
// falls back to email when the sender is unreachable.

export const THRESHOLD = 6 * 1024 * 1024;
export const TICKET_PREFIX = "VXFER1:";
export const FALLBACK_PREFIX = "VXFER-RESEND:";
/** Largest file the email fallback tries: chatmail's default 30 MiB message
 *  limit minus the encryption and base64 overhead (×~1.37). Bigger files get
 *  a clear error instead of a send the relay would bounce. */
export const EMAIL_MAX = 22 * 1024 * 1024;
/** How long a delivered offer stays up for the receiver's other devices. */
export const DELIVERED_GRACE_MS = 60 * 60 * 1000;
/** Account config key this device sets ("1"/"0"); core patch #31 then adds
 *  the capability header to its encrypted messages. */
export const CAPABILITY_KEY = "ui.velta.xfer";
export const peerCapabilityKey = (contactId) => `ui.velta.xfer.peer.${contactId}`;
const PREF = "velta-iroh-xfer";

/** On by default; "0" turns it off. */
export function irohXferEnabled(store = globalThis.localStorage) {
  try { return store?.getItem(PREF) !== "0"; } catch { return true; }
}
export function setIrohXferEnabled(on, store = globalThis.localStorage) {
  try { store?.setItem(PREF, on ? "1" : "0"); } catch {}
}

/** "iroh" or "email" for one attachment. `available`: the shell has xfer_* (Tauri). */
export function chooseRoute({ size, oneToOne, peerIsVelta, enabled, available }) {
  return enabled && available && oneToOne && peerIsVelta && Number(size) > THRESHOLD ? "iroh" : "email";
}

/**
 * The advertised iroh relay of the account's transport that sends, from
 * core's get_server_metadata ({addr: {irohRelay, …}} — camelCase over
 * JSON-RPC). Null when none: the transfer then runs direct-only. Only https
 * URLs are taken.
 */
export function advertisedRelay(metadata, addr) {
  const url = (m) => (m && (typeof m.irohRelay === "string" ? m.irohRelay : m.iroh_relay));
  const pick = (m) => { const u = url(m); return typeof u === "string" && /^https:\/\/[^\s/]+/.test(u) ? u : null; };
  if (!metadata || typeof metadata !== "object") return null;
  if (addr && metadata[addr]) return pick(metadata[addr]);
  for (const m of Object.values(metadata)) { const r = pick(m); if (r) return r; }
  return null;
}

/** The ticket's JSON, or null. Mirrors Ticket::decode's checks that matter to the UI. */
export function decodeTicket(s) {
  const raw = String(s || "").trim();
  if (!raw.startsWith(TICKET_PREFIX)) return null;
  try {
    const b64 = raw.slice(TICKET_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    const json = typeof atob === "function" ? atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")) : Buffer.from(b64, "base64").toString("binary");
    const tk = JSON.parse(decodeURIComponent(escape(json)));
    if (tk.v !== 1 || !/^[0-9a-f]{64}$/.test(tk.hash) || !Number.isSafeInteger(tk.size) || typeof tk.name !== "string") return null;
    return tk;
  } catch { return null; }
}

function fmtSize(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Text of the small encrypted message that replaces the attachment: readable
 * lines (what Delta Chat or any app without the transfer shows) and the
 * ticket on its own line.
 */
export function fileCardText({ name, size, ticket }) {
  return `${t("📎 {name} · {size} — sent with Velta Dash", { name, size: fmtSize(size) })}\n` +
    `${t("If your app can't open this, the file follows by email.")}\n${ticket}`;
}

/** {name, size, ticket, tk} from a received message text, or null. */
export function parseFileCard(text) {
  const line = String(text || "").split("\n").find((l) => l.trim().startsWith(TICKET_PREFIX));
  const tk = line && decodeTicket(line);
  return tk ? { name: tk.name, size: tk.size, ticket: line.trim(), tk } : null;
}

/** Receiver → sender: "fetch failed, please mail it" (ticket hash). */
export function resendRequestText(hash) { return `${FALLBACK_PREFIX}${hash}`; }
export function parseResendRequest(text) {
  const m = /^VXFER-RESEND:([0-9a-f]{64})$/.exec(String(text || "").trim());
  return m ? m[1] : null;
}

/** UI line saying which path a file took. */
export function routeLabel(route) {
  return route === "iroh" ? t("Sent with Velta Dash") : t("Sent by email");
}

/** Brand: "Velta Dash" stays untranslated (like Velta Loop / Velta Beam). */
export const DASH = "Velta Dash";
export const SETTING_LABEL = () => t(DASH);
export const SETTING_HINT = () => t("Fast transfer for files over 6 MB, directly between devices. It starts with a Velta contact after you both exchange a message; email is the fallback.");

/**
 * Dash status of one chat, for the header badge and the explainer:
 *   null       — not applicable (group, self, local chat, PWA)
 *   "off"      — the setting is off
 *   "waiting"  — on, but the contact has not proved it runs Dash yet
 *   "on"       — on and proven: files over 6 MB go via Dash
 */
export function dashState({ kind, isP2p, contactId, shell, enabled, proven }) {
  if (!shell || kind !== "single" || isP2p || contactId == null || contactId === 1) return null;
  if (!enabled) return "off";
  return proven ? "on" : "waiting";
}

/** Explainer text per dashState (plain text, the caller escapes). */
export function dashExplainer(state) {
  if (state === "on") return t("Velta Dash is on with this contact: files over 6 MB go directly between devices, with email as a fallback.");
  if (state === "waiting") return t("Velta Dash is on, but not with this contact yet. Dash starts after you both exchange a message. Contacts on other apps get files by email.");
  return t("Velta Dash is off: files go by email.");
}

/** Why a file over the threshold went by email, for the diagnostics log. */
export function emailReason({ size, oneToOne, proven, enabled, available }) {
  if (!(Number(size) > THRESHOLD)) return null;
  if (!available) return "no Dash here (PWA)";
  if (!enabled) return "Velta Dash is off";
  if (!oneToOne) return "not a 1:1 chat";
  if (!proven) return "contact has not proved Velta Dash yet (no Chat-Velta-Xfer seen — exchange one message)";
  return null;
}

/** A plain-object store over localStorage (the pending list survives restarts). */
export function jsonStore(key, store = globalThis.localStorage) {
  return {
    load() { try { const v = JSON.parse(store?.getItem(key) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } },
    save(obj) { try { if (Object.keys(obj).length) store?.setItem(key, JSON.stringify(obj)); else store?.removeItem?.(key); } catch {} },
  };
}

/**
 * One send/receive API over two backends (#470, files):
 *   email: { sendFile(chatId, file), sendText(chatId, text) }   — core / chatmail
 *   iroh:  { offer(path, relay, name) -> ticket, fetch(ticket, relay) -> {path}|{error, code, email},
 *            withdraw(hash), status(hashes) -> {hash: {size, exp, delivered, path}|null} } | null
 *                                                               — xfer.rs (Tauri); null in the PWA
 *   relay(): the advertised iroh relay or null; enabled(): the setting.
 *   store: { load(), save(obj) } for the pending offers (jsonStore()).
 * The caller says whether the chat is 1:1 with a contact that can fetch.
 * Returns { send, receive, onResendRequest, sweep, pending, reload }.
 */
export function createTransport({ email, iroh, relay = async () => null, enabled = () => irohXferEnabled(), store = null, now = () => Date.now() }) {
  // hash -> {chatId, name, size, exp (s), path, deliveredAt?, selfMailed?};
  // kept until mailed, withdrawn after delivery or expiry.
  const pending = new Map();
  function reload() {
    pending.clear();
    for (const [h, p] of Object.entries(store?.load() || {})) if (/^[0-9a-f]{64}$/.test(h) && p && p.chatId != null) pending.set(h, p);
  }
  const save = () => store?.save(Object.fromEntries(pending));
  reload();

  async function send({ chatId, file, oneToOne, peerIsVelta }) {
    const route = chooseRoute({ size: file.size, oneToOne, peerIsVelta, enabled: enabled(), available: !!iroh });
    if (route === "email") { await email.sendFile(chatId, file); return { route, via: "policy" }; }
    try {
      const ticket = await iroh.offer(file.path, await relay(), file.name);
      const tk = decodeTicket(ticket);
      if (!tk) throw new Error("bad ticket");
      pending.set(tk.hash, { chatId, name: file.name, size: file.size, exp: tk.exp, path: file.path });
      save();
      await email.sendText(chatId, fileCardText({ name: file.name, size: file.size, ticket }));
      return { route: "iroh", hash: tk.hash };
    } catch (error) {
      await email.sendFile(chatId, file); // could not offer: mail it right away
      return { route: "email", via: "offer-failed", error };
    }
  }
  /** A received text: fetch a file card over iroh, or ask for the email copy
   *  (always in the PWA, which has no iroh). */
  async function receive({ chatId, text }) {
    const card = parseFileCard(text);
    if (!card) return null;
    if (!iroh) { await email.sendText(chatId, resendRequestText(card.tk.hash)); return { route: "email", asked: true, code: "no-iroh" }; }
    const r = await iroh.fetch(card.ticket, await relay());
    if (r && r.path) return { route: "iroh", path: r.path };
    if (r && r.email) { await email.sendText(chatId, resendRequestText(card.tk.hash)); return { route: "email", asked: true, error: r.error, code: r.code }; }
    return { route: "iroh", error: r?.error || "failed", code: r?.code, retry: true }; // broken stream / no space: no email
  }
  /** Mails one pending file to `toChat` (the stored copy when xfer.rs still
   *  has it). Returns {name} or {error: "too-big"|"missing"}. */
  async function mail(hash, p, toChat) {
    let path = p.path;
    try { const st = (await iroh?.status?.([hash]))?.[hash]; if (st?.path) path = st.path; } catch {}
    if (Number(p.size) > EMAIL_MAX) return { name: p.name, error: "too-big" };
    if (!path) return { name: p.name, error: "missing" };
    await email.sendFile(toChat, { path, name: p.name, size: p.size });
    return { name: p.name };
  }
  async function drop(hash) {
    pending.delete(hash);
    save();
    try { await iroh?.withdraw(hash); } catch {}
  }
  /**
   * Sender: someone asked for the email copy. Honoured only from the chat
   * the file went to, or from Saved Messages (`selfChatId`: the sender's own
   * other device, which has no iroh copy) — the file is mailed to the chat
   * that asked. Returns {name, chatId} | {error, name} | null (nothing matched).
   */
  async function onResendRequest({ text, chatId = null, selfChatId = null }) {
    const hash = parseResendRequest(text);
    const p = hash && pending.get(hash);
    if (!p) return null;
    const fromPeer = chatId == null || chatId === p.chatId;
    const fromSelf = !fromPeer && selfChatId != null && chatId === selfChatId;
    if (!fromPeer && !fromSelf) return null;
    if (fromSelf && p.selfMailed) return null;
    const r = await mail(hash, p, fromPeer ? p.chatId : selfChatId);
    if (r.error) { await drop(hash); return r; }
    if (fromPeer) await drop(hash);
    else { p.selfMailed = true; save(); }
    return { name: r.name, chatId: fromPeer ? p.chatId : selfChatId };
  }
  /**
   * Periodic and boot pass over the pending offers: an expired, undelivered
   * file goes out by email (or errors when too big); delivered offers are
   * withdrawn after DELIVERED_GRACE_MS (the receiver's other devices fetch in
   * the meantime); offers xfer.rs no longer has are dropped. Returns the
   * events: [{hash, name, chatId, action: "mailed"|"withdrawn"|"too-big"|"missing"}].
   */
  async function sweep() {
    if (!pending.size || !iroh?.status) return [];
    const hashes = [...pending.keys()];
    let st;
    try { st = (await iroh.status(hashes)) || {}; } catch { return []; }
    const out = [];
    const t = now();
    for (const hash of hashes) {
      const p = pending.get(hash);
      if (!p) continue;
      const s = st[hash];
      const ev = (action) => out.push({ hash, name: p.name, chatId: p.chatId, action });
      if (s === undefined) continue; // not asked / not answered: try later
      if (s === null) { await drop(hash); ev("missing"); continue; }
      if (s.delivered && !p.deliveredAt) { p.deliveredAt = t; save(); }
      const expired = Number(p.exp) * 1000 <= t;
      if (p.deliveredAt && (expired || t - p.deliveredAt >= DELIVERED_GRACE_MS)) { await drop(hash); ev("withdrawn"); continue; }
      if (expired) {
        const r = await mail(hash, { ...p, path: s.path || p.path }, p.chatId).catch(() => ({ error: "failed" }));
        if (r.error === "failed") continue; // core down: next sweep retries
        await drop(hash);
        ev(r.error || "mailed");
      }
    }
    return out;
  }
  return { send, receive, onResendRequest, sweep, pending, reload };
}
