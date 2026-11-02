import test from "node:test";
import assert from "node:assert/strict";

const { parseProxyLink, buildProxyLink, buildProxyLinkV1, normalizeProxyHost, base32Encode, base32Decode, extractProxyLink, acceptProxyLink, proxyConfirmText, openProxyShare, PROXY_LINK_MAX } = await import("../app/js/proxy.js");
const { encodeQr } = await import("../app/js/qr-encode.js");

const base = (extra = "") => `velta://proxy?v=1&h=proxy.example.org&p=1080${extra}`;
const b32 = s => base32Encode(new TextEncoder().encode(s));

test("parses a minimal and a full link", () => {
  assert.deepEqual(parseProxyLink(base()), { version: 1, host: "proxy.example.org", port: 1080, user: "", pass: "", label: "" });
  const full = parseProxyLink(base("&u=me&w=p%40ss%3Aword&n=Office%20VPN"));
  assert.equal(full.user, "me");
  assert.equal(full.pass, "p@ss:word");
  assert.equal(full.label, "Office VPN");
});

test("v is optional (defaults to 1), host is normalized, + is a space", () => {
  assert.equal(parseProxyLink("velta://proxy?h=Proxy.Example.ORG.&p=1080").host, "proxy.example.org");
  assert.equal(parseProxyLink("VELTA://PROXY/?h=proxy.example.org&p=1080").port, 1080);
  assert.equal(parseProxyLink(base("&n=My+proxy")).label, "My proxy");
});

test("hosts: public names, LAN names, IPv4, IPv6", () => {
  assert.equal(parseProxyLink("velta://proxy?h=192.168.1.10&p=9050").host, "192.168.1.10");
  assert.equal(parseProxyLink("velta://proxy?h=%5B2001:db8::1%5D&p=1080").host, "2001:db8::1");
  assert.equal(parseProxyLink("velta://proxy?h=raspi&p=1080").host, "raspi");
  assert.equal(parseProxyLink("velta://proxy?h=my-proxy.lan&p=1080").host, "my-proxy.lan");
});

test("rejects malformed links", () => {
  const cases = [
    ["", /Empty/],
    ["velta://chat?chat=1", /Not a velta:\/\/proxy/],
    ["https://example.org/?h=x", /Not a velta/],
    ["velta://proxy", /address is not valid/],
    ["velta://proxy?h=proxy.example.org", /port is not valid/],
    ["velta://proxy?h=proxy.example.org&p=0", /port is not valid/],
    ["velta://proxy?h=proxy.example.org&p=70000", /port is not valid/],
    ["velta://proxy?h=proxy.example.org&p=1080x", /port is not valid/],
    ["velta://proxy?h=10.0.0.999&p=1080", /address is not valid/],
    ["velta://proxy?h=-bad-.org&p=1080", /address is not valid/],
    ["velta://proxy?h=bad_host&p=1080", /address is not valid/],
    ["velta://proxy?h=proxy.example.org&p=1080&x=1", /Unknown parameter: x/],
    ["velta://proxy?h=a.org&h=b.org&p=1080", /Repeated parameter: h/],
    ["velta://proxy?v=9&h=a.org&p=1080", /Unsupported link version 9/],
    ["velta://proxy?h=a.org&p=1080&w=secret", /password without a username/],
    ["velta://proxy?h=a.org&p=1080&u=me&n=bad\u202Elabel", /invalid characters/],
    ["velta://proxy?h=a.org&p=1080&n=" + "x".repeat(65), /label is too long/],
    [`velta://proxy?h=a.org&p=1080&u=${"u".repeat(129)}`, /too long/],
    ["velta://proxy?" + "h=a.org&p=1080&n=" + "x".repeat(PROXY_LINK_MAX), /too long/],
  ];
  for (const [link, re] of cases) assert.throws(() => parseProxyLink(link), re, link);
});

test("base32: RFC 4648 vectors, strict decode", () => {
  const vectors = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
  for (const [ascii, enc] of vectors) {
    assert.equal(b32(ascii), enc);
    assert.equal(new TextDecoder().decode(base32Decode(enc)), ascii);
  }
  assert.equal(base32Decode("mzxw6ytboi") !== null, true, "lowercase accepted");
  assert.equal(base32Decode("M"), null, "impossible length");
  assert.equal(base32Decode("MZXW6YTB!"), null, "bad alphabet");
  assert.equal(base32Decode("MZ"), null, "non-zero trailing bits");
});

test("v2 round trip: creds and a non-ASCII label survive", () => {
  const cfg = { host: "proxy.example.org", port: 1080, user: "me", pass: "p@ss:word", label: "Офис ✓" };
  const link = buildProxyLink(cfg);
  assert.match(link, /^velta:\/\/proxy\/2\/PROXY\.EXAMPLE\.ORG\/1080\/U\//);
  assert.deepEqual(parseProxyLink(link), { version: 2, ...cfg });
  // Order-independent: label only, password implies username upstream.
  assert.deepEqual(parseProxyLink(buildProxyLink({ host: "192.168.1.10", port: 9050, label: "Home" })),
    { version: 2, host: "192.168.1.10", port: 9050, user: "", pass: "", label: "Home" });
});

test("v2 stays in the QR alphanumeric set after the scheme", () => {
  const ALNUM = /^[0-9A-Z $%*+\-./:]*$/;
  const cfg = { host: "proxy.example.org", port: 1080, user: "me", pass: "p@ss:word", label: "Офис ✓" };
  const link = buildProxyLink(cfg);
  assert.match(link, /^velta:\/\/proxy\//);
  assert.ok(ALNUM.test(link.slice("velta://proxy/".length)), link);
  // Scheme and host stay lowercase for the Android intent-filter.
  assert.match(link, /^velta:\/\/proxy\/2\//);
});

test("v2 QR is smaller than v1", () => {
  const cfg = { host: "proxy.example.org", port: 1080, user: "me", pass: "p@ss:word", label: "Office" };
  const v1 = encodeQr(buildProxyLinkV1(cfg), { optimal: false });
  const v2 = encodeQr(buildProxyLink(cfg));
  assert.ok(v2.version < v1.version, `v2 ${v2.version} vs v1 ${v1.version}`);
  assert.deepEqual(v2.segments.map(s => s.mode), ["byte", "alnum"]);
});

test("build and parse agree on v1 too", () => {
  const cfg = { host: "proxy.example.org", port: 1080, user: "me", pass: "p@ss", label: "Office" };
  assert.deepEqual(parseProxyLink(buildProxyLinkV1(cfg)), { version: 1, ...cfg });
});

test("extractProxyLink only takes velta://proxy links", () => {
  assert.equal(extractProxyLink("  velta://proxy?h=a.org&p=1080 \n"), "velta://proxy?h=a.org&p=1080");
  assert.equal(extractProxyLink("velta://proxy/2/A.ORG/1080"), "velta://proxy/2/A.ORG/1080");
  assert.equal(extractProxyLink("velta://tunnel?zone=x"), null);
  assert.equal(extractProxyLink("https://example.org/velta://proxy"), null);
});

test("confirm text: server, creds warning, trust warning, current proxy", () => {
  const parsed = parseProxyLink(base("&u=me&w=x&n=Office"));
  const text = proxyConfirmText(parsed, { current: "Home" });
  assert.match(text, /Name: Office/);
  assert.match(text, /Proxy server: proxy\.example\.org:1080/);
  assert.match(text, /includes the proxy's username and password/);
  assert.match(text, /switches from the proxy in use \(Home\)/);
  assert.match(text, /Only accept proxy links from someone you trust/);
  const plain = proxyConfirmText(parseProxyLink(base()));
  assert.ok(!/username and password/.test(plain));
  assert.ok(!/switches from/.test(plain));
});

test("accept: bad link and browser app never reach the shell", async () => {
  const errs = [];
  const calls = [];
  const invoke = async (...a) => { calls.push(a); return null; };
  assert.equal(await acceptProxyLink("velta://proxy?h=a.org", { toast() {}, errToast: e => errs.push(e), invoke }), false);
  assert.match(errs[0], /can't be used: The port is not valid/);
  assert.deepEqual(calls, []);
  const toasts = [];
  assert.equal(await acceptProxyLink(base(), { toast: m => toasts.push(m), errToast: e => errs.push(e), invoke: null }), false);
  assert.match(toasts[0], /not in the browser app/);
});

test("accept: v2 reaches the shell as structured install args", async () => {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "proxy_status") return { installed: false, available: true };
    if (cmd === "proxy_list") return { active: null, proxies: [] };
    return null;
  };
  const cfg = { host: "proxy.example.org", port: 1080, user: "me", pass: "p@ss", label: "Office" };
  assert.equal(await acceptProxyLink(buildProxyLink(cfg), { confirmModal: async () => true, toast() {}, errToast: e => assert.fail(e), invoke }), true);
  const install = calls.find(c => c[0] === "proxy_install")[1];
  assert.deepEqual(install, { host: "proxy.example.org", port: 1080, user: "me", password: "p@ss", label: "Office", activate: true });
});

test("share: QR text is the v2 link and warns about included credentials", async () => {
  const els = {};
  const mkEl = () => ({ addEventListener() {}, textContent: "", innerHTML: "", isConnected: true });
  globalThis.document = { createElement: () => ({ set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; }, querySelector: sel => (els[sel] ||= mkEl()) }) };
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "proxy_link") return { host: "proxy.example.org", port: 1080, user: "me", pass: "p@ss", label: "Office" };
    return null;
  };
  let qrText = ""; let shown;
  const r = await openProxyShare({ showModal: m => { shown = m; return { close() {} }; }, toast() {}, errToast: e => assert.fail(e), renderQr: text => { qrText = text; return "<svg></svg>"; }, id: "p1", invoke });
  assert.deepEqual(calls.find(c => c[0] === "proxy_link")[1], { id: "p1" });
  assert.match(r.link, /\/N\/J5TGM2LDMU$/); // base32("Office")
  assert.equal(qrText, r.link);
  assert.deepEqual(parseProxyLink(r.link), { version: 2, host: "proxy.example.org", port: 1080, user: "me", pass: "p@ss", label: "Office" });
  assert.equal(shown.title, "Share proxy link");
  assert.match(shown.body.html, /Share it only with people you trust/);
  assert.match(shown.body.html, /includes the proxy&#39;s username and password/);
  delete globalThis.document;
});
