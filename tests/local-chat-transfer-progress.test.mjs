import test from "node:test";
import assert from "node:assert/strict";

// Covers the local-chat media transfer UI contract (phase 2):
//  - file-progress events drive the bubble bar and backfill the file size,
//  - a done event clears the bar (the finished file card takes over),
//  - a failed event (session died mid-send) marks the message failed,
//  - lcRetryTransfer re-sends the stored copy and swaps the message; the
//    failed message is restored when the engine rejects the re-send.

globalThis.CustomEvent ??= class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } };
globalThis.localStorage = { getItem: () => "1", setItem() {}, removeItem() {} };
globalThis.window = globalThis; // local-chat.js reads window.__TAURI__

let sendN = 0;
const listener = { current: null };
const baseInvoke = async (cmd, args = {}) => {
  if (cmd === "p2p_status") return { name: "dev", nodeId: "n0", peers: [{ id: "x", name: "Peer" }], nearby: [] };
  if (cmd === "p2p_send_file") return { id: `E${++sendN}`, path: "/stored/copy.bin" };
  if (cmd === "p2p_send") return { id: `E${++sendN}`, queued: !!args.__queued };
  throw new Error("unexpected command " + cmd);
};
globalThis.__TAURI__ = {
  event: { listen: async (name, fn) => { listener.current = fn; } },
  core: { invoke: baseInvoke },
};
const fire = payload => listener.current({ payload });

const { withLocalChat, lcRetryTransfer } = await import("../app/js/local-chat.js");

const inner = {
  accountEpoch: 1,
  async getChatList() { return []; },
  dispatchEvent() {},
};
const core = withLocalChat(inner);
const p2pMsgs = async () => (await core.getMessages("p2p:x")).messages;

test("file-progress: bar pct, size backfill, done clears, failed marks", async () => {
  await core.getChatList({});
  fire({ kind: "presence", peerId: "x", online: true }); // engine peers arrive offline until presence

  const sent = await core.sendMessage("p2p:x", { text: "", file: "/src/a.bin", filename: "a.bin" });
  assert.equal(sent.id, "E1");

  fire({ kind: "file-progress", peerId: "x", id: "E1", dir: "send", got: 1000, size: 4000 });
  let [m] = await p2pMsgs();
  assert.equal(m.transfer.pct, 25);
  assert.equal(m.fileSize, 4000); // send pushed size 0; progress knows the real one

  fire({ kind: "file-progress", peerId: "x", id: "E1", dir: "send", got: 0, size: 0, done: true });
  [m] = await p2pMsgs();
  assert.equal(m.transfer, undefined); // bar gone, file card renders instead

  await core.sendMessage("p2p:x", { text: "", file: "/src/b.bin", filename: "b.bin" }); // E2
  fire({ kind: "file-progress", peerId: "x", id: "E2", dir: "send", got: 2000, size: 8000 });
  fire({ kind: "file-progress", peerId: "x", id: "E2", dir: "send", failed: true });
  const msgs = await p2pMsgs();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].transfer.failed, true);
  assert.equal(msgs[1].transfer.pct, 25);
});

test("lcRetryTransfer swaps the failed message; restores it if the engine says offline", async () => {
  const msgsBefore = await p2pMsgs();
  const failed = msgsBefore[1]; // E2, showing the Retry button
  await lcRetryTransfer("p2p:x", failed.id);
  let msgs = await p2pMsgs();
  assert.equal(msgs.length, 2); // swap, not append
  assert.equal(msgs[1].id, "E3");
  assert.equal(msgs[1].transfer, undefined);
  assert.equal(msgs[1].filePath, "/stored/copy.bin"); // same stored copy, fresh id

  globalThis.__TAURI__.core.invoke = async (cmd) => {
    if (cmd === "p2p_send_file") throw new Error("peer is offline");
    throw new Error("unexpected command " + cmd);
  };
  await assert.rejects(() => lcRetryTransfer("p2p:x", msgs[1].id), /offline/);
  msgs = await p2pMsgs();
  assert.equal(msgs.length, 2); // message came back instead of vanishing
  assert.equal(msgs[1].id, "E3");
});

test("media queued while offline auto-flushes when presence goes online", async () => {
  globalThis.__TAURI__.core.invoke = baseInvoke;
  globalThis.__TAURI__.core.invoke = async (cmd) => {
    if (cmd === "p2p_send_file") return { id: `E${++sendN}`, path: "/stored/copy.bin" };
    throw new Error("unexpected command " + cmd);
  };

  fire({ kind: "presence", peerId: "x", online: false });
  await core.sendMessage("p2p:x", { text: "", file: "/src/c.bin", filename: "c.bin" });
  let msgs = await p2pMsgs();
  assert.equal(msgs[msgs.length - 1].queued, true); // parked, not sent

  fire({ kind: "presence", peerId: "x", online: true });
  await new Promise(r => setTimeout(r, 0)); // flush runs async
  msgs = await p2pMsgs();
  assert.equal(msgs[msgs.length - 1].queued, undefined);
  assert.equal(msgs[msgs.length - 1].id, `E${sendN}`); // engine re-send replaced it

  // Peer drops again, another file is queued, and the flush stops on the
  // engine rejecting the send — the item stays queued for the next presence.
  fire({ kind: "presence", peerId: "x", online: false });
  await core.sendMessage("p2p:x", { text: "", file: "/src/d.bin", filename: "d.bin" });
  globalThis.__TAURI__.core.invoke = async (cmd) => {
    if (cmd === "p2p_send_file") throw new Error("peer is offline");
    throw new Error("unexpected command " + cmd);
  };
  fire({ kind: "presence", peerId: "x", online: true });
  await new Promise(r => setTimeout(r, 0));
  msgs = await p2pMsgs();
  assert.equal(msgs[msgs.length - 1].queued, true); // still parked

  globalThis.__TAURI__.core.invoke = baseInvoke;
  fire({ kind: "presence", peerId: "x", online: false });
  fire({ kind: "presence", peerId: "x", online: true }); // offline -> online transition
  await new Promise(r => setTimeout(r, 0));
  msgs = await p2pMsgs();
  assert.equal(msgs[msgs.length - 1].queued, undefined); // flushed this time
});

test("offline text surfaces pending -> sent -> read through engine events", async () => {
  globalThis.__TAURI__.core.invoke = baseInvoke;

  // Sent-now: acked immediately (single ack model).
  await core.sendMessage("p2p:x", { text: "online hello" });
  let msgs = await p2pMsgs();
  assert.equal(msgs[msgs.length - 1].state, "read");

  // Queued by the engine: bubble shows the pending clock, not ticks.
  globalThis.__TAURI__.core.invoke = async (cmd, args = {}) => {
    if (cmd === "p2p_send") return { id: `E${++sendN}`, queued: true };
    return baseInvoke(cmd, args);
  };
  await core.sendMessage("p2p:x", { text: "offline hello" });
  await new Promise(r => setTimeout(r, 0)); // let the invoke promise set engineId
  msgs = await p2pMsgs();
  const pending = msgs[msgs.length - 1];
  assert.equal(pending.state, "pending");

  // Reconnect flush puts it on the wire -> ticks; peer ack -> read.
  fire({ kind: "msg-state", peerId: "x", id: pending.engineId, state: "sent" });
  msgs = await p2pMsgs();
  assert.equal(msgs[msgs.length - 1].state, "sent");
  fire({ kind: "ack", peerId: "x", id: pending.engineId });
  msgs = await p2pMsgs();
  assert.equal(msgs[msgs.length - 1].state, "read");
});

test("failed texts retry in place: swap for a fresh send, restore on failure", async () => {
  globalThis.__TAURI__.core.invoke = async (cmd, args = {}) => {
    if (cmd === "p2p_send") throw new Error("connect failed");
    return baseInvoke(cmd, args);
  };
  await core.sendMessage("p2p:x", { text: "will fail" });
  await new Promise(r => setTimeout(r, 0)); // let the rejection mark it failed
  let msgs = await p2pMsgs();
  const failed = msgs[msgs.length - 1];
  assert.equal(failed.state, "failed"); // no ticks — the Retry button replaces them

  // Successful retry: the failed bubble is swapped for a fresh engine send
  // with the same text (queued this time).
  globalThis.__TAURI__.core.invoke = async (cmd, args = {}) => {
    if (cmd === "p2p_send") return { id: `E${++sendN}`, queued: true };
    return baseInvoke(cmd, args);
  };
  await core.resendMessage(failed.id);
  msgs = await p2pMsgs();
  assert.ok(!msgs.some(m => m.state === "failed" && m.text === "will fail"));
  const fresh = msgs[msgs.length - 1];
  assert.equal(fresh.text, "will fail");
  assert.equal(fresh.state, "pending");

  // Failing retry: make a fresh failed text, then the bubble comes back
  // with its Retry button instead of vanishing.
  globalThis.__TAURI__.core.invoke = async (cmd, args = {}) => {
    if (cmd === "p2p_send") throw new Error("connect failed");
    return baseInvoke(cmd, args);
  };
  await core.sendMessage("p2p:x", { text: "will fail twice" });
  await new Promise(r => setTimeout(r, 0));
  const twice = (await p2pMsgs()).at(-1);
  assert.equal(twice.state, "failed");
  const before = (await p2pMsgs()).length;
  globalThis.__TAURI__.core.invoke = async (cmd, args = {}) => {
    if (cmd === "p2p_send") throw new Error("peer is offline");
    return baseInvoke(cmd, args);
  };
  await assert.rejects(() => core.resendMessage(twice.id), /offline/);
  msgs = await p2pMsgs();
  assert.equal(msgs.length, before); // restored, not vanished
  assert.equal(msgs.at(-1).state, "failed");
});
