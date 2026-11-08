// One-tap PWA onboarding: a signed proxy invite plus an administrator-approved
// relay id. The same-origin registry decides both the proxy and signup hosts;
// invite links never expand the proxy's destination allowlist.
import { normalizeHost, probeDnsVia, wsProxyUrl } from "./ws-relays.js";
import { installWsLinkPwa, normalizeWsProxyUrl, validWsToken } from "./ws-transport.js";

export const PWA_ONBOARDING_KEY = "velta-pwa-onboarding";
const RELAY_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Null for Delta Chat SecureJoin links; a proxy invite only for our token shape. */
export function parsePwaOnboardingUrl(rawUrl) {
  const url = new URL(rawUrl);
  const invites = url.searchParams.getAll("invite");
  if (!invites.length) return null;
  if (invites.length !== 1 || !validWsToken(invites[0])) {
    if (invites.some(validWsToken)) throw new Error("This PWA invite is damaged");
    return null;
  }
  const ids = url.searchParams.getAll("r");
  if (ids.length > 1 || (ids.length && !RELAY_ID.test(ids[0]))) throw new Error("This PWA invite has a bad relay id");
  return { token: invites[0], relay: ids[0] || "" };
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

export function readPendingOnboarding(storage = sessionStorage) {
  try {
    const value = JSON.parse(storage.getItem(PWA_ONBOARDING_KEY) || "null");
    if (!value || typeof value !== "object" || (value.relay && !RELAY_ID.test(value.relay)) || (value.token && !validWsToken(value.token))) throw new Error("bad pending invite");
    return { token: value.token || "", relay: value.relay || "" };
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

/**
 * Installs a newly opened invite before the wasm worker starts. A reload is
 * required because the worker captures its proxy URL once at boot.
 */
export async function preparePwaOnboarding({ rawUrl = location.href, storage = sessionStorage, fetchImpl, registryUrl, reload = () => location.reload(), scrub = scrubInviteUrl } = {}) {
  let pending = readPendingOnboarding(storage);
  let invite = null;
  try {
    invite = parsePwaOnboardingUrl(rawUrl);
  } catch (err) {
    scrub();
    return { error: err.message };
  }
  if (invite) {
    pending = invite;
    storage.setItem(PWA_ONBOARDING_KEY, JSON.stringify(pending));
    scrub(); // the bearer token must not remain visible or be copied again
  }
  if (!pending) return { pending: false };
  try {
    const registry = await loadOnboardingRegistry({ fetchImpl, registryUrl });
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

/** Probe only signup-capable registry entries, never the core's candidate pool. */
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
