// invite-domains.js — "Invite link domain" pill tabs on the invite QR screens.
// The core always makes https://i.delta.chat/#<fragment>; the fragment holds
// the whole invite and never reaches a server, so the host is cosmetic and
// any registered mirror (invites.js registry) can carry it. The default tab
// is velta.cc, which shares the payload as a velta.cc/join/?… link that the
// /join/ landing page parses; i.delta.chat keeps the core's own styled card.
import { getInviteHosts } from "./invites.js";
import { encodeQr, qrPathData, VELTA_QR_LOGO } from "./qr-encode.js";
import { escapeHtml, escapeAttr } from "./components.js";
import { t } from "./i18n.js";

export const DOMAIN_KEY = "velta-invite-domain";
export const DEFAULT_DOMAIN = "velta.cc";
const CORE_HOST = "i.delta.chat";
const CORE_PREFIX = `https://${CORE_HOST}/#`;

/** Swap the host of a core invite link; the payload stays byte-identical.
 *  velta.cc carries it in the query string (the /join/ landing page's form),
 *  the i.delta.chat mirrors keep the fragment form. */
export function rewriteInviteHost(link, host) {
  const s = String(link || "");
  if (!s.startsWith(CORE_PREFIX)) return s;
  const payload = s.slice(CORE_PREFIX.length);
  if (host === DEFAULT_DOMAIN) return `https://${DEFAULT_DOMAIN}/join/?${payload}`;
  if (host === CORE_HOST) return s;
  return `https://${host}/#${payload}`;
}

/** Registered domains, velta.cc first. */
export function inviteDomains(hosts = getInviteHosts()) {
  return [DEFAULT_DOMAIN, ...hosts.filter(h => h !== DEFAULT_DOMAIN)];
}

/** Last chosen domain, or velta.cc when unset / no longer registered. */
export function chosenDomain(hosts = inviteDomains()) {
  let v = null;
  try { v = localStorage.getItem(DOMAIN_KEY); } catch {}
  return v && hosts.includes(v) ? v : DEFAULT_DOMAIN;
}

export function rememberDomain(host) {
  try {
    if (host === DEFAULT_DOMAIN) localStorage.removeItem(DOMAIN_KEY);
    else localStorage.setItem(DOMAIN_KEY, host);
  } catch {}
}

/** Plain 512x512 QR (48px white quiet zone, ECC >= M) with the Velta logo. */
export function brandedQrSvg(text) {
  const qr = encodeQr(text);
  const scale = +(416 / qr.size).toFixed(6);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#fff"/><g transform="translate(48,48)"><path shape-rendering="crispEdges" fill="#000" d="${qrPathData(qr)}" transform="scale(${scale})"/></g>${VELTA_QR_LOGO}</svg>`;
}

/** Pill tablist markup; "" when only one domain applies. */
export function domainTabsHtml(hosts, selected) {
  if (hosts.length < 2) return "";
  return `<div class="domain-tabs" role="tablist" aria-label="${escapeAttr(t("Invite link domain"))}">` +
    hosts.map(h => `<button type="button" role="tab" class="domain-tab" data-domain="${escapeAttr(h)}" aria-selected="${h === selected}" tabindex="${h === selected ? 0 : -1}">${escapeHtml(h)}</button>`).join("") +
    `</div>`;
}

/**
 * Fill `holder` with the tabs and drive the QR: apply(svg, link, isDefault)
 * runs now for the remembered domain and again on every pick; callers show
 * `link` and use it for Copy / Share.
 */
export function mountInviteDomains(holder, { svg, link }, apply) {
  const hosts = inviteDomains();
  let sel = chosenDomain(hosts);
  const show = () => {
    // i.delta.chat keeps the core's styled card; every other domain gets a
    // plain QR that already carries the Velta logo.
    const isCore = sel === CORE_HOST || !String(link || "").startsWith(CORE_PREFIX);
    const l = isCore ? link : rewriteInviteHost(link, sel);
    apply(isCore ? svg : brandedQrSvg(l), l, isCore);
  };
  if (holder && link && String(link).startsWith(CORE_PREFIX)) {
    holder.innerHTML = domainTabsHtml(hosts, sel);
    const tabs = [...holder.querySelectorAll("[role=tab]")];
    const pick = (h, focus) => {
      sel = h;
      rememberDomain(h);
      for (const b of tabs) {
        const on = b.dataset.domain === h;
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      }
      show();
    };
    holder.addEventListener("click", e => {
      const b = e.target.closest?.("[role=tab]");
      if (b) pick(b.dataset.domain, false);
    });
    holder.addEventListener("keydown", e => {
      const i = tabs.findIndex(b => b.dataset.domain === sel);
      const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (n === undefined || !tabs.length) return;
      e.preventDefault();
      pick(tabs[(n + tabs.length) % tabs.length].dataset.domain, true);
    });
  } else if (holder) holder.innerHTML = "";
  show();
}
