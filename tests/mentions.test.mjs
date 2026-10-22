// @mentions (docs/mentions.md): "@Name (XXXX)" wire format, parser edge
// cases, fingerprint-code resolution, picker, notify-on-mute.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.HTMLElement = globalThis.HTMLElement || class {};
globalThis.customElements = globalThis.customElements || { get() {}, define() {} };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {} };
const { findMentions, mentionsMe, mentionQuery, filterMembers, mentionToken, fprCode, attachMentionPicker } = await import("../app/js/mentions.js");
const { renderMarkdown } = await import("../app/js/markdown.js");
const { mutedChatAllows, mentionInMutedOn } = await import("../app/js/notify-policy.js");

const ME = { id: 1, name: "Pavel", code: "1A2B" };
const ADA = { id: 2, name: "Ada Byron", code: "C0FE" };
const ADA2 = { id: 3, name: "Ada", code: "C0DE" };
const KENJI = { id: 4, name: "Kenji 🎌", code: "" };
const MEMBERS = [ME, ADA, ADA2, KENJI];
const hits = (t, m = MEMBERS) => findMentions(t, m).map(x => [x.text, x.member.id, x.me]);

test("fprCode / mentionToken: first 4-hex group, uppercase; no code without a key", () => {
  assert.equal(fprCode("c0fe 1234 5678 9abc def0 1234 5678 9abc def0 1234"), "C0FE");
  assert.equal(fprCode("abc"), "");
  assert.equal(mentionToken(ADA), "@Ada Byron (C0FE) ");
  assert.equal(mentionToken(KENJI), "@Kenji 🎌 ");
});

test("names: longest match, spaces, emoji, punctuation, case-insensitive", () => {
  assert.deepEqual(hits("@Ada Byron hi"), [["@Ada Byron", 2, false]]);
  assert.deepEqual(hits("@Ada, ok"), [["@Ada", 3, false]]);
  assert.deepEqual(hits("@pavel!"), [["@pavel", 1, true]]);
  assert.deepEqual(hits("yo @Kenji 🎌 there"), [["@Kenji 🎌", 4, false]]);
  assert.deepEqual(hits("(@Ada) and @Ada Byron."), [["@Ada", 3, false], ["@Ada Byron", 2, false]]);
  assert.deepEqual(hits("@Adam hi"), [], "word boundary after the name");
});

test("not mentions: e-mails, glued @, unknown names", () => {
  assert.deepEqual(hits("mail ada@b.c or a@b.c"), []);
  assert.deepEqual(hits("x@Ada"), []);
  assert.deepEqual(hits("@@Ada"), []);
  assert.deepEqual(hits("@Nobody here"), []);
});

test("codes: code resolves the member, also after a rename", () => {
  assert.deepEqual(hits("@Ada Byron (C0FE) x"), [["@Ada Byron (C0FE)", 2, false]]);
  assert.deepEqual(hits("@Old Name (C0FE), y"), [["@Old Name (C0FE)", 2, false]]);
  assert.deepEqual(hits("@Ada (c0fe)"), [["@Ada (c0fe)", 2, false]], "code beats the name");
  assert.deepEqual(hits("@Ada (FFFF)"), [], "a known member with another code is someone else");
  assert.deepEqual(hits("@Kenji 🎌 (ABCD)"), [["@Kenji 🎌 (ABCD)", 4, false]], "no key yet: name still counts");
});

test("prefix collision: name + code, then name", () => {
  const a = { id: 5, name: "Mara", code: "BEEF" }, b = { id: 6, name: "Tariq", code: "BEEF" };
  assert.deepEqual(hits("@Tariq (BEEF)", [a, b]), [["@Tariq (BEEF)", 6, false]]);
  assert.deepEqual(hits("@Mara (BEEF)", [a, b]), [["@Mara (BEEF)", 5, false]]);
  const twins = [{ id: 7, name: "Sam", code: "AAAA" }, { id: 8, name: "Sam", code: "BBBB" }];
  assert.deepEqual(hits("@Sam (BBBB)", twins), [["@Sam (BBBB)", 8, false]], "duplicate names split by code");
  assert.equal(hits("@Sam hi", twins)[0][1], 7, "plain duplicate name: first member");
});

test("own mention: code (rename-proof) or name; other people's code never", () => {
  assert.equal(mentionsMe("hey @Renamed Me (1A2B)", ME), true);
  assert.equal(mentionsMe("@PAVEL see this", ME), true);
  assert.equal(mentionsMe("@Pavel (9999) wrong one", ME), false);
  assert.equal(mentionsMe("pavel@x.org", ME), false);
  assert.equal(mentionsMe("@Pavelka", ME), false);
  assert.equal(mentionsMe("@Pavel", { name: "", code: "" }), false);
});

test("render: chips with de-emphasised code, me stronger, links/emails/markdown intact", () => {
  const html = renderMarkdown("**hi** @Ada Byron (C0FE), https://x.com/@Ada ada@x.org\n> @Pavel q", { mentions: MEMBERS });
  assert.match(html, /<strong>hi<\/strong>/);
  assert.match(html, /<span class="mention" title="Ada Byron \(C0FE\)">@Ada Byron<span class="mention-code"><span class="vh"> \(<\/span>C0FE<span class="vh">\)<\/span><\/span><\/span>/);
  assert.match(html, /<a href="https:\/\/x\.com\/@Ada"/);
  assert.match(html, /msg-nohyph">ada@x\.org/);
  assert.match(html, /<blockquote><span class="mention mention-me" title="Pavel \(1A2B\) — you">@Pavel<\/span>/);
  assert.equal(renderMarkdown("@Ada hi"), "@Ada hi", "no members (1:1) → plain");
  assert.match(renderMarkdown("@<b>x", { mentions: [{ id: 2, name: "<b>x", code: "" }] }), /@&lt;b&gt;x/);
});

test("composer query: word start only, spaces allowed, closes on newline/(", () => {
  assert.deepEqual(mentionQuery("hi @Ad"), { start: 3, query: "Ad" });
  assert.deepEqual(mentionQuery("@"), { start: 0, query: "" });
  assert.deepEqual(mentionQuery("@Ada By"), { start: 0, query: "Ada By" });
  assert.equal(mentionQuery("a@b"), null);
  assert.equal(mentionQuery("@Ada (C0"), null);
  assert.equal(mentionQuery("@x\ny"), null);
  assert.deepEqual(filterMembers(MEMBERS, "ad").map(m => m.id), [3, 2], "prefix, self excluded");
  assert.deepEqual(filterMembers(MEMBERS, "byr").map(m => m.id), [2]);
});

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this.classList = { toggle() {}, add() {} }; this.parent = null; }
  set textContent(v) { this._t = v; if (v === "") this.children = []; }
  get textContent() { return this._t; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatchEvent(e) { (this.listeners[e.type] || []).forEach(f => f(e)); }
  focus() {}
}
globalThis.Event = class { constructor(type) { this.type = type; } };

test("picker: listbox, keyboard nav, inserts '@Name (CODE) ', not in 1:1", () => {
  const doc = { createElement: t => new El(t) };
  const input = new El("textarea"); input.ownerDocument = doc; input.value = "";
  const anchor = new El("footer");
  let members = MEMBERS;
  const mp = attachMentionPicker(input, anchor, () => members);
  const type = v => { input.value = v; input.dispatchEvent(new Event("input")); };
  const key = k => mp.handleKey({ key: k, preventDefault() {} });
  type("hi @");
  assert.equal(mp.isOpen(), true);
  const pop = anchor.children[0];
  assert.equal(pop.getAttribute("role"), "listbox");
  assert.equal(pop.children.length, 3, "self excluded");
  assert.equal(input.getAttribute("aria-activedescendant"), "mention-opt-0");
  type("hi @by");
  assert.equal(key("Enter"), true);
  assert.equal(input.value, "hi @Ada Byron (C0FE) ");
  assert.equal(mp.isOpen(), false);
  type("@"); key("ArrowDown"); key("ArrowUp"); key("ArrowUp");
  assert.equal(input.getAttribute("aria-activedescendant"), "mention-opt-2");
  key("Escape"); assert.equal(mp.isOpen(), false);
  type("@k"); key("Tab"); assert.equal(input.value, "@Kenji 🎌 ");
  members = []; type("@"); assert.equal(mp.isOpen(), false, "1:1 chat: no picker");
});

test("notify on mute: mention of me passes when the switch is on", () => {
  assert.equal(mutedChatAllows({ muted: false }), true);
  assert.equal(mutedChatAllows({ muted: true, mentionsMe: false }), false);
  assert.equal(mutedChatAllows({ muted: true, mentionsMe: true }), true);
  assert.equal(mutedChatAllows({ muted: true, mentionsMe: true, mentionInMuted: false }), false);
  assert.equal(mentionInMutedOn({ getItem: () => null }), true, "default on");
  assert.equal(mentionInMutedOn({ getItem: () => "0" }), false);
});

test("wiring: app gates muted chats, ui has the switch, Rust mirrors the pref", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.match(app, /if \(chat\?\.muted\) \{[\s\S]*mutedChatAllows\(/);
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /data-notify-key="mutedmentions"/);
  assert.match(ui, /mentions_in_muted: localStorage\.getItem\("velta-notify-muted-mentions"\) !== "0"/);
  const rs = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(rs, /mentions_in_muted: true,/);
  assert.match(rs, /if muted && !prefs\.mentions_in_muted/);
});
