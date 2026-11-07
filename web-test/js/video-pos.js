// Playback resume for the video lightbox. Path-only key: the blobfile port
// and a #t= fragment must not split one file. The last two seconds count as
// finished so the next open starts over.

export function videoPosKey(src) {
  if (!src) return "";
  try { return new URL(src, "http://velta.local").pathname; } catch { return String(src); }
}

export function videoResumeSeconds(saved, duration) {
  const t = Number(saved);
  if (!Number.isFinite(t) || t < 1) return 0;
  const d = Number(duration);
  if (Number.isFinite(d) && d > 0 && t >= d - 2) return 0;
  return t;
}

export function rememberVideoPos(map, key, seconds, cap = 40) {
  const next = {};
  for (const k of Object.keys(map || {})) if (k !== key) next[k] = map[k];
  if (key && seconds >= 1) next[key] = Math.round(seconds);
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length - cap; i++) delete next[keys[i]];
  return next;
}
