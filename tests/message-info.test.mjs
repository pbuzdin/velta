import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatDateTime, formatServerUrl, messageInfoState, messageInfoReactions, timeParts } from "../app/js/format.js";
import { JsonRpcCore } from "../app/js/rpc-core.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("clocks are 24-hour", () => {
  const afternoon = new Date(2026, 9, 12, 15, 4, 5).getTime();
  const morning = new Date(2026, 9, 12, 3, 4, 5).getTime();
  for (const ts of [afternoon, morning]) {
    assert.doesNotMatch(formatDateTime(ts), /AM|PM/);
    assert.doesNotMatch(timeParts(ts).title, /AM|PM/);
  }
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  assert.ok(formatDateTime(afternoon).includes(clock(afternoon)));
  assert.ok(formatDateTime(morning).includes(clock(morning)));
  assert.equal(timeParts(afternoon).title, formatDateTime(afternoon));
  assert.equal(formatDateTime(NaN), "—");
});

test("server URLs drop the INBOX wrapper and keep a real folder", () => {
  assert.equal(
    formatServerUrl("<a@relay.example.org/INBOX/;UID=180514>"),
    "a@relay.example.org UID=180514",
  );
  assert.equal(
    formatServerUrl("<a@relay.example.org/INBOX/DeltaChat/;UID=9>"),
    "a@relay.example.org INBOX/DeltaChat UID=9",
  );
  assert.equal(formatServerUrl("not-a-url"), "not-a-url");
});

test("message info lists each reaction and who sent it", () => {
  assert.equal(messageInfoReactions(null), "");
  assert.equal(messageInfoReactions({ reactions: [] }), "");
  const html = messageInfoReactions({
    reactions: [
      { emoji: "👍", count: 2, isFromSelf: true },
      { emoji: "🔥", count: 1, isFromSelf: false },
    ],
    reactionsByContact: { "1": ["👍"], "4": ["👍"], "9": ["🔥"] },
    names: { "4": "Ann <a>", "9": "Bo" },
  });
  assert.match(html, /<details open class="info-react">/);
  assert.match(html, /<button type="button" class="reaction-chip mine" aria-pressed="true" data-react="👍">👍 2<\/button>/);
  assert.match(html, /<button type="button" class="reaction-chip" aria-pressed="false" data-react="🔥">🔥 1<\/button>/);
  assert.match(html, /info-react-who">You</);
  assert.match(html, /info-react-who">Ann &lt;a&gt;</);
  assert.match(html, /info-react-who">Bo</);
  assert.match(read("app/js/chat-view.js"), /getMessageReactions/);
  assert.match(read("app/js/rpc-core.js"), /get_message_reactions/);
});

test("getMessageReactions resolves contact names", async () => {
  const core = new JsonRpcCore();
  core.accountId = 3;
  const calls = [];
  core._call = async (method, ...args) => {
    calls.push([method, args]);
    if (method === "get_message_reactions") {
      return {
        reactions: [{ emoji: "👍", count: 2, isFromSelf: true }],
        reactionsByContact: { 1: ["👍"], 4: ["👍"] },
      };
    }
    if (method === "get_contacts_by_ids") return { 4: { id: 4, displayName: "Ann" } };
    throw new Error(method);
  };
  const out = await core.getMessageReactions(9);
  assert.deepEqual(calls.map(c => c[0]), ["get_message_reactions", "get_contacts_by_ids"]);
  assert.deepEqual(calls[1][1], [3, [4]]);
  assert.equal(out.names["4"], "Ann");
  core._call = async () => null;
  assert.equal(await core.getMessageReactions(9), null);
});

test("message info state is Seen plus Encrypted", () => {
  assert.equal(messageInfoState({ from: 1, state: "read", encrypted: true }), "Seen, Encrypted");
  assert.equal(messageInfoState({ from: 1, state: "sent", encrypted: false }), "Not seen, Not encrypted");
  assert.equal(messageInfoState({ from: 0, unread: true, encrypted: true }), "Not seen, Encrypted");
  assert.equal(messageInfoState({ from: 0, state: "read" }), "Seen, Encrypted");
});

test("mapped messages keep sent and received instants", () => {
  const msg = new JsonRpcCore()._mapMessage({
    id: 202959, chatId: 1, fromId: 2, timestamp: 100, sortTimestamp: 200, receivedTimestamp: 300,
    state: 13, viewType: "Text", showPadlock: false,
    sender: { id: 2, displayName: "A" },
  });
  assert.equal(msg.ts, 200000);
  assert.equal(msg.sentTs, 100000);
  assert.equal(msg.receivedTs, 300000);
  assert.equal(msg.encrypted, false);
  const unset = new JsonRpcCore()._mapMessage({
    id: 1, chatId: 1, fromId: 1, timestamp: 0, sortTimestamp: 5, receivedTimestamp: 0,
    state: 26, viewType: "Text", showPadlock: true, sender: {},
  });
  assert.equal(unset.sentTs, null);
  assert.equal(unset.receivedTs, null);
});

test("message info and clocks do not use a 12-hour locale string", () => {
  const chat = read("app/js/chat-view.js");
  const p2p = read("app/js/p2p.js");
  assert.match(chat, /Database ID/);
  assert.match(chat, /Message-ID/);
  assert.match(chat, /Server URL/);
  assert.match(chat, /getMessageInfo/);
  assert.doesNotMatch(chat, /toLocaleString\(/);
  assert.match(p2p, /formatTime\(m\.ts\)/);
  assert.doesNotMatch(p2p, /toLocaleTimeString/);
  for (const f of ["app/js/format.js", "app/js/diagnostics.js"]) {
    const calls = read(f).match(/toLocaleTimeString\([\s\S]{0,220}?\)/g) || [];
    assert.ok(calls.length > 0, f);
    for (const c of calls) { assert.match(c, /hourCycle:\s*"h23"|\bH24\b/); assert.doesNotMatch(c, /hour12/); }
  }
});
