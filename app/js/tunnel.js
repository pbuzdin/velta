// Optional DNS tunnel (Android): UI side of
// velta-app/src-tauri/src/tunnel.rs + velta-app/soar-tunnel.
//
// The tunnel exists only after the user accepts a velta://tunnel?… link; the
// server zone and key are never part of this code. Until then nothing here
// shows up and the app behaves exactly as upstream Velta.
//
// Shell commands: tunnel_preview, tunnel_install, tunnel_remove,
// tunnel_status, tunnel_set_mode, tunnel_network_changed, share_text.
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
//   velta://tunnel?v=1&zone=<domain>&key=<base64 32 bytes>[&r=<ip[:port],…>][&c=<host:port,…>][&n=<label>]
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

/**
 * Strictly parses a velta://tunnel link. Returns
 * {version, zone, key, resolvers, canaries, label}; throws on anything off:
 * other schemes/hosts, a path, unknown or repeated parameters, a future
 * version, oversized values.
 */
export function parseTunnelLink(raw) {
  const s = String(raw ?? "").trim();
  if (!s) bad("Empty link");
  if (s.length > TUNNEL_LINK_MAX) bad("The link is too long");
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

/** Canonical link for sharing (QR, copy). The key is URL-safe so the link stays readable. */
export function buildTunnelLink({ zone, key, resolvers = [], canaries = [], label = "" }) {
  const k = String(key || "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const parts = ["v=1", `zone=${encodeURIComponent(zone)}`, `key=${k}`];
  if (resolvers?.length) parts.push(`r=${resolvers.map(encodeURIComponent).join(",")}`);
  if (canaries?.length) parts.push(`c=${canaries.map(encodeURIComponent).join(",")}`);
  if (label) parts.push(`n=${encodeURIComponent(label)}`);
  return `velta://tunnel?${parts.join("&")}`;
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
  } catch (e) {
    cached = { installed: false, available: false, error: errMsg(e) };
  }
  return cached;
}

/** One-line state for the drawer and the settings sheet. */
export function describeTunnel(s) {
  if (!s?.installed) return { headline: "Not set up", detail: "" };
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
 * whether it replaces the current tunnel. Exported for tests. */
export function tunnelConfirmText(link, { replacing = null, resolvers } = {}) {
  const lines = [];
  if (link.label) lines.push(t("Name: {label}", { label: link.label }));
  lines.push(t("Tunnel server: {zone}", { zone: link.zone }));
  if (replacing) lines.push(t("This replaces your current DNS tunnel ({zone}).", { zone: replacing }));
  lines.push(
    t("All chat traffic will go through this tunnel's server whenever the tunnel is in use. Your messages stay end-to-end encrypted, but the server operator sees which relays you connect to and when."),
    t("It uses {n} DNS resolvers. Only accept tunnel links from someone you trust.", { n: resolvers ?? "?" }),
  );
  return lines.join("\n\n");
}

/**
 * A velta://tunnel link was opened (deep link, QR, paste). Links can come from
 * any web page or app, so nothing changes without the user's confirmation.
 */
export async function acceptTunnelLink(link, { confirmModal, toast, errToast, onChange, invoke = tauriInvoke() }) {
  let parsed;
  try {
    parsed = parseTunnelLink(link);
  } catch (e) {
    errToast(t("This tunnel link can't be used: {why}", { why: errMsg(e) }), 6000);
    return false;
  }
  if (!invoke) {
    toast(t("DNS tunnel links work only in the Velta Android app. Open this link on your Android phone."), 6000);
    return false;
  }
  const current = await refreshTunnelStatus(0, invoke);
  if (current.available === false && !current.installed && /only available/i.test(current.error || "")) {
    toast(t("DNS tunnel links work only in the Velta Android app. Open this link on your Android phone."), 6000);
    return false;
  }
  let preview;
  try {
    preview = await invoke("tunnel_preview", { link });
  } catch (e) {
    errToast(t("This tunnel link can't be used: {why}", { why: errMsg(e) }), 6000);
    return false;
  }
  const replacing = current.installed ? (current.zone || t("unknown server")) : null;
  const ok = await confirmModal(
    replacing ? t("Replace DNS tunnel?") : t("Add DNS tunnel?"),
    tunnelConfirmText({ ...parsed, zone: preview.zone || parsed.zone }, { replacing, resolvers: preview.resolvers }),
    replacing ? t("Replace") : t("Enable"),
    !!replacing,
  );
  if (!ok) return false;
  try {
    await invoke("tunnel_install", { link });
  } catch (e) {
    errToast(t("Couldn't enable the tunnel: {why}", { why: errMsg(e) }), 6000);
    return false;
  }
  storeLabel(parsed.label);
  await refreshTunnelStatus(0, invoke);
  toast(replacing ? t("DNS tunnel replaced") : t("DNS tunnel enabled"));
  onChange?.();
  return true;
}

/** Share sheet for the installed tunnel: QR, the link, Copy and Share. */
export async function openTunnelShare({ showModal, toast, errToast, renderQr, invoke = tauriInvoke() }) {
  let link;
  try {
    const cfg = await invoke("tunnel_link");
    link = buildTunnelLink({ ...cfg, label: storedLabel() });
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

/** Settings sheet: state, mode, diagnostics, removal. */
export async function openTunnelSettings({ showModal, confirmModal, toast, errToast, onChange, renderQr, appVersion = "", invoke = tauriInvoke() }) {
  if (!invoke) return;
  const s = await refreshTunnelStatus(200, invoke);
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="p2p-hint" data-tunnel-state>${stateHtml(s)}</p>
    ${privateDnsWarning(s)}
    ${interceptionWarning(s)}
    <fieldset class="scale-opts" data-tunnel-modes>
      <legend class="vh">Tunnel mode</legend>
      ${MODES.map(([v, label, hint]) => `<label class="scale-opt" title="${escapeHtml(hint)}"><input type="radio" name="tunnel-mode" value="${v}"${s.mode === v ? " checked" : ""}><span>${escapeHtml(label)}</span></label>`).join("")}
    </fieldset>
    <div class="bar-opts-hint" data-tunnel-hint>${escapeHtml((MODES.find(m => m[0] === s.mode) || MODES[0])[2])}</div>
    <p class="p2p-hint" data-tunnel-paths>${pathsHtml(s)}</p>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
      <button type="button" class="btn-text" data-tunnel-share-open>${ICON.qr}<span>${escapeHtml(t("Share tunnel link"))}</span></button>
      <button type="button" class="btn-text" data-tunnel-share>Share diagnostics…</button>
      <button type="button" class="btn-text" data-tunnel-remove style="color:var(--danger)">Remove the tunnel</button>
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

  body.querySelector("[data-tunnel-share-open]").addEventListener("click", () => {
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

  body.querySelector("[data-tunnel-remove]").addEventListener("click", async () => {
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
}
