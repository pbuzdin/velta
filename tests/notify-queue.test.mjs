import test from "node:test";
import assert from "node:assert/strict";
import { createNotifyQueue } from "../app/js/notify-queue.js";

// Incoming-message toasts are grouped per chat and flushed once per burst.

test("notify queue groups a burst per chat into one flush", async () => {
  const pending = [];
  const flushes = [];
  const q = createNotifyQueue((groups, epoch) => { flushes.push({ groups, epoch }); }, fn => pending.push(fn));
  q.push({ chatId: 1, text: "a" }, 0);
  q.push({ chatId: 2, text: "b" }, 0);
  q.push({ chatId: 1, text: "c" }, 0);
  assert.equal(pending.length, 1, "one scheduled flush for the burst");
  assert.equal(q.pending, 2);
  pending.shift()();
  await null;
  assert.equal(flushes.length, 1);
  assert.deepEqual([...flushes[0].groups.keys()], [1, 2]);
  assert.deepEqual(flushes[0].groups.get(1).map(m => m.text), ["a", "c"]);
  assert.equal(q.pending, 0);
});

test("notify queue drops a batch from a previous account epoch", async () => {
  const pending = [];
  const flushes = [];
  const q = createNotifyQueue(groups => { flushes.push(groups); }, fn => pending.push(fn));
  q.push({ chatId: 1 }, 0);
  q.push({ chatId: 2 }, 1); // account switched
  for (const fn of pending) fn();
  await null;
  assert.equal(flushes.length, 1);
  assert.deepEqual([...flushes[0].keys()], [2]);
});
