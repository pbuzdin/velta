// One-tap PWA onboarding. V2 invites carry an Ed25519-signed proxy and relay
// configuration; legacy v1 proxy tokens use the same-origin registry instead.
import { normalizeHost, probeDnsVia, wsProxyUrl } from "./ws-relays.js";
import { installWsLinkPwa, normalizeWsProxyUrl, validWsToken } from "./ws-transport.js";

export const PWA_ONBOARDING_KEY = "velta-pwa-onboarding";
const RELAY_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Bad base64url");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function readEnvelope(raw) {
  try {
    const [payload, signature, extra] = raw.split(".");
    if (extra !== undefined || !payload || !signature) return null;
    const data = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    return data?.v === 2 ? { data, payload, signature } : null;
  } catch { return null; }
}

/** Null for SecureJoin; v1 proxy token or an unverified v2 envelope otherwise. */
export function parsePwaOnboardingUrl(rawUrl) {
  const url = new URL(rawUrl);
  const invites = url.searchParams.getAll("invite");
  if (!invites.length) return null;
  if (invites.length !== 1) throw new Error("This PWA invite is damaged");
  const raw = invites[0];
  const ids = url.searchParams.getAll("r");
  if (readEnvelope(raw)) {
    if (ids.length) throw new Error("A signed PWA invite cannot use an unsigned relay id");
    return { token: "", relay: "", envelope: raw };
  }
  if (!validWsToken(raw)) {
    if (invites.some(validWsToken)) throw new Error("This PWA invite is damaged");
    return null;
  }
  if (ids.length > 1 || (ids.length && !RELAY_ID.test(ids[0]))) throw new Error("This PWA invite has a bad relay id");
  return { token: raw, relay: ids[0] || "" };
}

export function normalizeOnboardingRegistry(data) {
  if (!data || data.v !== 1 || typeof data.proxy !== "string" || !data.relays || typeof data.relays !== "object" || Array.isArray(data.relays)) {
    throw new Error("Bad PWA onboarding registry");
  }
  const proxy = normalizeWsProxyUrl(data.proxy);
  const u = new URL(proxy);
  if (u.protocol !== "wss:" || u.port) throw new Error("Bad PWA onboarding proxy");
  const relays = {};
  for (const [id, raw] of Object.entries(data.relays)) {
    const host = normalizeHost(raw);
    if (!RELAY_ID.test(id) || !host || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) throw new Error("Bad PWA onboarding relay");
    relays[id] = host;
  }
  if (!Object.keys(relays).length) throw new Error("PWA onboarding has no signup relays");
  return { proxy, relays };
}

export async function loadOnboardingRegistry({ fetchImpl = globalThis.fetch?.bind(globalThis), registryUrl = new URL("onboarding.json", document.baseURI).href } = {}) {
  if (!fetchImpl) throw new Error("Cannot load the PWA onboarding registry");
  const res = await fetchImpl(registryUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`PWA onboarding registry returned HTTP ${res.status}`);
  return normalizeOnboardingRegistry(await res.json());
}

/** Verify before trusting any hostname or installing the nested proxy token. */
export async function verifyOnboardingEnvelope(raw, keys = globalThis.window?.VELTA_PWA?.onboardingKeys || {}) {
  const envelope = readEnvelope(raw);
  if (!envelope) throw new Error("Bad signed PWA invite");
  const { data, payload, signature } = envelope;
  if (!RELAY_ID.test(data.k || "") || typeof keys?.[data.k] !== "string") throw new Error("Unknown PWA onboarding key");
  let verified;
  try {
    const key = await crypto.subtle.importKey("raw", decodeBase64Url(keys[data.k]), { name: "Ed25519" }, false, ["verify"]);
    verified = await crypto.subtle.verify({ name: "Ed25519" }, key, decodeBase64Url(signature), decodeBase64Url(payload));
  } catch { throw new Error("Bad signed PWA invite"); }
  if (!verified) throw new Error("Bad PWA onboarding signature");
  if (!validWsToken(data.t)) throw new Error("Bad proxy token in PWA invite");
  let proxyToken;
  try { proxyToken = JSON.parse(new TextDecoder().decode(decodeBase64Url(data.t.split(".")[0]))); }
  catch { throw new Error("Bad proxy token in PWA invite"); }
  const expiry = Number(proxyToken.e || 0);
  if (!Number.isInteger(data.e) || data.e < 0 || data.e !== expiry) throw new Error("PWA invite expiry does not match its proxy token");
  if (data.e && data.e <= Math.floor(Date.now() / 1000)) throw new Error("This PWA invite has expired");
  const registry = normalizeOnboardingRegistry({ v: 1, proxy: data.p, relays: data.r });
  return { token: data.t, relay: "", registry };
}

export function readPendingOnboarding(storage = sessionStorage) {
  try {
    const value = JSON.parse(storage.getItem(PWA_ONBOARDING_KEY) || "null");
    if (!value || typeof value !== "object" || (value.relay && !RELAY_ID.test(value.relay)) || (value.token && !validWsToken(value.token))) throw new Error("bad pending invite");
    if (value.envelope && typeof value.envelope !== "string") throw new Error("bad pending envelope");
    const pending = { token: value.token || "", relay: value.relay || "" };
    if (value.envelope) pending.envelope = value.envelope;
    if (value.registry) pending.registry = normalizeOnboardingRegistry({ v: 1, ...value.registry });
    return pending;
  } catch {
    storage.removeItem(PWA_ONBOARDING_KEY);
    return null;
  }
}

function scrubInviteUrl() {
  const url = new URL(location.href);
  url.searchParams.delete("invite");
  url.searchParams.delete("r");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}

/** Install before the worker starts; it captures the proxy URL once at boot. */
export async function preparePwaOnboarding({ rawUrl = location.href, storage = sessionStorage, fetchImpl, registryUrl, onboardingKeys, reload = () => location.reload(), scrub = scrubInviteUrl } = {}) {
  let pending = readPendingOnboarding(storage);
  let invite = null;
  try {
    invite = parsePwaOnboardingUrl(rawUrl);
  } catch (err) {
    scrub();
    return { error: err.message };
  }
  if (invite) {
    pending = invite.envelope
      ? { token: "", relay: "", envelope: invite.envelope }
      : { token: invite.token, relay: invite.relay };
    storage.setItem(PWA_ONBOARDING_KEY, JSON.stringify(pending));
    scrub(); // the bearer token must not remain visible or be copied again
  }
  if (!pending) return { pending: false };
  try {
    if (pending.envelope) {
      const verified = await verifyOnboardingEnvelope(pending.envelope, onboardingKeys);
      if (!installWsLinkPwa({ url: verified.registry.proxy, token: verified.token })) throw new Error("The PWA proxy invite could not be installed");
      pending = { token: "", relay: verified.relay, registry: verified.registry };
      storage.setItem(PWA_ONBOARDING_KEY, JSON.stringify(pending));
      reload();
      return { reload: true };
    }
    const registry = pending.registry || await loadOnboardingRegistry({ fetchImpl, registryUrl });
    if (pending.token) {
      if (!installWsLinkPwa({ url: registry.proxy, token: pending.token })) throw new Error("The PWA proxy invite could not be installed");
      pending = { token: "", relay: pending.relay };
      storage.setItem(PWA_ONBOARDING_KEY, JSON.stringify(pending));
      reload();
      return { reload: true };
    }
    return { pending: true, registry };
  } catch (err) {
    return { error: String(err?.message || err || "PWA onboarding failed") };
  }
}

/** Probe only approved entries, never the core's candidate pool. */
export async function selectOnboardingRelay(registry, requested = "", probe = host => probeDnsVia(wsProxyUrl(), host)) {
  if (requested) {
    const host = registry.relays[requested];
    if (!host) throw new Error(`Unknown onboarding relay id: ${requested}`);
    if (!(await probe(host))) throw new Error(`${host} is not reachable through this proxy`);
    return host;
  }
  const results = await Promise.all(Object.entries(registry.relays).map(async ([id, host]) => {
    const started = performance.now();
    return { id, host, ok: await probe(host), ms: performance.now() - started };
  }));
  results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms || a.id.localeCompare(b.id));
  if (!results[0]?.ok) throw new Error("No onboarding relay is reachable through this proxy");
  return results[0].host;
}
