import test from "node:test";
import assert from "node:assert/strict";
import { parseTunnelLink, buildTunnelLink, buildTunnelLinkV1, base32Encode, base32Decode, acceptTunnelLink } from "../app/js/tunnel.js";
import { encodeQr } from "../app/js/qr-encode.js";

const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 250));
const KEY_STD = KEY_BYTES.toString("base64");
const KEY_B32 = base32Encode(KEY_BYTES);
const ALNUM = /^[0-9A-Z $%*+\-./:]*$/;

test("base32: RFC 4648 vectors, strict decode", () => {
  const enc = s => base32Encode(new TextEncoder().encode(s));
  assert.deepEqual(["", "f", "fo", "foo", "foob", "fooba", "foobar"].map(enc), ["", "MY", "MZXQ", "MZXW6", "MZXW6YQ", "MZXW6YTB", "MZXW6YTBOI"]);
  assert.equal(new TextDecoder().decode(base32Decode("mzxw6ytboi")), "foobar");
  assert.equal(base32Decode("MZ"), null, "non-zero trailing bits");
  assert.equal(base32Decode("MZXW6YTBO"), null, "impossible length");
  assert.equal(base32Decode("MZ1"), null);
  assert.equal(KEY_B32.length, 52);
});

test("v2 link: everything after velta://tunnel/ is QR-alphanumeric and round-trips", () => {
  const cfg = { zone: "t.example.org", key: KEY_STD, resolvers: ["192.0.2.1:53", "198.51.100.7", "[2001:db8::1]:853", "2001:db8::53"], canaries: ["check.example.net:443"], label: "Офис ✓" };
  const link = buildTunnelLink(cfg);
  assert.equal(link.slice(0, 15), "velta://tunnel/");
  assert.match(link.slice(15), ALNUM);
  assert.equal(link, `velta://tunnel/2/T.EXAMPLE.ORG/${KEY_B32}/R/192.0.2.1*53+198.51.100.7+2001:DB8::1*853+2001:DB8::53/C/CHECK.EXAMPLE.NET*443/N/${base32Encode(new TextEncoder().encode("Офис ✓"))}`);
  assert.deepEqual(parseTunnelLink(link), { version: 2, ...cfg });
  // Lowercase / mixed case parses the same (scanners and people retype links).
  assert.deepEqual(parseTunnelLink(link.toLowerCase()), { version: 2, ...cfg });
  assert.deepEqual(parseTunnelLink(`velta://tunnel/2/T.EXAMPLE.ORG./${KEY_B32}`), { version: 2, zone: "t.example.org", key: KEY_STD, resolvers: [], canaries: [], label: "" });
});

test("v2 parsing is strict", () => {
  const ok = `velta://tunnel/2/T.EXAMPLE.ORG/${KEY_B32}`;
  for (const bad of [
    `velta://tunnel/3/T.EXAMPLE.ORG/${KEY_B32}`,
    `velta://tunnel/2/T.EXAMPLE.ORG/${KEY_B32.slice(0, 51)}`,
    `velta://tunnel/2/T.EXAMPLE.ORG/${KEY_B32.slice(0, 51)}B`, // trailing bits
    `velta://tunnel/2/EXAMPLE/${KEY_B32}`,
    `velta://tunnel/2/BAD_LABEL.EXAMPLE.ORG/${KEY_B32}`,
    `${ok}/`, `${ok}/R`, `${ok}/R/`, `${ok}/X/1`, `${ok}?v=1`, `${ok}#x`,
    `${ok}/R/1.2.3.4/R/5.6.7.8`, `${ok}/R/DNS.EXAMPLE.ORG*53`, `${ok}/R/1.2.3.4*0`, `${ok}/R/1.2.3.4:53`,
    `${ok}/C/CHECK.EXAMPLE.NET`, `${ok}/N/MZ`, `${ok}/N/7777777Q`, // invalid UTF-8
    `${ok}/N/${base32Encode(new TextEncoder().encode("a\u202eb"))}`,
    `velta://tunnel/2/T.EXAMPLE.ORG/${KEY_B32}/R/${Array(65).fill("192.0.2.1").map((x, i) => x.replace(/1$/, String(i + 1))).join("+")}`,
  ]) assert.throws(() => parseTunnelLink(bad), undefined, bad);
  assert.throws(() => parseTunnelLink(`velta://tunnel/3/X/Y`), /update Velta/);
});

test("v1 links keep working", () => {
  const v1 = `velta://tunnel?v=1&zone=t.example.org&key=${KEY_BYTES.toString("base64url")}&n=Office`;
  assert.deepEqual(parseTunnelLink(v1), { version: 1, zone: "t.example.org", key: KEY_STD, resolvers: [], canaries: [], label: "Office" });
  assert.equal(buildTunnelLinkV1(parseTunnelLink(v1)), v1);
});

test("a v2 link reaches the shell as v1 (any Go library build parses it)", async () => {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "tunnel_status") return { installed: false, available: true };
    if (cmd === "tunnel_preview") return { zone: "t.example.org", resolvers: 21 };
    return null;
  };
  const cfg = { zone: "t.example.org", key: KEY_STD, resolvers: ["192.0.2.1:53"], canaries: [], label: "Office" };
  assert.equal(await acceptTunnelLink(buildTunnelLink(cfg), { confirmModal: async () => true, toast() {}, errToast: e => assert.fail(e), invoke }), true);
  const install = calls.find(c => c[0] === "tunnel_install")[1];
  assert.equal(install.link, buildTunnelLinkV1(cfg));
  assert.equal(install.label, "Office");
  assert.equal(calls.find(c => c[0] === "tunnel_preview")[1].link, buildTunnelLinkV1(cfg));
});

test("v2 QR is smaller than v1", () => {
  const cfg = { zone: "t.example.org", key: KEY_STD, resolvers: ["192.0.2.1:53"], canaries: [], label: "Office" };
  const v1 = encodeQr(buildTunnelLinkV1(cfg), { optimal: false });
  const v2 = encodeQr(buildTunnelLink(cfg));
  assert.ok(v2.version < v1.version, `v2 ${v2.version} vs v1 ${v1.version}`);
  assert.deepEqual(v2.segments.map(s => s.mode), ["byte", "alnum"]);
});
