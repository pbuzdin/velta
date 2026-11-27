// media-catchup.js — the #478 background placeholder drain: newest chat
// first (the open chat jumps the queue), one fetch at a time, pending
// messages only, capped per run, reruns coalesced.
// NOTE: assertions poll for PROGRESS instead of sleeping — Windows timers
// clamp small setTimeouts to ~30ms, so wall-clock waits are not stable here.
import test from "node:test";
import assert from "node:assert/strict";
import { createMediaCatchup, MAX_ITEMS_PER_RUN } from "../app/js/media-catchup.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, desc) {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await sleep(10);
  }
  assert.fail("timeout waiting for: " + desc);
}

function fakeCore(chats, { failChatId = null } = {}) {
  const fetched = [];
  let inflight = 0;
  let maxInflight = 0;
  return {
    fetched,
    maxInflight: () => maxInflight,
    core: {
      async getMessages(id) {
        if (id === failChatId) throw new Error("boom");
        return { messages: (chats.find(([cid]) => cid === id) || [])[1] || [] };
      },
      async downloadFullMessage(id) {
        maxInflight = Math.max(maxInflight, ++inflight);
        await sleep(1);
        inflight--;
        fetched.push(id);
      },
    },
  };
}

test("newest chat first, open chat jumps the queue, pending only, strictly sequential", async () => {
  const chats = [
    [1, [{ id: "a1", downloadState: "Done" }, { id: "a2", downloadState: "Pending" }]],
    [2, [{ id: "b1", downloadState: "InProgress" }, { id: "b2", downloadState: undefined }]],
    [3, [{ id: "c1", downloadState: "Pending" }, { id: "c2", downloadState: "Pending" }]],
  ];
  const f = fakeCore(chats);
  const mc = createMediaCatchup({
    core: f.core,
    getChatIds: async () => [3, 2, 1],
    getCurrentChatId: () => 1,
    betweenMs: 1,
  });
  mc.now();
  await until(() => f.fetched.length === 3, "three fetches");
  await sleep(60); // grace: a wrong extra fetch would land here
  assert.deepEqual(f.fetched, ["a2", "c1", "c2"], "open chat 1 first, then newest-first 3, then 2");
  assert.equal(f.maxInflight(), 1, "one download at a time");
});

test("no limit set → nothing fetches; a failed scan retries on the next trigger", async () => {
  const chats = [[1, [{ id: "x1", downloadState: "Pending" }]]];
  let on = false;
  const f = fakeCore(chats);
  const mc = createMediaCatchup({
    core: f.core,
    getChatIds: async () => [1],
    limitOn: () => on,
    betweenMs: 0,
  });
  mc.now();
  await sleep(60);
  assert.deepEqual(f.fetched, [], "limit off: the queue is inert");
  // A scan that throws (chat fetch fails) is swallowed and retried on the
  // next trigger — the queue never turns itself off.
  const bad = fakeCore(chats, { failChatId: 1 });
  const mc2 = createMediaCatchup({ core: bad.core, getChatIds: async () => [1], betweenMs: 0 });
  mc2.now();
  await sleep(60);
  assert.deepEqual(bad.fetched, []);
  on = true;
  mc.now();
  await until(() => f.fetched.length === 1, "one fetch after the limit turns on");
  assert.deepEqual(f.fetched, ["x1"]);
});

test("run cap stops the scan; a trigger during a run coalesces into one rerun", async () => {
  let fetches = 0;
  const core = {
    async getMessages() { return { messages: Array.from({ length: MAX_ITEMS_PER_RUN + 20 }, (_, i) => ({ id: `m${i}`, downloadState: "Pending" })) }; },
    async downloadFullMessage() { fetches++; },
  };
  const mc = createMediaCatchup({ core, getChatIds: async () => [1], betweenMs: 0 });
  mc.now();
  await until(() => fetches >= MAX_ITEMS_PER_RUN, "the cap");
  const stopped = fetches;
  await sleep(60);
  assert.equal(fetches, stopped, "nothing runs past the cap without a new trigger");
  // Two triggers while the run is active coalesce into exactly one rerun.
  mc.now();
  mc.now();
  await until(() => fetches >= MAX_ITEMS_PER_RUN * 2, "the rerun's cap");
  assert.equal(fetches, MAX_ITEMS_PER_RUN * 2, "no run stacking storm");
});
