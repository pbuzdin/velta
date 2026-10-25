// Detached chat rows must drop their media pipeline or WebView2 stops taking
// chat-list clicks after enough video/voice chats have been opened.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parkMedia, unparkMedia } from "../app/js/media-park.js";

function media(src) {
  const el = {
    dataset: {},
    attrs: src ? { src } : {},
    events: [],
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    set src(value) { if (value) this.attrs.src = String(value); else delete this.attrs.src; this.events.push("src"); },
    get src() { return this.attrs.src || ""; },
    pause() { this.events.push("pause"); },
    load() { this.events.push("load"); },
  };
  return el;
}

function rootOf(...nodes) {
  return { querySelectorAll: (sel) => nodes.filter(n => n.tag === sel) };
}

test("park releases the decoder and unpark restores the same src", () => {
  const video = media("blobfile://x/a.mp4#t=0.1");
  video.tag = "video";
  const root = rootOf(video);
  parkMedia(root);
  assert.equal(video.getAttribute("src"), null);
  assert.equal(video.dataset.parkedSrc, "blobfile://x/a.mp4#t=0.1");
  assert.deepEqual(video.events, ["pause", "src", "load"]);
  parkMedia(root);
  assert.equal(video.events.length, 3, "a second park must not drop the saved src");
  unparkMedia(root);
  assert.equal(video.getAttribute("src"), "blobfile://x/a.mp4#t=0.1");
  assert.equal(video.dataset.parkedSrc, undefined);
});

test("park leaves an element that has no src alone", () => {
  const audio = media("");
  audio.tag = "audio";
  parkMedia(rootOf(audio));
  assert.equal(audio.dataset.parkedSrc, undefined);
  assert.deepEqual(audio.events, []);
});

test("chat rows park on detach and ignore the empty-src error", () => {
  const view = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  const video = readFileSync(new URL("../app/js/components.js", import.meta.url), "utf8");
  assert.match(view, /onItemUnmount: \(el\) => \{ queueMicrotask\(\(\) => \{ if \(!el\?\.isConnected\) parkMedia\(el\); \}\); \}/);
  assert.match(view, /unparkMedia\(cached\)/);
  assert.match(view, /for \(const el of this\._rowCache\.values\(\)\) parkMedia\(el\)/);
  assert.match(video, /if \(v\.dataset\.parkedSrc \|\| !v\.getAttribute\("src"\)\) return;/);
  assert.match(view, /if \(mediaAudio\.dataset\.parkedSrc \|\| !mediaAudio\.getAttribute\("src"\)\) return;/);
});
