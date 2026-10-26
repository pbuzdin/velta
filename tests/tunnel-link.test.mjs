import test from "node:test";
import assert from "node:assert/strict";

const { parseTunnelLink, buildTunnelLink, validTunnelZone, normalizeTunnelKey, validTunnelResolver, acceptTunnelLink, tunnelConfirmText, openTunnelShare, TUNNEL_LINK_MAX } = await import("../app/js/tunnel.js");

const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 250));
const KEY_STD = KEY_BYTES.toString("base64");
const KEY_URL = KEY_BYTES.toString("base64url");
const base = (extra = "") => `velta://tunnel?v=1&zone=t.example.org&key=${KEY_URL}${extra}`;

test("parses a minimal and a full link", () => {
  assert.deepEqual(parseTunnelLink(base()), { version: 1, zone: "t.example.org", key: KEY_STD, resolvers: [], canaries: [], label: "" });
  const full = parseTunnelLink(base("&r=192.0.2.1:53,[2001:db8::1]:853,192.0.2.1:53&c=check.example.net:443&n=Family%20tunnel"));
  assert.deepEqual(full.resolvers, ["192.0.2.1:53", "[2001:db8::1]:853"]);
  assert.deepEqual(full.canaries, ["check.example.net:443"]);
  assert.equal(full.label, "Family tunnel");
});

test("v is optional (defaults to 1), zone is normalized, std/url/padded keys accepted", () => {
  assert.equal(parseTunnelLink(`VELTA://tunnel?zone=T.Example.ORG.&key=${KEY_URL}`).zone, "t.example.org");
  assert.equal(parseTunnelLink(`velta://tunnel/?zone=t.example.org&key=${encodeURIComponent(KEY_STD)}`).key, KEY_STD);
  assert.equal(normalizeTunnelKey(KEY_URL), KEY_STD);
  assert.equal(normalizeTunnelKey(KEY_STD.replace(/=$/, "")), KEY_STD);
});

test("rejects malformed links", () => {
  const cases = [
    ["", /Empty/],
    ["velta://chat?chat=1", /Not a velta:\/\/tunnel/],
    ["https://example.org/?zone=x", /Not a velta/],
    [`velta://tunnel/x?zone=t.example.org&key=${KEY_URL}`, /Not a velta/],
    [base("#frag"), /Not a velta/],
    [base("&v=2").replace("v=1&", ""), /Unsupported link version 2/],
    [base("&zone=other.example.org"), /Repeated/],
    [base("&evil=1"), /Unknown parameter: evil/],
    [`velta://tunnel?v=1&key=${KEY_URL}`, /no tunnel domain/],
    [`velta://tunnel?v=1&zone=localhost&key=${KEY_URL}`, /domain is not valid/],
    [`velta://tunnel?v=1&zone=-bad.example.org&key=${KEY_URL}`, /domain is not valid/],
    [`velta://tunnel?v=1&zone=t.exa_mple.org&key=${KEY_URL}`, /domain is not valid/],
    [`velta://tunnel?v=1&zone=192.0.2.1.1&key=${KEY_URL}`, /domain is not valid/],
    ["velta://tunnel?v=1&zone=t.example.org", /32 bytes/],
    ["velta://tunnel?v=1&zone=t.example.org&key=AAAA", /32 bytes/],
    [`velta://tunnel?v=1&zone=t.example.org&key=${KEY_URL}AA`, /32 bytes/],
    [base("&r=resolver.example.org:53"), /Bad resolver/],
    [base("&r=192.0.2.1:0"), /Bad resolver/],
    [base("&r=300.0.2.1"), /Bad resolver/],
    [base("&c=192.0.2.1"), /Bad canar/],
    [base("&n=%E2%80%AEevil"), /invalid characters/],
    [base("&n=" + "x".repeat(65)), /too long/],
    [base("&zone=%ZZ").replace("zone=t.example.org&", ""), /encoded/],
    [base("&r=" + Array.from({ length: 65 }, (_, i) => `192.0.2.${i}`).join(",")), /Too many resolvers/],
    [base("&n=" + "x".repeat(TUNNEL_LINK_MAX)), /too long/],
  ];
  for (const [link, re] of cases) assert.throws(() => parseTunnelLink(link), re, link.slice(0, 80));
});

test("zone and resolver helpers", () => {
  assert.equal(validTunnelZone("a.b"), true);
  assert.equal(validTunnelZone("a".repeat(64) + ".org"), false);
  assert.equal(validTunnelZone("a..org"), false);
  assert.equal(validTunnelResolver("2001:db8::53"), true);
  assert.equal(validTunnelResolver("[2001:db8::53]:65536"), false);
  assert.equal(validTunnelResolver("01.2.3.4"), false);
});

test("build -> parse round trip keeps every field", () => {
  const cfg = { zone: "t.example.org", key: KEY_STD, resolvers: ["192.0.2.1:53", "[2001:db8::1]:853"], canaries: ["check.example.net:443"], label: "Café & co" };
  const link = buildTunnelLink(cfg);
  assert.match(link, /^velta:\/\/tunnel\?v=1&zone=t\.example\.org&key=[A-Za-z0-9_-]{43}&/);
  assert.deepEqual(parseTunnelLink(link), { version: 1, ...cfg });
});

function shell(calls, { installed = false, zone = "old.example.net", desktop = false } = {}) {
  return async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "tunnel_status") return desktop === "old" ? { available: false, installed: false, error: "The DNS tunnel is only available in the Android app" }
      : desktop ? { available: false, installed: false, unsupported: true, platform: "macos", error: "The DNS tunnel is not available on this platform yet (Android and Windows only)" } : { installed, available: true, zone: installed ? zone : undefined };
    if (cmd === "tunnel_preview") return { zone: "t.example.org", resolvers: 21 };
    return null;
  };
}
const ui = (over = {}) => ({ toast() {}, errToast() {}, confirmModal: async () => true, ...over });

test("an invalid link is rejected before the shell or a dialog", async () => {
  const calls = []; let err = "", asked = false;
  const ok = await acceptTunnelLink(base("&x=1"), { ...ui({ errToast: m => { err = m; }, confirmModal: async () => { asked = true; return true; } }), invoke: shell(calls) });
  assert.equal(ok, false); assert.equal(asked, false); assert.deepEqual(calls, []);
  assert.match(err, /Unknown parameter/);
});

test("confirmation shows label, domain and the traffic warning; cancel applies nothing", async () => {
  const calls = []; let seen;
  const ok = await acceptTunnelLink(base("&n=Office"), { ...ui({ confirmModal: async (...a) => { seen = a; return false; } }), invoke: shell(calls) });
  assert.equal(ok, false);
  assert.equal(seen[0], "Add DNS tunnel?");
  assert.match(seen[1], /Name: Office/);
  assert.match(seen[1], /Tunnel server: t\.example\.org/);
  assert.match(seen[1], /All chat traffic will go through this tunnel's server/);
  assert.equal(seen[2], "Add and use");
  assert.ok(!calls.some(c => c[0] === "tunnel_install"));
});

test("with a tunnel in use: Add and use names the tunnel it switches from", async () => {
  const calls = []; let seen;
  const ok = await acceptTunnelLink(base(), { ...ui({ confirmModal: async (...a) => { seen = a; return true; } }), invoke: shell(calls, { installed: true }) });
  assert.equal(ok, true);
  assert.equal(seen[0], "Add DNS tunnel?");
  assert.match(seen[1], /switches from the tunnel in use \(old\.example\.net\)/);
  assert.equal(seen[2], "Add and use");
  assert.equal(seen[3], false);
  assert.deepEqual(calls.find(c => c[0] === "tunnel_install")[1].activate, true);
});

test("unsupported platforms get a clear message, no dialog", async () => {
  for (const invoke of [null, shell([], { desktop: true }), shell([], { desktop: "old" })]) {
    let msg = "", asked = false;
    const ok = await acceptTunnelLink(base(), { ...ui({ toast: m => { msg = m; }, confirmModal: async () => { asked = true; return true; } }), invoke });
    assert.equal(ok, false); assert.equal(asked, false);
    assert.match(msg, /only in the Velta app for Android or Windows/);
  }
});

test("confirm text escapes nothing itself but carries only validated values", () => {
  const txt = tunnelConfirmText({ zone: "t.example.org", label: "<b>x</b>" }, { resolvers: 3 });
  assert.match(txt, /Name: <b>x<\/b>/); // confirmModal escapes it
  assert.match(txt, /3 DNS resolvers/);
});

test("share sheet builds a link from the stored config with the label", async () => {
  const store = new Map([["velta-tunnel-label", "Office"]]);
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  const els = {};
  const mkEl = () => ({ addEventListener(t, f) { this.on = f; }, textContent: "", innerHTML: "", isConnected: true });
  globalThis.document = { createElement: () => ({ set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; }, querySelector: sel => (els[sel] ||= mkEl()) }) };
  let title = "";
  const r = await openTunnelShare({
    showModal: o => { title = o.title; return { close() {} }; }, toast() {}, errToast: e => assert.fail(e),
    renderQr: text => `<svg data-text="${text.length}"></svg>`,
    invoke: async cmd => (cmd === "tunnel_link" ? { zone: "t.example.org", key: KEY_STD, resolvers: [], canaries: null } : null),
  });
  assert.equal(title, "Share tunnel link");
  assert.equal(r.link, `velta://tunnel?v=1&zone=t.example.org&key=${KEY_URL}&n=Office`);
  assert.equal(els["[data-tunnel-link]"].textContent, r.link);
  assert.match(els[".qr-box"].innerHTML, /<svg/);
  delete globalThis.document; delete globalThis.localStorage;
});
