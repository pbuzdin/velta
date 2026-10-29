// Invite link domain pills (invite-domains.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import fr from "../app/locales/fr.json" with { type: "json" };
import ru from "../app/locales/ru.json" with { type: "json" };

const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { get() {}, define() {} };
globalThis.window ??= { addEventListener() {} };
const D = await import("../app/js/invite-domains.js");
const { encodeQr } = await import("../app/js/qr-encode.js");

const LINK = "https://i.delta.chat/#A1B2C3D4E5F60718293A4B5C6D7E8F9012345678&v=3&x=grp&i=inv&s=auth&a=pavel%40example.org&n=Pavel&g=Chat+RU%21";

test("rewrite: velta.cc takes the /join/? form, mirrors keep the fragment; payload byte-identical", () => {
  const out = D.rewriteInviteHost(LINK, "i.gluek.info");
  assert.ok(out.startsWith("https://i.gluek.info/#"));
  assert.equal(out.slice(out.indexOf("#")), LINK.slice(LINK.indexOf("#")));
  assert.equal(D.rewriteInviteHost(LINK, "i.delta.chat"), LINK);
  const v = D.rewriteInviteHost(LINK, "velta.cc");
  assert.ok(v.startsWith("https://velta.cc/join/?"));
  assert.equal(v.slice("https://velta.cc/join/?".length), LINK.slice(LINK.indexOf("#") + 1));
  assert.equal(D.rewriteInviteHost("OPENPGP4FPR:AB#x", "i.gluek.info"), "OPENPGP4FPR:AB#x", "non-core forms untouched");
});

test("domains: velta.cc first; tabs hidden with one domain", () => {
  assert.deepEqual(D.inviteDomains(["i.deltachat.id", "i.delta.chat", "x.example.org"]), ["velta.cc", "i.deltachat.id", "i.delta.chat", "x.example.org"]);
  assert.equal(D.domainTabsHtml(["i.delta.chat"], "i.delta.chat"), "");
  const html = D.domainTabsHtml(["velta.cc", "i.delta.chat"], "i.delta.chat");
  assert.match(html, /role="tablist" aria-label="Invite link domain"/);
  assert.match(html, /data-domain="i.delta.chat" aria-selected="true" tabindex="0"/);
  assert.match(html, /data-domain="velta.cc" aria-selected="false" tabindex="-1"/);
  assert.ok(ru["Invite link domain"] && fr["Invite link domain"]);
});

test("remembered domain falls back to velta.cc when it was removed", () => {
  D.rememberDomain("x.example.org");
  assert.equal(D.chosenDomain(["i.delta.chat", "x.example.org"]), "x.example.org");
  assert.equal(D.chosenDomain(["i.delta.chat", "i.gluek.info"]), "velta.cc");
  D.rememberDomain("velta.cc");
  assert.equal(mem.get(D.DOMAIN_KEY), undefined);
});

test("velta.cc/join/? links parse like the fragment form; canonical stays i.delta.chat", async () => {
  const I = await import("../app/js/invites.js");
  const p = I.parseInviteLink(D.rewriteInviteHost(LINK, "velta.cc"));
  assert.ok(p, "query form parses");
  assert.equal(p.fingerprint, "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678");
  assert.equal(p.params.n, "Pavel");
  assert.equal(p.link, LINK);
  assert.equal(I.parseInviteLink("https://velta.cc/join/?invite=" + encodeURIComponent(LINK)).link, LINK, "urlencoded invite= form");
  assert.equal(I.parseInviteLink("https://velta.cc/join/#" + LINK.slice(LINK.indexOf("#") + 1)).link, LINK, "hash form still parses");
  assert.equal(I.getInviteHosts()[0], "velta.cc");
  assert.equal(I.parseInviteLink("https://velta.cc/other/?n=x"), null, "query without a fingerprint is not an invite");
});

test("mirror QR: plain 512 QR with Velta logo, ECC >= M, decodes to the rewritten link", async () => {
  const link = D.rewriteInviteHost(LINK, "i.deltachat.id");
  const svg = D.brandedQrSvg(link);
  assert.match(svg, /viewBox="0 0 512 512"/);
  assert.match(svg, /data-velta-logo/);
  assert.ok(["M", "Q", "H"].includes(encodeQr(link).ecl));
  // Decode: rasterise the module path ourselves, blank the logo disc, jsQR.
  let jsQR;
  try { jsQR = createRequire("/workspace/drawer-icons/")("jsqr"); } catch { return; } // decoder optional (dev box)
  const qr = encodeQr(link), N = 512, px = new Uint8ClampedArray(N * N * 4).fill(255), sc = 416 / qr.size;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const mx = Math.floor((x - 48) / sc), my = Math.floor((y - 48) / sc);
    let dark = x >= 48 && y >= 48 && qr.get(mx, my);
    if ((x - 256) ** 2 + (y - 256) ** 2 <= 56 * 56) dark = (x - 256) ** 2 + (y - 256) ** 2 <= 48 * 48; // white ring + dark disc
    if (dark) { const i = (y * N + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
  }
  assert.equal(jsQR(px, N, N)?.data, link);
});

test("wired into Invite to Velta / group invite and Your QR code", () => {
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  for (const s of [ui, app]) {
    assert.ok(s.includes("<div data-domain-tabs></div>"));
    assert.match(s, /mountInviteDomains\(\w+\.querySelector\("\[data-domain-tabs\]"\), \{ svg, link \}/);
  }
  assert.match(ui, /if \(account && qr && isDefault\)/, "self badge only over the core card");
});
