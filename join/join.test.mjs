// join.test.mjs — node join/join.test.mjs  (from the repo root)
import assert from "node:assert/strict";
import { parsePayload, qrText, shareUrl, label } from "./join.js";
import { qrSvg } from "./qr-encode.js";

const FP = "A".repeat(40);
const PAYLOAD = `${FP}&v=3&x=abc&s=tok&a=me%40example.org&n=Pavel`;

// raw query string form
let p = parsePayload(`?${PAYLOAD}`);
assert.equal(p.fp, FP);
assert.equal(p.rest, "v=3&x=abc&s=tok&a=me%40example.org&n=Pavel");

// ?invite= form — the DOM pass decodes the param (URLSearchParams.get), so
// this is what parsePayload receives:
p = parsePayload(PAYLOAD);
assert.equal(p.fp, FP);
assert.equal(p.params.n, "Pavel");
assert.equal(p.params.a, "me@example.org");

// full links pasted as the value: a delta.chat mirror and our own share URL
p = parsePayload(`https://i.delta.chat/#${FP}&v=3&n=Pavel`);
assert.equal(p.fp, FP);
assert.equal(p.rest, "v=3&n=Pavel");
p = parsePayload(`https://velta.cc/join/?${PAYLOAD}`);
assert.equal(p.fp, FP);
assert.equal(p.params.n, "Pavel");

// bare fingerprint link, no params
p = parsePayload(`https://i.delta.chat/#${FP}`);
assert.equal(p.fp, FP);
assert.equal(p.rest, "");

// OPENPGP4FPR QR text (fp#rest, rest keeps &), Safari %23 form
p = parsePayload(`OPENPGP4FPR:${FP}#v=3&g=Chat+RU`);
assert.equal(p.params.g, "Chat RU");
p = parsePayload(`openpgp4fpr:${FP}%23v=3&n=Pavel`);
assert.equal(p.fp, FP);

// lowercase fingerprint is normalized
assert.equal(parsePayload("b".repeat(40)).fp, "B".repeat(40));

// invalid: short fp, missing fp, empty
assert.equal(parsePayload(`${FP.slice(4)}&v=3`), null);
assert.equal(parsePayload("?v=3&n=Pavel"), null);
assert.equal(parsePayload(""), null);

// label: person / group / channel, name fallbacks
assert.deepEqual(label(parsePayload(`?${FP}&n=Pavel&a=a@b.c`)), { kind: "person", actor: "Pavel", group: null, addr: "a@b.c" });
assert.deepEqual(label(parsePayload(`?${FP}&a=a@b.c`)), { kind: "person", actor: "a", group: null, addr: "a@b.c" });
assert.deepEqual(label(parsePayload(`?${FP}&n=Pavel&g=Weekend Crew`)).group, "Weekend Crew");
assert.deepEqual(label(parsePayload(`?${FP}&n=Pavel&b=News`)), { kind: "channel", actor: "Pavel", group: "News", addr: "" });
assert.equal(label(parsePayload(`?${FP}`)).actor, "someone");

// round-trips
const parsed = parsePayload(`?${PAYLOAD}`);
assert.equal(qrText(parsed), `OPENPGP4FPR:${FP}#v=3&x=abc&s=tok&a=me%40example.org&n=Pavel`);
assert.equal(shareUrl("https://velta.cc", parsed), `https://velta.cc/join/?${PAYLOAD}`);
// the share URL parses back to the same invite
assert.deepEqual(parsePayload(shareUrl("https://velta.cc", parsed).split("/join/")[1]).fp, FP);

// QR encoder end-to-end on the real payload shape
const svg = qrSvg(qrText(parsed));
assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
assert.doesNotThrow(() => qrSvg(qrText(parsed)));

console.log("join tests: all green");
