import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatDuration } from "../app/js/format.js";

test("formatDuration pads mm:ss and switches to h:mm:ss from one hour", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(5), "00:05");
  assert.equal(formatDuration(307), "05:07");
  assert.equal(formatDuration(59.9), "00:59");
  assert.equal(formatDuration(3599), "59:59");
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(3723), "1:02:03");
  assert.equal(formatDuration(-4), "00:00");
  assert.equal(formatDuration(undefined), "00:00");
});

test("duration displays use the shared helper, no local mm:ss copies", () => {
  for (const f of ["calls.js", "components.js", "chat-view.js"]) {
    const js = readFileSync(new URL(`../app/js/${f}`, import.meta.url), "utf8");
    assert.match(js, /formatDuration\(/, f);
    assert.doesNotMatch(js, /\/ 60\)\}:\$\{String\(/, f);
    assert.doesNotMatch(js, /% 60\)\.padStart\(2/, f);
  }
});
