import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";
import { MockCore } from "../app/js/mock-core.js";

// The relay status line's sending dashes ride _trackSending/_untrackSending.
// Their terminal MsgDelivered/MsgFailed events can be lost (Android bg
// poller consumes them while hidden, reconnects drop mid-flight events, a
// deleted pending message never delivers) — the dashes then stuck forever.
// Pins: emit contract, the 90 s backstop, and reconcileSending().

const wait = ms => new Promise(r => setTimeout(r, ms));

function makeCore() {
  const core = new JsonRpcCore();
  core.accountId = 1;
  core.calls = [];
  core.reply = null; // (msgId) => raw message object | throws
  core._call = async (method, ...args) => {
    core.calls.push([method, ...args]);
    if (method === "get_message") return core.reply ? core.reply(args[1]) : null;
    return null;
  };
  const events = [];
  core.addEventListener("send-activity", e => events.push(!!e.detail.sending));
  core.events = events;
  return core;
}

test("track/untrack emits true per add, exactly one false when the set empties", () => {
  const core = makeCore();
  core._trackSending(30);
  core._trackSending(31); // every add emits true; render is idempotent
  core._untrackSending(30);
  assert.deepEqual(core.events, [true, true]);
  core._untrackSending(30); // foreign/duplicate untrack is a no-op
  core._untrackSending(31);
  assert.deepEqual(core.events, [true, true, false]);
  assert.equal(core._sendingIds.size, 0);
});

test("backstop force-clears a stuck set and emits false", async () => {
  const core = makeCore();
  core.sendingBackstopMs = 40;
  core._trackSending(30);
  await wait(120);
  assert.deepEqual(core.events, [true, false]);
  assert.equal(core._sendingIds.size, 0);
});

test("untrack while other ids remain re-arms the backstop instead of clearing", async () => {
  const core = makeCore();
  core.sendingBackstopMs = 40;
  core._trackSending(30);
  await wait(20);
  core._trackSending(31);
  core._untrackSending(30); // re-arms — 31 must still be covered
  await wait(80);
  assert.deepEqual(core.events, [true, true, false]);
  assert.equal(core._sendingIds.size, 0);
});

test("reconcileSending untracks delivered/failed/gone ids, keeps pending", async () => {
  const core = makeCore();
  core.sendingBackstopMs = 60000;
  core._trackSending(30); // delivered
  core._trackSending(31); // still pending
  core._trackSending(32); // failed
  core._trackSending(33); // gone (deleted before delivery)
  core.reply = msgId => {
    if (msgId === 30) return { state: 26 };  // OutDelivered
    if (msgId === 31) return { state: 20 };  // OutPending
    if (msgId === 32) return { state: 24 };  // OutFailed
    throw new Error("no such message");
  };
  await core.reconcileSending();
  assert.deepEqual([...core._sendingIds], [31]);
  assert.equal(core.events.at(-1), true); // still sending — 31 pending
  assert.equal(core.calls.filter(c => c[0] === "get_message").length, 4);
  // later delivered → set empties, false emitted, backstop timer cleared
  core.reply = () => ({ state: 26 });
  await core.reconcileSending();
  assert.deepEqual(core.events.at(-1), false);
  assert.equal(core._sendingIds.size, 0);
});

test("reconcileSending is a no-op with nothing tracked", async () => {
  const core = makeCore();
  await core.reconcileSending();
  assert.deepEqual(core.calls, []);
  assert.deepEqual(core.events, []);
});

// Context-menu Resend re-queues the SAME message id (core resend_messages) —
// the id must re-enter the sending-dash tracking until the terminal event.
test("resendMessage re-tracks the id for the sending dashes", async () => {
  const core = makeCore();
  await core.resendMessage(44);
  assert.deepEqual(core.calls[0], ["resend_messages", 1, [44]]);
  assert.ok(core._sendingIds.has(44));
  assert.deepEqual(core.events, [true]);
  core._untrackSending(44);
  assert.deepEqual(core.events, [true, false]);
});

test("mock-core resendMessage replays delivery on own messages only", async () => {
  const mock = new MockCore();
  mock._simTimer?.unref();
  const chat = mock.chats[0];
  const mine = mock._mkMsg(chat, { from: 1, text: "resend me", ts: Date.now() });
  chat.messages.push(mine);
  mock.addEventListener("msg-state", e => { const m = chat.messages.find(x => x.id === mine.id); if (m) m.state = e.detail.state; });
  await mock.resendMessage(mine.id);
  assert.equal(mine.state, "pending");
  await new Promise(r => setTimeout(r, 2800));
  assert.equal(mine.state, "read");
  const theirs = mock._mkMsg(chat, { from: 2, text: "not mine", ts: Date.now() });
  chat.messages.push(theirs);
  await assert.rejects(() => mock.resendMessage(theirs.id));
});
