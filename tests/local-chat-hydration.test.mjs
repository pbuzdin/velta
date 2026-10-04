import test from "node:test";
import assert from "node:assert/strict";

// Local group chat work, Phase 0a: the adapter store is memory-only, so a
// `p2p:` chat used to open EMPTY after an app restart even though the engine
// still holds messages-<id>.jsonl. Pins the hydration contract:
//  - history comes from p2p_messages, once per peer (idempotent, concurrent
//    callers share one request),
//  - ids stay NUMERIC (1e9+seq) so the chat view's append-only filter works,
//  - a live event that raced the hydration is not duplicated,
//  - a failed hydration is retried instead of leaving the chat empty.

globalThis.CustomEvent ??= class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } };
globalThis.localStorage = { getItem: () => "1", setItem() {}, removeItem() {} };
globalThis.window = globalThis; // local-chat.js reads window.__TAURI__

const listener = { current: null };
const calls = [];                 // every p2p_messages request
let history = {};                 // peerId -> engine rows
let gate = null;                  // optional promise p2p_messages waits for
let failNext = 0;
const invoke = async (cmd, args = {}) => {
  if (cmd === "p2p_status") {
    return { name: "dev", nodeId: "n0", nearby: [], peers: Object.keys(history).map(id => ({ id, name: "Peer " + id })) };
  }
  if (cmd === "p2p_messages") {
    calls.push(args);
    if (gate) await gate;
    if (failNext > 0) { failNext--; throw new Error("P2P engine is still starting"); }
    return history[args.peerId] || [];
  }
  if (cmd === "p2p_send") return { id: "ENG-NEW", queued: false };
  throw new Error("unexpected command " + cmd);
};
globalThis.__TAURI__ = { event: { listen: async (name, fn) => { listener.current = fn; } }, core: { invoke } };
const fire = payload => listener.current({ payload });

const { withLocalChat } = await import("../app/js/local-chat.js");
const core = withLocalChat({ accountEpoch: 1, async getChatList() { return []; }, dispatchEvent() {} });
const msgsOf = async id => (await core.getMessages("p2p:" + id)).messages;

const row = (id, dir, text, extra = {}) => ({ id, ts: 1_700_000_000_000 + calls.length, dir, state: dir === "out" ? "acked" : "acked", text, ...extra });

test("history loads from the engine once per peer and ids are numeric", async () => {
  history.a = [
    row("m1", "in", "hello"),
    row("m2", "out", "hi back", { state: "sent" }),
    row("m3", "out", "still pending", { state: "queued" }),
    row("m4", "in", "re: hi", { reply_to: "m2", reply_text: "hi back" }),
    row("m5", "in", "", { file: { name: "pic.png", size: 12, mime: "image/png", path: "/blobs/a/pic.png" } }),
  ];
  await core.getChatList({}); // first paint: list hydrates previews too
  const first = await msgsOf("a");
  assert.deepEqual(first.map(m => m.text), ["hello", "hi back", "still pending", "re: hi", ""]);
  assert.deepEqual(first.map(m => m.from), [0, 1, 1, 0, 0]);
  assert.deepEqual(first.map(m => m.state), ["read", "sent", "pending", "read", "read"]);
  assert.equal(first[3].quote.text, "hi back");
  assert.equal(first[4].filePath, "/blobs/a/pic.png");
  assert.equal(first[4].viewtype, "image");
  for (const m of first) {
    assert.equal(typeof m.id, "number");
    assert.ok(m.id > 1_000_000_000, "ids live in the 1e9+ range, never engine strings");
  }
  assert.deepEqual(first.map(m => m.id), [...first.map(m => m.id)].sort((x, y) => x - y)); // increasing in order

  // Idempotent: every entry point again, the engine is not asked twice and
  // the store does not grow.
  await core.getChat("p2p:a");
  await core.getMessageIds("p2p:a");
  await core.getChatList({});
  const second = await msgsOf("a");
  assert.deepEqual(second.map(m => m.id), first.map(m => m.id));
  assert.equal(calls.filter(c => c.peerId === "a").length, 1);
  assert.equal(calls[0].limit > 0, true);

  // The list shows the newest message as the preview without opening the chat.
  const chat = await core.getChat("p2p:a");
  assert.equal(chat.lastMsg, "📎 pic.png");
});

test("concurrent first opens share one request", async () => {
  history.b = [row("b1", "in", "one"), row("b2", "in", "two")];
  await core.getChatList({});
  calls.length = 0;
  // b was hydrated by the list already; a brand-new peer exercises the race.
  history.c = [row("c1", "in", "x")];
  let release; gate = new Promise(r => { release = r; });
  const listP = core.getChatList({});
  await new Promise(r => setTimeout(r, 0));
  const open1 = core.getMessages("p2p:c");
  const open2 = core.getMessageIds("p2p:c");
  release(); gate = null;
  const [, r1, r2] = await Promise.all([listP, open1, open2]);
  assert.equal(r1.messages.length, 1);
  assert.equal(r2.length, 1);
  assert.equal(calls.filter(c => c.peerId === "c").length, 1);
});

test("a live event that raced the hydration is not duplicated and stays after the history", async () => {
  history.d = [row("d1", "in", "old 1"), row("d2", "in", "old 2"), row("d3", "in", "arrived during load")];
  let release; gate = new Promise(r => { release = r; });
  const listP = core.getChatList({});
  await new Promise(r => setTimeout(r, 0));
  // The engine delivers d3 live while p2p_messages is still in flight (it is
  // in the snapshot as well), plus a genuinely newer d4.
  fire({ kind: "message", peerId: "d", id: "d3", ts: 3, text: "arrived during load" });
  fire({ kind: "message", peerId: "d", id: "d4", ts: 4, text: "newer" });
  release(); gate = null;
  await listP;
  const msgs = await msgsOf("d");
  assert.deepEqual(msgs.map(m => m.text), ["old 1", "old 2", "arrived during load", "newer"]);
  assert.equal(new Set(msgs.map(m => m.id)).size, 4);
});

test("append-only filter: messages after hydration get ids above all history ids", async () => {
  history.e = [row("e1", "in", "h1"), row("e2", "out", "h2")];
  await core.getChatList({});
  const before = await msgsOf("e");
  const maxId = Math.max(...before.map(m => m.id));

  fire({ kind: "message", peerId: "e", id: "e3", ts: 9, text: "live" });
  await core.sendMessage("p2p:e", { text: "mine" });
  const after = await msgsOf("e");
  const fresh = after.filter(m => m.id > maxId);          // what chat-view's tail refetch keeps
  assert.deepEqual(fresh.map(m => m.text), ["live", "mine"]);
  assert.equal(after.length, before.length + 2);

  // A repeated engine delivery of a hydrated message is ignored.
  fire({ kind: "message", peerId: "e", id: "e1", ts: 1, text: "h1" });
  assert.equal((await msgsOf("e")).length, after.length);
});

test("a queued text from history is released by the msg-state event", async () => {
  history.f = [row("f1", "out", "waiting", { state: "queued" })];
  await core.getChatList({});
  let [m] = await msgsOf("f");
  assert.equal(m.state, "pending");
  fire({ kind: "msg-state", peerId: "f", id: "f1", state: "sent" });
  [m] = await msgsOf("f");
  assert.equal(m.state, "sent");
  fire({ kind: "ack", peerId: "f", id: "f1" });
  [m] = await msgsOf("f");
  assert.equal(m.state, "read");
});

test("a failed hydration does not throw, shows nothing and is retried on the next call", async () => {
  history.g = [row("g1", "in", "recovered")];
  failNext = 2;
  const list = await core.getChatList({}); // attempt 1 fails: the list still resolves
  assert.ok(Array.isArray(list));
  assert.deepEqual(await msgsOf("g"), []); // attempt 2 fails: empty, no exception
  const msgs = await msgsOf("g");          // attempt 3 succeeds
  assert.deepEqual(msgs.map(m => m.text), ["recovered"]);
  assert.equal(calls.filter(c => c.peerId === "g").length, 3);
  await msgsOf("g");                        // done: no further requests
  assert.equal(calls.filter(c => c.peerId === "g").length, 3);
});

test("msg-state / ack that arrive while the history request is in flight are applied to the snapshot", async () => {
  history.h = [row("h1", "out", "queued then flushed", { state: "queued" }), row("h2", "out", "sent then acked", { state: "sent" })];
  let release; gate = new Promise(r => { release = r; });
  const listP = core.getChatList({});
  await new Promise(r => setTimeout(r, 0));
  // The engine flushed h1 and the peer acked h2 right after it took the snapshot.
  fire({ kind: "msg-state", peerId: "h", id: "h1", state: "sent" });
  fire({ kind: "ack", peerId: "h", id: "h2" });
  release(); gate = null;
  await listP;
  const msgs = await msgsOf("h");
  assert.deepEqual(msgs.map(m => m.state), ["sent", "read"]); // no pending clock forever
});
