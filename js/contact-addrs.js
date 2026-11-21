import { escapeHtml as esc } from "./format.js";
import { t } from "./i18n.js";


// Contact profile addresses (Pavel, 2026-11-01): one "Relays" list like
// Delta Chat's, primary (sending) address first with a badge. One address
// (no key, or a single-relay contact) is a plain "Address" row. Each address
// row copies on click / Enter.
export function contactAddrRowsHtml(addrs) {
  if (!addrs.length) return "";
  const addrRow = (a, i, key) => `<div class="info-row contact-addr" data-copy-addr="${esc(a)}" role="button" tabindex="0" title="${esc(t("Copy"))}"><span class="k">${esc(key)}</span><span class="v">${esc(a)}${i === 0 && addrs.length > 1 ? ` <span class="addr-primary-badge">${esc(t("Primary"))}</span>` : ""}</span></div>`;
  if (addrs.length === 1) return addrRow(addrs[0], 0, t("Address"));
  return `<div class="info-row contact-addr-head"><span class="k">${esc(t("Relays"))}</span><span class="v">(${addrs.length})</span></div>`
    + addrs.map((a, i) => addrRow(a, i, "")).join("");
}
