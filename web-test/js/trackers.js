// trackers.js — drop known tracking query params from http(s) links (#89).
// One list for paste and for open. Non-http schemes and invite fragments
// (40-hex hash) are left alone. Default on; "0" in localStorage turns it off.

const KEY = "velta-strip-trackers";

// Names that are click-ids on their own. Short generic names (s, t, si, tag)
// are host-limited below so a normal ?id= or ?s= is kept.
const CLICK_IDS = new Set([
  "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid",
  "gad_source", "gad_campaignid", "srsltid",
  "msclkid", "mc_cid", "mc_eid",
  "igshid", "igsh", "ttclid", "twclid", "yclid",
  "_hsenc", "_hsmi", "mkt_tok",
  "vero_id", "vero_conv", "li_fat_id",
]);

export function trackingStripEnabled() {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}

export function setTrackingStripEnabled(on) {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "0");
  } catch { /* private mode */ }
}

function hostIs(host, root) {
  return host === root || host.endsWith("." + root);
}

function extraNames(host) {
  if (host === "youtu.be" || hostIs(host, "youtube.com") || hostIs(host, "youtube-nocookie.com")) return ["si"];
  if (hostIs(host, "spotify.com")) return ["si"];
  if (hostIs(host, "x.com") || hostIs(host, "twitter.com")) return ["s", "t", "ref_src", "ref_url"];
  if (host === "amzn.to" || hostIs(host, "amazon.com") || host.startsWith("amazon.")) return ["tag", "linkcode", "linkid", "ascsubtag"];
  return [];
}

function isInvite(url) {
  const hash = url.hash.replace(/^#\/?/, "");
  return /^[0-9a-f]{40}(?:[&#]|$)/i.test(hash);
}

function isTracker(name, host) {
  const n = name.toLowerCase();
  if (n.startsWith("utm_") || n.startsWith("hsa_")) return true;
  if (CLICK_IDS.has(n)) return true;
  return extraNames(host).includes(n);
}

// Original string when nothing was removed, so a clean URL is not re-serialized.
export function stripTrackingUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return raw; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
  if (isInvite(url)) return raw;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let removed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (!isTracker(key, host)) continue;
    url.searchParams.delete(key);
    removed = true;
  }
  if (!removed) return raw;
  if ([...url.searchParams].length === 0) url.search = "";
  return url.href;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

// Rewrite http(s) URLs inside pasted text. Trailing sentence punctuation stays.
export function stripTrackingText(text) {
  const src = String(text || "");
  if (!trackingStripEnabled()) return { text: src, changed: false };
  let changed = false;
  const next = src.replace(URL_RE, (m) => {
    const cut = m.replace(/[.,;:!?]+$/, "");
    const cleaned = stripTrackingUrl(cut);
    if (cleaned === cut) return m;
    changed = true;
    return cleaned + m.slice(cut.length);
  });
  return { text: changed ? next : src, changed };
}
