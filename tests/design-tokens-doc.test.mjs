import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #182: the /design/ reference is GENERATED from app/css/main.css
// (tools/gen-design-tokens.mjs) instead of hand-maintained — the hand table
// had drifted (green "4.8:1" is really 5.51, accent-tint/light and brutal
// were still described as inheriting the dark blue after the per-theme
// change). This test regenerates in memory and fails when the committed
// fragment no longer matches the CSS: a token change cannot land without
// regenerating, so the website page (which embeds this fragment) cannot rot.

process.env.VELTA_GEN_NO_WRITE = "1";
const { generateDesignTokens } = await import("../tools/gen-design-tokens.mjs");

test("committed docs/design-tokens.html matches the current main.css", () => {
  const committed = readFileSync(new URL("../docs/design-tokens.html", import.meta.url), "utf8");
  assert.equal(generateDesignTokens(), committed, "stale — run: node tools/gen-design-tokens.mjs");
});

test("every color token in each theme block has a card", () => {
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  const gen = generateDesignTokens();
  const blockOf = (header) => {
    const i = css.indexOf(header);
    return css.slice(i, css.indexOf("\n}", i));
  };
  for (const [header, suffix] of [[":root {", ""], ['html[data-theme="light"] {', "-light"], ['html[data-theme="brutal"] {', "-brutal"]]) {
    const defined = [...blockOf(header).matchAll(/^\s*--([\w-]+):/gm)].map(m => m[1]);
    // Cards list a token when it is defined in the theme OR inherited from dark.
    const shown = new Set([...gen.matchAll(/id="--([\w-]+)"/g)].map(m => m[1]));
    for (const name of defined) {
      assert.ok(shown.has(name + suffix) || shown.has(name), `${header} token --${name} missing from the generated cards`);
    }
  }
});

test("contrast numbers are computed, not hand-measured", () => {
  const gen = generateDesignTokens();
  assert.match(gen, /<tr><td>Light: --green on --bg<\/td><td class="mono">5\.51<\/td><td class="ok">AA<\/td><\/tr>/);
  assert.match(gen, /<tr><td>Light: --accent-2 on --bg<\/td><td class="mono">3\.40<\/td><td class="warn">AA large\/UI<\/td><\/tr>/);
  assert.match(gen, /<tr><td>Light: --accent on --bg<\/td><td class="mono">3\.01<\/td><td class="warn">AA large\/UI<\/td><\/tr>/);
});
