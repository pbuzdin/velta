import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { timeTag } from "../app/js/format.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("day time uses the local calendar date", () => {
  const d = new Date(2024, 0, 2, 0, 30);
  const tag = timeTag(d.getTime(), "Jan 2", { day: true, className: "day-chip" });
  assert.match(tag, /datetime="2024-01-02"/);
  assert.match(tag, /class="day-chip"/);
  assert.doesNotMatch(tag, /T/);
});

test("instant time is ISO and escapes text", () => {
  const tag = timeTag(Date.UTC(2024, 5, 1, 12, 0, 0), `a < b & "c"`);
  assert.match(tag, /datetime="2024-06-01T12:00:00.000Z"/);
  assert.match(tag, />a &lt; b &amp; &quot;c&quot;</);
});

test("top native controls are wired", () => {
  const ui = read("app/js/ui.js");
  const app = read("app/js/app.js");
  const chat = read("app/js/chat-view.js");
  const css = read("app/css/main.css");
  const html = read("app/index.html");
  assert.match(ui, /popoverSupported/);
  assert.match(ui, /form: true/);
  assert.match(app, /form: true/);
  assert.match(app, /type = "search"/);
  assert.match(html, /enterkeyhint="send"/);
  assert.match(html, /<progress id="chat-load-bar"/);
  assert.match(chat, /_pickLocalFile/);
  assert.match(chat, /<progress class="mfp-bar"/);
  assert.match(chat, /field-sizing/);
  assert.match(css, /field-sizing:\s*content/);
  assert.match(ui, /role="switch"/);
  assert.match(app, /minlength="6"/);
});
