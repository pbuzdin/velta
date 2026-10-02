import test from "node:test";
import assert from "node:assert/strict";
import { MockCore } from "../app/js/mock-core.js";

// #74: demo image messages render through an <img src> — the old bare CSS
// linear-gradient() strings were broken images. Every generated filePath
// must be a loadable URL (data: or http(s):), never a bare CSS value.
test("mock image messages carry a renderable src, not a CSS value", () => {
  const core = new MockCore();
  core._simTimer?.unref(); // demo traffic loop would keep node alive
  let images = 0;
  for (const chat of core.chats) {
    for (const m of chat.messages) {
      if (!m.img) continue;
      images++;
      assert.equal(m.downloadState, "Done");
      assert.match(m.filePath, /^(data:image\/|https?:)/, m.filePath);
      if (m.filePath.startsWith("data:image/svg+xml")) {
        assert.ok(m.filePath.includes("%3Csvg"), "encoded svg body");
      }
    }
  }
  assert.ok(images > 0, "demo fixture should contain image messages");
});
