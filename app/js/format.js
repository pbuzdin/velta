// format.js — pure helpers shared by the production modules (rpc-core,
// chat-view, components, app) without pulling mock-core into the
// production module graph (#48).

// Page window over a chat's ordered message-id list, shared by the real and
// the demo core's getMessages (see JsonRpcCore.getMessages for the options).
// An unknown aroundId/beforeId falls back to the newest page; an unknown
// afterId yields an empty page with hasNewer false, so a detached chat view
// reloads the tail instead of appending it after a gap.
export function pageBounds(ids, { beforeId = null, afterId = null, aroundId = null, before = 10, limit = 40 } = {}) {
  const n = ids.length;
  if (aroundId != null) {
    const idx = ids.indexOf(aroundId);
    if (idx >= 0) {
      const end = Math.min(n, Math.max(0, idx - before) + limit);
      return { start: Math.max(0, end - limit), end };
    }
  } else if (afterId != null) {
    const idx = ids.indexOf(afterId);
    if (idx < 0) return { start: n, end: n };
    return { start: idx + 1, end: Math.min(n, idx + 1 + limit) };
  }
  let end = n;
  if (beforeId != null) {
    const idx = ids.indexOf(beforeId);
    if (idx >= 0) end = idx;
  }
  return { start: Math.max(0, end - limit), end };
}

// Elapsed seconds -> "mm:ss", or "h:mm:ss" from one hour on. Shared by the
// call overlay timer, call cards, voice recording and video duration badges.
// Fractions are floored; negative / non-finite input reads as 0.
export function formatDuration(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}

export function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

// hourCycle h23 alone: adding hour12:false overrides it and V8/ICU then emits "24:05" after midnight.
const H24 = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

export function formatTime(ts) {
  const d = new Date(ts);
  // 24-hour everywhere, regardless of device locale
  return d.toLocaleTimeString([], H24);
}

// Date plus 24-hour time, for message info and <time> tooltips.
export function formatDateTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString([], { ...H24, second: "2-digit" });
  return `${date} ${time}`;
}

// Message-info State: Seen is the recipient MDN for outgoing, and not-unread for incoming.
// encrypted === false is the core padlock off; a missing flag (local chat) stays Encrypted.
export function messageInfoState(m) {
  const seen = m?.from === 1 ? m.state === "read" : !m?.unread;
  const enc = m?.encrypted === false ? "Not encrypted" : "Encrypted";
  return `${seen ? "Seen" : "Not seen"}, ${enc}`;
}

function escInfo(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Message-info reactions (#122). One open <details> per emoji: the summary is
// a chip (button, so the tap reacts and does not toggle the details), the
// body is who sent it. payload is get_message_reactions plus names[id].
// Contact 1 with no name is "You".
export function messageInfoReactions(payload) {
  const list = payload?.reactions;
  if (!Array.isArray(list) || !list.length) return "";
  const by = payload.reactionsByContact || {};
  const names = payload.names || {};
  const who = new Map();
  for (const [id, emojis] of Object.entries(by)) {
    const name = names[id] || (String(id) === "1" ? "You" : "Contact");
    for (const emoji of emojis || []) {
      if (!who.has(emoji)) who.set(emoji, []);
      who.get(emoji).push(name);
    }
  }
  return list.map((r) => {
    const emoji = r.emoji || "";
    const people = who.get(emoji) || [];
    const mine = !!(r.isFromSelf || r.mine);
    const count = Number(r.count) || people.length || 0;
    const body = people.map((n) => `<div class="info-react-who">${escInfo(n)}</div>`).join("");
    return `<details open class="info-react"><summary><button type="button" class="reaction-chip${mine ? " mine" : ""}" aria-pressed="${mine ? "true" : "false"}" data-react="${escInfo(emoji)}">${escInfo(emoji)} ${count}</button></summary>${body}</details>`;
  }).join("");
}

// Core server URL "<addr/folder/;UID=n>" → "addr UID=n" (folder kept when it is not INBOX).
export function formatServerUrl(raw) {
  const s = String(raw ?? "");
  const m = /^<(.+)\/;UID=(\d+)>$/.exec(s);
  if (!m) return s;
  const slash = m[1].indexOf("/");
  if (slash < 0) return `${m[1]} UID=${m[2]}`;
  const addr = m[1].slice(0, slash);
  const folder = m[1].slice(slash + 1);
  return folder && folder !== "INBOX" ? `${addr} ${folder} UID=${m[2]}` : `${addr} UID=${m[2]}`;
}

// Whole local calendar days between ts and now (0 = today, 1 = yesterday).
// Counted on local midnights, not 24h windows, so DST and early-morning
// "now" do not shift the boundary; negative for future timestamps.
export function calendarDaysAgo(ts, now = Date.now()) {
  const d = new Date(ts), n = new Date(now);
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((b - a) / 86400e3);
}

function relativeDayLabel() {
  try {
    const s = new Intl.RelativeTimeFormat([], { numeric: "auto" }).format(-1, "day");
    return s.charAt(0).toLocaleUpperCase() + s.slice(1);
  } catch { return "Yesterday"; }
}

// Chat-list stamp, Delta Chat convention: today HH:MM, yesterday
// "Yesterday", 2–6 calendar days ago weekday, same year "Oct 3", older
// with year. Future timestamps (clock skew) never get a weekday.
export function formatListTime(ts, now = Date.now()) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const days = calendarDaysAgo(ts, now);
  if (days === 0) return formatTime(ts);
  if (days === 1) return relativeDayLabel();
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: "short" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString([], sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

export function formatDay(ts, now = Date.now()) {
  const d = new Date(ts);
  const days = calendarDaysAgo(ts, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "long", year: d.getFullYear() !== new Date(now).getFullYear() ? "numeric" : undefined });
}

// "just now" / "5 minutes ago" / "3 hours ago" / "2 days ago" — relative time
// for last-seen info.
function escTime(s) {
  return String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

// datetime is an instant, or a local YYYY-MM-DD when day is set (UTC slice
// would label the wrong calendar day).
export function timeParts(ts, { day = false } = {}) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const datetime = day
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    : d.toISOString();
  return { datetime, title: formatDateTime(ts) };
}

export function timeTag(ts, text, { day = false, className = "" } = {}) {
  const cls = className ? ` class="${escTime(className)}"` : "";
  const body = escTime(text);
  const p = timeParts(ts, { day });
  if (!p) return `<span${cls}>${body}</span>`;
  return `<time${cls} datetime="${escTime(p.datetime)}" title="${escTime(p.title)}">${body}</time>`;
}

export function stampTime(el, ts, { day = false } = {}) {
  const p = timeParts(ts, { day });
  if (!p || !el) return;
  el.dateTime = p.datetime;
  el.title = p.title;
}

export function timeAgo(ts) {
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

// #127: welcome splash version line. Tauri shells name Tauri; the browser
// names the service-worker / app-shell cache instead.
export function formatSplashVersion({ app, core, tauri, sw }) {
  const shell = tauri ? `Tauri ${tauri}` : `service worker ${sw || "—"}`;
  return `Velta ${app} (Chatmail core ${core}, ${shell})`;
}
