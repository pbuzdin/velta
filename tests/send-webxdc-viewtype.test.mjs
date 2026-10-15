import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";
// #138: "Send directly" posts viewtype "webxdc"; mapping it to Text made the
// core store a non-webxdc message and the frame 404'd with "not found".
test("webxdc viewtype maps to core Webxdc", () => {
  assert.equal(JsonRpcCore.prototype._toCoreViewtype("webxdc"), "Webxdc");
  assert.equal(JsonRpcCore.prototype._toCoreViewtype("file"), "File");
});
test("sendMessage sends viewType Webxdc for webxdc", async () => {
  const calls = [];
  const core = Object.create(JsonRpcCore.prototype);
  core._call = async (m, ...a) => { calls.push([m, a]); if (m === "send_msg") throw new Error("stop"); };
  Object.defineProperty(core, "accountId", { value: 1 });
  await assert.rejects(core.sendMessage(5, { viewtype: "webxdc", file: "/x.xdc", filename: "send-direct.xdc" }));
  const data = calls.find(c => c[0] === "send_msg")[1][2];
  assert.equal(data.viewType, "Webxdc");
  assert.equal(data.viewtype, "Webxdc");
});
