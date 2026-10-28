// invite-cards.js — Velta invite links rendered as cards in chat messages
// (docs/invite-cards.md):
//   • proxy invites   velta://ws?u=<wss url>&n=<name>&t=<token>
//   • relay invites   https://<relay>/i/<token>   (single-use account signup)
//   • DNS tunnels     velta://tunnel…
// A message carrying a relay AND a proxy invite (Veltar's /invite) gets one
// combined "account + proxy" card. Parsing is strict: anything malformed is
// not a card and stays ordinary text. Nothing is applied without a tap; the
// app supplies the actions (bindInviteCards) and reuses its confirm dialogs.
// The proxy token payload is readable without the HMAC key, so name, expiry
// and device cap show up front; relay tokens are opaque (server-side state).
import { escapeHtml, escapeAttr } from "./format.js";
import { t } from "./i18n.js";
import { ICON } from "./icons.js";
import { parseWsLink, buildWsLink, validWsToken, wsProxyHost } from "./ws-transport.js";
import { parseTunnelLink } from "./tunnel.js";
import { trimLinkEnd } from "./bare-links.js";

export const RELAY_LINK_MAX = 300;
const RELAY_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** DNS name with a dot and an alphabetic TLD; no IPs, ports or userinfo. */
export function validRelayHost(h) {
  if (typeof h !== "string" || !h || h.length > 253) return false;
  const labels = h.split(".");
  return labels.length >= 2 && labels.every(l => LABEL_RE.test(l)) && /^[a-z]{2,63}$/.test(labels.at(-1));
}

/** Strict https://<host>/i/<token>[/] → { kind, host, token, link } or null. */
export function parseRelayInviteLink(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > RELAY_LINK_MAX) return null;
  const m = /^https:\/\/([^/?#\s]+)\/i\/([^/?#\s]+)\/?$/i.exec(s);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/\.$/, "");
  const token = m[2];
  if (!validRelayHost(host) || !RELAY_TOKEN_RE.test(token) || token === "claim") return null;
  return { kind: "relay", host, token, link: `https://${host}/i/${token}` };
}

/** Lenient form for the Add-account field: scheme optional, http accepted. */
export function parseRelayInviteInput(raw) {
  const s = String(raw ?? "").trim().replace(/^https?:\/\//i, "");
  return parseRelayInviteLink(`https://${s}`);
}

function b64urlJson(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length > 700) return null;
  try {
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return null; }
}

/** Proxy invite token payload {v:1,i,n?,e?,u?} WITHOUT verifying the HMAC
 *  (display only — the proxy checks it). null when not exactly that shape. */
export function decodeWsTokenPayload(token) {
  if (!validWsToken(token)) return null;
  const p = b64urlJson(token.split(".")[0]);
  if (!p || typeof p !== "object" || Array.isArray(p) || p.v !== 1) return null;
  if (typeof p.i !== "string" || !p.i || p.i.length > 64) return null;
  for (const k of Object.keys(p)) if (!["v", "i", "n", "e", "u"].includes(k)) return null;
  if ("n" in p && (typeof p.n !== "string" || p.n.length > 64)) return null;
  if ("e" in p && !(Number.isSafeInteger(p.e) && p.e > 0)) return null;
  if ("u" in p && !(Number.isSafeInteger(p.u) && p.u >= 1 && p.u <= 10000)) return null;
  return { id: p.i, name: clean(p.n), expires: p.e ? p.e * 1000 : null, devices: p.u || null };
}

function clean(s) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 64);
}

/** Strict velta://ws invite → card model or null (a token must decode). */
export function parseProxyInvite(raw) {
  let p;
  try { p = parseWsLink(raw); } catch { return null; }
  const meta = p.token ? decodeWsTokenPayload(p.token) : null;
  if (p.token && !meta) return null;
  const host = wsProxyHost(p.url);
  if (!host) return null;
  return {
    kind: "proxy", url: p.url, label: clean(p.label), token: p.token, host,
    name: clean(p.label) || meta?.name || host,
    expires: meta?.expires ?? null, devices: meta?.devices ?? null,
    link: buildWsLink(p),
  };
}

/** Strict velta://tunnel link → card model or null. */
export function parseTunnelInvite(raw) {
  try {
    const tn = parseTunnelLink(raw);
    return { kind: "tunnel", zone: tn.zone, name: clean(tn.label) || tn.zone, link: String(raw).trim() };
  } catch { return null; }
}

const SCAN_MAX = 20000;
// Same token boundaries as markdown.js's link scan ([^\s<]), so a card exists
// exactly when the text shows the matching chip.
const CANDIDATE_RE = /\bhttps:\/\/[^\s<]+|\bvelta:\/\/(?:ws|tunnel)\b[^\s<]*/gi;


/** First valid invite of each kind in a message: { proxy, relay, tunnel }. */
export function findInviteLinks(text) {
  const out = { proxy: null, relay: null, tunnel: null };
  const s = String(text ?? "").slice(0, SCAN_MAX);
  for (const m of s.matchAll(CANDIDATE_RE)) {
    const u = trimLinkEnd(m[0]);
    if (/^https:/i.test(u)) out.relay ||= parseRelayInviteLink(u);
    else if (/^velta:\/\/ws/i.test(u)) out.proxy ||= parseProxyInvite(u);
    else out.tunnel ||= parseTunnelInvite(u);
  }
  return out;
}

/** Placeholder for the raw link inside the message text (token hidden). */
export function inviteLinkChipHtml(raw) {
  const r = parseRelayInviteLink(raw);
  const p = r ? null : parseProxyInvite(raw);
  const tn = r || p ? null : parseTunnelInvite(raw);
  const what = r ? t("Relay invite: {host}", { host: r.host })
    : p ? t("Proxy invite: {host}", { host: p.host })
    : tn ? t("DNS tunnel: {name}", { name: tn.name }) : null;
  if (!what) return null;
  return `<span class="ivc-chip">${ICON.link}<span>${escapeHtml(what)}</span></span>`;
}

function fmtDate(ms, lang) {
  try { return new Date(ms).toLocaleDateString(lang || undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}

function row(icon, text) {
  return `<li>${icon}<span>${escapeHtml(text)}</span></li>`;
}

function btn(act, label, { primary = false, disabled = false, aria = "", icon = "" } = {}) {
  return `<button type="button" class="ivc-btn${primary ? " ivc-primary" : ""}" data-ivc-act="${act}"` +
    `${disabled ? ` disabled aria-disabled="true"` : ""}${aria ? ` aria-label="${escapeAttr(aria)}"` : ""}>` +
    `${icon}<span>${escapeHtml(label)}</span></button>`;
}

/** Card HTML for one message's invites ("" when none). opts: sender, now, lang. */
export function inviteCardsHtml(text, { sender = "", now = Date.now(), lang = "" } = {}) {
  const { proxy, relay, tunnel } = findInviteLinks(text);
  const cards = [];
  const proxyExpired = !!(proxy?.expires && proxy.expires <= now);
  const from = sender ? `<p class="ivc-from">${escapeHtml(t("From {name}", { name: clean(sender) }))}</p>` : "";
  const expiryRow = p => p.expires
    ? row(ICON.clock, (p.expires <= now ? t("Expired on {date}") : t("Expires {date}")).replace("{date}", fmtDate(p.expires, lang)))
    : row(ICON.clock, t("No expiry"));
  const devRow = p => p.devices ? row(ICON.devices, p.devices === 1 ? t("For 1 device") : t("For up to {n} devices", { n: p.devices })) : "";
  const linksAttr = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => ` data-ivc-${k}="${escapeAttr(v)}"`).join("");
  const shell = (cls, title, icon, body, acts, links, expired, shown) => {
    return `<div class="ivc ${cls}${expired ? " ivc-expired" : ""}" role="group" aria-label="${escapeAttr(title + (expired ? ` (${t("Expired")})` : ""))}"${linksAttr(links)}>` +
      `<div class="ivc-head">${icon}<span class="ivc-title">${escapeHtml(title)}</span>` +
      `${expired ? `<span class="ivc-badge">${escapeHtml(t("Expired"))}</span>` : ""}</div>` +
      from + `<ul class="ivc-meta" role="list">${body}</ul>` +
      `<div class="ivc-acts">${acts}` +
      btn("show", t("Show link"), { aria: t("Show the invite link") }) +
      btn("copy", "", { aria: t("Copy invite link"), icon: ICON.copy }) +
      `</div><code class="ivc-link" hidden>${escapeHtml(shown)}</code></div>`;
  };
  if (relay && proxy) {
    cards.push(shell("ivc-combined", t("Join {relay}: account + proxy", { relay: relay.host }), ICON.invite,
      row(ICON.profileAdd, t("New account on {host}", { host: relay.host })) +
      row(ICON.wsTransport, t("Proxy: {name} ({host})", { name: proxy.name, host: proxy.host })) +
      expiryRow(proxy) + devRow(proxy),
      btn("join", t("Join"), { primary: true, disabled: proxyExpired, aria: t("Join {relay}: set up the proxy, then create an account", { relay: relay.host }) }),
      { relay: relay.link, proxy: proxy.link }, proxyExpired, `${relay.link}\n${proxy.link}`));
  } else if (relay) {
    cards.push(shell("ivc-relay", t("Account invite: {host}", { host: relay.host }), ICON.profileAdd,
      row(ICON.globe, t("Relay: {host}", { host: relay.host })) + row(ICON.clock, t("Single use; expiry is checked when you join")),
      btn("create", t("Create account"), { primary: true, aria: t("Create an account on {host}", { host: relay.host }) }),
      { relay: relay.link }, false, relay.link));
  } else if (proxy) {
    cards.push(shell("ivc-proxy", t("Proxy invite: {name}", { name: proxy.name }), ICON.wsTransport,
      row(ICON.globe, t("Server: {host}", { host: proxy.host })) + expiryRow(proxy) + devRow(proxy),
      btn("use", t("Use proxy"), { primary: true, disabled: proxyExpired, aria: t("Use proxy {name}", { name: proxy.name }) }) +
      btn("save", t("Save"), { disabled: proxyExpired, aria: t("Save proxy {name} without using it", { name: proxy.name }) }),
      { proxy: proxy.link }, proxyExpired, proxy.link));
  }
  if (tunnel) {
    cards.push(shell("ivc-tunnel", t("DNS tunnel: {name}", { name: tunnel.name }), ICON.tunnel,
      row(ICON.globe, t("Domain: {zone}", { zone: tunnel.zone })),
      btn("tunnel", t("Set up tunnel"), { primary: true, aria: t("Set up DNS tunnel {name}", { name: tunnel.name }) }),
      { tunnel: tunnel.link }, false, tunnel.link));
  }
  return cards.join("");
}

/** Relay /i/claim answer → { email, password } or throws a readable Error. */
export function relayClaimResult(status, body) {
  const ok = status === 200 && body && typeof body.email === "string" && typeof body.password === "string" && body.email.includes("@") && body.password;
  if (ok) return { email: body.email, password: body.password };
  if (status === 200) throw new Error(t("The relay's answer had no account details. Try again later."));
  const why = {
    400: t("The invite link is damaged."),
    403: t("This invite is not valid. Ask for a new one."),
    404: t("This relay doesn't accept invites."),
    409: t("This invite has already been used. Ask for a new one."),
    410: t("This invite has expired. Ask for a new one."),
    503: t("The relay can't create accounts right now. Try again later; the invite was not used."),
  }[status];
  throw new Error(why || t("The relay answered with an error ({status}). Try again later.", { status: status || "?" }));
}

/** Document-level actions (capture; survives re-renders). handlers:
 *  useProxy(link), saveProxy(link), createAccount({host,token}),
 *  join({proxy, relay}), tunnel(link), copy(text). */
export function bindInviteCards(handlers, root = document) {
  root.addEventListener("click", async ev => {
    const b = ev.target?.closest?.("[data-ivc-act]");
    const card = b?.closest?.(".ivc");
    if (!card || b.disabled) return;
    ev.preventDefault();
    ev.stopPropagation();
    const d = card.dataset;
    const relay = d.ivcRelay ? parseRelayInviteLink(d.ivcRelay) : null;
    switch (b.dataset.ivcAct) {
      case "show": {
        const code = card.querySelector(".ivc-link");
        const open = code.hidden;
        code.hidden = !open;
        b.setAttribute("aria-expanded", String(open));
        b.querySelector("span").textContent = open ? t("Hide link") : t("Show link");
        return;
      }
      case "copy": return handlers.copy?.([d.ivcRelay, d.ivcProxy, d.ivcTunnel].filter(Boolean).join("\n"));
      case "use": return handlers.useProxy?.(d.ivcProxy);
      case "save": return handlers.saveProxy?.(d.ivcProxy);
      case "create": return relay && handlers.createAccount?.(relay);
      case "join": return relay && handlers.join?.({ proxy: d.ivcProxy, relay });
      case "tunnel": return handlers.tunnel?.(d.ivcTunnel);
    }
  }, true);
}
