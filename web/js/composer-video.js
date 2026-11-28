// Composer video preview: the poster frame, duration and loader for a video
// staged in the attachment strip above the composer (#5 strip pattern).
//
// The video is never read into memory: a throwaway <video preload=metadata>
// streams just enough of the file over the same range-capable URL the chat
// uses (blobfile / loopback media server / blob: for pasted files), seeks to
// the first frame, paints it onto a small canvas and is then released, so no
// decoder stays alive while the user types the caption. Plain ES module.

export const PROBE_TIMEOUT_MS = 15000;
const POSTER_MAX = 320; // longest canvas side in CSS px (the strip box is 128x72)

/** Seconds to seek for the first frame: 0.1 s in, or mid-clip for very short ones. */
export function firstFrameTime(duration) {
  const d = Number(duration);
  if (!(d > 0) || !Number.isFinite(d)) return 0;
  return Math.min(0.1, d / 2);
}

/** Canvas size for a poster: the video's aspect, longest side capped. */
export function posterSize(w, h, max = POSTER_MAX, dpr = 1) {
  if (!(w > 0) || !(h > 0)) return null;
  const s = Math.min(1, max / Math.max(w, h)) * Math.max(1, Math.min(2, dpr || 1));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Accessible name of the play button: "Play video: clip.mp4, 01:23". */
export function playLabel(t, name, durationText) {
  const n = String(name || "").trim() || t("Video");
  return t("Play video: {name}", { name: durationText ? `${n}, ${durationText}` : n });
}

/**
 * Probe a staged video. `urls` are tried in order (the WebView2 media stack
 * can refuse the blobfile scheme, so the media-server fallback goes second).
 * Resolves { src, poster: HTMLCanvasElement|null, duration, width, height }
 * — `src` is the URL that loaded (play that one), `poster` null when no frame
 * could be painted (codec the WebView can't decode, timeout). Never rejects.
 * `cancel()` stops the probe and releases the element.
 */
export function probeVideo(urls, { doc = document, timeoutMs = PROBE_TIMEOUT_MS, dpr = globalThis.devicePixelRatio || 1 } = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : [urls]).filter(Boolean))];
  let video = null, timer = 0, done = false, finish = () => {};
  const release = () => {
    if (!video) return;
    const v = video;
    video = null;
    v.onloadedmetadata = v.onseeked = v.onloadeddata = v.onerror = null;
    try { v.removeAttribute("src"); v.load(); } catch { /* already gone */ }
  };
  const promise = new Promise((resolve) => {
    const result = { src: list[0] || "", poster: null, duration: 0, width: 0, height: 0 };
    finish = () => { if (done) return; done = true; clearTimeout(timer); release(); resolve(result); };
    const paint = (v) => {
      const size = posterSize(v.videoWidth, v.videoHeight, POSTER_MAX, dpr);
      if (!size) return;
      try {
        const c = doc.createElement("canvas");
        c.width = size.w; c.height = size.h;
        c.getContext("2d").drawImage(v, 0, 0, size.w, size.h);
        result.poster = c; // a cross-origin frame taints the canvas; it still displays
      } catch { /* no frame: the strip shows the video glyph */ }
    };
    const attempt = (i) => {
      release();
      if (done) return;
      if (i >= list.length) { finish(); return; }
      result.src = list[i];
      const v = doc.createElement("video");
      video = v;
      v.muted = true; v.playsInline = true; v.preload = "metadata";
      let seeking = false;
      v.onloadedmetadata = () => {
        result.duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
        result.width = v.videoWidth; result.height = v.videoHeight;
        const at = firstFrameTime(result.duration);
        if (at > 0) {
          seeking = true;
          try { v.currentTime = at; } catch { seeking = false; }
        }
      };
      v.onseeked = () => { paint(v); finish(); };
      v.onloadeddata = () => { if (!seeking) { paint(v); finish(); } };
      v.onerror = () => attempt(i + 1);
      v.src = list[i];
    };
    timer = setTimeout(finish, timeoutMs);
    attempt(0);
  });
  return { promise, cancel: () => finish() };
}
