import test from "node:test";
import assert from "node:assert/strict";

// Velta invite cards (invite-cards.js, docs/invite-cards.md): strict parsing
// of proxy / relay / tunnel invite links, card HTML, the token-free chip in
// the message text, and claim error mapping.
globalThis.HTMLElement = class {};
globalThis.customElements = { get() {}, define() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {} };
const m = await import("../app/js/invite-cards.js");
const { renderMarkdown } = await import("../app/js/markdown.js");

const b64 = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const tok = (p, mac = "A".repeat(43)) => `${b64(p)}.${mac}`;
const FUTURE = 1893456000; // 2030-01-01
const PAST = 1600000000;
const proxyLink = (p = { v: 1, i: "ab12", n: "Office", e: FUTURE, u: 3 }, extra = "&n=Office") =>
  `velta://ws?u=${encodeURIComponent("wss://proxy.example.org")}${extra}&t=${tok(p)}`;
const RELAY = "https://relay.example/i/AbCdEfGh12345678xyz_-";
const NOW = 1761400000000;

test("relay invite: strict parse", () => {
  assert.deepEqual(m.parseRelayInviteLink(RELAY), { kind: "relay", host: "relay.example", token: "AbCdEfGh12345678xyz_-", link: RELAY });
  assert.equal(m.parseRelayInviteLink(RELAY + "/").token, "AbCdEfGh12345678xyz_-");
  assert.equal(m.parseRelayInviteLink("https://RELAY.Example./i/AbCdEfGh12").host, "relay.example");
  for (const bad of [
    "http://relay.example/i/AbCdEfGh12", "https://relay.example:8443/i/AbCdEfGh12", "https://user@relay.example/i/AbCdEfGh12",
    "https://10.0.0.1/i/AbCdEfGh12", "https://localhost/i/AbCdEfGh12", "https://relay.example/i/short",
    "https://relay.example/i/claim", "https://relay.example/i/AbCdEfGh12?x=1", "https://relay.example/i/AbCdEfGh12#f",
    "https://relay.example/i/AbCd%2FEfGh12", "https://relay.example/x/i/AbCdEfGh12", "https://relay.example/i/AbCdEfGh12/x",
    "https://rel_ay.example/i/AbCdEfGh12", "https://relay.example/i/" + "a".repeat(129), "javascript:alert(1)//relay.example/i/AbCdEfGh12",
    "https://relay.example/i/<script>x</script>", "", null,
  ]) assert.equal(m.parseRelayInviteLink(bad), null, String(bad));
  assert.equal(m.parseRelayInviteInput("relay.example/i/AbCdEfGh12").host, "relay.example");
  assert.equal(m.parseRelayInviteInput("http://relay.example/i/AbCdEfGh12").host, "relay.example");
});

test("proxy token payload: decoded for display, malformed refused", () => {
  assert.deepEqual(m.decodeWsTokenPayload(tok({ v: 1, i: "ab", n: "Office", e: FUTURE, u: 2 })), { id: "ab", name: "Office", expires: FUTURE * 1000, devices: 2 });
  assert.deepEqual(m.decodeWsTokenPayload(tok({ v: 1, i: "ab" })), { id: "ab", name: "", expires: null, devices: null });
  for (const bad of [
    tok({ v: 2, i: "ab" }), tok({ i: "ab" }), tok({ v: 1 }), tok({ v: 1, i: 5 }), tok({ v: 1, i: "ab", e: "soon" }),
    tok({ v: 1, i: "ab", e: -1 }), tok({ v: 1, i: "ab", u: 0 }), tok({ v: 1, i: "ab", u: 1.5 }), tok({ v: 1, i: "ab", x: 1 }),
    tok([1, 2]), tok("not json"), tok({ v: 1, i: "ab" }, "short"), `${b64({ v: 1, i: "ab" })}`, "", "a.b.c",
    `${Buffer.from([0xff, 0xfe]).toString("base64url")}.${"A".repeat(43)}`,
  ]) assert.equal(m.decodeWsTokenPayload(bad), null, bad);
});

test("proxy invite: card model", () => {
  const p = m.parseProxyInvite(proxyLink());
  assert.equal(p.name, "Office");
  assert.equal(p.host, "proxy.example.org");
  assert.equal(p.devices, 3);
  assert.equal(p.expires, FUTURE * 1000);
  assert.equal(m.parseProxyInvite(proxyLink({ v: 1, i: "x", n: "FromToken" }, "")).name, "FromToken");
  assert.equal(m.parseProxyInvite(proxyLink({ v: 1, i: "x" }, "")).name, "proxy.example.org");
  // malformed: bad token payload, unknown field, repeated field, http proxy
  assert.equal(m.parseProxyInvite(proxyLink({ v: 9, i: "x" })), null);
  assert.equal(m.parseProxyInvite(proxyLink() + "&x=1"), null);
  assert.equal(m.parseProxyInvite(proxyLink() + "&n=Again"), null);
  assert.equal(m.parseProxyInvite(`velta://ws?u=${encodeURIComponent("ws://proxy.example.org")}`), null);
  assert.equal(m.parseProxyInvite("velta://ws?u=wss%3A%2F%2Fuser%40proxy.example.org"), null);
  assert.equal(m.parseProxyInvite("velta://ws?u=%E0%A4%A"), null);
});

test("findInviteLinks: first of each kind, punctuation trimmed", () => {
  const f = m.findInviteLinks(`Join: ${RELAY}. Proxy (${proxyLink()}), again ${RELAY.replace("xyz", "zzz")}`);
  assert.equal(f.relay.token, "AbCdEfGh12345678xyz_-");
  assert.equal(f.proxy.name, "Office");
  assert.equal(f.tunnel, null);
  assert.deepEqual(m.findInviteLinks("nothing https://example.org/i/ here"), { proxy: null, relay: null, tunnel: null });
});

test("cards: combined, sender, no token in visible text, show/copy", () => {
  const html = m.inviteCardsHtml(`${RELAY}\n${proxyLink()}`, { sender: "Veltar", now: NOW, lang: "en" });
  assert.equal((html.match(/class="ivc /g) || []).length, 1, "one combined card");
  assert.match(html, /Join relay\.example: account \+ proxy/);
  assert.match(html, /From Veltar/);
  assert.match(html, /For up to 3 devices/);
  assert.match(html, /data-ivc-act="join"/);
  assert.match(html, /data-ivc-act="show"/);
  assert.match(html, /aria-label="Copy invite link"/);
  // the token is only in attributes and the hidden <code>, never in visible text
  const visible = html.replace(/<code class="ivc-link" hidden>[\s\S]*?<\/code>/, "").replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(visible, /AbCdEfGh12345678xyz|eyJ2Ijox/);
});

test("cards: proxy-only, relay-only, expired, tunnel", () => {
  const p = m.inviteCardsHtml(proxyLink(), { now: NOW });
  assert.match(p, /Proxy invite: Office/);
  assert.match(p, /data-ivc-act="use"/);
  assert.match(p, /data-ivc-act="save"/);
  assert.doesNotMatch(p, /ivc-expired/);
  const r = m.inviteCardsHtml(RELAY, { now: NOW });
  assert.match(r, /Account invite: relay\.example/);
  assert.match(r, /data-ivc-act="create"/);
  const e = m.inviteCardsHtml(proxyLink({ v: 1, i: "x", e: PAST, u: 1 }), { now: NOW });
  assert.match(e, /ivc-expired/);
  assert.match(e, />Expired</);
  assert.match(e, /For 1 device/);
  assert.match(e, /data-ivc-act="use" disabled/);
  assert.match(e, /data-ivc-act="copy"/); // copy stays available
  const ce = m.inviteCardsHtml(`${RELAY} ${proxyLink({ v: 1, i: "x", e: PAST })}`, { now: NOW });
  assert.match(ce, /data-ivc-act="join" disabled/);
  const key = Buffer.alloc(32, 7).toString("base64");
  const tl = m.inviteCardsHtml(`velta://tunnel?zone=t.example.org&key=${encodeURIComponent(key)}&n=Home`, { now: NOW });
  assert.match(tl, /DNS tunnel: Home/);
  assert.match(tl, /data-ivc-act="tunnel"/);
  assert.equal(m.inviteCardsHtml("velta://tunnel?zone=t.example.org&key=bad"), "");
});

test("cards: hostile text is escaped and malformed links make no card", () => {
  const evil = proxyLink({ v: 1, i: "x", n: "<img src=x onerror=alert(1)>" }, "");
  const html = m.inviteCardsHtml(evil, { sender: '"><script>', now: NOW });
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
  assert.equal(m.inviteCardsHtml("velta://ws?u=wss%3A%2F%2Fp.example.org&t=garbage"), "");
  assert.equal(m.inviteCardsHtml('https://relay.example/i/AbCdEfGh12"onmouseover="x'), "");
  assert.equal(m.inviteCardsHtml("velta://ws?" + "a".repeat(5000)), "");
});

test("markdown: invite URLs become token-free chips, malformed stay text", () => {
  const out = renderMarkdown(`Hi ${RELAY} and ${proxyLink()}`);
  assert.match(out, /Relay invite: relay\.example/);
  assert.match(out, /Proxy invite: proxy\.example\.org/);
  assert.doesNotMatch(out, /AbCdEfGh12345678xyz|eyJ2Ijox|<a href/);
  const bad = renderMarkdown("velta://ws?u=x&t=<b>");
  assert.match(bad, /velta:\/\/ws\?u=x&amp;t=&lt;b&gt;/);
  assert.doesNotMatch(bad, /<b>/);
  assert.match(renderMarkdown("see https://example.org/page"), /<a href="https:\/\/example.org\/page"/);
});

test("claim answers: credentials or clear errors", () => {
  assert.deepEqual(m.relayClaimResult(200, { email: "a@relay.example", password: "pw" }), { email: "a@relay.example", password: "pw" });
  assert.throws(() => m.relayClaimResult(200, { email: "x" }), /no account details/);
  assert.throws(() => m.relayClaimResult(409, { error: "used up" }), /already been used/);
  assert.throws(() => m.relayClaimResult(410, null), /expired/);
  assert.throws(() => m.relayClaimResult(403, null), /not valid/);
  assert.throws(() => m.relayClaimResult(503, null), /right now.*not used/);
  assert.throws(() => m.relayClaimResult(502, null), /error \(502\)/);
});

test("bindInviteCards dispatches only from card buttons", async () => {
  let listener;
  const root = { addEventListener: (_, fn) => { listener = fn; } };
  const calls = [];
  m.bindInviteCards({ join: a => calls.push(["join", a.relay.host, a.proxy]), copy: s => calls.push(["copy", s]), useProxy: l => calls.push(["use", l]) }, root);
  const card = { dataset: { ivcRelay: RELAY, ivcProxy: "velta://ws?u=x" } };
  const mk = act => ({ dataset: { ivcAct: act }, disabled: false, closest: s => (s === ".ivc" ? card : null) });
  const ev = target => ({ target: { closest: () => target }, preventDefault() {}, stopPropagation() {} });
  await listener(ev(mk("join")));
  await listener(ev(mk("copy")));
  await listener(ev({ ...mk("use"), disabled: true }));
  await listener({ target: { closest: () => null } });
  assert.deepEqual(calls, [["join", "relay.example", "velta://ws?u=x"], ["copy", `${RELAY}\nvelta://ws?u=x`]]);
});

test("link previews never fetch relay invite URLs", async () => {
  const src = await import("node:fs").then(fs => fs.readFileSync(new URL("../app/js/link-preview.js", import.meta.url), "utf8"));
  assert.match(src, /parseRelayInviteLink\(url\)\) return null/);
});
