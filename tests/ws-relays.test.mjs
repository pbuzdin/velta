import test from "node:test";
import assert from "node:assert/strict";
import { addWsRelay, editWsRelay, listWsRelays, removeWsRelay, useWsRelay, wsProxyUrl } from "../app/js/ws-relays.js";

function store(proxy = "wss://relay.example.org") {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
  globalThis.window = { VELTA_PWA: { wsProxyUrl: proxy } };
}

test("an untouched PWA keeps the baked websocket URL and shows that domain", () => {
  store();
  assert.deepEqual(listWsRelays(), ["relay.example.org"]);
  assert.equal(wsProxyUrl(), "wss://relay.example.org");
});

test("add, edit, use, and delete relay domains", () => {
  store();
  assert.equal(addWsRelay("https://Nine.TestRun.org/new"), "nine.testrun.org");
  assert.deepEqual(listWsRelays(), ["relay.example.org", "nine.testrun.org"]);
  assert.equal(wsProxyUrl(), "wss://relay.example.org");
  assert.equal(addWsRelay("not a host"), null);
  assert.equal(editWsRelay("nine.testrun.org", "localhost"), null);
  assert.equal(editWsRelay("nine.testrun.org", "mail.example.org"), "mail.example.org");
  assert.equal(wsProxyUrl(), "wss://relay.example.org");
  assert.equal(useWsRelay("mail.example.org"), true);
  assert.equal(wsProxyUrl(), "wss://mail.example.org");
  assert.equal(removeWsRelay("relay.example.org"), true);
  assert.deepEqual(listWsRelays(), ["mail.example.org"]);
  assert.equal(removeWsRelay("mail.example.org"), false);
  assert.equal(editWsRelay("mail.example.org", "other.example.org"), "other.example.org");
  assert.equal(wsProxyUrl(), "wss://other.example.org");
});
