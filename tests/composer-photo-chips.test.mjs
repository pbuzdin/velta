// The composer media strip: WebP/2k photo toggles (the #509 Settings keys,
// surfaced where the attachment is staged), Replace for every staged kind,
// and the crop modal filling the real modal box instead of a 420×320 cap.
// image-compress.js stays lazy (tests/lazy-modules gate), so chat-view owns
// the key literals — the first test here pins them equal.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const html = read("../app/index.html");
const cv = read("../app/js/chat-view.js");
const css = read("../app/css/main.css");

test("the strip's key literals are the ones image-compress.js owns", () => {
  const ic = read("../app/js/image-compress.js");
  const literal = (src, name) => src.match(new RegExp(`${name} = "([^"]+)"`))[1];
  assert.equal(literal(ic, "COMPRESS_KEY"), "velta-compress-photos");
  assert.equal(literal(ic, "RESIZE_KEY"), "velta-resize-photos");
  assert.match(cv, /webp: "velta-compress-photos", resize2k: "velta-resize-photos"/);
  // …and chat-view must not pull the module into the static boot graph.
  assert.doesNotMatch(cv, /^import .*image-compress\.js/m);
});

test("strip markup: WebP/2k chips sit with Crop/Replace, hidden by default", () => {
  const actions = html.match(/<div class="media-preview-actions">[\s\S]*?<\/div>/)[0];
  assert.match(actions, /id="btn-media-webp"[^>]*class="btn-text mp-toggle"[^>]*hidden/);
  assert.match(actions, /id="btn-media-2k"[^>]*class="btn-text mp-toggle"[^>]*hidden/);
  assert.match(actions, /aria-pressed="true"/);
  // The aria labels are the #509 Settings strings — already translated, the
  // i18n gate covers fr/ru parity for data-i18n-aria keys.
  assert.match(actions, /data-i18n-aria="Compress photos to save relay space"/);
  assert.match(actions, /data-i18n-aria="Resize photos to 2k"/);
});

test("chips toggle the #509 keys on the strip; pressed mirrors the send policy", () => {
  assert.match(cv, /\[\["btn-media-webp", PHOTO_KEYS\.webp\], \["btn-media-2k", PHOTO_KEYS\.resize2k\]\]/);
  // Settings convention: on = key unset, off = "0"; toggling "0" removes it.
  assert.match(cv, /localStorage\.getItem\(key\) === "0"\) localStorage\.removeItem\(key\);\s*else localStorage\.setItem\(key, "0"\)/);
  assert.match(cv, /webpChip\.hidden = k2Chip\.hidden = pm\.kind !== "image"/);
  assert.match(cv, /webpChip\.setAttribute\("aria-pressed", String\(photoSettingOn\(PHOTO_KEYS\.webp\)\)\)/);
  assert.match(cv, /k2Chip\.setAttribute\("aria-pressed", String\(photoSettingOn\(PHOTO_KEYS\.resize2k\)\)\)/);
  // The !pm branch hides the chips again.
  assert.match(cv, /webpChip\.hidden = true; k2Chip\.hidden = true/);
});

test("Replace reopens the picker for every staged kind (image, video, file)", () => {
  assert.match(cv, /btn-media-replace"\)\.addEventListener\("click", \(\) => \{\s*const pm = this\.pendingMedia;\s*if \(pm\) this\._sendAttachment\(pm\.kind\);/);
});

test("cropper fills the modal: measured fit, DPR-sharp backing, tokens", () => {
  assert.match(cv, /cropFitScale\(img\.naturalWidth, img\.naturalHeight, stage\.clientWidth, stage\.clientHeight\)/);
  assert.match(cv, /Math\.min\(2, window\.devicePixelRatio \|\| 1\)/);
  assert.doesNotMatch(cv, /420 \/ img\.naturalWidth/, "the hardcoded 420×320 cap is gone");
  assert.doesNotMatch(cv, /#0b0b10/, "no raw slab color in the cropper markup");
  // The old inline styles moved to token classes (Apply uses the audited pair).
  assert.match(cv, /class="btn-text btn-primary" data-apply/);
  assert.match(css, /\.crop-stage \{[^}]*flex: 1;/, "the stage fills the modal body");
  assert.match(css, /\.crop-stage \{[^}]*background: var\(--bg-hover\);/);
  assert.match(css, /\.mp-toggle\[aria-pressed="true"\] \{ background: var\(--accent\); color: var\(--on-accent\); \}/);
  assert.match(css, /\.crop-sel \{[^}]*border: 2px solid var\(--text\);/);
});
