// #97 share-in. The shell hands the page whatever another app shared:
// Android (tao) turns ACTION_SEND text into data:text/plain,… or an https
// URL, and files into content:// or file://. Windows Send to passes a path.
// Invite and chat links are not shares — the deeplink router owns those.

export function parseSharePayload(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const data = /^data:text\/plain(?:;[^,]*)?,(.*)$/is.exec(s);
  if (data) {
    let text = data[1];
    try { text = decodeURIComponent(text); } catch { /* already plain */ }
    return text.length ? { text } : null;
  }
  if (/^content:\/\//i.test(s)) return { file: s };
  if (/^file:/i.test(s)) {
    try {
      const u = new URL(s);
      let p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return p ? { file: p } : null;
    } catch { return null; }
  }
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\") || (s.startsWith("/") && !s.startsWith("//"))) {
    return { file: s };
  }
  return null;
}

// A shared page URL arrives as https://, which is also how invite links
// arrive. Only the ones the deeplink router did not consume are text shares.
export function shareTextIfUnconsumed(raw, consumed) {
  if (consumed) return null;
  const s = String(raw || "").trim();
  return /^https?:\/\//i.test(s) ? { text: s } : null;
}

export function shareViewtype(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return "video";
  if (["mp3", "m4a", "ogg", "opus", "wav", "flac"].includes(ext)) return "audio";
  return "file";
}
