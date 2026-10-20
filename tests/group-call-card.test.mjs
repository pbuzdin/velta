// The group call card (group-call-card.js), the call meta update, the
// in-call bar visibility rule, and the design-token lint for their CSS.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChatViewGlobals, installFakeDocument } from "./helpers/fake-dom.mjs";
import { cardModel, subText, formatDuration, renderCard } from "../app/js/group-call-card.js";
import { cleanTitle, callMeta, DEFAULT_CALL_TITLE, MAX_TITLE, TTL_UPDATE_MS } from "../app/js/group-call-signal.js";

const T = 1_000_000;
const row = (vc, serial) => ({ payload: { veltaCall: { vgc: 1, ts: T, ...vc } }, serial });
const meta = row({ t: "meta", from: "a", sid: "meta", title: "  Saturday\n hike ", creatorName: "Mara" }, 1);
const join = (from, sid, s, ts = T) => row({ t: "join", from, sid, name: from, ts }, s);

test("cleanTitle: trims, strips control chars, caps, defaults", () => {
  assert.equal(cleanTitle("  a\u0007b  "), "a b");
  assert.equal(cleanTitle(""), DEFAULT_CALL_TITLE);
  assert.equal(cleanTitle(null), DEFAULT_CALL_TITLE);
  assert.equal(cleanTitle("x".repeat(200)).length, MAX_TITLE);
});

test("callMeta: first meta wins; default without one", () => {
  assert.deepEqual(callMeta([]), { title: DEFAULT_CALL_TITLE, creatorName: "", ts: 0 });
  const m = callMeta([meta, row({ t: "meta", title: "later", creatorName: "X" }, 2)]);
  assert.equal(m.title, "Saturday hike"); assert.equal(m.creatorName, "Mara");
});

test("cardModel: not started / in progress / joined / ended", () => {
  let m = cardModel([meta], { now: T });
  assert.equal(m.started, false); assert.equal(m.count, 0); assert.equal(m.ended, false);
  assert.match(subText(m, "Mara"), /Started by Mara · Nobody in the call yet/);

  m = cardModel([meta, join("mara", "m1", 2), join("kenji", "k1", 3)], { now: T + 1000 });
  assert.equal(m.title, "Saturday hike"); assert.equal(m.count, 2); assert.equal(m.joined, false);
  assert.equal(subText(m, "Mara"), "Started by Mara · 2 in call");

  m = cardModel([meta, join("mara", "m1", 2)], { now: T, live: { state: "connected", participants: [{ id: "me", name: "Me" }, { id: "mara", name: "Mara" }, { id: "k", name: "K" }] } });
  assert.equal(m.joined, true); assert.equal(m.count, 3);

  m = cardModel([meta, join("mara", "m1", 2), row({ t: "leave", from: "mara", sid: "m1" }, 3)], { now: T + 1 });
  assert.equal(m.ended, true); assert.equal(subText(m, "Mara"), "Call ended"); // same ts: no duration
  assert.deepEqual(m.members, []); assert.equal(m.count, 0);
  m = cardModel([meta, join("mara", "m1", 2), join("k", "k1", 3, T + 60000), row({ t: "leave", from: "mara", sid: "m1", ts: T + 30000 }, 4), row({ t: "leave", from: "k", sid: "k1", ts: T + 12 * 60000 }, 5)], { now: T + 13 * 60000 });
  assert.equal(m.ended, true); assert.equal(m.duration, 12 * 60000);
  assert.equal(subText(m, "Mara"), "Call ended · 12 min"); // no "Started by", no count
  // silent members expire by TTL -> ended
  assert.equal(cardModel([meta, join("mara", "m1", 2)], { now: T + TTL_UPDATE_MS + 5000 }).ended, true);
});

test("barVisible: only in a call and not on its call screen", async () => {
  installChatViewGlobals(); installFakeDocument();
  const { barVisible } = await import("../app/js/group-call-ui.js");
  const s = { state: "connected", msgId: 13 };
  assert.equal(barVisible(s, null), true);
  assert.equal(barVisible(s, 13), false);
  assert.equal(barVisible(s, 9), true);
  assert.equal(barVisible({ ...s, state: "ended" }, null), false);
  assert.equal(barVisible(null, null), false);
});

test("design tokens: group call card/bar CSS has no hard-coded colors", () => {
  const css = readFileSync(new URL("../app/css/main.css", import.meta.url), "utf8");
  const rules = css.split("}").filter((r) => /#group-call-bar|\.gcb-|\.msg-groupcall|\.gc-/.test(r.split("{")[0]));
  assert.ok(rules.length > 10, "found the group call rules");
  for (const r of rules) assert.doesNotMatch(r.split("{")[1] || "", /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, r.trim());
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), ""); assert.equal(formatDuration(45000), "45 s");
  assert.equal(formatDuration(12 * 60000), "12 min"); assert.equal(formatDuration(65 * 60000), "1 h 5 min"); assert.equal(formatDuration(120 * 60000), "2 h");
});

test("renderCard ended: only creator avatar, name, sub line, Start again", () => {
  const mk = (cls) => ({ cls, hidden: false, textContent: "", children: [], attrs: {}, classList: { toggle() {} },
    setAttribute(k, v) { this.attrs[k] = v }, appendChild(c) { this.children.push(c) } });
  const parts = Object.fromEntries([".gc-title", ".gc-sub", ".gc-people", ".gc-join", ".gc-in", ".gc-leave", ".gc-open"].map((k) => [k, mk(k)]));
  const el = { classList: { toggle() {} }, ownerDocument: { createElement: () => mk("x") }, querySelector: (k) => parts[k] };
  renderCard(el, { title: "Hike", creatorName: "Mara", members: [], count: 0, joined: false, ended: true, started: true, duration: 3 * 60000 });
  assert.equal(parts[".gc-sub"].textContent, "Call ended · 3 min");
  assert.equal(parts[".gc-join"].textContent, "Start again"); assert.equal(parts[".gc-join"].hidden, false);
  for (const k of [".gc-people", ".gc-in", ".gc-leave", ".gc-open"]) assert.equal(parts[k].hidden, true, k);
  renderCard(el, { title: "Hike", creatorName: "Mara", members: [{ id: "m", name: "Mara" }], count: 1, joined: false, ended: false, started: true });
  assert.equal(parts[".gc-open"].hidden, false); assert.equal(parts[".gc-join"].textContent, "Join");
});
