import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// PWA console hygiene: the blobfile boot probe is shell-only (in the browser
// PWA it is a guaranteed-failing http:// element on an https:// page —
// mixed-content console noise), and the deprecated
// apple-mobile-web-app-capable meta is paired with the modern
// mobile-web-app-capable form.
const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("the blobfile probe runs only inside the shell", () => {
  const media = strip(read("app/js/media.js"));
  assert.match(media, /if \(tauriInvoke\(\)\) \{\s*try \{\s*const probe = new Image\(\)/);
  // resolution must still fall through to the PWA pipeline when the probe
  // is skipped: veltaBlobfileOk stays unset and fileUrl checks it
  assert.match(media, /window\.veltaBlobfileOk/);
});

test("index.html carries both web-app-capable metas", () => {
  const html = read("app/index.html");
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
});
