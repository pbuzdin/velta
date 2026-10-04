import test, { mock } from "node:test";
import assert from "node:assert/strict";

// Typing indicator (local chat, Phase 5b): composer-side sender state machine
// (first keystroke, 3 s repeat, 5 s idle stop, stop on send/empty), receiver
// text and expiry (6 s), the user setting (off = neither send nor show),
// multi-name group text, and routing of the hint to the right engine command.

globalThis.CustomEvent ??= class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } };
const ls = new Map([["velta-p2p", "1"]]);
globalThis.localStorage = {
  getItem: k => ls.get(k) ?? null,
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: k => ls.delete(k),
};
globalThis.window = globalThis;

const ME = "aaaa".repeat(16), BOB = "bbbb".repeat(16), CAL = "cccc".repeat(16), DAN = "dddd".repeat(16);
const GID = "11".repeat(16);
const member = (id, name) => ({ id, name, self: id === ME, online: true, introduced: false });
const engine = { log: [] };
const listener = { current: null };
const invoke = async (cmd, args = {}) => {
  engine.log.push({ cmd, args });
  switch (cmd) {
    case "p2p_status":
      return {
        name: "dev", nodeId: ME, nearby: [],
        peers: [{ id: BOB, name: "Bob", online: true, queued: 0, proto: 2 }],
        groups: [{ gid: GID, name: "Quad", creator: ME, epoch: 1, closed: false, removed: false, canManage: true,
          members: [member(ME, "Me"), member(BOB, "Bob"), member(CAL, "Cal"), member(DAN, "Dan")] }],
      };
    case "p2p_messages": return [];
    case "p2p_group_messages": return [];
    case "p2p_typing": return null;
    default: throw new Error("unexpected command " + cmd);
  }
};
globalThis.__TAURI__ = { event: { listen: async (n, fn) => { listener.current = fn; } }, core: { invoke } };
const fire = payload => listener.current({ payload });

const inner = {
  accountEpoch: 1, events: [],
  async getChatList() { return []; },
  async getChat() { return null; },
  dispatchEvent(ev) { this.events.push(ev.type + ":" + (ev.detail?.chatId ?? "")); },
};
const lc = await import("../app/js/local-chat.js");
const { TypingSender, typingText, REPEAT_MS, IDLE_MS, SHOW_TTL_MS } = await import("../app/js/typing.js");
const core = lc.withLocalChat(inner);
await core.getChatList({}); // loads peers + groups from the engine
const hints = () => engine.log.filter(e => e.cmd === "p2p_typing").map(e => e.args);
const listRow = async id => (await core.getChatList({})).find(c => c.id === id);

test("typingText: one, two and three names", () => {
  assert.equal(typingText([]), "");
  assert.equal(typingText(["Anna"]), "Anna is typing…");
  assert.equal(typingText(["Anna", "Ben"]), "Anna and Ben are typing…");
  assert.equal(typingText(["Anna", "Ben", "Cal"]), "Anna, Ben and Cal are typing…");
});

test("sender: first keystroke sends, repeats at most every 3 s, stops after 5 s idle", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const sent = [];
    const s = new TypingSender({ send: on => sent.push(on) });
    s.ping();
    assert.deepEqual(sent, [true], "first keystroke");
    mock.timers.tick(1000); s.ping();
    mock.timers.tick(1000); s.ping();
    assert.deepEqual(sent, [true], "no repeat inside 3 s");
    mock.timers.tick(1000); s.ping(); // 3 s since the first send
    assert.deepEqual(sent, [true, true], "repeat at 3 s");
    mock.timers.tick(IDLE_MS - 1);
    assert.deepEqual(sent, [true, true], "still active just before 5 s idle");
    mock.timers.tick(1);
    assert.deepEqual(sent, [true, true, false], "stop after 5 s idle");
    assert.equal(s.active, false);
    mock.timers.tick(20000);
    assert.deepEqual(sent, [true, true, false], "nothing more once stopped");
  } finally { mock.timers.reset(); }
});

test("sender: stop() on send/empty sends one stop; stop when idle sends nothing; new burst starts again", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const sent = [];
    const s = new TypingSender({ send: on => sent.push(on) });
    s.stop();
    assert.deepEqual(sent, [], "stop without typing is silent");
    s.ping(); s.stop(); s.stop();
    assert.deepEqual(sent, [true, false], "one stop");
    mock.timers.tick(IDLE_MS * 2);
    assert.deepEqual(sent, [true, false], "idle timer was cancelled by stop");
    s.ping();
    assert.deepEqual(sent, [true, false, true], "a new burst sends immediately");
    assert.equal(REPEAT_MS, 3000);
  } finally { mock.timers.reset(); }
});

test("sender: a throwing or rejecting transport never breaks typing", async () => {
  const a = new TypingSender({ send: () => { throw new Error("x"); } });
  assert.doesNotThrow(() => { a.ping(); a.stop(); });
  const b = new TypingSender({ send: () => Promise.reject(new Error("y")) });
  b.ping(); b.stop();
  await new Promise(r => setImmediate(r));
});

test("adapter routes the hint: 1:1 → peerId, group → gid; other ids are ignored", async () => {
  engine.log.length = 0;
  await core.sendTyping("p2p:" + BOB, true);
  await core.sendTyping("p2pg:" + GID, false);
  await core.sendTyping("42", true);
  assert.deepEqual(hints(), [{ peerId: BOB, on: true }, { gid: GID, on: false }]);
});

test("receiver 1:1: 'Name is typing…' in the list row, expires after 6 s, explicit stop clears", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    inner.events.length = 0;
    fire({ kind: "typing", peerId: BOB, on: true });
    assert.equal((await listRow("p2p:" + BOB)).typingText, "Bob is typing…");
    assert.ok(inner.events.includes("chat-updated:p2p:" + BOB), "header/list refresh is requested");
    mock.timers.tick(SHOW_TTL_MS - 1);
    assert.equal((await listRow("p2p:" + BOB)).typingText, "Bob is typing…");
    fire({ kind: "typing", peerId: BOB, on: true }); // a repeat renews the window
    mock.timers.tick(SHOW_TTL_MS - 1);
    assert.equal((await listRow("p2p:" + BOB)).typingText, "Bob is typing…", "renewed");
    inner.events.length = 0;
    mock.timers.tick(1);
    assert.equal((await listRow("p2p:" + BOB)).typingText, undefined, "expired 6 s after the last signal");
    assert.ok(inner.events.includes("chat-updated:p2p:" + BOB), "expiry refreshes the view");
    fire({ kind: "typing", peerId: BOB, on: true });
    fire({ kind: "typing", peerId: BOB, on: false });
    assert.equal((await listRow("p2p:" + BOB)).typingText, undefined, "explicit stop");
  } finally { mock.timers.reset(); }
});

test("receiver group: several names, order of arrival, a message from the sender clears only them", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const row = () => listRow("p2pg:" + GID);
    fire({ kind: "group-typing", gid: GID, from: BOB, name: "Bob", on: true });
    assert.equal((await row()).typingText, "Bob is typing…");
    fire({ kind: "group-typing", gid: GID, from: CAL, name: "Cal", on: true });
    assert.equal((await row()).typingText, "Bob and Cal are typing…");
    fire({ kind: "group-typing", gid: GID, from: DAN, name: "Dan", on: true });
    assert.equal((await row()).typingText, "Bob, Cal and Dan are typing…");
    fire({ kind: "group-message", gid: GID, from: CAL, name: "Cal", id: "m1", seq: 1, ts: 1_700_000_100_000, tsEff: 1_700_000_100_000, text: "hi", replyTo: null, replyText: null });
    assert.equal((await row()).typingText, "Bob and Dan are typing…", "Cal's message ended her typing");
    mock.timers.tick(SHOW_TTL_MS);
    assert.equal((await row()).typingText, undefined, "all expire");
  } finally { mock.timers.reset(); }
});

test("setting off: nothing is sent and incoming hints are ignored; default is on", async () => {
  assert.equal(lc.typingEnabled(), true, "default on");
  ls.set("velta-p2p-typing", "0");
  try {
    assert.equal(lc.typingEnabled(), false);
    engine.log.length = 0;
    await core.sendTyping("p2p:" + BOB, true);
    await core.sendTyping("p2pg:" + GID, true);
    assert.deepEqual(hints(), [], "nothing sent");
    fire({ kind: "typing", peerId: BOB, on: true });
    fire({ kind: "group-typing", gid: GID, from: BOB, name: "Bob", on: true });
    assert.equal((await listRow("p2p:" + BOB)).typingText, undefined);
    assert.equal((await listRow("p2pg:" + GID)).typingText, undefined);
  } finally { ls.delete("velta-p2p-typing"); }
  assert.equal(lc.typingEnabled(), true);
});

test("local chat off: sendTyping is a no-op", async () => {
  ls.set("velta-p2p", "0");
  try {
    engine.log.length = 0;
    await core.sendTyping("p2p:" + BOB, true);
    assert.deepEqual(hints(), []);
  } finally { ls.set("velta-p2p", "1"); }
});
