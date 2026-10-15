// PWA avatar loss: a profile change must reach OPFS before the user can
// reload, and the snapshot must never save a db row that names a blob the
// snapshot lacks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { JsonRpcCore } from "../app/js/rpc-core.js";

test("profile and chat-image changes await a checkpoint; file sends start one", async () => {
  const log = [];
  class Probe extends JsonRpcCore {
    async _call(method, ...args) { log.push(method); return method === "send_msg" ? 5 : null; }
  }
  const core = new Probe();
  core.accountId = 1;
  core.transport = { checkpoint: async () => { log.push("checkpoint"); } };
  await core.setAvatar("/uploads/a.jpg");
  await core.setDisplayName("Pavel");
  await core.setSelfStatus("hi");
  await core.setChatImage(10, "/uploads/g.png");
  assert.deepEqual(log, [
    "set_config", "checkpoint", "set_config", "checkpoint",
    "set_config", "checkpoint", "set_chat_profile_image", "checkpoint",
  ]);
});

test("a failing checkpoint does not fail the save; no checkpoint = no-op", async () => {
  class Probe extends JsonRpcCore { async _call() { return null; } }
  const core = new Probe();
  core.accountId = 1;
  core.transport = { checkpoint: async () => { throw new Error("quota"); } };
  await core.setAvatar("/uploads/a.jpg");
  core.transport = {};
  await core.setAvatar(null);
});

test("app drops the /uploads temp copy after the core copied it", async () => {
  const src = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const from = src.indexOf("function dropUpload(");
  const to = src.indexOf("async function pickProfileImage(", from);
  assert.ok(from > 0 && to > from);
  const removed = [];
  const ctx = { core: { transport: { removeCoreFile: async (p) => { removed.push(p); } } } };
  createContext(ctx);
  new Script(src.slice(from, to)).runInContext(ctx);
  ctx.dropUpload("/uploads/avatar-1.jpg");
  ctx.dropUpload("/accounts/u/dc.db-blobs/x.jpg");
  ctx.dropUpload("data:image/png;base64,AA");
  assert.deepEqual(removed, ["/uploads/avatar-1.jpg"]);
  const flow = src.slice(src.indexOf("async function editProfileFlow("));
  assert.match(flow.slice(0, 2000), /await core\.setAvatar\(result\.avatar\.path\);\s*dropUpload\(result\.avatar\.path\)/);
});
