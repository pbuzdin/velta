// #152: resume position per video, stretch + speed on the lightbox, and the
// Android fullscreen exit that left the header under the status bar.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { videoPosKey, videoResumeSeconds, rememberVideoPos } from "../app/js/video-pos.js";

test("video progress key is the path, not the port or fragment", () => {
  assert.equal(
    videoPosKey("http://127.0.0.1:9/blobfile/accounts%2Fa%2Fclip.mp4?w=720#t=0.1"),
    "/blobfile/accounts%2Fa%2Fclip.mp4",
  );
  assert.equal(videoPosKey(""), "");
});

test("resume skips the first second and the last two", () => {
  assert.equal(videoResumeSeconds(0, 100), 0);
  assert.equal(videoResumeSeconds(0.4, 100), 0);
  assert.equal(videoResumeSeconds(12.2, 100), 12.2);
  assert.equal(videoResumeSeconds(98, 100), 0);
  assert.equal(videoResumeSeconds(97.9, 100), 97.9);
  assert.equal(videoResumeSeconds(12, NaN), 12);
});

test("rememberVideoPos caps the map and drops a finished video", () => {
  let map = {};
  for (let i = 0; i < 41; i++) map = rememberVideoPos(map, "k" + i, 10, 40);
  assert.equal(Object.keys(map).length, 40);
  assert.equal(map.k0, undefined);
  assert.equal(map.k40, 10);
  map = rememberVideoPos(map, "k1", 8, 40);
  assert.equal(Object.keys(map).at(-1), "k1");
  map = rememberVideoPos(map, "k40", 0, 40);
  assert.equal(map.k40, undefined);
});

test("lightbox offers stretch and a speed selector; fullscreen exit restores insets", () => {
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /aria-label="Stretch"/);
  assert.match(ui, /aria-label="Playback speed"/);
  assert.match(ui, /classList\.toggle\("is-stretch"\)/);
  assert.match(ui, /video\.playbackRate = n/);
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(css, /\.lightbox\.is-stretch \.lightbox-video \{[^}]*object-fit: cover/);
  const kt = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/VeltaWebChromeClient.kt", import.meta.url), "utf8");
  assert.match(kt, /systemBarsBehavior = WindowInsetsControllerCompat\.BEHAVIOR_DEFAULT/);
  assert.match(kt, /ViewCompat\.requestApplyInsets\(decor\)/);
});
