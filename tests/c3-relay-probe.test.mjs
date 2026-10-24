import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probeC3Relay, probeDnsVia } from "../app/js/ws-relays.js";

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

test("probeDnsVia asks the active tunnel about the other host", () => withFakeWS(async () => {
  assert.equal(await probeDnsVia("not a host", "relay.example.org"), false);
  const p = probeDnsVia("relay.example.org", "mail.example.org");
  assert.equal(FakeWS.instances[0].url, "wss://relay.example.org/dns/mail.example.org");
  FakeWS.instances[0].serve('["9.9.9.9"]');
  assert.equal(await p, true);
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
  assert.ok(app.includes("probeDnsVia(via, host)"), "a non-C3 host stays on the tunnel that can resolve it");
  assert.ok(app.includes('probeDnsVia(via, "example.com")'), "autopick refuses a tunnel that only resolves itself");
});

test("worker rewrites stock chatmail POST /new onto this origin", () => {
  const src = readFileSync(new URL("../app/js/worker-wasm.js", import.meta.url), "utf8");
  const page = { href: "https://relay.example.org/app/worker-wasm.js", origin: "https://relay.example.org", hostname: "relay.example.org" };
  const self = { postMessage() {}, location: page };
  const chatmailNewUrl = new Function("self", "navigator", "setInterval", src + "\nreturn chatmailNewUrl;")(self, {}, () => ({}));
  assert.equal(chatmailNewUrl("https://mail.example.org/new", { method: "POST" }, page), "https://relay.example.org/cm-new/mail.example.org");
  assert.equal(chatmailNewUrl("https://mail.example.org/new?t=abc", { method: "POST" }, page), "https://relay.example.org/cm-new/mail.example.org?t=abc");
  assert.equal(chatmailNewUrl("https://relay.example.org/new", { method: "POST" }, page), null);
  assert.equal(chatmailNewUrl("https://mail.example.org/other", { method: "POST" }, page), null);
  assert.equal(chatmailNewUrl("https://127.0.0.1/new", { method: "POST" }, page), null);
});

test("worker sends /new to the configured relay's /cm-new when the page is on another origin", () => {
  const src = readFileSync(new URL("../app/js/worker-wasm.js", import.meta.url), "utf8");
  const page = { href: "https://pwa.example.org/web/worker-wasm.js", origin: "https://pwa.example.org", hostname: "pwa.example.org" };
  const self = { postMessage() {}, location: page };
  const { chatmailNewUrl, relayBaseFromWsUrl } = new Function("self", "navigator", "setInterval", src + "\nreturn { chatmailNewUrl, relayBaseFromWsUrl };")(self, {}, () => ({}));
  const relay = relayBaseFromWsUrl("wss://relay.example.org");
  assert.deepEqual(relay, { origin: "https://relay.example.org", hostname: "relay.example.org" });
  assert.equal(relayBaseFromWsUrl(""), null);
  assert.equal(relayBaseFromWsUrl("https://relay.example.org"), null);
  assert.equal(chatmailNewUrl("https://mail.example.org/new", { method: "POST" }, page, relay), "https://relay.example.org/cm-new/mail.example.org");
  assert.equal(chatmailNewUrl("https://relay.example.org/new", { method: "POST" }, page, relay), null, "the relay's own /new goes direct");
  assert.equal(chatmailNewUrl("https://mail.example.org/new", { method: "POST" }, page, null), "https://pwa.example.org/cm-new/mail.example.org", "no relay: page origin as before");
});

// Tauri shells: the W probe goes to Rust (no browser Origin), never the
// WebView's own WebSocket, which origin-gated relays refuse.
test("probe: in the Tauri shell it invokes probe_c3_relay, not a browser WebSocket", () => withFakeWS(async () => {
  const realWin = globalThis.window;
  const calls = [];
  globalThis.window = { __TAURI__: { core: { invoke: async (cmd, args) => { calls.push([cmd, args]); return args.host === "good.example"; } } } };
  try {
    assert.equal(await probeC3Relay("good.example"), true);
    assert.equal(await probeC3Relay("bad.example"), false);
    globalThis.window.__TAURI__.core.invoke = async () => { throw new Error("boom"); };
    assert.equal(await probeC3Relay("err.example"), false);
    assert.deepEqual(calls, [["probe_c3_relay", { host: "good.example" }], ["probe_c3_relay", { host: "bad.example" }]]);
    assert.equal(FakeWS.instances.length, 0);
  } finally {
    globalThis.window = realWin;
  }
}));

test("probe_c3_relay: Rust command exists, is registered and sends no Origin", () => {
  const src = readFileSync(new URL("../velta-app/src-tauri/src/c3_probe.rs", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(src, /pub async fn probe_c3_relay\(host: String\) -> bool/);
  assert.match(src, /valid_host\(&host\)/);
  assert.match(src, /Duration::from_secs\(5\)/);
  const req = src.match(/"GET \/dns\/[^"]*"/)?.[0] || "";
  assert.ok(req && !/Origin/i.test(req), "handshake must not carry an Origin header");
  assert.match(lib, /pub mod c3_probe;/);
  assert.match(lib, /generate_handler!\[[^\]]*c3_probe::probe_c3_relay/);
});
