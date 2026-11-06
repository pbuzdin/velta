import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const TOK = "eyJ2IjoxLCJpIjoiYWFhMTExIn0." + "A".repeat(42) + "w";
const registry = { v: 1, proxy: "wss://proxy.example.org/vp-test", relays: { alpha: "mail.example.org", fast: "fast.example.org" } };
function storage() {
  const m = new Map();
  return {
    m,
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
  };
}
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.window = { VELTA_PWA: { wasmCore: true, wsProxyUrl: "" } };
globalThis.location = { hostname: "velta.cc" };
const m = await import("../app/js/pwa-onboarding.js");
const relays = await import("../app/js/ws-relays.js");

function reset() {
  localStorage.m.clear();
  sessionStorage.m.clear();
  globalThis.window.VELTA_PWA.wsProxyUrl = "";
}

test("proxy invites are distinct from SecureJoin and validate relay ids", () => {
  assert.deepEqual(m.parsePwaOnboardingUrl(`https://velta.cc/web?invite=${TOK}&r=alpha`), { token: TOK, relay: "alpha" });
  assert.deepEqual(m.parsePwaOnboardingUrl(`https://velta.cc/web?invite=${TOK}`), { token: TOK, relay: "" });
  assert.equal(m.parsePwaOnboardingUrl("https://velta.cc/web?invite=https%3A%2F%2Fi.delta.chat%2F%23abc"), null);
  assert.throws(() => m.parsePwaOnboardingUrl(`https://velta.cc/web?invite=${TOK}&r=mail.example.org`), /bad relay id/);
  assert.throws(() => m.parsePwaOnboardingUrl(`https://velta.cc/web?invite=${TOK}&invite=${TOK}`), /damaged/);
});

test("only a strict same-origin proxy and normalized registry hosts are accepted", () => {
  assert.deepEqual(m.normalizeOnboardingRegistry(registry), { proxy: "wss://proxy.example.org/vp-test", relays: { alpha: "mail.example.org", fast: "fast.example.org" } });
  for (const bad of [
    null,
    { v: 1, proxy: "https://proxy.example.org/vp-test", relays: registry.relays },
    { v: 1, proxy: "wss://proxy.example.org:8443/vp-test", relays: registry.relays },
    { v: 1, proxy: registry.proxy, relays: {} },
    { v: 1, proxy: registry.proxy, relays: { alpha: "127.0.0.1" } },
    { v: 1, proxy: registry.proxy, relays: { "BAD": "mail.example.org" } },
  ]) assert.throws(() => m.normalizeOnboardingRegistry(bad));
});

test("capture scrubs the token, installs the full-path proxy, and resumes after reload", async () => {
  reset();
  let scrubbed = 0;
  let reloaded = 0;
  const fetchImpl = async url => ({ ok: true, json: async () => registry });
  const first = await m.preparePwaOnboarding({
    rawUrl: `https://velta.cc/web?invite=${TOK}&r=alpha&wasm=1`,
    fetchImpl,
    registryUrl: "https://velta.cc/web/onboarding.json",
    scrub: () => scrubbed++,
    reload: () => reloaded++,
  });
  assert.equal(first.reload, true);
  assert.equal(scrubbed, 1);
  assert.equal(reloaded, 1);
  assert.equal(relays.activeWsRelay(), "proxy.example.org");
  assert.equal(relays.wsProxyUrl(), "wss://proxy.example.org/vp-test");
  assert.equal(relays.wsProxyToken(), TOK);
  assert.deepEqual(m.readPendingOnboarding(), { token: "", relay: "alpha" });
  assert.ok(!sessionStorage.m.get(m.PWA_ONBOARDING_KEY).includes(TOK), "session state no longer duplicates the bearer token");

  const second = await m.preparePwaOnboarding({
    rawUrl: "https://velta.cc/web?wasm=1",
    fetchImpl,
    registryUrl: "https://velta.cc/web/onboarding.json",
    reload: () => { throw new Error("must not reload again"); },
  });
  assert.equal(second.pending, true);
  assert.deepEqual(second.registry.relays, registry.relays);
});

test("a registry failure keeps the pending invite retryable and never reloads", async () => {
  reset();
  let scrubbed = 0;
  const result = await m.preparePwaOnboarding({
    rawUrl: `https://velta.cc/web?invite=${TOK}`,
    fetchImpl: async () => { throw new Error("offline"); },
    registryUrl: "https://velta.cc/web/onboarding.json",
    scrub: () => scrubbed++,
    reload: () => { throw new Error("must not reload"); },
  });
  assert.match(result.error, /offline/);
  assert.equal(scrubbed, 1);
  assert.deepEqual(m.readPendingOnboarding(), { token: TOK, relay: "" });
  assert.equal(relays.wsRelayToken("proxy.example.org"), "", "nothing is installed before the registry is validated");
});

test("relay selection uses only registry entries and picks the fastest responsive one", async () => {
  const probed = [];
  const probe = async host => {
    probed.push(host);
    await new Promise(resolve => setTimeout(resolve, host === "fast.example.org" ? 1 : 15));
    return true;
  };
  assert.equal(await m.selectOnboardingRelay(m.normalizeOnboardingRegistry(registry), "", probe), "fast.example.org");
  assert.deepEqual(probed.sort(), ["fast.example.org", "mail.example.org"]);
  assert.equal(await m.selectOnboardingRelay(m.normalizeOnboardingRegistry(registry), "alpha", async () => true), "mail.example.org");
  await assert.rejects(() => m.selectOnboardingRelay(m.normalizeOnboardingRegistry(registry), "missing", async () => true), /Unknown/);
  await assert.rejects(() => m.selectOnboardingRelay(m.normalizeOnboardingRegistry(registry), "", async () => false), /No onboarding relay/);
});

test("boot creates the selected Chatmail profile without core autopick or a nickname step", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const start = app.indexOf("async function finishPwaOnboarding()");
  const body = app.slice(start, app.indexOf("/* ---------------- deeplinks", start));
  assert.match(body, /selectOnboardingRelay\(pwaOnboardingBoot\.registry, pending\.relay\)/);
  assert.match(body, /core\.configureWithQr\(link\)/);
  assert.match(body, /core\.addAccountWithQr\(link\)/);
  assert.doesNotMatch(body, /initTransports|askNickname|ensureMailTunnelForLink/);
  assert.ok(app.indexOf("await preparePwaOnboarding()") < app.indexOf("coreStartupPromise = createCore"), "proxy is installed before the worker starts");
});
