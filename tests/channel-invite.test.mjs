import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #312: SecureJoin can mint channel invites only for OutBroadcast. Incoming
// subscriptions and mailing lists must not offer an action that always fails.
const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const profileStart = app.indexOf("async function showChatInfo(");
const profileEnd = app.indexOf("async function showMediaInChat(", profileStart);
const profile = app.slice(profileStart, profileEnd);
const match = profile.match(/\$\{(chat\.kind === "channel"[^?]+)\? `<div class="profile-actions"><button type="button" class="btn-text" data-pa="invite">/);

test("only an owned broadcast channel offers SecureJoin link/QR invites", () => {
  assert.ok(match, "channel invite condition exists in the chat profile");
  const offersInvite = chat => Function("chat", `return (${match[1]});`)(chat);
  assert.equal(offersInvite({ kind: "channel", chatType: "OutBroadcast" }), true);
  assert.equal(offersInvite({ kind: "channel", chatType: "InBroadcast" }), false);
  assert.equal(offersInvite({ kind: "channel", chatType: "Mailinglist" }), false);
  assert.equal(offersInvite({ kind: "group", chatType: "Group" }), false);
});
