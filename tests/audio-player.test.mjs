import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChatViewGlobals, installFakeDocument, FakeElement } from "./helpers/fake-dom.mjs";
import { audioPlayerHtml, mountAudioPlayer, timeLabel, finiteDuration, decodeAudioDuration } from "../app/js/audio-player.js";

installChatViewGlobals();
installFakeDocument();
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function fakePlayer(duration = Infinity) {
  const box = new FakeElement("div");
  const play = new FakeElement("button"), seek = new FakeElement("input"), time = new FakeElement("span");
  box.querySelector = sel => ({ ".vp-play": play, ".vp-seek": seek, ".vp-time": time })[sel] || null;
  const audio = new FakeElement("audio");
  Object.assign(audio, { duration, currentTime: 0, paused: true, plays: 0 });
  audio.play = () => { audio.paused = false; audio.plays++; return Promise.resolve(); };
  audio.pause = () => { audio.paused = true; };
  return { box, play, seek, time, audio };
}

test("player markup: full bar with play, seek and total from the first render", () => {
  const html = audioPlayerHtml({ label: "Voice message", duration: 4 });
  assert.match(html, /^<div class="vp" role="group" aria-label="Voice message">/);
  assert.match(html, /<button type="button" class="vp-play" aria-label="Play">/);
  assert.match(html, /<input type="range" class="vp-seek" min="0" max="4" step="0\.1" value="0" aria-label="Seek">/);
  assert.match(html, /vp-time[^>]*>00:00 \/ 00:04</);
  // unknown total (header-less recording): still the full bar, total pending
  assert.match(audioPlayerHtml({ duration: Infinity }), /max="0"[^>]*disabled.*00:00 \/ --:--/s);
  assert.equal(timeLabel(3, 0), "00:03 / --:--");
  assert.equal(finiteDuration(Infinity), 0);
  assert.equal(finiteDuration(NaN), 0);
});

test("header-less voice note: total learned by decoding, before any play", async () => {
  const p = fakePlayer(Infinity);
  let decodes = 0;
  mountAudioPlayer(p.box, p.audio, { decodeDuration: async () => { decodes++; return 4.2; } });
  assert.equal(p.time.textContent, "00:00 / --:--");
  await p.audio.fire("loadedmetadata");
  await new Promise(r => setTimeout(r, 0));
  assert.equal(decodes, 1);
  assert.equal(p.time.textContent, "00:00 / 00:04");
  assert.equal(p.seek.max, "4.2");
  assert.equal(p.seek.disabled, false);
  assert.equal(p.audio.plays, 0, "no playback needed to show the duration");
  await p.audio.fire("durationchange");
  assert.equal(decodes, 1, "decoded once");
});

test("element duration wins when finite; core duration shows immediately", async () => {
  const p = fakePlayer(Infinity);
  mountAudioPlayer(p.box, p.audio, { duration: 9, decodeDuration: async () => { throw new Error("no"); } });
  assert.equal(p.time.textContent, "00:00 / 00:09");
  p.audio.duration = 12;
  await p.audio.fire("durationchange");
  assert.equal(p.time.textContent, "00:00 / 00:12");
});

test("play/pause, progress and seeking", async () => {
  const p = fakePlayer(10);
  mountAudioPlayer(p.box, p.audio);
  await p.audio.fire("loadedmetadata");
  await p.play.fire("click", { stopPropagation() {} });
  assert.equal(p.audio.plays, 1);
  await p.audio.fire("play");
  assert.equal(p.play.getAttribute("aria-label"), "Pause");
  p.audio.currentTime = 3;
  await p.audio.fire("timeupdate");
  assert.equal(p.time.textContent, "00:03 / 00:10");
  assert.equal(p.seek.value, "3");
  p.seek.value = "7";
  await p.seek.fire("input");
  await p.seek.fire("change");
  assert.equal(p.audio.currentTime, 7);
  await p.play.fire("click", { stopPropagation() {} });
  assert.equal(p.audio.paused, true);
  await p.audio.fire("pause");
  assert.equal(p.play.getAttribute("aria-label"), "Play");
});

test("decodeAudioDuration: small files decoded, big files skipped", async () => {
  globalThis.AudioContext = class { async decodeAudioData() { return { duration: 4.5 }; } close() {} };
  const ok = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(100) });
  assert.equal(await decodeAudioDuration("u", { fetchImpl: ok }), 4.5);
  assert.equal(await decodeAudioDuration("u", { fetchImpl: ok, maxBytes: 10 }), 0);
  delete globalThis.AudioContext;
});

test("outgoing and incoming bubbles share the player path, fixed width CSS", () => {
  const cv = src("app/js/chat-view.js");
  const branch = cv.slice(cv.indexOf('} else if (m.viewtype === "audio" || m.viewtype === "voice") {'), cv.indexOf('} else if (m.viewtype === "webxdc") {'));
  assert.doesNotMatch(branch, /\bout\b|m\.from|isOut|outgoing/, "no own-message special case");
  assert.match(branch, /audioPlayerHtml\(\{ label: m\.viewtype === "voice" \? "Voice message" : "Audio", duration: m\.duration \}\)\}<audio data-src="audio" preload="metadata" hidden><\/audio>/);
  assert.doesNotMatch(branch, /<audio[^>]*\bcontrols\b/, "no native control (pill on header-less files)");
  assert.match(cv, /mountAudioPlayer\(mediaAudio\.closest\("\.msg-audio"\), mediaAudio, \{\s*duration: m\.duration,\s*decodeDuration:/);
  const css = src("app/css/main.css");
  assert.match(css, /\.msg-audio \{\s*width: 100%; max-width: 320px; min-width: min\(240px, var\(--bubble-inner-max\)\);/);
  assert.match(css, /\.vp \{ display: flex;[^}]*width: 100%; height: 40px;/);
});
