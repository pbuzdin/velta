import { test } from "node:test";
import assert from "node:assert/strict";
import { glassComposerWanted, glassMap } from "../app/js/glass-composer.js";

test("glass map is flat in the middle and bends inward at the rim", () => {
  const w = 80, h = 40, r = 12;
  const data = glassMap(w, h, r);
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const mid = at(40, 20);
  assert.ok(Math.abs(mid[0] - 128) < 10 && Math.abs(mid[1] - 128) < 10, `center ${mid}`);
  assert.equal(mid[3], 255);
  // Square corner of the box sits outside the rounded slab: no bend.
  const corner = at(0, 0);
  assert.deepEqual(corner.slice(0, 2), [128, 128]);
  // Left rim samples from inside the slab, so red is above neutral.
  const left = at(2, 20);
  assert.ok(left[0] > 170, `left rim red ${left[0]}`);
  assert.ok(Math.abs(left[1] - 128) < 20, `left rim green ${left[1]}`);
  // Top rim samples downward.
  const top = at(40, 2);
  assert.ok(top[1] > 170, `top rim green ${top[1]}`);
});

test("glass composer stays off unless the setting is 1", () => {
  const prev = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = { getItem: k => mem.get(k) ?? null };
  try {
    assert.equal(glassComposerWanted(), false);
    mem.set("velta-glass-composer", "0");
    assert.equal(glassComposerWanted(), false);
    mem.set("velta-glass-composer", "1");
    assert.equal(glassComposerWanted(), true);
  } finally {
    if (prev === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prev;
  }
});
