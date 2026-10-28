// settings-transfer.js — "Export settings" / "Apply these settings" (drawer →
// Settings, message bubble in Saved Messages). The export is ONE plain,
// human-readable text message the user sends to their own Saved Messages;
// any of their devices can then apply it from there. Manual only.
//
// Format (stable; one `key: value` per line, fixed order, ASCII values):
//
//   Velta settings v1 (2026-10-18)
//   theme: dark
//   interface-scale: normal
//   message-text-size: 15.5
//   ...
//   (Apply on another device: open this in Saved Messages and tap Apply these settings.)
//
// The parser is strict: the first non-empty line must be the v1 header, every
// other line is a `key: value` line, a "(…)" note or blank — anything else and
// the text is not a settings block at all. Keys are a fixed whitelist; unknown
// keys are skipped (forward compatible), invalid values are skipped or
// clamped. Bounded sizes, no eval, no JSON from the message.
//
// Never exported (private or per device): relays/transports, the send
// transport, push distributor/tokens, proxy and DNS tunnel config, keys and
// identity backups, account addresses, multi-device (bcc_self), invite-link
// domains, the Lufi server, local-chat engine on/off, background-connection
// and battery switches, logging/debug/demo flags, per-chat state (read
// markers, recent commands, per-chat link-preview overrides) and the device
// info block.

export const HEADER = "Velta settings v1";
export const MAX_TEXT = 4096;
export const MAX_LINES = 80;
export const MAX_LINE = 200;
const HEADER_RE = /^Velta settings v1(?:\s*\((\d{4}-\d{2}-\d{2})\))?$/;
const LINE_RE = /^([a-z][a-z0-9-]{0,39}):[ \t]*(.{0,120})$/;
const NOTE_RE = /^\(.{0,180}\)$/;

const BAR_KEYS = ["chats", "contacts", "calls", "qr"];
const CAT_KEYS = ["people", "groups", "channels", "bots", "system"];
const SCALES = [["small", "0.85"], ["normal", "1"], ["large", "1.15"]];
// #147: smallest cap is 1 MiB. 655360 is the retired 640 KB preset.
export function normalizeDownloadLimit(raw) {
  if (raw == null || raw === "") return "0";
  return raw === "655360" ? "1048576" : String(raw);
}
const DL = [["none", "0"], ["1MB", "1048576"], ["5MB", "5242880"], ["25MB", "26214400"]];

const get = (ls, k) => { try { return ls.getItem(k); } catch { return null; } };
const put = (ls, k, v) => { try { v == null ? ls.removeItem(k) : ls.setItem(k, String(v)); } catch {} };

// "0" = off, absent = on (the repo's default-on switch pattern).
function onByDefault(key, label, lsKey) {
  return {
    key, label, lsKeys: [lsKey],
    read: ls => (get(ls, lsKey) === "0" ? "off" : "on"),
    parse: parseOnOff,
    write: (ls, v) => put(ls, lsKey, v === "on" ? null : "0"),
  };
}
// "1" = on, absent = off.
function offByDefault(key, label, lsKey) {
  return {
    key, label, lsKeys: [lsKey],
    read: ls => (get(ls, lsKey) === "1" ? "on" : "off"),
    parse: parseOnOff,
    write: (ls, v) => put(ls, lsKey, v === "on" ? "1" : null),
  };
}
function parseOnOff(raw) {
  const v = raw.toLowerCase();
  if (v === "on" || v === "yes" || v === "true") return "on";
  if (v === "off" || v === "no" || v === "false") return "off";
  return undefined;
}
function oneOf(key, label, lsKey, pairs, dflt, { removeAt = null } = {}) {
  // pairs: [[exported word, stored value]]
  return {
    key, label, lsKeys: [lsKey],
    read: ls => (pairs.find(([, s]) => s === (get(ls, lsKey) ?? dflt)) || pairs.find(([, s]) => s === dflt))[0],
    parse: raw => pairs.find(([w]) => w.toLowerCase() === raw.toLowerCase())?.[0],
    write: (ls, v) => { const s = pairs.find(([w]) => w === v)[1]; put(ls, lsKey, s === removeAt ? null : s); },
  };
}
// A visible-set list stored as the JSON array of HIDDEN keys.
function visibleList(key, label, lsKey, all) {
  const hidden = ls => { try { const a = JSON.parse(get(ls, lsKey) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
  return {
    key, label, lsKeys: [lsKey],
    read: ls => { const h = hidden(ls); const vis = all.filter(k => !h.includes(k)); return vis.length ? vis.join(", ") : "none"; },
    parse: raw => {
      const v = raw.toLowerCase().trim();
      if (v === "none") return "none";
      const parts = v.split(",").map(s => s.trim()).filter(Boolean);
      if (!parts.length || parts.some(p => !all.includes(p))) return undefined;
      const vis = all.filter(k => parts.includes(k)); // canonical order, deduped
      return vis.join(", ");
    },
    write: (ls, v) => {
      const vis = v === "none" ? [] : v.split(", ");
      put(ls, lsKey, JSON.stringify(all.filter(k => !vis.includes(k))));
    },
  };
}
const fmtNum = n => String(n);

export const SETTINGS = [
  oneOf("theme", "Theme", "dw-theme", [["auto", "auto"], ["dark", "dark"], ["light", "light"], ["brutal", "brutal"]], "auto"),
  oneOf("language", "Language", "velta-lang", [["english", "en"], ["french", "fr"], ["russian", "ru"]], "en", { removeAt: "en" }),
  oneOf("interface-scale", "Interface scale", "velta-ui-scale", SCALES, "1", { removeAt: "1" }),
  {
    key: "message-text-size", label: "Message text size", lsKeys: ["velta-msg-font-size"],
    read: ls => { const n = Number(get(ls, "velta-msg-font-size")); return fmtNum(get(ls, "velta-msg-font-size") == null || !Number.isFinite(n) ? 15.5 : clamp(Math.round(n * 2) / 2, 10, 22)); },
    parse: raw => { const m = /^(\d{1,3}(?:\.\d{1,2})?)\s*(?:px)?$/i.exec(raw); if (!m) return undefined; return fmtNum(clamp(Math.round(Number(m[1]) * 2) / 2, 10, 22)); },
    write: (ls, v) => put(ls, "velta-msg-font-size", v === "15.5" ? null : v),
  },
  {
    key: "message-corners", label: "Message corners", lsKeys: ["velta-bubble-radius"],
    read: ls => { const r = get(ls, "velta-bubble-radius"); const n = Number(r); return r == null || r === "" || !Number.isFinite(n) ? "default" : fmtNum(clamp(Math.round(n), 0, 14)); },
    parse: raw => { if (raw.toLowerCase() === "default") return "default"; const m = /^(\d{1,3})\s*(?:px)?$/i.exec(raw); return m ? fmtNum(clamp(Number(m[1]), 0, 14)) : undefined; },
    write: (ls, v) => put(ls, "velta-bubble-radius", v === "default" ? null : v),
  },
  {
    // Hex without "#": a "#3fa34d" would render as a hashtag button in the bubble.
    key: "accent-color", label: "Accent color", lsKeys: ["velta-accent"],
    read: ls => { const m = /^#([0-9a-f]{6})$/.exec(get(ls, "velta-accent") || ""); return m ? m[1] : "default"; },
    parse: raw => { const v = raw.toLowerCase(); if (v === "default") return "default"; const m = /^#?([0-9a-f]{6})$/.exec(v); return m ? m[1] : undefined; },
    write: (ls, v) => put(ls, "velta-accent", v === "default" ? null : "#" + v),
  },
  onByDefault("hyphenation", "Hyphenation", "velta-hyphens"),
  visibleList("bottom-bar-buttons", "Bottom bar buttons", "velta-bar-hidden", BAR_KEYS),
  visibleList("chat-categories", "Chat categories", "velta-cats-hidden", CAT_KEYS),
  onByDefault("notifications", "Notifications", "velta-notify"),
  offByDefault("notify-replies-only", "Replies only", "velta-notify-mentions"),
  onByDefault("notify-show-content", "Show message content", "velta-notify-text"),
  onByDefault("notify-system", "System notification for new messages", "velta-notify-system"),
  onByDefault("notify-vibration", "Vibration (Android)", "velta-notify-vibration"),
  onByDefault("notify-sounds", "In-chat sounds (Android)", "velta-notify-sounds"),
  onByDefault("notify-calls", "Call notifications", "velta-notify-calls"),
  oneOf("image-quality", "Image quality", "velta-media-quality", [["standard", "0"], ["compact", "1"]], "0"),
  onByDefault("compress-photos", "Compress photos", "velta-compress-photos"),
  (() => {
    const dl = oneOf("auto-download-limit", "Auto-download limit", "velta-download-limit", DL, "0");
    const read = dl.read, parse = dl.parse;
    dl.read = ls => {
      const raw = get(ls, "velta-download-limit");
      const v = normalizeDownloadLimit(raw);
      if (raw != null && raw !== v) put(ls, "velta-download-limit", v);
      return read(ls);
    };
    dl.parse = raw => parse(raw.toLowerCase() === "640kb" ? "1MB" : raw);
    return dl;
  })(),
  oneOf("link-previews", "Link previews", "velta-link-preview", [["off", "off"], ["picture", "picture"], ["fetch", "fetch"]], "off", { removeAt: "off" }),
  onByDefault("strip-tracking", "Strip tracking from links", "velta-strip-trackers"),
  onByDefault("send-on-enter", "Send on Enter", "velta-send-enter"),
  onByDefault("read-receipts", "Read receipts", "velta-mdns"),
  onByDefault("remember-scroll", "Remember scroll position", "velta-remember-scroll"),
  onByDefault("local-chat-typing", "Local chat typing hints", "velta-p2p-typing"),
];
const BY_KEY = new Map(SETTINGS.map(s => [s.key, s]));
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

// Storage keys that must never appear in an export (also pinned by tests).
export const EXCLUDED_STORAGE_KEYS = [
  "velta-ws-relay", "velta-ws-relays", "velta-push", "velta-bridge-token", "velta-identity",
  "velta-bcc-self-choice", "velta-invite-hosts", "velta-invite-domain", "velta-invite-creds", "velta-short-invites",
  "velta-lufi-server", "velta-lufi-files", "velta-p2p", "velta-p2pg-hidden", "velta-notify-bg",
  "velta-notify-bgforce", "velta-low-battery-react", "velta-battery-opt-asked", "velta-sync-only-active",
  "velta-logging", "velta-debug", "velta-mock", "velta-mock-fresh", "velta-wasm", "velta-tunnel-log",
  "velta-tunnel-diag-seen", "velta-read-markers", "velta-recent-commands", "velta-recent-apps", "velta-xdc-mirrors", "velta-xdc-mirror-ok", "velta-link-preview-chats",
  "velta-chat-category", "velta-ask-notifications", "velta-pending-invite", "velta-pending-add",
  "velta-call-log",
];

const pad = n => String(n).padStart(2, "0");
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Current values: { key: canonical string } in SETTINGS order.
export function readSettings(ls) {
  const out = {};
  for (const s of SETTINGS) out[s.key] = s.read(ls);
  return out;
}

export function serializeSettings(ls, now = new Date()) {
  const lines = [`${HEADER} (${isoDay(now)})`];
  const cur = readSettings(ls);
  for (const s of SETTINGS) lines.push(`${s.key}: ${cur[s.key]}`);
  lines.push("(Apply on another device: open this in Saved Messages and tap Apply these settings.)");
  return lines.join("\n");
}

// Quick, cheap gate for the message renderer (runs per row).
export function looksLikeSettings(text) {
  return typeof text === "string" && text.length <= MAX_TEXT && /^\s*Velta settings v1\b/.test(text);
}

// → { date, values: {key: canonical}, ignored: [key], invalid: [key] } or null.
export function parseSettings(text) {
  if (typeof text !== "string" || text.length > MAX_TEXT) return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > MAX_LINES) return null;
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const head = HEADER_RE.exec((lines[i] || "").trim());
  if (!head) return null;
  const values = Object.create(null), ignored = [], invalid = [];
  for (const raw of lines.slice(i + 1)) {
    if (raw.length > MAX_LINE) return null;
    const line = raw.trim();
    if (!line || NOTE_RE.test(line)) continue;
    const m = LINE_RE.exec(line);
    if (!m) return null; // not a settings block: free text mixed in
    const [, key, rawVal] = m;
    const spec = BY_KEY.get(key);
    if (!spec) { ignored.push(key); continue; }
    if (key in values) continue; // first one wins
    const v = spec.parse(rawVal.trim());
    if (v === undefined) invalid.push(key);
    else values[key] = v;
  }
  if (!Object.keys(values).length) return null;
  return { date: head[1] || null, values: { ...values }, ignored, invalid };
}

// [{ key, label, from, to }] for values that differ from the current ones.
export function diffSettings(ls, values) {
  const cur = readSettings(ls);
  const out = [];
  for (const s of SETTINGS) {
    if (!(s.key in values)) continue;
    if (values[s.key] !== cur[s.key]) out.push({ key: s.key, label: s.label, from: cur[s.key], to: values[s.key] });
  }
  return out;
}

// Writes the changed keys. Returns the applied diff (the app then refreshes
// everything live — see app.js applySettingsFromMessage).
export function applySettings(ls, values) {
  const changes = diffSettings(ls, values);
  for (const c of changes) BY_KEY.get(c.key).write(ls, c.to);
  return changes;
}
