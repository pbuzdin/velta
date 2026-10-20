// audio-player.js — the chat's audio/voice player: a plain-DOM bar (play,
// seek, "0:03 / 0:04") driving a hidden <audio>.
//
// Why not native controls: voice notes recorded by MediaRecorder (Velta's
// own sends: webm / fragmented mp4) have no duration in their header. The
// element reports duration = Infinity until it has played through, and
// Chromium / Android WebView then draws its live-stream control — a tiny
// "play 0:00" pill with no total and no seek bar — and nothing in CSS can
// change that. This bar is full width from the first render; the total
// comes from the element when finite, else from decoding the (small) file
// once, else from the core's duration when it has one.
import { formatDuration } from "./format.js";

export const DECODE_MAX_BYTES = 4 * 1024 * 1024;
const PLAY = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
const PAUSE = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>`;

export function finiteDuration(d) {
  return Number.isFinite(d) && d > 0 ? d : 0;
}

export function timeLabel(current, total) {
  return `${formatDuration(current)} / ${total ? formatDuration(total) : "--:--"}`;
}

export function audioPlayerHtml({ label = "Audio", duration = 0 } = {}) {
  const total = finiteDuration(duration);
  return `<div class="vp" role="group" aria-label="${label === "Voice message" ? "Voice message" : "Audio"}">`
    + `<button type="button" class="vp-play" aria-label="Play">${PLAY}</button>`
    + `<input type="range" class="vp-seek" min="0" max="${total || 0}" step="0.1" value="0" aria-label="Seek"${total ? "" : " disabled"}>`
    + `<span class="vp-time" aria-live="off">${timeLabel(0, total)}</span>`
    + `</div>`;
}

// Wire the bar inside `box` to `audio`. opts.duration: core-known seconds.
// opts.decodeDuration(): async -> seconds (fallback for header-less files).
export function mountAudioPlayer(box, audio, { duration = 0, decodeDuration = null } = {}) {
  const play = box.querySelector(".vp-play");
  const seek = box.querySelector(".vp-seek");
  const time = box.querySelector(".vp-time");
  if (!play || !seek || !time || !audio) return null;
  const st = { total: finiteDuration(duration), decoding: false, seeking: false };
  const setTotal = (t) => {
    t = finiteDuration(t);
    if (!t || Math.abs(t - st.total) < 0.05) return;
    st.total = t;
    seek.max = String(t);
    seek.disabled = false;
    paint();
  };
  const paint = () => {
    const cur = Math.min(Number(audio.currentTime) || 0, st.total || Infinity);
    time.textContent = timeLabel(cur, st.total);
    if (!st.seeking) seek.value = String(cur);
  };
  const setPlaying = (on) => {
    play.innerHTML = on ? PAUSE : PLAY;
    play.setAttribute("aria-label", on ? "Pause" : "Play");
  };
  const learn = () => {
    const d = finiteDuration(audio.duration);
    if (d) { setTotal(d); return; }
    if (st.total || st.decoding || !decodeDuration) return;
    st.decoding = true;
    Promise.resolve().then(decodeDuration).then(setTotal, () => {}).finally(() => { st.decoding = false; });
  };
  audio.addEventListener("loadedmetadata", learn);
  audio.addEventListener("durationchange", learn);
  audio.addEventListener("timeupdate", paint);
  audio.addEventListener("play", () => setPlaying(true));
  audio.addEventListener("pause", () => setPlaying(false));
  audio.addEventListener("ended", () => { setPlaying(false); learn(); try { audio.currentTime = 0; } catch {} paint(); });
  play.addEventListener("click", (e) => {
    e.stopPropagation?.();
    if (audio.paused) audio.play?.()?.catch?.(() => {});
    else audio.pause?.();
  });
  seek.addEventListener("input", () => { st.seeking = true; time.textContent = timeLabel(Number(seek.value), st.total); });
  seek.addEventListener("change", () => {
    st.seeking = false;
    try { audio.currentTime = Number(seek.value) || 0; } catch {}
    paint();
  });
  paint();
  return st;
}

// Header-less recordings: decode once to learn the length (small files only).
export async function decodeAudioDuration(url, { fetchImpl = globalThis.fetch, maxBytes = DECODE_MAX_BYTES } = {}) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext || globalThis.OfflineAudioContext;
  if (!url || !fetchImpl || !Ctx) return 0;
  const res = await fetchImpl(url);
  if (!res.ok) return 0;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) return 0;
  const ctx = Ctx === globalThis.OfflineAudioContext ? new Ctx(1, 1, 44100) : new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(buf);
    return finiteDuration(decoded?.duration);
  } finally {
    try { ctx.close?.(); } catch {}
  }
}
