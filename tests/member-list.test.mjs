import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChatViewGlobals, installFakeDocument } from "./helpers/fake-dom.mjs";
import { filterMembers, foldText, virtualWindow, memberRowHtml, mountMemberList, MEMBER_ROW_H } from "../app/js/member-list.js";

const people = [
  { id: 1, name: "Me", addr: "me@relay.one", self: true },
  { id: 11, name: "José Álvarez", addr: "jose@relay.two" },
  { id: 12, name: "Anna", addr: "anna@nine.example" },
  { id: 13, name: "Bob <b>", addr: "bob@relay.two" },
];

test("filter: name or address, case- and diacritics-insensitive", () => {
  assert.equal(foldText("José ÁLVAREZ"), "jose alvarez");
  assert.deepEqual(filterMembers(people, "jose").map(m => m.id), [11]);
  assert.deepEqual(filterMembers(people, "ALVAREZ").map(m => m.id), [11]);
  assert.deepEqual(filterMembers(people, "relay.two").map(m => m.id), [11, 13]);
  assert.deepEqual(filterMembers(people, "  ").map(m => m.id), [1, 11, 12, 13]);
  assert.deepEqual(filterMembers(people, "zzz"), []);
});

test("virtual window: visible rows plus overscan, clamped", () => {
  assert.deepEqual(virtualWindow({ scrollTop: 0, viewportH: 240, rowH: 56, count: 500, overscan: 4 }), { start: 0, end: 10 });
  assert.deepEqual(virtualWindow({ scrollTop: 5600, viewportH: 240, rowH: 56, count: 500, overscan: 4 }), { start: 96, end: 110 });
  assert.deepEqual(virtualWindow({ scrollTop: 56 * 498, viewportH: 240, rowH: 56, count: 500, overscan: 4 }), { start: 494, end: 500 });
  assert.deepEqual(virtualWindow({ scrollTop: 0, viewportH: 240, count: 3 }), { start: 0, end: 3 });
  assert.deepEqual(virtualWindow({ scrollTop: 100, viewportH: 240, count: 0 }), { start: 0, end: 0 });
});

test("row: avatar component + name + address, escaped, no relay line, (you) for self", () => {
  const html = memberRowHtml(people[3]);
  assert.match(html, /^<velta-avatar name="Bob &lt;b&gt;" color="" kind="single" size="36" contact-id="13" addr="bob@relay.two"><\/velta-avatar>/);
  assert.match(html, /<span class="member-name">Bob &lt;b&gt;<\/span><span class="member-sub">bob@relay.two<\/span>/);
  assert.match(memberRowHtml(people[0]), /Me <span class="member-you">\(you\)<\/span>/);
  assert.match(memberRowHtml({ id: "peer", name: "P" }, { subtitle: "online" }), /member-sub">online</);
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /\(m\.addr \|\| ""\)\.split\("@"\)\[1\]/, "per-member relay (address domain) line is gone");
  assert.match(app, /mountMemberList\(list, members\.map/);
});

test("mounted list: only the window is in the DOM, search filters live, empty state, open", async () => {
  installChatViewGlobals();
  installFakeDocument();
  const many = Array.from({ length: 300 }, (_, i) => ({ id: 100 + i, name: `Member ${i}`, addr: `m${i}@x.example` }));
  const host = document.createElement("div");
  const opened = [];
  const ml = mountMemberList(host, many, { onOpen: m => opened.push(m.id), viewportH: 240 });
  const [search, scroller, empty] = host.children;
  const spacer = scroller.children[0];
  assert.equal(ml.input.type, "search");
  assert.equal(ml.input.getAttribute("aria-label"), "Search members");
  assert.equal(spacer.style.height, `${300 * MEMBER_ROW_H}px`);
  // fake scroll box is 500px tall: ceil(500/56)+1 visible + 4 overscan
  assert.equal(spacer.children.length, 14);
  assert.equal(spacer.children[0].tabIndex, 0);
  assert.match(spacer.children[0].innerHTML, /<velta-avatar /);
  scroller.scrollTop = 150 * MEMBER_ROW_H;
  await scroller.fire("scroll");
  const idx = spacer.children.map(r => Number(r.dataset.index));
  assert.ok(Math.min(...idx) === 146 && Math.max(...idx) === 163 && idx.length === 18, `window ${idx}`);
  ml.input.value = "member 29";
  await ml.input.fire("input");
  assert.deepEqual(spacer.children.map(r => r.dataset.memberId), ["129", "390", "391", "392", "393", "394", "395", "396", "397", "398", "399"]);
  assert.equal(spacer.style.height, `${11 * MEMBER_ROW_H}px`);
  assert.equal(empty.hidden, true);
  assert.equal(search.children[1].hidden, false); // clear button
  ml.input.value = "nobody";
  await ml.input.fire("input");
  assert.equal(spacer.children.length, 0);
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, "No members found");
  await search.children[1].fire("click");
  assert.equal(ml.input.value, "");
  assert.equal(empty.hidden, true);
  const row = spacer.children[0];
  await scroller.fire("click", { target: { closest: sel => (sel === ".member-row" ? row : null) } });
  await scroller.fire("keydown", { key: "Enter", target: row });
  assert.deepEqual(opened, [100, 100]);
  // a per-member action button does not open the profile
  await scroller.fire("click", { target: { closest: sel => (sel === "button" ? {} : row) } });
  assert.equal(opened.length, 2);
});
