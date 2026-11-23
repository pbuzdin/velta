import { t } from "./i18n.js";
// iroh-xfer.js — automatic iroh file transfer for Velta ↔ Velta 1:1 chats
// (#470). The engine is velta-app/src-tauri/src/xfer.rs (Tauri commands
// xfer_offer / xfer_fetch / xfer_withdraw); this module holds the policy and
// the message formats, pure so node tests cover them.
//
// Rule: a 1:1 attachment strictly over 6 MB to a Velta contact goes over iroh
// when the setting is on (default). Everything else is a normal email
// attachment. The ticket only names the chatmail relay's own advertised iroh
// relay — never n0's — and with none advertised the fetch is direct-only and
// falls back to email when the sender is unreachable.

export const THRESHOLD = 6 * 1024 * 1024;
export const TICKET_PREFIX = "VXFER1:";
export const FALLBACK_PREFIX = "VXFER-RESEND:";
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
 * core's get_server_metadata ({addr: {iroh_relay, …}}). Null when none:
 * the transfer then runs direct-only. Only https URLs are taken.
 */
export function advertisedRelay(metadata, addr) {
  const pick = (m) => (m && typeof m.iroh_relay === "string" && /^https:\/\/[^\s/]+/.test(m.iroh_relay) ? m.iroh_relay : null);
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
 * Text of the small encrypted message that replaces the attachment: a
 * readable first line (what a non-Velta device of the same person shows)
 * and the ticket on its own line.
 */
export function fileCardText({ name, size, ticket }) {
  return `${t("📎 {name} · {size} — sent directly from device to device", { name, size: fmtSize(size) })}\n${ticket}`;
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
  return route === "iroh" ? t("Sent directly (iroh)") : t("Sent by email");
}

export const SETTING_LABEL = () => t("Send large files directly");
export const SETTING_HINT = () => t("Files over 6 MB to Velta contacts go device to device. If that fails, Velta sends them by email.");

/**
 * One send/receive API over two backends (#470 phase 1, files):
 *   email: { sendFile(chatId, file), sendText(chatId, text) }   — core / chatmail
 *   iroh:  { offer(path, relay) -> ticket, fetch(ticket, relay) -> {path}|{error, email},
 *            withdraw(hash) } | null                              — xfer.rs (Tauri)
 *   relay(): the advertised iroh relay or null; enabled(): the setting.
 * The caller says whether the chat is 1:1 with a Velta contact.
 * Returns { send, receive, onResendRequest, pending }.
 */
export function createTransport({ email, iroh, relay = async () => null, enabled = () => irohXferEnabled() }) {
  const pending = new Map(); // hash -> {chatId, file} kept until fetched, mailed or expired
  async function send({ chatId, file, oneToOne, peerIsVelta }) {
    const route = chooseRoute({ size: file.size, oneToOne, peerIsVelta, enabled: enabled(), available: !!iroh });
    if (route === "email") { await email.sendFile(chatId, file); return { route }; }
    try {
      const ticket = await iroh.offer(file.path, await relay());
      const tk = decodeTicket(ticket);
      if (!tk) throw new Error("bad ticket");
      pending.set(tk.hash, { chatId, file, exp: tk.exp });
      await email.sendText(chatId, fileCardText({ name: file.name, size: file.size, ticket }));
      return { route: "iroh", hash: tk.hash };
    } catch {
      await email.sendFile(chatId, file); // could not offer: mail it right away
      return { route: "email" };
    }
  }
  /** A received text: fetch a file card over iroh, or ask for the email copy. */
  async function receive({ chatId, text }) {
    const card = parseFileCard(text);
    if (!card) return null;
    if (!iroh) { await email.sendText(chatId, resendRequestText(card.tk.hash)); return { route: "email", asked: true }; }
    const r = await iroh.fetch(card.ticket, await relay());
    if (r && r.path) return { route: "iroh", path: r.path };
    if (r && r.email) { await email.sendText(chatId, resendRequestText(card.tk.hash)); return { route: "email", asked: true, error: r.error }; }
    return { route: "iroh", error: r?.error || "failed", retry: true }; // broken stream: retry resumes
  }
  /** Sender: the receiver could not fetch — mail the file and stop offering it. */
  async function onResendRequest({ text }) {
    const hash = parseResendRequest(text);
    const p = hash && pending.get(hash);
    if (!p) return false;
    pending.delete(hash);
    await iroh?.withdraw(hash);
    await email.sendFile(p.chatId, p.file);
    return true;
  }
  return { send, receive, onResendRequest, pending };
}
