import test from "node:test";
import assert from "node:assert/strict";

// Local group chat, Phase 5: media. Pins the adapter side of group files:
// the send goes to p2p_group_send_file (never p2p_group_send), voice stays
// rejected, per-member state drives the tick / aggregated bar / failed card,
// events that beat the command reply are not lost, Retry re-sends only to
// members that are not done (or to the one member asked for), incoming files
// and history rows (seq 0, identified by transfer id) are de-duplicated, and
// a refusal by the engine leaves no phantom bubble.

globalThis.CustomEvent ??= class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } };
globalThis.localStorage = { getItem: k => (k === "velta-p2p" ? "1" : null), setItem() {}, removeItem() {} };
globalThis.window = globalThis;

const ME = "aaaa".repeat(16), BOB = "bbbb".repeat(16), CAL = "cccc".repeat(16);
const GID = "11".repeat(16);
const member = (id, name) => ({ id, name, self: id === ME, online: true, introduced: false });
const engine = { log: [], seq: 0, refuse: null, retryFail: new Set(), history: [] };
const listener = { current: null };
const invoke = async (cmd, args = {}) => {
  engine.log.push({ cmd, args });
  switch (cmd) {
    case "p2p_status":
      return { name: "dev", nodeId: ME, nearby: [], peers: [],
        groups: [{ gid: GID, name: "Trio", creator: ME, epoch: 1, closed: false, removed: false, canManage: true,
          members: [member(ME, "Me"), member(BOB, "Bob"), member(CAL, "Cal")] }] };
    case "p2p_messages": return [];
    case "p2p_group_messages": return engine.history;
    case "p2p_group_send_file": {
      if (engine.refuse) throw new Error(engine.refuse);
      const id = "F" + ++engine.seq;
      return {
        id, ts: 1_700_000_000_000 + engine.seq, tsEff: 1_700_000_000_000 + engine.seq,
        file: { name: args.name, size: 1000, mime: args.name.endsWith(".pdf") ? "application/pdf" : "image/png", path: "/blobs/g/out-" + args.name },
        members: [{ id: BOB, state: "sending", got: 0 }, { id: CAL, state: "sending", got: 0 }],
      };
    }
    case "p2p_group_file_retry":
      if (engine.retryFail.has(args.member)) throw new Error("that member is offline");
      return null;
    case "p2p_group_send": return { id: "T1", seq: 1, ts: 1, tsEff: 1, queued: false };
    default: throw new Error("unexpected command " + cmd);
  }
};
globalThis.__TAURI__ = { event: { listen: async (n, fn) => { listener.current = fn; } }, core: { invoke } };
const fire = payload => listener.current({ payload });

const inner = { accountEpoch: 1, events: [], async getChatList() { return []; }, dispatchEvent(ev) { this.events.push(ev.type); } };
const lc = await import("../app/js/local-chat.js");
const core = lc.withLocalChat(inner);
await core.getChatList({});
const CHAT = "p2pg:" + GID;
const msgs = async () => (await core.getMessages(CHAT)).messages;
const progress = (id, member, state, got, size = 1000) =>
  fire({ kind: "group-file-progress", gid: GID, id, member, dir: "send", state, got, size });
const send = (extra = {}) => core.sendMessage(CHAT, { text: "look", viewtype: "image", file: "/tmp/pic.png", filename: "pic.png", ...extra });
const cmds = name => engine.log.filter(e => e.cmd === name);

test("a file goes to p2p_group_send_file with name and caption; voice stays rejected", async () => {
  engine.log.length = 0;
  const m = await send();
  assert.equal(cmds("p2p_group_send_file").length, 1);
  assert.deepEqual(cmds("p2p_group_send_file")[0].args, { gid: GID, path: "/tmp/pic.png", name: "pic.png", caption: "look" });
  assert.equal(cmds("p2p_group_send").length, 0, "not sent as a text message");
  assert.equal(m.viewtype, "image");
  assert.equal(m.fileName, "pic.png");
  assert.equal(m.text, "look");
  assert.equal(m.state, "pending", "on its way: clock");
  assert.deepEqual(m.transfer, { pct: 0, dir: "send", members: 2 });
  assert.deepEqual(m.delivery.map(d => [d.name, d.delivered, d.sending]), [["Bob", false, true], ["Cal", false, true]]);
  await assert.rejects(() => core.sendMessage(CHAT, { text: "", viewtype: "voice", file: "/tmp/v.ogg" }), /Voice/);
});

test("aggregated progress, per-member done, ticks: pending → sent → read", async () => {
  const m = await send({ filename: "agg.png" });
  const id = m.engineId;
  const row = async () => (await msgs()).find(x => x.engineId === id);
  progress(id, BOB, "sending", 500);
  progress(id, CAL, "sending", 1000);
  assert.equal((await row()).transfer.pct, 75, "average over both members");
  progress(id, CAL, "done", 1000);
  assert.equal((await row()).state, "pending", "Bob is still receiving");
  progress(id, BOB, "done", 1000);
  const done = await row();
  assert.equal(done.transfer, undefined, "bar gone, finished card");
  assert.equal(done.state, "read", "everyone has it");
  assert.ok(done.delivery.every(d => d.delivered && !d.retryable));
});

test("an offline member leaves a single tick and a Retry for that member; none got it = failed card", async () => {
  engine.log.length = 0;
  const m = await core.sendMessage(CHAT, { text: "", viewtype: "file", file: "/tmp/doc.pdf", filename: "doc.pdf" });
  const id = m.engineId;
  const row = async () => (await msgs()).find(x => x.engineId === id);
  progress(id, CAL, "offline", 0);
  progress(id, BOB, "done", 1000);
  let r = await row();
  assert.equal(r.state, "sent", "delivered to some, not all");
  assert.equal(r.transfer, undefined);
  assert.deepEqual(r.delivery.map(d => [d.name, d.delivered, d.retryable]), [["Bob", true, false], ["Cal", false, true]]);
  assert.equal(r.viewtype, "file");

  // Nobody got it → failed card with Retry.
  const m2 = await send({ filename: "none.png" });
  progress(m2.engineId, BOB, "failed", 100);
  progress(m2.engineId, CAL, "failed", 100);
  const r2 = (await msgs()).find(x => x.engineId === m2.engineId);
  assert.equal(r2.state, "failed");
  assert.equal(r2.transfer.failed, true);
});

test("Retry: all missing members, or exactly the member asked for; offline errors are reported", async () => {
  const m = await send({ filename: "retry.png" });
  const id = m.engineId;
  progress(id, BOB, "done", 1000);
  progress(id, CAL, "failed", 10);
  engine.log.length = 0;
  await lc.lcRetryTransfer(CHAT, m.id);
  assert.deepEqual(cmds("p2p_group_file_retry").map(c => c.args), [{ gid: GID, id, member: CAL }], "Bob has it: not sent again");
  engine.log.length = 0;
  await lc.lcRetryTransfer(CHAT, m.id, BOB);
  assert.deepEqual(cmds("p2p_group_file_retry").map(c => c.args.member), [BOB], "the asked member only");
  engine.retryFail.add(CAL);
  await assert.rejects(() => lc.lcRetryTransfer(CHAT, m.id), /offline/);
  engine.retryFail.clear();
  // A text message / unknown id is a no-op.
  await lc.lcRetryTransfer(CHAT, 999999999);
});

test("progress events that beat the send reply are applied when the message exists", async () => {
  // Deliver the events from inside the command: the reply has not returned yet.
  const orig = globalThis.__TAURI__.core.invoke;
  globalThis.__TAURI__.core.invoke = async (cmd, args) => {
    const res = await invoke(cmd, args);
    if (cmd === "p2p_group_send_file") { progress(res.id, BOB, "done", 1000); progress(res.id, CAL, "done", 1000); }
    return res;
  };
  try {
    const m = await send({ filename: "fast.png" });
    assert.equal(m.state, "read", "both done before the reply returned");
    assert.equal(m.transfer, undefined);
  } finally { globalThis.__TAURI__.core.invoke = orig; }
});

test("the engine refusing (nobody online, over the cap) leaves no bubble and rejects", async () => {
  const before = (await msgs()).length;
  engine.refuse = "file too large for a local group (cap 32 MB)";
  await assert.rejects(() => send({ filename: "huge.bin" }), /32 MB/);
  engine.refuse = "nobody in this group is online — files are only sent to members who are online";
  await assert.rejects(() => send({ filename: "x.bin" }), /online/);
  engine.refuse = null;
  assert.equal((await msgs()).length, before);
});

test("incoming file: a media bubble from the sender, de-duplicated; list preview shows the file name", async () => {
  const ev = (id, name) => ({
    kind: "group-message", gid: GID, from: BOB, name: "Bob", id, seq: 0, ts: 1_700_000_500_000, tsEff: 1_700_000_500_000,
    text: "cap", replyTo: null, replyText: null, file: { name, size: 12, mime: "application/pdf", path: "/blobs/g/" + name },
  });
  fire(ev("in1", "a.pdf"));
  fire(ev("in1", "a.pdf")); // replay
  fire(ev("in2", "b.pdf")); // same author, same seq 0, another transfer
  const rows = (await msgs()).filter(m => m.fileName === "a.pdf" || m.fileName === "b.pdf");
  assert.deepEqual(rows.map(r => [r.fileName, r.from, r.viewtype, r.text]), [["a.pdf", 0, "file", "cap"], ["b.pdf", 0, "file", "cap"]]);
  assert.equal(rows[0].filePath, "/blobs/g/a.pdf");
  assert.ok(rows[1].id > rows[0].id, "numeric ids keep increasing");
  const chat = (await core.getChatList({})).find(c => c.id === CHAT);
  assert.match(chat.lastMsg, /^Bob: 📎 b\.pdf$/);
  assert.ok(chat.unread >= 2);
});
