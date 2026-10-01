import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCore } from "../app/js/rpc-core.js";

function raw(over) {
  return {
    id: 5, chatId: 1, fromId: 2, timestamp: 1, sortTimestamp: 1, state: 10,
    viewType: "Text", sender: { id: 2, displayName: "Pavel" },
    ...over,
  };
}

test("a large-image pre-message becomes a download card and keeps the caption", () => {
  const msg = new JsonRpcCore()._mapMessage(raw({
    text: "look [Image – 1.34 MiB]",
    downloadState: "Available",
    fileBytes: 1405091,
    fileName: "photo.jpg",
  }));
  assert.equal(msg.viewtype, "image");
  assert.equal(msg.text, "look");
  assert.equal(msg.downloadState, "Available");
  assert.equal(msg.fileSize, 1405091);
  assert.equal(msg.fileName, "photo.jpg");
});

test("a pre-message with no filename uses the type label", () => {
  const msg = new JsonRpcCore()._mapMessage(raw({
    text: " [Image – 1.34 MiB]",
    downloadState: "InProgress",
    fileBytes: 1405091,
  }));
  assert.equal(msg.viewtype, "image");
  assert.equal(msg.text, "");
  assert.equal(msg.fileName, "Image");
  assert.equal(msg.downloadState, "InProgress");
});

test("a downloaded message keeps a bracket the sender actually wrote", () => {
  const msg = new JsonRpcCore()._mapMessage(raw({
    text: "see [Image – 1.34 MiB]",
    downloadState: "Done",
    viewType: "Text",
  }));
  assert.equal(msg.viewtype, "text");
  assert.equal(msg.text, "see [Image – 1.34 MiB]");
});
