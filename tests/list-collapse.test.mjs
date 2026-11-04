// #282: collapsible chat list on wide layouts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collapsedBadgeCount, isToggleShortcut, LIST_COLLAPSED_KEY, WIDE_QUERY } from "../app/js/list-collapse.js";

const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
const js = readFileSync(new URL("../app/js/list-collapse.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");

test("badge counts unread of non-muted, non-archived chats", () => {
  assert.equal(collapsedBadgeCount([{ unread: 2 }, { unread: 5, muted: true }, { unread: 1, archived: true }, { unread: 3 }]), 5);
  assert.equal(collapsedBadgeCount(null), 0);
});

test("Ctrl/Cmd+B toggles, other chords don't", () => {
  assert.ok(isToggleShortcut({ ctrlKey: true, key: "b" }));
  assert.ok(isToggleShortcut({ metaKey: true, key: "B" }));
  assert.ok(!isToggleShortcut({ ctrlKey: true, shiftKey: true, key: "B" }));
  assert.ok(!isToggleShortcut({ key: "b" }));
});

test("two-pane only, same breakpoint as the layout", () => {
  assert.equal(WIDE_QUERY, "(min-width: 821px)");
  assert.match(css, /@media \(max-width: 820px\) \{ \.list-toggle \{ display: none; \} \}/);
});

test("collapsed state: slide out, chevron flips, reduced motion honoured", () => {
  assert.match(css, /\.app\.list-collapsed \.sidebar \{ margin-left: calc\(-1 \*/);
  assert.match(css, /\.app\.list-collapsed \.list-toggle svg \{ transform: rotate\(180deg\); \}/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\n  \.sidebar, \.list-toggle, \.list-toggle svg \{ transition: none; \}/);
});

test("a11y and persistence", () => {
  assert.equal(LIST_COLLAPSED_KEY, "velta-list-collapsed");
  assert.match(js, /aria-expanded/);
  assert.match(js, /t\("Show chat list"\)/);
  assert.match(js, /t\("Hide chat list"\)/);
  assert.match(js, /toggleAttribute\("inert", collapsed\)/);
  assert.match(app, /initListCollapse\(\{ getChats: \(\) => state\.chats \}\)/);
  assert.match(app, /listCollapse\?\.refreshBadge\(\)/);
});

test("strings in ru and fr", () => {
  for (const l of ["ru", "fr"]) {
    const j = JSON.parse(readFileSync(new URL(`../app/locales/${l}.json`, import.meta.url), "utf8"));
    assert.ok(j["Show chat list"] && j["Hide chat list"]);
  }
});
