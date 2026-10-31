// Stable media heights: images/stickers/GIFs and video boxes reserve their
// final size at render, and nothing resizes them after load (a row whose
// height changes after it is shown makes the virtual scroller re-measure).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CV = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
const COMP = readFileSync(new URL("../app/js/components.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");

test("image wrap reserves aspect-ratio + px width from core dimensions", () => {
  assert.match(CV, /aspect-ratio:\$\{dims\[0\]\} \/ \$\{dims\[1\]\}/);
  assert.match(CV, /no-dims/);
});

test("unknown-size images keep the fixed 4/3 placeholder (contain, no resize)", () => {
  assert.match(CSS, /\.msg-image \.img-wrap \{[^}]*aspect-ratio: 4 \/ 3/);
  assert.match(CSS, /\.msg-image \.img-wrap\.no-dims img \{ object-fit: contain; \}/);
  const reveal = CV.slice(CV.indexOf("const reveal = () => {"), CV.indexOf("mediaImg.addEventListener(\"load\", reveal)"));
  assert.ok(reveal.length > 0);
  assert.doesNotMatch(reveal, /wrap\.style\.(width|aspectRatio)\s*=/);
});

test("video box reserves aspect-ratio or the fixed band; metadata never reshapes it", () => {
  assert.match(CV, /aspect-ratio:\$\{dw\} \/ \$\{dh\}; max-width:100%/);
  assert.match(CSS, /\.msg-video:not\(\[style\]\) \{[^}]*height: 260px/);
  assert.doesNotMatch(COMP, /host\.style\.(aspectRatio|height)\s*=/);
});
