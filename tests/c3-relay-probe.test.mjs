import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probeC3Relay } from "../app/js/ws-relays.js";

// Stub the WebSocket global: probeC3Relay must decide from the FIRST text
// frame only — a JSON array with at least one entry (the relay's own name
// has to resolve, or the core dies at DNS anyway).
class FakeWS {
  constructor(url) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  close() { this.closed = true; }
  serve(text) { setTimeout(() => { this.onmessage?.({ data: text }); }, 0); }
  fail() { setTimeout(() => { this.onerror?.(new Error("handshake")); this.onclose?.({}); }, 0); }
  hangUp() { setTimeout(() => { this.onclose?.({}); }, 0); }
}
FakeWS.instances = [];

function withFakeWS(fn) {
  const real = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  FakeWS.instances = [];
  return Promise.resolve(fn()).finally(() => { globalThis.WebSocket = real; });
}

test("probe: relay answering its own name with IPs is capable", () => withFakeWS(async () => {
  const p = probeC3Relay("relay.example.org");
  const ws = FakeWS.instances[0];
  assert.equal(ws.url, "wss://relay.example.org/dns/relay.example.org");
  ws.serve('["127.0.0.1"]');
  assert.equal(await p, true);
}));

test("probe: empty array, error page text, handshake failure, silence all fail", () => withFakeWS(async () => {
  let p = probeC3Relay("broken.example");
  FakeWS.instances.at(-1).serve("[]");
  assert.equal(await p, false, "[] would strand the core at DNS");

  p = probeC3Relay("nginx404.example");
  FakeWS.instances.at(-1).serve("<html>404 Not Found</html>");
  assert.equal(await p, false, "HTML error page is not a DNS answer");

  p = probeC3Relay("dead.example");
  FakeWS.instances.at(-1).fail();
  assert.equal(await p, false, "handshake failure");

  p = probeC3Relay("mute.example");
  FakeWS.instances.at(-1).hangUp();
  assert.equal(await p, false, "close without answering");
}));

test("create-account gates: probe before create, auto-switch with reload resume", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.ok(app.includes("async function ensureMailTunnelForLink(link)"), "shared gate exists");
  assert.ok(app.includes("if (!window.VELTA_PWA?.wasmCore) return true;"), "native shells and the mock never gate");
  assert.ok(app.includes('sessionStorage.setItem("velta-pending-add", link)'), "link stashed across the reload");
  assert.equal(app.split("ensureMailTunnelForLink(link)").length - 1, 4, "splash form + modal add + deeplink-new + the definition");
  assert.ok(app.includes('sessionStorage.getItem("velta-pending-add")'), "boot resumes the interrupted create");
  assert.ok(app.includes("sessionStorage.removeItem(\"velta-pending-add\")"), "resume removes the stash before use — no reload loops");
});
