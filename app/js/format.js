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

export function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

export function formatTime(ts) {
  const d = new Date(ts);
  // 24-hour everywhere, regardless of device locale
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatListTime(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return formatTime(ts);
  const diff = (now - d) / 86400e3;
  if (diff < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function formatDay(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now - 86400e3);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "long", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
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
  return { datetime, title: d.toLocaleString() };
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
