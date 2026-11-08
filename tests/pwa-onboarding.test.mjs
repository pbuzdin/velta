import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOK = "eyJ2IjoxLCJpIjoiYWFhMTExIn0." + "A".repeat(42) + "w";
const registry = { v: 1, proxy: "wss://proxy.example.org/vp-test", relays: { alpha: "mail.example.org", fast: "fast.example.org" } };
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
function makeEnvelope(overrides = {}) {
  const payload = { v: 2, t: TOK, p: registry.proxy, r: registry.relays, e: 0, k: "test", ...overrides };
  const raw = Buffer.from(JSON.stringify(payload));
  return raw.toString("base64url") + "." + sign(null, raw, privateKey).toString("base64url");
}
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
globalThis.window = { VELTA_PWA: { wasmCore: true, wsProxyUrl: "", onboardingKeys: { test: PUBLIC_KEY } } };
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

test("v2 verifies a self-contained signed configuration without registry JSON", async () => {
  const envelope = makeEnvelope();
  assert.deepEqual(m.parsePwaOnboardingUrl(`https://velta.cc/web?invite=${envelope}`), { token: "", relay: "", envelope });
  assert.throws(() => m.parsePwaOnboardingUrl(`https://velta.cc/web?invite=${envelope}&r=alpha`), /unsigned relay id/);
  assert.deepEqual(await m.verifyOnboardingEnvelope(envelope), {
    token: TOK,
    relay: "",
    registry: { proxy: registry.proxy, relays: registry.relays },
  });

  reset();
  let reloaded = 0;
  const noRegistryFetch = async () => { throw new Error("registry JSON must not be fetched"); };
  const first = await m.preparePwaOnboarding({
    rawUrl: `https://velta.cc/web?invite=${envelope}`,
    onboardingKeys: { test: PUBLIC_KEY },
    fetchImpl: noRegistryFetch,
    reload: () => reloaded++,
    scrub: () => {},
  });
  assert.equal(first.reload, true);
  assert.equal(reloaded, 1);
  assert.equal(relays.wsProxyToken(), TOK);
  assert.deepEqual(m.readPendingOnboarding(), {
    token: "",
    relay: "",
    registry: { proxy: registry.proxy, relays: registry.relays },
  });
  const second = await m.preparePwaOnboarding({
    rawUrl: "https://velta.cc/web",
    onboardingKeys: { test: PUBLIC_KEY },
    fetchImpl: noRegistryFetch,
    reload: () => { throw new Error("must not reload again"); },
  });
  assert.equal(second.pending, true);
  assert.deepEqual(second.registry.relays, registry.relays);
});

test("v2 rejects tampering, unknown keys and inconsistent expiry before installation", async () => {
  const envelope = makeEnvelope();
  const [payload, signature] = envelope.split(".");
  const tampered = Buffer.from(JSON.stringify({ v: 2, t: TOK, p: "wss://attacker.example.org/ws", r: registry.relays, e: 0, k: "test" })).toString("base64url") + "." + signature;
  await assert.rejects(() => m.verifyOnboardingEnvelope(tampered), /signature/);
  await assert.rejects(() => m.verifyOnboardingEnvelope(envelope, {}), /Unknown/);
  await assert.rejects(() => m.verifyOnboardingEnvelope(makeEnvelope({ e: 1 })), /expiry does not match/);
  const expiredToken = Buffer.from(JSON.stringify({ v: 1, i: "expired", e: 1 })).toString("base64url") + "." + "A".repeat(42) + "w";
  await assert.rejects(() => m.verifyOnboardingEnvelope(makeEnvelope({ t: expiredToken, e: 1 })), /expired/);
  await assert.rejects(() => m.verifyOnboardingEnvelope(makeEnvelope({ p: "https://proxy.example.org/vp-test" })), /wss|proxy|Bad/);
  await assert.rejects(() => m.verifyOnboardingEnvelope(payload + ".bad-signature"), /Bad signed/);

  reset();
  const result = await m.preparePwaOnboarding({
    rawUrl: `https://velta.cc/web?invite=${tampered}`,
    onboardingKeys: { test: PUBLIC_KEY },
    scrub: () => {},
  });
  assert.match(result.error, /signature/);
  assert.notEqual(relays.wsProxyUrl(), "wss://attacker.example.org/ws", "an unverified proxy is never installed");
  assert.equal(relays.wsRelayToken("attacker.example.org"), "");
});

test("Veltar's Python helper produces envelopes accepted by the PWA", async () => {
  const dir = mkdtempSync(join(tmpdir(), "velta-pwa-signer-"));
  const pem = join(dir, "signing-key.pem");
  writeFileSync(pem, privateKey.export({ format: "pem", type: "pkcs8" }));
  const helper = fileURLToPath(new URL("../scripts/relay-invite/pwa_onboarding.py", import.meta.url));
  const result = spawnSync("python3", [
    helper, "mint", "--private-key", pem, "--key-id", "test", "--token", TOK,
    "--proxy", registry.proxy, "--relay", "alpha=mail.example.org", "--relay", "fast=fast.example.org",
    "--pwa-url", "https://velta.cc/web",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const link = result.stdout.trim();
  const parsed = m.parsePwaOnboardingUrl(link);
  assert.ok(parsed.envelope);
  assert.deepEqual(await m.verifyOnboardingEnvelope(parsed.envelope), {
    token: TOK,
    relay: "",
    registry: { proxy: registry.proxy, relays: registry.relays },
  });
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
