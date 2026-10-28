import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.HTMLElement = class {};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const { sheetDragDecision, bindSheetDrag } = await import("../app/js/ui.js");

test("drag decision: 30% of height or a fast flick closes, else snap", () => {
  assert.equal(sheetDragDecision(150, 500, 0), "close");
  assert.equal(sheetDragDecision(149, 500, 0.1), "snap");
  assert.equal(sheetDragDecision(40, 500, 0.9), "close");
  assert.equal(sheetDragDecision(8, 500, 2), "snap");
  assert.equal(sheetDragDecision(-80, 500, 3), "snap");
});

function fakeSheet() {
  const handlers = {};
  return {
    style: {},
    handlers,
    addEventListener(type, fn, opts) { (handlers[type] ||= []).push({ fn, opts }); },
    getBoundingClientRect: () => ({ top: 300, height: 400 }),
    setPointerCapture() {},
    fire(type, e) { for (const h of handlers[type] || []) h.fn({ button: 0, pointerId: 1, timeStamp: 0, preventDefault() {}, type, ...e }); },
  };
}

test("dragging the handle down follows the finger and closes past 30%", async () => {
  const handle = { contains: t => t === handle };
  const sheet = fakeSheet();
  let closed = 0;
  bindSheetDrag(sheet, handle, () => closed++);
  sheet.fire("pointerdown", { target: handle, clientY: 310 });
  sheet.fire("pointermove", { clientY: 290, timeStamp: 10 });
  assert.equal(sheet.style.transform, undefined, "no upward drag");
  sheet.fire("pointermove", { clientY: 400, timeStamp: 200 });
  assert.equal(sheet.style.transform, "translateY(90px)");
  sheet.fire("pointerup", { clientY: 450, timeStamp: 400 });
  await new Promise(r => setTimeout(r, 220));
  assert.equal(closed, 1);
});

test("a short drag snaps back; a tap below the top strip never drags", () => {
  const handle = { contains: t => t === handle };
  const sheet = fakeSheet();
  let closed = 0;
  bindSheetDrag(sheet, handle, () => closed++);
  sheet.fire("pointerdown", { target: handle, clientY: 310 });
  sheet.fire("pointermove", { clientY: 340, timeStamp: 200 });
  sheet.fire("pointerup", { clientY: 340, timeStamp: 400 });
  assert.equal(sheet.style.transform, "");
  const tile = {};
  sheet.fire("pointerdown", { target: tile, clientY: 500 });
  sheet.fire("pointermove", { clientY: 600, timeStamp: 100 });
  assert.equal(sheet.style.transform, "");
  assert.equal(closed, 0);
});

test("handle is a labelled button; bar has non-text contrast ≥3:1", () => {
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /grab = document\.createElement\("button"\)[\s\S]{0,200}aria-label", t\("Close menu"\)/);
  for (const l of ["ru", "fr"]) assert.ok(JSON.parse(readFileSync(new URL(`../app/locales/${l}.json`, import.meta.url)))["Close menu"]);
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  assert.match(css, /\.msg-sheet-grab::before \{[^}]*background: var\(--text-dim\)/);
  const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  for (const [fg, bg] of [["#8b8b96", "#181820"], ["#5d626d", "#f4f4f4"], ["#a3a0ad", "#2a2a35"]]) assert.ok(ratio(fg, bg) >= 3, `${fg} on ${bg}`);
});
