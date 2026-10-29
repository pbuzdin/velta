// join.js — velta.cc/join/ invite landing. The invite is the i.delta.chat
// fragment payload (FPR&v=3&x=…&s=…&a=…&n=…&g=…&b=…) carried in the query
// string instead of the hash: /join/?invite=<urlencoded> or raw /join/?FPR&v=3&…
// Pure helpers are exported for join.test.mjs; the DOM pass only runs in a page.

import { qrSvg } from "./qr-encode.js";

/**
 * Parse an invite payload into { fp, rest, params }. Accepts the raw query
 * (?FPR&v=3&…), ?invite=<value>, a full invite link pasted as the value, and
 * the OPENPGP4FPR:FPR#rest QR-text form. Returns null when the first segment
 * is not a 40-hex OpenPGP fingerprint. `rest` keeps the & separator form so
 * it round-trips into links and QR text.
 */
export function parsePayload(s) {
  s = String(s ?? "").trim()
    .replace(/^[?#]/, "")
    .replace(/^https?:\/\/[^#\s]*?[#?]/i, "")
    .replace(/^openpgp4fpr:/i, "")
    .replace(/%23/gi, "#"); // Safari/iOS encodes the # (i.delta.chat #16)
  const m = s.match(/^([0-9A-Fa-f]{40})(?:[#&]([\s\S]*))?$/);
  if (!m) return null;
  const fp = m[1].toUpperCase();
  const rest = m[2] || "";
  const params = {};
  for (const part of rest.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
    let value = eq === -1 ? "" : part.slice(eq + 1);
    try { value = decodeURIComponent(value.replace(/\+/g, "%20")); } catch { /* keep raw */ }
    params[key] = value;
  }
  return { fp, rest, params };
}

/** What the app's QR scanner expects (the form core's qr.rs accepts). */
export function qrText({ fp, rest }) {
  return "OPENPGP4FPR:" + fp + (rest ? "#" + rest : "");
}

/** The canonical shareable link on this site. */
export function shareUrl(origin, { fp, rest }) {
  return origin + "/join/?" + fp + (rest ? "&" + rest : "");
}

/**
 * Human label from the link's own params — same semantics as the app's
 * invites.js: n= inviter name, a= address, g= group, b= broadcast channel.
 */
export function label({ params }) {
  const addr = params.a || "";
  const actor = params.n || addr.split("@")[0] || "someone";
  if (params.b) return { kind: "channel", actor, group: params.b, addr };
  if (params.g) return { kind: "group", actor, group: params.g, addr };
  return { kind: "person", actor, group: null, addr };
}

// --- page pass ---------------------------------------------------------------

if (typeof document !== "undefined" && document.getElementById("invite-open")) {
  const sp = new URLSearchParams(location.search);
  // ?invite=<value>, the raw query, or a fragment form (velta.cc/join/#FPR&…)
  const parsed = parsePayload(sp.get("invite") ?? (location.search || location.hash));
  if (parsed) {
    const info = label(parsed);
    document.title = (info.kind === "person"
      ? `Say hello to ${info.actor}`
      : info.kind === "group" ? `Join ${info.group}` : `Subscribe to ${info.group}`)
      + " — Velta";
    document.getElementById("invite-title").textContent =
      info.kind === "person" ? `Say hello to ${info.actor}.`
        : info.kind === "group" ? `Join ${info.group}.`
        : `Subscribe to ${info.group}.`;
    const who = info.kind === "person"
      ? info.actor + (info.addr && info.addr !== info.actor ? ` (${info.addr})` : "")
      : `${info.actor} invited you to ${info.kind === "group" ? "the group" : "the channel"} “${info.group}”`;
    document.getElementById("invite-lede").textContent =
      `${who} — over Velta, messages are end-to-end encrypted. Open the invite in Velta to start chatting.`;
    document.getElementById("invite-open").href = qrText(parsed);
    const wrap = document.getElementById("invite-qr-wrap");
    wrap.hidden = false;
    document.getElementById("invite-qr").innerHTML = qrSvg(qrText(parsed));
  }
}
