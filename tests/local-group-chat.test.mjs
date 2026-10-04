import test from "node:test";
import assert from "node:assert/strict";

// Local group chat, Phase 3: the adapter side. Group chats surface as
// `p2pg:<gid>` chats (kind "group") next to `p2p:` 1:1 chats; everything with a
// p2pg id is answered by the adapter and never reaches the real core or the
// 1:1 engine commands. Pins: ids, list/header fields, sender names, numeric
// increasing ids, ticks derived from per-member acks over the CURRENT roster,
// read-only after removal/disband, rejected voice/files, leave vs disband,
// relay ids falling through with ALL arguments, once-per-group hydration, and
// the disabled-by-default invariant.

globalThis.CustomEvent ??= class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } };
const flags = { enabled: true };
const ls = new Map();
globalThis.localStorage = {
  getItem: k => (k === "velta-p2p" ? (flags.enabled ? "1" : "0") : ls.get(k) ?? null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: k => ls.delete(k),
};
globalThis.window = globalThis;

const ME = "aaaa".repeat(16), BOB = "bbbb".repeat(16), CAL = "cccc".repeat(16), DAN = "dddd".repeat(16);
const member = (id, name, extra = {}) => ({ id, name, self: id === ME, online: id === ME, introduced: false, ...extra });
const groupJson = (gid, name, creator, members, extra = {}) => ({
  gid, name, creator, epoch: 1, closed: false, removed: false, canManage: creator === ME, members, ...extra,
});

const GID = "11".repeat(16), GID2 = "22".repeat(16);
const engine = {
  groups: [
    groupJson(GID, "Trio", ME, [member(ME, "Me"), member(BOB, "Bob", { online: true }), member(CAL, "Cal", { introduced: true })]),
    groupJson(GID2, "Bob's club", BOB, [member(BOB, "Bob", { online: true }), member(ME, "Me")]),
  ],
  peers: [{ id: BOB, name: "Bob", online: true, queued: 0, proto: 2 }],
  history: {},      // gid -> rows
  log: [],          // every invoke
  seq: 0,
  failSend: false,
  failDelete: false,
  deleted: [],
  impact: { created: [], member: [] },
};
const listener = { current: null };
const invoke = async (cmd, args = {}) => {
  engine.log.push({ cmd, args });
  switch (cmd) {
    case "p2p_status": return { name: "dev", nodeId: ME, nearby: [], peers: engine.peers, groups: engine.groups };
    case "p2p_messages": return [];
    case "p2p_group_messages": return engine.history[args.gid] || [];
    case "p2p_group_send":
      if (engine.failSend) throw new Error("boom");
      return { id: "E" + ++engine.seq, seq: engine.seq, ts: 1_700_000_000_000 + engine.seq, tsEff: 1_700_000_000_000 + engine.seq, queued: false };
    case "p2p_send": return { id: "P1", queued: false };
    case "p2p_group_leave": return { ...engine.groups[1], removed: true };
    case "p2p_group_disband": return { ...engine.groups[0], removed: true, closed: true };
    case "p2p_group_delete":
      if (engine.failDelete) throw new Error("nope");
      engine.deleted.push(args.gid);
      engine.groups = engine.groups.filter(g => g.gid !== args.gid);
      return null;
    case "p2p_peer_groups": return engine.impact;
    case "p2p_remove_peer": engine.peers = engine.peers.filter(p => p.id !== args.peerId); return null;
    case "p2p_group_create": return groupJson("33".repeat(16), args.name, ME, [member(ME, "Me"), ...args.memberIds.map(i => member(i, "x"))]);
    default: throw new Error("unexpected command " + cmd);
  }
};
globalThis.__TAURI__ = { event: { listen: async (name, fn) => { listener.current = fn; } }, core: { invoke } };
const fire = payload => listener.current({ payload });

const inner = {
  accountEpoch: 1, calls: [], events: [],
  async getChatList() { return []; },
  async getChat(id) { this.calls.push(["getChat", id]); return { id, kind: "single" }; },
  async getMessages(id, o) { this.calls.push(["getMessages", id, o]); return { messages: [], hasMore: false }; },
  async getMessageIds(id) { this.calls.push(["getMessageIds", id]); return [7]; },
  async getMessage(id) { this.calls.push(["getMessage", id]); return { id }; },
  async deleteMessages(...a) { this.calls.push(["deleteMessages", ...a]); },
  async setChatFlags(...a) { this.calls.push(["setChatFlags", ...a]); },
  async markRead(id) { this.calls.push(["markRead", id]); },
  async getChatMembers(...a) { this.calls.push(["getChatMembers", ...a]); return [{ id: 5 }]; },
  async leaveGroup(...a) { this.calls.push(["leaveGroup", ...a]); },
  async sendMessage(...a) { this.calls.push(["sendMessage", ...a]); return { id: 9 }; },
  async resendMessage(...a) { this.calls.push(["resendMessage", ...a]); },
  dispatchEvent(ev) { this.events.push(ev.type + ":" + (ev.detail?.chatId ?? "")); },
};
const lc = await import("../app/js/local-chat.js");
const core = lc.withLocalChat(inner);
const gc = id => "p2pg:" + id;
const msgs = async id => (await core.getMessages(gc(id))).messages;
const chatOf = async id => (await core.getChatList({})).find(c => c.id === gc(id));
const groupMsgEv = (gid, from, seq, text, extra = {}) => ({
  kind: "group-message", gid, from, name: from === BOB ? "Bob" : "Cal", id: "e" + from.slice(0, 2) + seq, seq,
  ts: 1_700_000_100_000 + seq, tsEff: 1_700_000_100_000 + seq, text, replyTo: null, replyText: null, ...extra,
});

test("group chat list entry: kind group, isP2p, p2pg id, counts, name filter", async () => {
  const list = await core.getChatList({});
  const g = list.find(c => c.id === gc(GID));
  assert.equal(g.kind, "group");
  assert.equal(g.isP2p, true);
  assert.equal(g.isP2pGroup, true);
  assert.equal(g.name, "Trio");
  assert.equal(g.memberCount, 3);
  assert.equal(g.onlineCount, 2, "me + Bob");
  assert.equal(g.canManage, true);
  assert.equal(g.readOnly, false);
  assert.equal(list.find(c => c.id === "p2p:" + BOB).kind, "single", "1:1 entry unchanged");
  assert.deepEqual((await core.getChatList({ query: "club" })).map(c => c.id), [gc(GID2)]);
});

test("getChat returns members and canManage for the creator only", async () => {
  const mine = await core.getChat(gc(GID));
  const theirs = await core.getChat(gc(GID2));
  assert.equal(mine.canManage, true);
  assert.equal(theirs.canManage, false);
  assert.equal(mine.memberCount, 3);
  assert.equal(await core.getChat(gc("ff".repeat(16))), null);
});

test("getChatMembers maps self + members with online flags; relay ids fall through with all args", async () => {
  const rows = await core.getChatMembers(gc(GID));
  assert.deepEqual(rows.map(r => [r.name, r.self, r.online, r.introduced, r.isCreator]), [
    ["Me", true, true, false, true],
    ["Bob", false, true, false, false],
    ["Cal", false, false, true, false],
  ]);
  inner.calls.length = 0;
  assert.deepEqual(await core.getChatMembers(42, "extra"), [{ id: 5 }]);
  assert.deepEqual(inner.calls, [["getChatMembers", 42, "extra"]]);
});

test("group message event shows the sender name and keeps ids numeric and increasing", async () => {
  fire(groupMsgEv(GID, BOB, 1, "hi all"));
  fire(groupMsgEv(GID, CAL, 1, "hello"));
  fire(groupMsgEv(GID, BOB, 2, "second"));
  const m = (await msgs(GID)).filter(x => x.kind === "msg");
  assert.deepEqual(m.map(x => x.text), ["hi all", "hello", "second"]);
  assert.deepEqual(m.map(x => x.fromContact.name), ["Bob", "Cal", "Bob"]);
  assert.deepEqual(m.map(x => x.from), [0, 0, 0]);
  assert.equal(m[0].fromContact.id, null, "avatar never looks a core contact up");
  for (const x of m) assert.ok(typeof x.id === "number" && x.id > 1_000_000_000);
  assert.ok(m[0].id < m[1].id && m[1].id < m[2].id);
  // Exact duplicate (same author + seq) is ignored.
  fire(groupMsgEv(GID, BOB, 2, "second"));
  assert.equal((await msgs(GID)).filter(x => x.kind === "msg").length, 3);
  const chat = await chatOf(GID);
  assert.equal(chat.unread, 3);
  assert.equal(chat.lastMsg, "Bob: second");
  assert.ok(inner.events.includes("chat-updated:" + gc(GID)));
});

test("the first row is a system line; markRead clears group unread", async () => {
  const all = await msgs(GID);
  assert.equal(all[0].kind, "service");
  assert.equal(all[0].text, "You created the group");
  assert.ok(all[0].ts < all[1].ts);
  const other = await msgs(GID2);
  assert.equal(other[0].text, "Bob added you to the group");
  await core.markRead(gc(GID));
  assert.equal((await chatOf(GID)).unread, 0);
  inner.calls.length = 0;
  await core.markRead(55);
  assert.deepEqual(inner.calls, [["markRead", 55]]);
});

test("group sendMessage calls p2p_group_send with gid and the engine id of the quoted message", async () => {
  const before = (await msgs(GID)).filter(x => x.kind === "msg");
  const quoted = before[0];
  engine.log.length = 0;
  const sent = await core.sendMessage(gc(GID), { text: "re: hi", quoteId: quoted.id, quoteText: "hi all" });
  assert.equal(sent.from, 1);
  const call = engine.log.find(c => c.cmd === "p2p_group_send");
  assert.equal(call.args.gid, GID);
  assert.equal(call.args.text, "re: hi");
  assert.equal(call.args.replyTo, "e" + BOB.slice(0, 2) + "1", "engine id, not the adapter's numeric id");
  assert.equal(call.args.replyText, "hi all");
  await new Promise(r => setTimeout(r, 0));
  const mine = (await msgs(GID)).at(-1);
  assert.equal(mine.quote.text, "hi all");
  assert.equal(mine.quote.fromContact.name, "Bob");
  assert.equal(mine.quote.id, quoted.id, "quote jumps to the local message");
  assert.equal(engine.log.some(c => ["p2p_send", "p2p_messages", "p2p_remove_peer"].includes(c.cmd) && JSON.stringify(c.args).includes(GID)), false);
});

test("group message state goes pending -> sent -> read only when all current members acked", async () => {
  const g = GID2; // members: Bob (online) + me
  fire({ kind: "group-state", group: groupJson(GID, "Trio", ME, [member(ME, "Me"), member(BOB, "Bob"), member(CAL, "Cal")]) });
  const sent = await core.sendMessage(gc(GID), { text: "ticks" });
  await new Promise(r => setTimeout(r, 0));
  const seq = engine.seq;
  const state = async () => (await msgs(GID)).find(x => x.text === "ticks").state;
  assert.equal(await state(), "pending", "nobody online, nobody acked");
  fire({ kind: "group-presence", peerId: BOB, online: true, gids: [GID] });
  assert.equal(await state(), "sent", "a member is online");
  fire({ kind: "group-ack", gid: GID, by: BOB, have: seq });
  assert.equal(await state(), "sent", "one of two others is not enough");
  fire({ kind: "group-ack", gid: GID, by: CAL, have: seq - 1 });
  assert.equal(await state(), "sent", "an older cursor does not cover this message");
  fire({ kind: "group-ack", gid: GID, by: CAL, have: seq });
  assert.equal(await state(), "read");
  assert.equal((await chatOf(GID)).lastState, "read");
  void g; void sent;
});

test("removed or left members no longer count toward read", async () => {
  await core.sendMessage(gc(GID), { text: "before cal leaves" });
  await new Promise(r => setTimeout(r, 0));
  const seq = engine.seq;
  fire({ kind: "group-ack", gid: GID, by: BOB, have: seq });
  const state = async () => (await msgs(GID)).find(x => x.text === "before cal leaves").state;
  assert.equal(await state(), "sent", "Cal has not acked yet");
  engine.groups[0] = groupJson(GID, "Trio", ME, [member(ME, "Me"), member(BOB, "Bob")], { epoch: 2 }); // the engine's truth
  fire({ kind: "group-state", group: engine.groups[0] });
  assert.equal(await state(), "read", "Cal left the roster: only Bob counts");
  assert.equal((await chatOf(GID)).memberCount, 2);
});

test("group-state updates the roster and header counts; group-removed makes the chat read-only", async () => {
  fire({ kind: "group-state", group: groupJson(GID2, "Bob's club (renamed)", BOB, [member(BOB, "Bob", { online: true }), member(ME, "Me"), member(DAN, "Dan")], { epoch: 2 }) });
  let chat = await core.getChat(gc(GID2));
  assert.equal(chat.name, "Bob's club (renamed)");
  assert.equal(chat.memberCount, 3);
  assert.equal(chat.readOnly, false);
  fire({ kind: "group-removed", gid: GID2, reason: "removed" });
  chat = await core.getChat(gc(GID2));
  assert.equal(chat.readOnly, true);
  const last = (await msgs(GID2)).at(-1);
  assert.equal(last.kind, "service");
  assert.match(last.text, /no longer in this group/);
  await assert.rejects(core.sendMessage(gc(GID2), { text: "nope" }), /not in this group/);
  fire({ kind: "group-removed", gid: GID2, reason: "removed" }); // idempotent
  assert.equal((await msgs(GID2)).filter(x => x.kind === "service").length, 2);
});

test("voice and file sends in a group are rejected until the media phase", async () => {
  engine.log.length = 0;
  await assert.rejects(core.sendMessage(gc(GID), { text: "", viewtype: "voice", file: "/tmp/v.ogg" }), /Voice/);
  await assert.rejects(core.sendMessage(gc(GID), { text: "cap", file: "/tmp/a.png", filename: "a.png" }), /Files/);
  assert.equal(engine.log.some(c => c.cmd === "p2p_group_send" || c.cmd === "p2p_send_file"), false);
});

test("group-presence updates member dots and never creates a p2p: chat", async () => {
  fire({ kind: "group-presence", peerId: CAL, online: true, gids: [GID] });
  const rows = await core.getChatMembers(gc(GID));
  assert.equal(rows.find(r => r.name === "Dan") === undefined, true);
  const list = await core.getChatList({});
  assert.deepEqual(list.filter(c => c.id.startsWith("p2p:")).map(c => c.id), ["p2p:" + BOB], "no chat for the introduced member");
  fire({ kind: "group-presence", peerId: "e".repeat(64), online: true, gids: ["00".repeat(16)] });
  assert.deepEqual((await core.getChatList({})).filter(c => c.id.startsWith("p2p:")).map(c => c.id), ["p2p:" + BOB]);
});

test("p2pg ids never reach the real core or 1:1 commands", async () => {
  inner.calls.length = 0;
  engine.log.length = 0;
  const id = gc(GID);
  await core.getChat(id); await core.getMessages(id); await core.getMessageIds(id);
  await core.markRead(id); await core.deleteMessages(id, [1, 2]); await core.setChatFlags(id, { muted: true });
  await core.getChatMembers(id);
  assert.deepEqual(inner.calls, []);
  assert.equal(engine.log.some(c => ["p2p_send", "p2p_messages", "p2p_remove_peer", "p2p_send_file", "p2p_retry"].includes(c.cmd)), false);
});

test("deleteMessages/setChatFlags are no-ops for p2pg and pass through for relay ids with all args", async () => {
  inner.calls.length = 0;
  await core.deleteMessages(12, [3, 4]);
  await core.setChatFlags(12, { pinned: true });
  assert.deepEqual(inner.calls, [["deleteMessages", 12, [3, 4]], ["setChatFlags", 12, { pinned: true }]]);
});

test("leaveGroup on a p2pg id: member leaves, creator disbands; relay ids fall through with all arguments", async () => {
  engine.log.length = 0;
  await core.leaveGroup(gc(GID2));
  assert.deepEqual(engine.log.filter(c => c.cmd.startsWith("p2p_group_")).map(c => [c.cmd, c.args]), [["p2p_group_leave", { gid: GID2 }]]);
  await core.leaveGroup(gc(GID));
  assert.equal(engine.log.at(-1).cmd, "p2p_group_disband");
  assert.deepEqual(engine.log.at(-1).args, { gid: GID });
  const g = await core.getChat(gc(GID));
  assert.equal(g.readOnly, true);
  assert.equal(g.closed, true);
  inner.calls.length = 0;
  await core.leaveGroup(77, "x");
  assert.deepEqual(inner.calls, [["leaveGroup", 77, "x"]]);
});

test("dismissLocalGroup hides the chat from the list (and leaves it first if still active)", async () => {
  engine.log.length = 0;
  await lc.dismissLocalGroup(GID2);
  assert.equal(engine.log.some(c => c.cmd === "p2p_group_leave"), false, "already read-only: nothing to leave");
  const ids = (await core.getChatList({})).map(c => c.id);
  assert.equal(ids.includes(gc(GID2)), false);
  assert.equal(await core.getChat(gc(GID2)), null);
  assert.deepEqual(engine.deleted, [GID2], "the engine forgets the group, no localStorage workaround");
  assert.equal(ls.get("velta-p2pg-hidden"), undefined);
});

test("createLocalGroup calls p2p_group_create and the new chat shows up", async () => {
  engine.log.length = 0;
  const id = await lc.createLocalGroup("New one", [BOB]);
  assert.equal(id, gc("33".repeat(16)));
  assert.deepEqual(engine.log[0], { cmd: "p2p_group_create", args: { name: "New one", memberIds: [BOB] } });
  const g = await core.getChat(id);
  assert.equal(g.name, "New one");
  assert.equal(g.memberCount, 2);
});

test("1:1 behaviour is unchanged with groups present", async () => {
  engine.log.length = 0;
  const sent = await core.sendMessage("p2p:" + BOB, { text: "hello bob" });
  assert.equal(sent.chatId, "p2p:" + BOB);
  assert.equal(engine.log.find(c => c.cmd === "p2p_send").args.peerId, BOB);
  assert.equal(engine.log.some(c => c.cmd === "p2p_group_send"), false);
  inner.calls.length = 0;
  await core.sendMessage(5, { text: "relay" });
  assert.equal(inner.calls[0][0], "sendMessage");
});

test("group history hydrates once from p2p_group_messages, seeds acks and keeps numeric ids", async () => {
  const gid = "44".repeat(16);
  engine.groups.push(groupJson(gid, "Old group", ME, [member(ME, "Me"), member(BOB, "Bob", { online: true }), member(CAL, "Cal")]));
  engine.history[gid] = [
    { seq: 1, from: ME, id: "o1", ts: 1_700_000_000_001, tsEff: 1_700_000_000_001, dir: "out", text: "mine", replyTo: null, replyText: null, delivered: [BOB, CAL] },
    { seq: 1, from: BOB, id: "b1", ts: 1_700_000_000_002, tsEff: 1_700_000_000_002, dir: "in", text: "bob says", replyTo: "o1", replyText: "mine", delivered: [] },
    { seq: 2, from: ME, id: "o2", ts: 1_700_000_000_003, tsEff: 1_700_000_000_003, dir: "out", text: "bob only", replyTo: null, replyText: null, delivered: [BOB] },
  ];
  await core.getChatList({});
  const first = await msgs(gid);
  assert.deepEqual(first.map(m => m.text), ["You created the group", "mine", "bob says", "bob only"]);
  assert.deepEqual(first.slice(1).map(m => m.state), ["read", "read", "sent"]);
  assert.equal(first[2].quote.text, "mine");
  assert.equal(first[2].quote.fromContact.name, "You");
  for (const m of first) assert.equal(typeof m.id, "number");
  assert.ok(first.every((m, i) => i === 0 || m.id > first[i - 1].id));
  // Live message that raced the snapshot is not duplicated.
  fire(groupMsgEv(gid, BOB, 1, "bob says", { id: "b1" }));
  await core.getChat(gc(gid)); await core.getMessageIds(gc(gid)); await core.getChatList({});
  assert.equal((await msgs(gid)).length, 4);
  assert.equal(engine.log.filter(c => c.cmd === "p2p_group_messages" && c.args.gid === gid).length, 1);
});

test("a failed group send shows failed and resend swaps in a fresh send", async () => {
  engine.failSend = true;
  await core.sendMessage(gc(GID), { text: "will fail" });
  await new Promise(r => setTimeout(r, 0));
  const failed = (await msgs(GID)).find(m => m.text === "will fail");
  assert.equal(failed.state, "failed");
  engine.failSend = false;
  await core.resendMessage(failed.id);
  const after = (await msgs(GID)).filter(m => m.text === "will fail");
  assert.equal(after.length, 1);
  assert.notEqual(after[0].state, "failed");
  assert.ok(after[0].id > failed.id);
});

test("local chat off: groups are invisible and everything falls through", async () => {
  flags.enabled = false;
  try {
    assert.deepEqual(await core.getChatList({}), []);
    inner.calls.length = 0;
    await core.markRead(gc(GID));
    assert.deepEqual(inner.calls, [["markRead", gc(GID)]], "nothing is intercepted while the toggle is off");
    assert.equal(await lc.hubModel(), null);
  } finally { flags.enabled = true; }
});

test("hub model lists groups for the Local chat card", async () => {
  const model = await lc.hubModel();
  const trio = model.groups.find(g => g.id === gc(GID));
  assert.equal(trio.name, "Trio");
  assert.equal(model.groups.some(g => g.id === gc(GID2)), false, "deleted group is gone");
  assert.equal(model.peers[0].proto, 2);
});

test("create-group picker: v1 and offline peers are disabled with a reason, limits and duplicates are reported", () => {
  const st = {
    peers: [
      { id: BOB, name: "Bob", online: true, proto: 2 },
      { id: CAL, name: "Cal", online: false, proto: 2 },
      { id: DAN, name: "Dan", online: true, proto: 1 },
    ],
    groups: [groupJson(GID, "Trio", ME, [member(ME, "Me"), member(BOB, "Bob")])],
  };
  const m = lc.groupPickerModel(st);
  const by = id => m.peers.find(p => p.id === id);
  assert.equal(by(BOB).disabled, false);
  assert.equal(by(CAL).disabled, true);
  assert.match(by(CAL).reason, /offline/);
  assert.equal(by(DAN).disabled, true);
  assert.match(by(DAN).reason, /latest Velta/);
  assert.equal(m.atLimit, false);
  assert.equal(lc.GROUP_MAX_OTHERS, 3);
  assert.equal(lc.findDuplicateGroup(st, [BOB])?.gid, GID, "same member set is flagged");
  assert.equal(lc.findDuplicateGroup(st, [BOB, CAL]), null);
  const many = { peers: [], groups: Array.from({ length: 16 }, (_, i) => groupJson(String(i), "g", ME, [member(ME, "Me")])) };
  assert.equal(lc.groupPickerModel(many).atLimit, true);
  many.groups[0].removed = true;
  assert.equal(lc.groupPickerModel(many).atLimit, false, "closed groups do not count toward the limit");
});

test("UI guards exist for p2pg: header line, hidden relay-only actions, gated entry points", async () => {
  const { readFileSync } = await import("node:fs");
  const read = f => readFileSync(new URL("../app/js/" + f, import.meta.url), "utf8");
  const comp = read("components.js"), view = read("chat-view.js"), app = read("app.js");
  assert.match(comp, /isP2pGroup[\s\S]{0,200}members[\s\S]{0,40}online/, "header shows N members · M online");
  for (const label of ["Forward", "Save to Saved Messages", "Delete"]) {
    assert.ok(view.includes(label), label);
  }
  assert.match(view, /const p2pg = !!this\.chat\?\.isP2pGroup/);
  assert.match(view, /_applyGroupComposer/);
  assert.match(app, /chat\.kind === "group" && !chat\.isP2pGroup \? \[\{ label: "Group invite QR"/);
  assert.match(app, /!c\.isP2pGroup\);\s*for \(const chat of targets\)/, "forward targets exclude local groups");
  // both "new group" entries only exist behind the local-chat switch
  assert.match(app, /p2pEnabled\(\) && p2pAvailable\(\) \? \[\{ label: "New local group/);
  assert.match(app, /async function newLocalGroupFlow\(\)[\s\S]{0,300}!p2pEnabled\(\)/);
  assert.match(app, /if \(!model\) \{ el\.hidden = true/, "hub card stays hidden when local chat is off");
});

const sysRow = (id, kind, text, ts) => ({ seq: 0, from: "", id, ts, tsEff: ts, dir: "sys", text, replyTo: null, replyText: null, delivered: [], sysKind: kind });
const sysEv = (gid, id, kind, text, ts = 1_700_000_300_000) => ({ kind: "group-system", gid, id, sysKind: kind, text, ts, tsEff: ts });

test("engine system lines hydrate as service messages in time order and replace the derived intro line", async () => {
  const gid = "55".repeat(16);
  engine.groups.push(groupJson(gid, "Sys group", BOB, [member(ME, "Me"), member(BOB, "Bob", { online: true })], { canManage: false }));
  engine.history[gid] = [
    sysRow("sys:joined:1:0", "joined", "Bob added you", 1_700_000_000_000),
    { seq: 1, from: BOB, id: "b1", ts: 1_700_000_000_010, tsEff: 1_700_000_000_010, dir: "in", text: "hi", replyTo: null, replyText: null, delivered: [] },
    sysRow("sys:renamed:2:0", "renamed", "Bob renamed the group to \u201cSys group\u201d", 1_700_000_000_020),
  ];
  await core.getChatList({});
  const rows = await msgs(gid);
  assert.deepEqual(rows.map(m => m.text), ["Bob added you", "hi", "Bob renamed the group to \u201cSys group\u201d"]);
  assert.deepEqual(rows.map(m => m.kind), ["service", "msg", "service"]);
  assert.equal(rows[0].ts, 1_700_000_000_000, "real timestamps, not the derived ones");
  assert.equal(rows.filter(m => /added you/.test(m.text)).length, 1, "no second, adapter-derived line");
  const chat = await chatOf(gid);
  assert.equal(chat.lastMsg, "Bob: hi", "system lines are never the chat preview");
  assert.equal(chat.unread, 0);
});

test("a live group-system event adds one service line (deduped) and a joined line beats the derived intro", async () => {
  const gid = "56".repeat(16);
  // The system line arrives BEFORE the roster (engine order for a new invitation).
  fire(sysEv(gid, "sys:joined:1:0", "joined", "Bob added you"));
  fire(sysEv(gid, "sys:joined:1:0", "joined", "Bob added you"));
  engine.groups.push(groupJson(gid, "Fresh", BOB, [member(ME, "Me"), member(BOB, "Bob")], { canManage: false }));
  fire({ kind: "group-state", group: engine.groups.at(-1) });
  const rows = await msgs(gid);
  assert.deepEqual(rows.map(m => m.text), ["Bob added you"]);
  fire(sysEv(gid, "sys:added:2:0", "added", "Bob added Cal"));
  assert.deepEqual((await msgs(gid)).map(m => m.text), ["Bob added you", "Bob added Cal"]);
  assert.ok(inner.events.some(e => e === "chat-updated:" + gc(gid)));
});

test("group-removed uses the engine's end line, and adds its own only for logs that have none", async () => {
  const withEnd = "57".repeat(16), without = "58".repeat(16);
  for (const gid of [withEnd, without]) {
    engine.groups.push(groupJson(gid, "Ending", BOB, [member(ME, "Me"), member(BOB, "Bob")], { canManage: false }));
  }
  await core.getChatList({});
  fire(sysEv(withEnd, "sys:removed-me:3:0", "removed-me", "You were removed from the group"));
  fire({ kind: "group-removed", gid: withEnd, reason: "removed" });
  fire({ kind: "group-removed", gid: without, reason: "closed" });
  const a = (await msgs(withEnd)).map(m => m.text);
  assert.equal(a.filter(t => /removed|no longer/.test(t)).length, 1, a.join("|"));
  for (const g of engine.groups) if (g.gid === withEnd || g.gid === without) g.removed = true; // engine truth
  assert.equal((await chatOf(withEnd)).readOnly, true);
  assert.ok((await msgs(without)).some(m => m.text === "The group was disbanded"));
  assert.equal((await msgs(without)).filter(m => m.text === "The group was disbanded").length, 1);
});

test("a finished group from before the persisted lines still gets one end line after hydration", async () => {
  const gid = "59".repeat(16);
  engine.groups.push(groupJson(gid, "Old ended", BOB, [member(ME, "Me")], { removed: true, closed: false, canManage: false }));
  engine.history[gid] = [
    { seq: 1, from: BOB, id: "b1", ts: 1_700_000_000_010, tsEff: 1_700_000_000_010, dir: "in", text: "old", replyTo: null, replyText: null, delivered: [] },
  ];
  await core.getChatList({});
  await core.getChatList({});
  const t = (await msgs(gid)).map(m => m.text);
  assert.equal(t.filter(x => x === "You are no longer in this group").length, 1, t.join("|"));
});

test("outgoing group messages carry a per-member delivery list from the acks", async () => {
  const gid = "5a".repeat(16);
  engine.groups.push(groupJson(gid, "Deliv", ME, [member(ME, "Me"), member(BOB, "Bob", { online: true }), member(CAL, "Cal")]));
  engine.history[gid] = [
    { seq: 1, from: ME, id: "d1", ts: 1_700_000_000_001, tsEff: 1_700_000_000_001, dir: "out", text: "both", replyTo: null, replyText: null, delivered: [BOB, CAL] },
    { seq: 2, from: ME, id: "d2", ts: 1_700_000_000_002, tsEff: 1_700_000_000_002, dir: "out", text: "bob only", replyTo: null, replyText: null, delivered: [BOB] },
  ];
  await core.getChatList({});
  let rows = (await msgs(gid)).filter(m => m.kind === "msg");
  assert.deepEqual(rows[1].delivery.map(d => [d.name, d.delivered]), [["Bob", true], ["Cal", false]]);
  assert.deepEqual(rows[0].delivery.map(d => d.delivered), [true, true]);
  fire({ kind: "group-ack", gid, by: CAL, have: 2 });
  rows = (await msgs(gid)).filter(m => m.kind === "msg");
  assert.deepEqual(rows[1].delivery.map(d => d.delivered), [true, true]);
  assert.equal(rows[1].state, "read");
  // Incoming messages have no delivery list.
  fire(groupMsgEv(gid, BOB, 1, "from bob"));
  assert.equal((await msgs(gid)).at(-1).delivery, undefined);
});

test("delete falls back to the hidden list when the engine can't, and old hidden groups are migrated", async () => {
  const gid = "5b".repeat(16);
  engine.groups.push(groupJson(gid, "Stubborn", BOB, [member(ME, "Me")], { removed: true, canManage: false }));
  await core.getChatList({});
  engine.failDelete = true;
  await lc.dismissLocalGroup(gid);
  assert.deepEqual(JSON.parse(ls.get("velta-p2pg-hidden")), [gid]);
  assert.equal((await core.getChatList({})).some(c => c.id === gc(gid)), false);
  // Next start the engine can: the hidden entry is migrated to a real delete.
  engine.failDelete = false;
  engine.deleted.length = 0;
  await core.getChatList({});
  assert.deepEqual(engine.deleted, [gid]);
  assert.deepEqual(JSON.parse(ls.get("velta-p2pg-hidden")), []);
  assert.equal(engine.groups.some(g => g.gid === gid), false);
});

test("group-deleted drops the chat; removing a creator's contact prunes their groups; impact is reported", async () => {
  const gid = "5c".repeat(16), mine = "5d".repeat(16);
  engine.groups.push(groupJson(gid, "Dan's", DAN, [member(ME, "Me"), member(DAN, "Dan")], { canManage: false }));
  engine.groups.push(groupJson(mine, "Mine", ME, [member(ME, "Me"), member(DAN, "Dan")]));
  engine.peers.push({ id: DAN, name: "Dan", online: true, queued: 0, proto: 2 });
  await core.getChatList({});
  assert.ok(await chatOf(gid));
  engine.impact = { created: [{ gid, name: "Dan's" }], member: [{ gid: mine, name: "Mine" }] };
  const imp = await lc.peerGroupImpact(DAN);
  assert.deepEqual(imp.created.map(g => g.name), ["Dan's"]);
  assert.deepEqual(imp.member.map(g => g.name), ["Mine"]);
  // The engine deletes the creator's group when the peer is removed.
  engine.groups = engine.groups.filter(g => g.gid !== gid);
  await lc.removePeer(DAN);
  assert.equal(await chatOf(gid), undefined, "gone with its creator");
  assert.ok(await chatOf(mine), "a group I created stays");
  assert.ok(engine.log.some(c => c.cmd === "p2p_remove_peer" && c.args.peerId === DAN));
  // The engine can also tell us directly.
  fire({ kind: "group-deleted", gid: mine });
  assert.equal(await core.getChat(gc(mine)), null);
});

test("info-sheet model: creator gets rename/add/disband, members only leave, finished groups only delete", () => {
  const keys = c => lc.groupActionsModel(c).map(a => a.key);
  assert.deepEqual(keys({ canManage: true, readOnly: false, memberCount: 3 }), ["rename", "add", "leave"]);
  assert.deepEqual(keys({ canManage: false, readOnly: false, memberCount: 3 }), ["leave"]);
  assert.deepEqual(keys({ canManage: true, readOnly: true, memberCount: 1 }), ["delete"]);
  assert.deepEqual(keys({ canManage: false, readOnly: true, memberCount: 2 }), ["delete"]);
  const labels = c => lc.groupActionsModel(c).map(a => a.label);
  assert.equal(labels({ canManage: true, memberCount: 2 }).at(-1), "Disband group");
  assert.equal(labels({ canManage: false, memberCount: 2 }).at(-1), "Leave group");
  // Cap of 4 including the creator: Add is shown but disabled, with the reason.
  const full = lc.groupActionsModel({ canManage: true, readOnly: false, memberCount: 4 }).find(a => a.key === "add");
  assert.equal(full.disabled, true);
  assert.match(full.label, /full/);
  assert.equal(lc.groupActionsModel({ canManage: true, readOnly: false, memberCount: 3 }).find(a => a.key === "add").disabled, false);
  assert.ok(lc.groupActionsModel({ canManage: true, readOnly: false, memberCount: 2 }).filter(a => a.danger).length === 1);
});

test("member hint explains who can manage and what 'not paired' means", () => {
  const ms = [{ self: true }, { introduced: false }, { introduced: true }];
  assert.match(lc.groupMemberHint({ canManage: true, readOnly: false }, ms), /only you can rename it and add or remove members \(3\/4\)/);
  assert.match(lc.groupMemberHint({ canManage: false, readOnly: false }, ms), /Only the group's creator/);
  const t = lc.groupMemberHint({ canManage: false, readOnly: false }, ms);
  assert.match(t, /Not paired/);
  assert.match(t, /only here/);
  assert.doesNotMatch(lc.groupMemberHint({ canManage: true, readOnly: false }, [{ self: true }, { introduced: false }]), /Not paired/);
  assert.match(lc.groupMemberHint({ canManage: false, readOnly: true }, ms), /nobody can write/);
});

test("unpair confirm text lists deleted groups and groups where the device stays a member", () => {
  const none = lc.removePeerImpactText("Bob", { created: [], member: [] });
  assert.match(none, /^Forget "Bob"\?/);
  assert.doesNotMatch(none, /group/);
  const both = lc.removePeerImpactText("Bob", { created: [{ name: "Trip" }, { name: "Gym" }], member: [{ name: "Mine" }] });
  assert.match(both, /Bob created "Trip", "Gym": those groups will be deleted from this device too/);
  assert.match(both, /Bob is also in "Mine": it stays there as a member you can't message directly any more/);
  assert.match(lc.removePeerImpactText("Bob", { created: [{ name: "Trip" }] }), /that group will be deleted/);
  assert.match(lc.removePeerImpactText("Bob", null), /^Forget/);
});

test("member management goes through the engine commands and updates the roster", async () => {
  const gid = "5e".repeat(16);
  engine.groups.push(groupJson(gid, "Mgmt", ME, [member(ME, "Me"), member(BOB, "Bob", { online: true })]));
  await core.getChatList({});
  engine.log.length = 0;
  const upd = (name, members) => groupJson(gid, name, ME, members, { epoch: 2 });
  const origInvoke = globalThis.__TAURI__.core.invoke;
  globalThis.__TAURI__.core.invoke = async (cmd, args) => {
    if (cmd === "p2p_group_add") { engine.log.push({ cmd, args }); return upd("Mgmt", [member(ME, "Me"), member(BOB, "Bob"), member(CAL, "Cal")]); }
    if (cmd === "p2p_group_remove") { engine.log.push({ cmd, args }); return upd("Mgmt", [member(ME, "Me"), member(BOB, "Bob")]); }
    if (cmd === "p2p_group_rename") { engine.log.push({ cmd, args }); return upd(args.name, [member(ME, "Me"), member(BOB, "Bob")]); }
    return origInvoke(cmd, args);
  };
  try {
    await lc.groupAddMember(gid, CAL);
    assert.equal((await core.getChat(gc(gid))).memberCount, 3);
    await lc.groupRemoveMember(gid, CAL);
    assert.equal((await core.getChat(gc(gid))).memberCount, 2);
    await lc.groupRename(gid, "Better");
    assert.equal((await core.getChat(gc(gid))).name, "Better");
    assert.deepEqual(engine.log.map(c => c.cmd), ["p2p_group_add", "p2p_group_remove", "p2p_group_rename"]);
    assert.deepEqual(engine.log[0].args, { gid, nodeId: CAL });
  } finally { globalThis.__TAURI__.core.invoke = origInvoke; }
});

test("UI wiring for member management exists and stays creator-only", async () => {
  const { readFileSync } = await import("node:fs");
  const read = f => readFileSync(new URL("../app/js/" + f, import.meta.url), "utf8");
  const app = read("app.js"), view = read("chat-view.js"), p2p = read("p2p.js");
  assert.match(app, /canRemove = chat\.isP2pGroup && chat\.canManage && !chat\.readOnly && !m\.self && !m\.isCreator/);
  for (const k of ["rename", "add", "leave", "delete"]) assert.ok(app.includes(`act("${k}"`), k);
  assert.match(app, /await confirmRemovePeer\(peerId, name\)/, "hub card unpair confirm");
  assert.match(app, /confirmRemovePeer\(String\(chat\.id\)\.slice\("p2p:"\.length\)/, "chat-list unpair confirm");
  assert.match(view, /Delivered<\/span>[\s\S]{0,200}m\.delivery\.filter/, "per-member delivery rows in message info");
  assert.match(p2p, /export async function showAddMembersModal/);
  assert.match(p2p, /GROUP_MAX_OTHERS \+ 1 - inGroup\.size/, "free slots of the 4-member cap");
});
