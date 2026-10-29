// Admin groups (#177, core quilt #19): UI rules, RPC wiring, strings, icon.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fr from "../app/locales/fr.json" with { type: "json" };
import ru from "../app/locales/ru.json" with { type: "json" };

const mem = new Map();
globalThis.localStorage ??= {
  getItem: k => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};
const { adminCaps, canRemoveMember, adminBadgeHtml, adminInfoText, isAdminGroup, selfIsAdmin } = await import("../app/js/admin-group.js");
const { JsonRpcCore } = await import("../app/js/rpc-core.js");
const { MockCore } = await import("../app/js/mock-core.js");
const { ICON } = await import("../app/js/icons.js");

const src = f => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const group = (groupAdminId = null) => ({ id: 5, kind: "group", groupAdminId });

test("regular groups keep the stock rules: everyone edits, nobody removes others", () => {
  const caps = adminCaps(group(null));
  assert.equal(caps.isAdminGroup, false);
  assert.equal(caps.canEditGroup, true);
  assert.equal(caps.canAddMembers, true);
  assert.equal(caps.canSetTimer, true);
  assert.equal(caps.canPin, true);
  assert.equal(caps.canRemoveOthers, false);
  assert.equal(caps.canDeleteForAll(1), true);
  assert.equal(caps.canDeleteForAll(7), false, "others' messages stay undeletable for everyone");
  assert.equal(canRemoveMember(group(null), { id: 7 }), false);
});

test("admin group, this account is the admin: full control", () => {
  const chat = group(1);
  assert.ok(isAdminGroup(chat));
  assert.ok(selfIsAdmin(chat));
  const caps = adminCaps(chat);
  for (const k of ["canEditGroup", "canAddMembers", "canSetTimer", "canPin", "canRemoveOthers"]) assert.equal(caps[k], true, k);
  assert.equal(caps.canDeleteForAll(7), true);
  assert.equal(canRemoveMember(chat, { id: 7 }), true);
  assert.equal(canRemoveMember(chat, { id: 1 }), false, "no Remove on self (Leave is the menu)");
  assert.equal(canRemoveMember(chat, { id: 7, self: true }), false);
});

test("admin group, this account is a member: admin-only controls are off", () => {
  const chat = group(4);
  assert.ok(isAdminGroup(chat));
  assert.ok(!selfIsAdmin(chat));
  const caps = adminCaps(chat);
  for (const k of ["canEditGroup", "canAddMembers", "canSetTimer", "canPin", "canRemoveOthers"]) assert.equal(caps[k], false, k);
  assert.equal(caps.canDeleteForAll(1), true, "own messages: still deletable for everyone");
  assert.equal(caps.canDeleteForAll(4), false);
  assert.equal(canRemoveMember(chat, { id: 7 }), false);
  assert.equal(canRemoveMember(chat, { id: 4 }), false, "the admin can never be removed");
});

test("channels, 1:1, missing chats and bogus ids are never admin groups", () => {
  for (const c of [null, { kind: "channel", groupAdminId: 1 }, { kind: "single", groupAdminId: 1 }, group(0), group(-1), group("1")]) {
    assert.equal(isAdminGroup(c), false, JSON.stringify(c));
    assert.equal(adminCaps(c).canEditGroup, true);
  }
});

test("badge and info line", () => {
  const b = adminBadgeHtml();
  assert.match(b, /class="admin-badge"/);
  assert.match(b, /<span>Admin<\/span>/);
  assert.ok(b.includes(ICON.shieldCheck));
  assert.equal(adminInfoText(group(null), "X"), "");
  assert.equal(adminInfoText(group(4), "Bob <b>"), "Moderated group · admin: Bob <b>");
  assert.equal(adminInfoText(group(1), "ignored"), "Moderated group · admin: you");
});

test("shield icon: outline, stroke 2, 24 grid", () => {
  assert.match(ICON.shieldCheck, /^<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"/);
  assert.doesNotMatch(ICON.shieldCheck, /fill="currentColor"/);
});

test("new strings are translated in fr and ru", () => {
  for (const k of [
    "Admin group",
    "Only you can add or remove members and edit the group. Protection works only in Velta and ArcaneChat.",
    "Admin", "Moderated group · admin: {name}", "Only the group admin can do this",
  ]) {
    assert.ok(fr[k], `fr: ${k}`);
    assert.ok(ru[k], `ru: ${k}`);
    if (k.includes("{name}")) { assert.ok(fr[k].includes("{name}")); assert.ok(ru[k].includes("{name}")); }
  }
});

function rpcFixture(handlers) {
  const core = new JsonRpcCore({});
  core.accountId = 3;
  const calls = [];
  core._call = async (method, ...params) => {
    calls.push([method, ...params]);
    if (Object.hasOwn(handlers, method)) return handlers[method](...params);
    throw new Error(`Unexpected RPC: ${method}`);
  };
  return { core, calls };
}

test("rpc: createChat(admin-group) uses create_group_with_admin, then adds members", async () => {
  const { core, calls } = rpcFixture({ create_group_with_admin: () => 42, add_contact_to_chat: () => true });
  const id = await core.createChat("Mods", [10, 11], "admin-group");
  assert.equal(id, 42);
  assert.deepEqual(calls, [
    ["create_group_with_admin", 3, "Mods"],
    ["add_contact_to_chat", 3, 42, 10],
    ["add_contact_to_chat", 3, 42, 11],
  ]);
});

test("rpc: plain groups still use create_group_chat", async () => {
  const { core, calls } = rpcFixture({ create_group_chat: () => 7, add_contact_to_chat: () => true });
  await core.createChat("Plain", [10], "group");
  assert.deepEqual(calls[0], ["create_group_chat", 3, "Plain", false]);
});

test("rpc: getGroupAdminId reads FullChat.groupAdminId (null when absent)", async () => {
  let full = { groupAdminId: 9 };
  const { core } = rpcFixture({ get_full_chat_by_id: () => full });
  assert.equal(await core.getGroupAdminId(5), 9);
  full = { groupAdminId: null };
  assert.equal(await core.getGroupAdminId(5), null);
  full = {}; // a core without quilt #19
  assert.equal(await core.getGroupAdminId(5), null);
});

test("rpc: removeChatMember calls remove_contact_from_chat", async () => {
  const { core, calls } = rpcFixture({ remove_contact_from_chat: () => null });
  await core.removeChatMember(5, 12);
  assert.deepEqual(calls, [["remove_contact_from_chat", 3, 5, 12]]);
});

test("mock: admin groups created by us are ours; Velta Devs demo is run by contact 4", async () => {
  const core = new MockCore();
  core._simTimer?.unref();
  const id = await core.createChat("Mods", [2], "admin-group");
  assert.equal(core.chats.find(c => c.id === id).kind, "group");
  assert.equal(await core.getGroupAdminId(id), 1);
  assert.equal(await core.getGroupAdminId(15), 4);
  assert.equal(await core.getGroupAdminId(13), null);
  const before = (await core.getChatMembers(13)).length;
  await core.removeChatMember(13, 2);
  assert.equal((await core.getChatMembers(13)).length, before - 1);
});

test("UI wiring: switch in the new-group dialog, gated controls, badge", () => {
  const app = src("app/js/app.js");
  assert.match(app, /data-admin-group/);
  assert.match(app, /res\.admin \? "admin-group" : "group"/);
  assert.match(app, /caps\.canEditGroup \? `<div class="profile-actions"><button type="button" class="btn-text" data-pa="ep"|isGroup && !chat\.isP2pGroup && caps\.canEditGroup/);
  assert.match(app, /caps\.canAddMembers \? `<div class="profile-actions"><button type="button" class="btn-text" data-pa="add-members"/);
  assert.match(app, /if \(caps\.canSetTimer\) ephRow\.addEventListener/);
  assert.match(app, /!adminCaps\(chat\)\.canAddMembers \? \[\] : chat\.kind === "group" && !chat\.isP2pGroup \? \[\{ label: "Group invite QR"/);
  assert.match(app, /adminBadgeHtml\(\)/);
  const cv = src("app/js/chat-view.js");
  assert.match(cv, /!this\.readOnly && adminCaps\(this\.chat\)\.canPin\) \{/);
  assert.match(cv, /const canUnpin = !this\.readOnly && adminCaps\(this\.chat\)\.canPin;/);
  assert.match(cv, /msgs\.every\(m => adminCaps\(this\.chat\)\.canDeleteForAll\(m\.from\)\)/);
});

test("CSS: badge colours come from theme tokens only", () => {
  const css = src("app/css/main.css");
  const block = css.slice(css.indexOf(".admin-badge {"), css.indexOf("}", css.indexOf(".admin-badge {")));
  assert.match(block, /color: var\(--accent-text\)/);
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b/i);
});
