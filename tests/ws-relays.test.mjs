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

test("an empty bake without --same-origin-proxy has no proxy", () => {
  store("");
  globalThis.location = { hostname: "velta.example" };
  assert.deepEqual(listWsRelays(), []);
  assert.equal(wsProxyUrl(), null);
});

test("without --same-origin-proxy a stale page-host entry is dropped unless it has a token", () => {
  store("");
  globalThis.location = { hostname: "velta.example" };
  localStorage.setItem("velta-ws-relays", JSON.stringify(["velta.example", "relay.example.org"]));
  localStorage.setItem("velta-ws-relay", "velta.example");
  localStorage.setItem("velta-ws-relay-urls", JSON.stringify({ "velta.example": "wss://velta.example/ws" }));
  assert.deepEqual(listWsRelays(), ["relay.example.org"]);
  assert.equal(localStorage.getItem("velta-ws-relay"), null);
  assert.equal(localStorage.getItem("velta-ws-relay-urls"), "{}");
  assert.equal(wsProxyUrl(), "wss://relay.example.org");

  store("");
  localStorage.setItem("velta-ws-relays", JSON.stringify(["velta.example"]));
  localStorage.setItem("velta-ws-relay-tokens", JSON.stringify({ "velta.example": "tok123" }));
  assert.deepEqual(listWsRelays(), ["velta.example"]);
  assert.equal(wsProxyUrl(), "wss://velta.example");
});

test("--same-origin-proxy: an empty bake uses the page host, and localhost stays proxy-less", () => {
  store("");
  globalThis.window.VELTA_PWA.sameOriginProxy = true;
  localStorage.setItem("velta-ws-relays", JSON.stringify(["relay.example.org"]));
  globalThis.location = { hostname: "relay.example.org" };
  assert.deepEqual(listWsRelays(), ["relay.example.org"]);
  localStorage.removeItem("velta-ws-relays");
  globalThis.location = { hostname: "relay.example.org" };
  assert.deepEqual(listWsRelays(), ["relay.example.org"]);
  assert.equal(wsProxyUrl(), "wss://relay.example.org");
  globalThis.location = { hostname: "localhost" };
  assert.deepEqual(listWsRelays(), []);
  assert.equal(wsProxyUrl(), null);
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
