// Optional DNS tunnel (Android and Windows apps): UI side of
// velta-app/src-tauri/src/tunnel.rs + velta-app/soar-tunnel.
//
// The tunnel exists only after the user accepts a velta://tunnel?… link; the
// server zone and key are never part of this code. Until then nothing here
// shows up and the app behaves exactly as upstream Velta.
//
// Several tunnels can be saved (tunnels.json in the shell); one or none is
// active. Shell commands: tunnel_preview, tunnel_install, tunnel_list,
// tunnel_select, tunnel_rename, tunnel_delete, tunnel_link, tunnel_status,
// tunnel_set_mode, tunnel_network_changed, share_text.
import { escapeHtml } from "./format.js";
import { tauriInvoke } from "./tauri.js";
import { t } from "./i18n.js";
import { ICON } from "./icons.js";

const MODES = [
  ["auto", "Automatic", "Direct while the relays answer; through the tunnel when only allowlisted sites work."],
  ["always", "Always", "Every connection goes through the tunnel. Slower; use it if Automatic misjudges the network."],
  ["off", "Off", "Never use the tunnel. Mail connects directly, as without it."],
];

let cached = { installed: false, available: false };



function errMsg(e) {
  return e?.message || String(e);
}

/** Returns the link if rawUrl is a velta://tunnel setup link, else null. */
export function extractTunnelLink(rawUrl) {
  const s = String(rawUrl || "").trim();
  return /^velta:\/\/tunnel(?:[?#/]|$)/i.test(s) ? s : null;
}

// Link format (docs/dns-tunnel-link.md), parsed again by the Go library:
//   v1: velta://tunnel?v=1&zone=<domain>&key=<base64 32 bytes>[&r=<ip[:port],…>][&c=<host:port,…>][&n=<label>]
//   v2: velta://tunnel/2/<ZONE>/<KEY base32>[/R/…][/C/…][/N/…] (see parseV2)
// The page checks it strictly first so a malformed or oversized link never
// reaches the shell and the confirmation shows only validated values.
export const TUNNEL_LINK_MAX = 2048;
export const TUNNEL_LABEL_MAX = 64;
const TUNNEL_PARAMS = new Set(["v", "zone", "key", "r", "c", "n"]);
const MAX_RESOLVERS = 64;
const MAX_CANARIES = 16;
const LABEL_KEY = "velta-tunnel-label";

class TunnelLinkError extends Error {}
const bad = msg => { throw new TunnelLinkError(msg); };

/** Same rules as checkZone in soar-tunnel/tunnel/config.go. */
export function validTunnelZone(z) {
  if (typeof z !== "string" || !z || z.length > 200) return false;
  const labels = z.split(".");
  if (labels.length < 2) return false;
  return labels.every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) && !/^[0-9]+$/.test(labels.at(-1));
}

/** Server Ed25519 public key: standard or URL-safe base64, padded or not, 32 bytes. */
export function normalizeTunnelKey(k) {
  if (typeof k !== "string" || k.length < 43 || k.length > 44) return null;
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(k)) return null;
  if (/[+/]/.test(k) && /[_-]/.test(k)) return null;
  const std = k.replace(/-/g, "+").replace(/_/g, "/").replace(/=$/, "");
  // 43 chars = 258 bits: the last char may only carry 4 data bits.
  if (!/[AEIMQUYcgkosw048]$/.test(std)) return null;
  return std + "=";
}

function validIPv4(s) {
  const p = s.split(".");
  return p.length === 4 && p.every(x => /^(?:0|[1-9][0-9]{0,2})$/.test(x) && Number(x) <= 255);
}
function validIPv6(s) {
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(s) || (s.match(/::/g) || []).length > 1) return false;
  try { return new URL(`http://[${s}]/`).hostname.length > 2; } catch { return false; }
}
function validPort(p) {
  return /^[1-9][0-9]{0,4}$/.test(p) && Number(p) <= 65535;
}
/** ip, ip:port, [ipv6]:port or a bare IPv6 address (port 53). */
export function validTunnelResolver(r) {
  if (validIPv4(r) || validIPv6(r)) return true;
  let m = /^\[([^\]]+)\]:([0-9]+)$/.exec(r);
  if (m) return validIPv6(m[1]) && validPort(m[2]);
  m = /^([0-9.]+):([0-9]+)$/.exec(r);
  return !!m && validIPv4(m[1]) && validPort(m[2]);
}
function validCanary(c) {
  const m = /^([a-z0-9.-]+):([0-9]+)$/i.exec(c);
  return !!m && validTunnelZone(m[1].toLowerCase()) && validPort(m[2]);
}
function cleanLabel(n) {
  // Display text only: no control or bidi-override characters.
  const s = n.normalize("NFC").trim();
  if (/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s)) bad("The label has invalid characters");
  if ([...s].length > TUNNEL_LABEL_MAX) bad(`The label is too long (max ${TUNNEL_LABEL_MAX})`);
  return s;
}
function list(raw, max, ok, what) {
  const items = raw.split(",").map(x => x.trim()).filter(Boolean);
  if (items.length > max) bad(`Too many ${what} (max ${max})`);
  for (const x of items) if (!ok(x)) bad(`Bad ${what.replace(/s$/, "")}: ${x.slice(0, 60)}`);
  return [...new Set(items)];
}

// Base32 (RFC 4648, no padding): uppercase output, either case accepted.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(bytes) {
  let out = "", acc = 0, n = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; n += 8;
    while (n >= 5) { out += B32[(acc >>> (n - 5)) & 31]; n -= 5; }
    acc &= (1 << n) - 1;
  }
  if (n) out += B32[(acc << (5 - n)) & 31];
  return out;
}
/** Strict: canonical length, zero trailing bits. Returns bytes or null. */
export function base32Decode(str) {
  const s = String(str).toUpperCase();
  if (!/^[A-Z2-7]*$/.test(s) || [1, 3, 6].includes(s.length % 8)) return null;
  const out = [];
  let acc = 0, n = 0;
  for (const c of s) {
    acc = (acc << 5) | B32.indexOf(c); n += 5;
    if (n >= 8) { out.push((acc >>> (n - 8)) & 255); n -= 8; }
    acc &= (1 << n) - 1;
  }
  return acc === 0 ? Uint8Array.from(out) : null;
}
const keyToB32 = std => base32Encode(Uint8Array.from(atob(std), c => c.charCodeAt(0)));
function keyFromB32(s) {
  const b = s.length === 52 ? base32Decode(s) : null;
  return b && b.length === 32 ? btoa(String.fromCharCode(...b)) : null;
}

// v2 (docs/dns-tunnel-link.md): every byte after "velta://" is in the QR
// alphanumeric set (0-9 A-Z space $%*+-./:), so a QR encodes it at 5.5 bits
// a char instead of 8. Scheme and host stay lowercase: Android matches
// intent-filter schemes/hosts case-sensitively.
//   velta://tunnel/2/<ZONE>/<KEY base32>[/R/<ip[*port]>+…][/C/<HOST*port>+…][/N/<label base32>]
const V2_RE = /^velta:\/\/tunnel\/2\/([^/?#]+)\/([A-Za-z2-7]{52})((?:\/[RCN]\/[^/?#]+)*)$/i;
function v2Resolver(r) {
  // ip | ip*port  (IPv6 without brackets; ":" is part of the address)
  const m = /^([0-9A-Fa-f:.]+)(?:\*([0-9]+))?$/.exec(r);
  if (!m) return null;
  const ip = m[1].toLowerCase();
  if (!(ip.includes(":") ? validIPv6(ip) : validIPv4(ip))) return null;
  if (!m[2]) return ip;
  return validIPv4(ip) ? `${ip}:${m[2]}` : `[${ip}]:${m[2]}`;
}
function parseV2(m) {
  const zone = m[1].toLowerCase().replace(/\.$/, "");
  if (!validTunnelZone(zone)) bad("The tunnel domain is not valid");
  const key = keyFromB32(m[2]);
  if (!key) bad("The key must be 32 bytes of base32");
  const seen = new Map();
  const rest = m[3] ? m[3].slice(1).split("/") : [];
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i].toUpperCase();
    if (seen.has(k)) bad(`Repeated parameter: ${k}`);
    seen.set(k, rest[i + 1]);
  }
  const items = (k, conv) => (seen.get(k) || "").split("+").map(x => conv(x) ?? bad(`Bad value: ${x.slice(0, 60)}`));
  const resolvers = seen.has("R") ? list(items("R", v2Resolver).join(","), MAX_RESOLVERS, validTunnelResolver, "resolvers") : [];
  const canaries = seen.has("C")
    ? list(items("C", c => (/^[^*]+\*[0-9]+$/.test(c) ? c.toLowerCase().replace("*", ":") : null)).join(","), MAX_CANARIES, validCanary, "canaries") : [];
  let label = "";
  if (seen.has("N")) {
    const b = base32Decode(seen.get("N"));
    if (!b) bad("The label is not encoded correctly");
    try { label = cleanLabel(new TextDecoder("utf-8", { fatal: true }).decode(b)); } catch (e) { if (e instanceof TunnelLinkError) throw e; bad("The label is not encoded correctly"); }
  }
  return { version: 2, zone, key, resolvers, canaries, label };
}

/**
 * Strictly parses a velta://tunnel link (v1 query form or v2 path form). Returns
 * {version, zone, key, resolvers, canaries, label}; throws on anything off:
 * other schemes/hosts, a path, unknown or repeated parameters, a future
 * version, oversized values.
 */
export function parseTunnelLink(raw) {
  const s = String(raw ?? "").trim();
  if (!s) bad("Empty link");
  if (s.length > TUNNEL_LINK_MAX) bad("The link is too long");
  const m2 = V2_RE.exec(s);
  if (m2) return parseV2(m2);
  const fut = /^velta:\/\/tunnel\/([0-9]+)\//i.exec(s);
  if (fut && fut[1] !== "2") bad(`Unsupported link version ${fut[1].slice(0, 10)}: update Velta`);
  if (fut) bad("The link is not valid");
  const m = /^velta:\/\/tunnel\/?(?:\?([^#]*))?$/i.exec(s);
  if (!m) bad("Not a velta://tunnel link");
  const seen = new Map();
  for (const part of (m[1] || "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq < 0 ? part : part.slice(0, eq);
    let v;
    try { v = decodeURIComponent((eq < 0 ? "" : part.slice(eq + 1)).replace(/\+/g, "%20")); } catch { bad("The link is not encoded correctly"); }
    if (!TUNNEL_PARAMS.has(k)) bad(`Unknown parameter: ${k.slice(0, 20)}`);
    if (seen.has(k)) bad(`Repeated parameter: ${k}`);
    seen.set(k, v);
  }
  const version = seen.has("v") ? seen.get("v") : "1";
  if (version !== "1") bad(`Unsupported link version ${version.slice(0, 10)}: update Velta`);
  const zone = (seen.get("zone") || "").trim().toLowerCase().replace(/\.$/, "");
  if (!zone) bad("The link has no tunnel domain");
  if (!validTunnelZone(zone)) bad("The tunnel domain is not valid");
  const key = normalizeTunnelKey((seen.get("key") || "").trim());
  if (!key) bad("The key must be 32 bytes of base64");
  const resolvers = seen.has("r") ? list(seen.get("r"), MAX_RESOLVERS, validTunnelResolver, "resolvers") : [];
  const canaries = seen.has("c") ? list(seen.get("c"), MAX_CANARIES, validCanary, "canaries") : [];
  const label = seen.has("n") ? cleanLabel(seen.get("n")) : "";
  return { version: 1, zone, key, resolvers, canaries, label };
}

/** v1 query form. Also what the page hands the shell (any Go library build parses it). */
export function buildTunnelLinkV1({ zone, key, resolvers = [], canaries = [], label = "" }) {
  const k = String(key || "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const parts = ["v=1", `zone=${encodeURIComponent(zone)}`, `key=${k}`];
  if (resolvers?.length) parts.push(`r=${resolvers.map(encodeURIComponent).join(",")}`);
  if (canaries?.length) parts.push(`c=${canaries.map(encodeURIComponent).join(",")}`);
  if (label) parts.push(`n=${encodeURIComponent(label)}`);
  return `velta://tunnel?${parts.join("&")}`;
}

/** Canonical link for sharing (QR, copy): v2, alphanumeric after "velta://". */
export function buildTunnelLink({ zone, key, resolvers = [], canaries = [], label = "" }) {
  const std = normalizeTunnelKey(String(key || "").trim());
  if (!std) bad("The key must be 32 bytes of base64");
  let out = `velta://tunnel/2/${String(zone).toUpperCase()}/${keyToB32(std)}`;
  const res = r => {
    const m = /^\[(.+)\]:([0-9]+)$/.exec(r) || /^([0-9.]+):([0-9]+)$/.exec(r);
    return (m ? `${m[1]}*${m[2]}` : r).toUpperCase();
  };
  if (resolvers?.length) out += `/R/${resolvers.map(res).join("+")}`;
  if (canaries?.length) out += `/C/${canaries.map(c => c.replace(/:([0-9]+)$/, "*$1").toUpperCase()).join("+")}`;
  if (label) out += `/N/${base32Encode(new TextEncoder().encode(label.normalize("NFC")))}`;
  return out;
}

function storedLabel() {
  try { return globalThis.localStorage?.getItem(LABEL_KEY) || ""; } catch { return ""; }
}
function storeLabel(label) {
  try {
    if (label) globalThis.localStorage?.setItem(LABEL_KEY, label);
    else globalThis.localStorage?.removeItem(LABEL_KEY);
  } catch {}
}

const UNSUPPORTED_MSG = "DNS tunnel links work only in the Velta app for Android or Windows. Open this link there.";

/** The shell has no tunnel on this platform (macOS, Linux): `unsupported`
 * from current shells, the old "only available" error from older ones. */
export function tunnelUnsupported(s) {
  return !!s && !s.installed && (s.unsupported === true || (s.available === false && /only available|not available on this platform/i.test(s.error || "")));
}

/** Last known status (sync, for drawer rendering). */
export function tunnelInstalled() {
  return !!cached.installed;
}

export function tunnelStatus() {
  return cached;
}

export async function refreshTunnelStatus(events = 0, invoke = tauriInvoke()) {
  if (!invoke) return (cached = { installed: false, available: false });
  try {
    cached = await invoke("tunnel_status", { events });
    await migrateLegacyLabel(cached, invoke);
  } catch (e) {
    cached = { installed: false, available: false, error: errMsg(e) };
  }
  return cached;
}

/** Upgrade from the single-tunnel version: its label lived in this
 * WebView's storage, the shell moved the tunnel itself into the list. Give
 * that (active, unnamed) entry the label once, then drop the old key. */
export async function migrateLegacyLabel(s, invoke) {
  const label = storedLabel();
  if (!label || !s?.installed || typeof s.count !== "number") return;
  if (s.active && !s.active_label) {
    try {
      await invoke("tunnel_rename", { id: s.active, label });
      s.active_label = label;
    } catch { return; }
  }
  storeLabel("");
}

/** Name shown for a saved tunnel: its label, else its server. */
export function tunnelName(tn) {
  return (tn?.label || "").trim() || tn?.zone || t("unknown server");
}

/** One-line state for the drawer and the settings sheet. */
export function describeTunnel(s) {
  if (!s?.installed) return { headline: "Not set up", detail: "" };
  // Tunnels are saved but none is in use (current shells send active: null).
  if (s.active === null) return { headline: "Off", detail: t("No tunnel is in use. Pick one of your saved tunnels to use it.") };
  if (s.available === false || s.running === false) {
    return { headline: "Not running", detail: s.error || "The tunnel library did not start." };
  }
  if (s.mode === "off") return { headline: "Off", detail: "Mail connects directly." };
  if (s.route === "tunnel") {
    const why = s.mode === "always" ? "set to Always" : "relays are blocked on this network";
    return { headline: "Through the tunnel", detail: `Mail goes through the DNS tunnel (${why}).` };
  }
  switch (s.state) {
    case "blocked":
      return { headline: "Checking", detail: "The relays did not answer directly; checking again before switching to the tunnel." };
    case "relays-down":
      return { headline: "Direct", detail: "The relays answer neither directly nor through the tunnel: they seem to be down, so mail stays direct." };
    case "offline":
      return { headline: "No network", detail: "Neither the relays nor the allowlisted sites answer." };
    case "unknown":
      return { headline: "Direct", detail: "Mail connects directly. The network is checked once the relays are in use." };
    default:
      return { headline: "Direct", detail: "The relays answer directly; the tunnel is idle." };
  }
}

function kb(n) {
  return `${Math.round((n || 0) / 1024)} KB`;
}

/** One line per resolver path, working ones first (most answers first):
 * which resolvers carry the tunnel on this network. Durations arrive in ns. */
export function pathLines(paths) {
  if (!Array.isArray(paths) || !paths.length) return ["paths: none (tunnel not started)"];
  const rows = [...paths].sort((a, b) =>
    (b.verified - a.verified) || ((b.successes || 0) - (a.successes || 0)));
  const ok = rows.filter(p => p.verified).length;
  return [
    `paths: ${ok}/${rows.length} verified`,
    ...rows.map(p => {
      const state = p.suspended ? "suspended" : p.verified ? "ok" : "unverified";
      const rtt = p.rtt ? `${Math.round(p.rtt / 1e6)}ms` : "-";
      return `  ${p.resolver} ${p.transport} ${state} rtt=${rtt} loss=${(p.loss || 0).toFixed(2)} answers=${p.successes || 0} name=${p.name_len} ans=${p.answer_limit || "-"}`;
    }),
  ];
}

/** Plain-text diagnostics for sharing: routing state and events, never message content. */
export function tunnelReport(s, { app = "", now = new Date() } = {}) {
  const lines = [
    `Velta DNS tunnel report ${now.toISOString()}`,
    app ? `app: ${app}` : null,
    `soar: ${s.soar || "?"}`,
    `zone: ${s.zone || "?"}  resolvers: ${s.resolvers ?? "?"}`,
    `mode: ${s.mode}  route: ${s.route}  state: ${s.state}  since: ${s.route_since || "?"}`,
    `last probe: ${s.last_probe || "never"}  relays ok ${s.last_result?.relay_ok ?? 0}/${s.last_result?.relays ?? 0}  canary ok: ${!!s.last_result?.canary_ok}${s.last_result?.tunnel_checked ? `  via tunnel ok: ${!!s.last_result.tunnel_ok}` : ""}`,
    `relays: ${(s.relays || []).join(", ") || "none yet"}`,
    `network: ${s.network?.transport || "?"}  operator: ${s.network?.sim_operator || s.operator || "?"} ${s.network?.operator_name || ""}  private dns: ${s.network?.private_dns ? s.network.private_dns_name || "on" : "off"}`,
    `network resolvers: ${(s.network_resolvers || []).join(", ") || "none"}`,
    `dns interception: ${s.dns_intercepted ? `yes${s.dns_egress ? `, answered via ${s.dns_egress}` : ""}` : "no"}`,
  ];
  for (const r of ["direct", "tunnel"]) {
    const st = s.stats?.[r] || {};
    lines.push(`${r}: active ${s.active?.[r] ?? 0}, conns ${st.conns ?? 0}, fails ${st.fails ?? 0}, up ${kb(st.up)}, down ${kb(st.down)}`);
  }
  lines.push("", ...pathLines(s.paths), "", "events:");
  for (const e of s.events || []) lines.push(`${e.t} ${e.msg}`);
  return lines.filter(l => l !== null).join("\n");
}

/** Confirmation text for a parsed link: what it is, where traffic goes, and
 * which tunnel "Add and use" switches away from. Exported for tests. */
export function tunnelConfirmText(link, { current = null, replacing = null, resolvers } = {}) {
  const lines = [];
  if (link.label) lines.push(t("Name: {label}", { label: link.label }));
  lines.push(t("Tunnel server: {zone}", { zone: link.zone }));
  const now = current || replacing;
  if (now) lines.push(t("“Add and use” switches from the tunnel in use ({name}); it stays saved.", { name: now }));
  lines.push(
    t("All chat traffic will go through this tunnel's server whenever the tunnel is in use. Your messages stay end-to-end encrypted, but the server operator sees which relays you connect to and when."),
    t("It uses {n} DNS resolvers. Only accept tunnel links from someone you trust.", { n: resolvers ?? "?" }),
  );
  return lines.join("\n\n");
}

/**
 * Dialog with several actions, built on ui.js showModal (focus starts on
 * the primary action; Back/overlay/close = cancel). Resolves the chosen
 * action's id, or null. actions: [{ id, label, primary? }].
 */
export function makeChooser(showModal) {
  return (title, text, actions) => new Promise(resolve => {
    const doc = globalThis.document;
    const body = doc.createElement("div");
    body.innerHTML = `<p style="font-size:15px;line-height:1.45;white-space:pre-line">${escapeHtml(text)}</p>`;
    const foot = doc.createElement("div");
    foot.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end";
    let done = false;
    const finish = (v, close) => { if (done) return; done = true; resolve(v); close?.(); };
    const btns = [...actions, { id: null, label: t("Cancel") }].map(a => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = a.primary ? "btn-text btn-primary" : "btn-text";
      if (a.primary) b.style.width = "auto";
      b.textContent = a.label;
      b.dataset.choice = a.id ?? "cancel";
      return [b, a.id];
    });
    // Cancel first in the row, like confirmModal; actions after it.
    foot.append(btns.at(-1)[0], ...btns.slice(0, -1).map(x => x[0]));
    const { close } = showModal({ title, body, foot, compact: true, onClose: () => finish(null) });
    for (const [b, id] of btns) b.addEventListener("click", () => finish(id, close));
    setTimeout(() => (btns.find(([, id]) => actions.find(a => a.id === id)?.primary) || btns[0])[0].focus?.(), 60);
  });
}

/**
 * A velta://tunnel link was opened (deep link, QR, paste). Links can come from
 * any web page or app, so nothing changes without the user's confirmation.
 * New tunnel: "Add and use" / "Add" / "Cancel". Already saved (same zone and
 * key): offer to switch to it. Older shells without a list fall back to the
 * single-tunnel confirm.
 */
export async function acceptTunnelLink(link, { confirmModal, choose = null, toast, errToast, onChange, invoke = tauriInvoke() }) {
  let parsed;
  try {
    parsed = parseTunnelLink(link);
  } catch (e) {
    errToast(t("This tunnel link can't be used: {why}", { why: errMsg(e) }), 6000);
    return false;
  }
  // The shell gets the validated values as a v1 link: every Go library
  // build parses that, v2 support there is only a second line of defence.
  const shellLink = buildTunnelLinkV1(parsed);
  if (!invoke) {
    toast(t(UNSUPPORTED_MSG), 6000);
    return false;
  }
  const current = await refreshTunnelStatus(0, invoke);
  if (tunnelUnsupported(current)) {
    toast(t(UNSUPPORTED_MSG), 6000);
    return false;
  }
  let preview;
  try {
    preview = await invoke("tunnel_preview", { link: shellLink });
  } catch (e) {
    errToast(t("This tunnel link can't be used: {why}", { why: errMsg(e) }), 6000);
    return false;
  }
  const zone = preview.zone || parsed.zone;
  const existing = preview.existing;
  if (existing?.id) {
    const name = tunnelName({ label: existing.label, zone });
    if (existing.active) {
      toast(t("This DNS tunnel is already saved and in use ({name}).", { name }), 4000);
      return true;
    }
    const ok = await confirmModal(
      t("Use saved DNS tunnel?"),
      t("This tunnel is already saved as “{name}”. Use it now?", { name }),
      t("Use it"),
      false,
    );
    if (!ok) return false;
    try {
      await invoke("tunnel_select", { id: existing.id });
    } catch (e) {
      errToast(t("Couldn't switch the tunnel: {why}", { why: errMsg(e) }), 6000);
      return false;
    }
    await refreshTunnelStatus(0, invoke);
    toast(t("Now using {name}", { name }));
    onChange?.();
    return true;
  }
  const inUse = current.installed && current.active !== null
    ? (current.active_label || current.zone || t("unknown server")) : null;
  const text = tunnelConfirmText({ ...parsed, zone }, { current: inUse, resolvers: preview.resolvers });
  let activate;
  if (choose) {
    const pick = await choose(t("Add DNS tunnel?"), text, [
      { id: "add", label: t("Add") },
      { id: "use", label: t("Add and use"), primary: true },
    ]);
    if (!pick) return false;
    activate = pick === "use";
  } else {
    if (!(await confirmModal(t("Add DNS tunnel?"), text, t("Add and use"), false))) return false;
    activate = true;
  }
  try {
    await invoke("tunnel_install", { link: shellLink, label: parsed.label, activate });
  } catch (e) {
    errToast(t("Couldn't enable the tunnel: {why}", { why: errMsg(e) }), 6000);
    return false;
  }
  await refreshTunnelStatus(0, invoke);
  toast(activate ? t("DNS tunnel added and in use") : t("DNS tunnel added"));
  onChange?.();
  return true;
}

/** Share sheet for a saved tunnel (default: the active one): QR, the link,
 * Copy and Share. */
export async function openTunnelShare({ showModal, toast, errToast, renderQr, id = null, invoke = tauriInvoke() }) {
  let link;
  try {
    const cfg = await invoke("tunnel_link", id ? { id } : {});
    link = buildTunnelLink({ ...cfg, label: cfg.label ?? storedLabel() });
    parseTunnelLink(link);
  } catch (e) {
    errToast(t("Couldn't build the tunnel link: {why}", { why: errMsg(e) }));
    return null;
  }
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="p2p-hint">${escapeHtml(t("Anyone who opens this link in Velta can add this DNS tunnel. Their chat traffic will then go through its server. Share it only with people you trust."))}</p>
    <div class="qr-box" role="img" aria-label="${escapeHtml(t("QR code of the tunnel link"))}"><div class="qr-loading">${escapeHtml(t("Generating QR…"))}</div></div>
    <p class="invite-link" style="word-break:break-all;font-size:12px" data-tunnel-link></p>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:6px">
      <button type="button" class="btn-text" data-tunnel-copy>${ICON.copy}<span>${escapeHtml(t("Copy link"))}</span></button>
      <button type="button" class="btn-text" data-tunnel-share-link>${ICON.share}<span>${escapeHtml(t("Share…"))}</span></button>
    </div>`;
  body.querySelector("[data-tunnel-link]").textContent = link;
  const handle = showModal({ title: t("Share tunnel link"), body });
  body.querySelector("[data-tunnel-copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast(t("Tunnel link copied"));
    } catch (e) {
      errToast(t("Couldn't copy: {why}", { why: errMsg(e) }));
    }
  });
  body.querySelector("[data-tunnel-share-link]").addEventListener("click", async () => {
    try {
      await invoke("share_text", { text: link, title: t("Velta DNS tunnel") });
    } catch {
      try { await navigator.clipboard.writeText(link); toast(t("Tunnel link copied")); } catch {}
    }
  });
  const svg = renderQr ? await Promise.resolve().then(() => renderQr(link)).catch(() => null) : null;
  const box = body.querySelector(".qr-box");
  if (box?.isConnected !== false) {
    box.innerHTML = svg || `<div class="qr-loading">${escapeHtml(t("QR unavailable — copy the link instead"))}</div>`;
  }
  return { link, ...handle };
}

/** Router (Go) and shell (Rust) events as one time-ordered list of
 * {ms, level, msg}. Router events carry RFC 3339 times; shell events carry
 * epoch ms and their own level. */
export function tunnelEventRows(status) {
  const rows = [];
  for (const e of status?.events || []) {
    const ms = Date.parse(e.t);
    if (Number.isFinite(ms)) rows.push({ ms, level: routerEventLevel(e.msg), msg: e.msg });
  }
  for (const e of status?.shell_events || []) {
    if (Number.isFinite(e.t_ms)) rows.push({ ms: e.t_ms, level: e.level || "info", msg: e.msg });
  }
  return rows.sort((a, b) => a.ms - b.ms);
}

export function routerEventLevel(msg) {
  return /failed|error|refused|unreachable|-> blocked|-> offline|socks:/i.test(msg || "") ? "warning" : "info";
}

const DIAG_SEEN_KEY = "velta-tunnel-diag-seen";

/**
 * Mirrors tunnel events into the Velta Diagnostics chat: polls the status
 * (every 20 s, on resume, and when the shell signals a new line) and appends
 * only events newer than the last one shown. The high-water mark survives UI
 * reloads, so a reconnect does not repeat old lines.
 */
export function initTunnelDiagnostics({ append, invoke = tauriInvoke(), listen = globalThis.window?.__TAURI__?.event?.listen, intervalMs = 20000 }) {
  if (!invoke) return null;
  let seen = 0;
  try { seen = Number(globalThis.localStorage?.getItem(DIAG_SEEN_KEY)) || 0; } catch {}
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const s = await refreshTunnelStatus(200, invoke);
      if (!s.installed && !(s.shell_events || []).length) return;
      for (const row of tunnelEventRows(s)) {
        if (row.ms <= seen) continue;
        append(row.level, `DNS tunnel: ${row.msg}`);
        seen = row.ms;
      }
      try { globalThis.localStorage?.setItem(DIAG_SEEN_KEY, String(seen)); } catch {}
    } finally {
      busy = false;
    }
  };
  listen?.("velta-tunnel-log", () => { poll(); });
  const timer = setInterval(poll, intervalMs);
  globalThis.document?.addEventListener?.("visibilitychange", () => { if (!globalThis.document.hidden) poll(); });
  const ready = poll();
  return { poll, ready, stop: () => clearInterval(timer) };
}

/** Re-check routing after a network switch (Wi-Fi <-> mobile, airplane mode). */
export function bindTunnelNetworkEvents(invoke = tauriInvoke()) {
  if (!invoke) return;
  // Mobile WebViews fire "change" on every bandwidth/RTT estimate; the shell
  // only acts on a real resolver/operator change, so a few calls are plenty.
  let last = 0;
  const kick = () => {
    if (!cached.installed || Date.now() - last < 5000) return;
    last = Date.now();
    invoke("tunnel_network_changed").catch(() => {});
  };
  globalThis.navigator?.connection?.addEventListener?.("change", kick);
  globalThis.window?.addEventListener?.("online", kick);
}

function stateHtml(s) {
  const d = describeTunnel(s);
  return `<b>${escapeHtml(d.headline)}</b>${d.detail ? ` — ${escapeHtml(d.detail)}` : ""}`;
}

/** Path summary for the sheet. On the direct route the tunnel is idle and
 * soar verifies paths only while carrying traffic, so "0 of N" would read
 * like a failure. */
export function pathsSummary(s) {
  if (!Array.isArray(s?.paths)) return `${s?.resolvers ?? "?"} resolvers`;
  if (s.route !== "tunnel") return `${s.paths.length} resolver paths ready · tunnel idle, mail goes direct`;
  const ok = s.paths.filter(p => p.verified).length;
  return `${ok} of ${s.paths.length} resolver paths working${s.session ? " · session up" : " · connecting…"}`;
}

function pathsHtml(s) {
  return `Server: ${escapeHtml(s.zone || "?")} · ${escapeHtml(pathsSummary(s))}`;
}

/** Android Private DNS intercepts the tunnel's DNS queries (measured: answers
 * shrink to ~512 bytes and every path runs through one provider). */
export function privateDnsWarning(s) {
  if (!s?.network?.private_dns) return "";
  const name = s.network.private_dns_name ? ` (${escapeHtml(s.network.private_dns_name)})` : "";
  return `<p class="p2p-hint" style="color:var(--danger)">Private DNS is on${name}. It intercepts the tunnel's DNS queries and makes it much slower. Turn it off in Android Settings → Network → Private DNS while you need the tunnel.</p>`;
}

/** The network redirects all port-53 traffic to one resolver: plain-DNS
 * paths collapse into that one, and only DNS-over-TLS gets past it. */
export function interceptionWarning(s) {
  if (!s?.dns_intercepted) return "";
  const via = s.dns_egress ? ` (answered via ${escapeHtml(s.dns_egress)})` : "";
  return `<p class="p2p-hint" style="color:var(--danger)">This network intercepts DNS${via}: every plain-DNS resolver path goes through one resolver, so the tunnel relies on DNS-over-TLS here and may be slow. Check the router's DNS settings.</p>`;
}

function addedDate(sec) {
  if (!sec) return "";
  try { return new Date(sec * 1000).toLocaleDateString(); } catch { return ""; }
}

/** Saved-tunnel rows for the settings sheet. The active one is marked with
 * a check AND the words "In use" (never by colour alone); every action is a
 * real <button> whose accessible name carries the tunnel's name. */
export function tunnelListHtml(list) {
  const rows = list?.tunnels || [];
  if (!rows.length) return `<li class="tunnel-row"><span class="tunnel-sub">${escapeHtml(t("No saved tunnels."))}</span></li>`;
  return rows.map(tn => {
    const name = tunnelName(tn);
    const on = !!tn.active;
    const sub = [tn.label ? tn.zone : "", addedDate(tn.added) ? t("Added {date}", { date: addedDate(tn.added) }) : ""].filter(Boolean).join(" · ");
    const btn = (act, icon, label, extra = "") =>
      `<button type="button" class="icon-btn" data-act="${act}" aria-label="${escapeHtml(t(label, { name }))}" title="${escapeHtml(t(label, { name }))}"${extra}>${icon}</button>`;
    return `<li class="tunnel-row${on ? " is-active" : ""}" data-id="${escapeHtml(tn.id)}"${on ? ' aria-current="true"' : ""}>
      <span class="tunnel-mark" aria-hidden="true">${on ? ICON.check : ""}</span>
      <span class="tunnel-text"><span class="tunnel-name">${escapeHtml(name)}</span>${on ? ` <span class="tunnel-badge">${escapeHtml(t("In use"))}</span>` : ""}${sub ? `<span class="tunnel-sub">${escapeHtml(sub)}</span>` : ""}</span>
      <span class="tunnel-acts">
        ${on
          ? `<button type="button" class="btn-text" data-act="off" aria-label="${escapeHtml(t("Stop using {name}", { name }))}">${escapeHtml(t("Stop"))}</button>`
          : `<button type="button" class="btn-text" data-act="use" aria-label="${escapeHtml(t("Use {name}", { name }))}">${escapeHtml(t("Use"))}</button>`}
        ${btn("rename", ICON.edit, "Rename {name}")}
        ${btn("share", ICON.qr, "Share {name}")}
        ${btn("delete", ICON.trash, "Delete {name}", ' style="color:var(--danger)"')}
      </span>
    </li>`;
  }).join("");
}

/** Settings sheet: saved tunnels (use / stop / rename / share / delete),
 * then the active tunnel's state, mode and diagnostics. */
export async function openTunnelSettings(deps) {
  const { showModal, confirmModal, askText, toast, errToast, onChange, renderQr, appVersion = "", invoke = tauriInvoke() } = deps;
  if (!invoke) return;
  const s = await refreshTunnelStatus(200, invoke);
  let list;
  try { list = await invoke("tunnel_list"); } catch { list = null; }
  const body = document.createElement("div");
  const hasActive = !list || !!list.active;
  body.innerHTML = `
    <h3 class="tunnel-list-h" id="tunnel-list-h">${escapeHtml(t("Saved tunnels"))}</h3>
    ${list ? `<ul class="tunnel-list" role="list" aria-labelledby="tunnel-list-h" data-tunnel-list>${tunnelListHtml(list)}</ul>
    <p class="bar-opts-hint">${escapeHtml(t("To add another tunnel, open its link or scan its QR code."))}</p>` : ""}
    <div data-tunnel-active${hasActive ? "" : " hidden"}>
    <p class="p2p-hint" data-tunnel-state aria-live="polite">${stateHtml(s)}</p>
    ${privateDnsWarning(s)}
    ${interceptionWarning(s)}
    <fieldset class="scale-opts" data-tunnel-modes>
      <legend class="vh">Tunnel mode</legend>
      ${MODES.map(([v, label, hint]) => `<label class="scale-opt" title="${escapeHtml(hint)}"><input type="radio" name="tunnel-mode" value="${v}"${s.mode === v ? " checked" : ""}><span>${escapeHtml(label)}</span></label>`).join("")}
    </fieldset>
    <div class="bar-opts-hint" data-tunnel-hint>${escapeHtml((MODES.find(m => m[0] === s.mode) || MODES[0])[2])}</div>
    <p class="p2p-hint" data-tunnel-paths>${pathsHtml(s)}</p>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
      ${list ? "" : `<button type="button" class="btn-text" data-tunnel-share-open>${ICON.qr}<span>${escapeHtml(t("Share tunnel link"))}</span></button>`}
      <button type="button" class="btn-text" data-tunnel-share>Share diagnostics…</button>
      ${list ? "" : `<button type="button" class="btn-text" data-tunnel-remove style="color:var(--danger)">Remove the tunnel</button>`}
    </div>`;
  // Live while open: a mode switch or an allowlist flip shows up within
  // seconds instead of only after reopening the sheet.
  let live = null;
  const { close } = showModal({ title: "DNS tunnel", body, onClose: () => clearInterval(live) });
  live = setInterval(async () => {
    const fresh = await refreshTunnelStatus(0, invoke);
    const st = body.querySelector("[data-tunnel-state]");
    const ps = body.querySelector("[data-tunnel-paths]");
    if (st) st.innerHTML = stateHtml(fresh);
    if (ps) ps.innerHTML = pathsHtml(fresh);
  }, 2000);

  const reopen = focusId => { clearInterval(live); return openTunnelSettings({ ...deps, focusId }); };
  // Back from a rename/delete/switch: keyboard focus returns to that row.
  if (deps.focusId) {
    setTimeout(() => body.querySelector(`li[data-id="${String(deps.focusId).replace(/[^a-z0-9]/gi, "")}"] button`)?.focus?.(), 80);
  }
  const ul = body.querySelector("[data-tunnel-list]");
  ul?.addEventListener("click", async ev => {
    const b = ev.target?.closest?.("button[data-act]");
    const id = b?.closest?.("li[data-id]")?.dataset.id;
    if (!b || !id) return;
    const tn = list.tunnels.find(x => x.id === id);
    if (!tn) return;
    await tunnelAction(b.dataset.act, tn, { ...deps, invoke, close, reopen });
  });

  body.querySelectorAll('input[name="tunnel-mode"]').forEach(input =>
    input.addEventListener("change", async () => {
      try {
        await invoke("tunnel_set_mode", { mode: input.value });
        body.querySelector("[data-tunnel-hint]").textContent = MODES.find(m => m[0] === input.value)[2];
        await refreshTunnelStatus(0, invoke);
        onChange?.();
      } catch (e) {
        errToast("Couldn't change the mode: " + errMsg(e));
      }
    }));

  body.querySelector("[data-tunnel-share-open]")?.addEventListener("click", () => {
    clearInterval(live);
    openTunnelShare({ showModal, toast, errToast, renderQr, invoke });
  });

  body.querySelector("[data-tunnel-share]").addEventListener("click", async () => {
    const fresh = await refreshTunnelStatus(200, invoke);
    const text = tunnelReport(fresh, { app: appVersion });
    try {
      await invoke("share_text", { text, title: "Velta DNS tunnel report" });
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        toast("Diagnostics copied");
      } catch (e) {
        errToast("Couldn't share diagnostics: " + errMsg(e));
      }
    }
  });

  // Older shells (no tunnel_list): the single tunnel's Remove.
  body.querySelector("[data-tunnel-remove]")?.addEventListener("click", async () => {
    const ok = await confirmModal("Remove the DNS tunnel?", "Mail will only connect directly. You need the tunnel link again to set it up.", "Remove", true);
    if (!ok) return;
    try {
      await invoke("tunnel_remove");
      storeLabel("");
      await refreshTunnelStatus(0, invoke);
      close();
      toast("DNS tunnel removed");
      onChange?.();
    } catch (e) {
      errToast("Couldn't remove the tunnel: " + errMsg(e));
    }
  });
  return { body, close };
}

/** One saved-tunnel action from the settings sheet. Exported for tests.
 * Dialogs (rename, delete, share) replace the sheet; it reopens after. */
export async function tunnelAction(act, tn, { invoke, confirmModal, askText, toast, errToast, onChange, showModal, renderQr, close, reopen }) {
  const name = tunnelName(tn);
  const fail = (what, e) => { errToast(t(what, { why: errMsg(e) }), 6000); };
  switch (act) {
    case "use":
    case "off":
      try {
        await invoke("tunnel_select", { id: act === "use" ? tn.id : null });
      } catch (e) {
        fail("Couldn't switch the tunnel: {why}", e);
        return false;
      }
      await refreshTunnelStatus(0, invoke);
      toast(act === "use" ? t("Now using {name}", { name }) : t("DNS tunnel turned off"));
      onChange?.();
      await reopen?.(tn.id);
      return true;
    case "rename": {
      const label = await askText?.(t("Rename tunnel"), tn.label || "", t("Save"));
      if (label == null) { await reopen?.(tn.id); return false; }
      try {
        await invoke("tunnel_rename", { id: tn.id, label });
      } catch (e) {
        fail("Couldn't rename the tunnel: {why}", e);
      }
      await refreshTunnelStatus(0, invoke);
      onChange?.();
      await reopen?.(tn.id);
      return true;
    }
    case "share":
      return !!(await openTunnelShare({ showModal, toast, errToast, renderQr, id: tn.id, invoke }));
    case "delete": {
      const ok = await confirmModal(
        t("Delete DNS tunnel?"),
        tn.active
          ? t("“{name}” is in use. Deleting it stops the tunnel and mail connects directly. You need its link to add it again.", { name })
          : t("Delete “{name}”? You need its link to add it again.", { name }),
        t("Delete"),
        true,
      );
      if (!ok) { await reopen?.(tn.id); return false; }
      try {
        await invoke("tunnel_delete", { id: tn.id });
      } catch (e) {
        fail("Couldn't delete the tunnel: {why}", e);
        await reopen?.(tn.id);
        return false;
      }
      const fresh = await refreshTunnelStatus(0, invoke);
      toast(t("DNS tunnel deleted"));
      onChange?.();
      if (fresh.installed) await reopen?.(); else close?.();
      return true;
    }
  }
  return false;
}
