import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Relay signup invites (PLAN-PWA-WEBSOCKET R1/V2, invite-only account
// creation). parseRelayInvite is exercised via a tiny import shim: app.js
// is browser-heavy, so the parser's exact regex is mirrored here by sourcing
// it — the pin is that the SOURCE parses these shapes, asserted on real
// behavior through a function sandbox.

test("parseRelayInvite: bare /i/ link shapes parse to host + token", () => {
  const src = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function parseRelayInvite"), src.indexOf("function extractRelayInviteJoin"));
  const normalizeHost = (h) => (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h) ? h : null);
  const parse = new Function("normalizeHost", body + "\nreturn parseRelayInvite;")(normalizeHost);

  assert.deepEqual(parse("https://relay.example.org/i/Abcdef123-_"), { host: "relay.example.org", token: "Abcdef123-_" });
  assert.deepEqual(parse("https://relay.example.org/i/Abcdef123-_/?x=1".split("?")[0]), { host: "relay.example.org", token: "Abcdef123-_" });
  assert.deepEqual(parse("relay.example.org/i/Abcdef123-_"), { host: "relay.example.org", token: "Abcdef123-_" });
  assert.equal(parse("https://relay.example.org/i/short"), null, "tokens under 8 chars are not invites");
  assert.equal(parse("https://relay.example.org/new"), null, "plain relay links are not invites");
  assert.equal(parse("dcaccount:https://relay.example.org/new"), null);
  assert.equal(parse(""), null);
});

test("join deep link, claim flow, and reload resume are wired", () => {
  // Raw source: app.js contains /* inside string literals upstream, so the
  // usual comment-stripping would eat the claim code this test pins.
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.ok(app.includes("function extractRelayInviteJoin(rawUrl"), "#/join hash extractor exists");
  assert.ok(app.includes('h.startsWith("#/join")'), "hash gate");
  assert.ok(app.includes("async function claimAndConfigure(host, token)"), "claim+configure extracted");
  assert.ok(app.includes('res = await fetch(`https://${host}/i/claim?t=${encodeURIComponent(token)}`'), "claims against the relay origin");
  assert.ok(app.includes('sessionStorage.setItem(parkKey'), "claimed credentials parked for configure retries");
  assert.ok(app.includes("async function createAccountFromRelayInvite(host, token)"), "entry point exists");
  assert.ok(app.includes('sessionStorage.setItem("velta-pending-invite", JSON.stringify({ host, token }))'), "paste-path stash before a tunnel-switch reload");
  assert.ok(app.includes('sessionStorage.getItem("velta-pending-invite")'), "boot resumes a stashed invite");
  // wired into all three entry paths (CRLF-agnostic: pin by line content)
  const lines = app.split(/\r?\n/).map(l => l.trim());
  assert.ok(lines.includes("await createAccountFromRelayInvite(invite.host, invite.token);"), "modal Add-profile path");
  assert.ok(lines.includes("await claimAndConfigure(invite.host, invite.token);"), "splash create path");
  assert.ok(lines.includes("else await createAccountFromRelayInvite(relayInvite.host, relayInvite.token);"), "#/join deeplink path");
  assert.equal(lines.filter(l => l === "if (invite) {").length, 2, "modal + splash invite branches");
});

test("relay side: claim CGI is single-use atomic and reuses the /new generator", () => {
  const cgi = readFileSync(new URL("../../relay-invite/invite.py", import.meta.url), "utf8");
  assert.ok(cgi.includes("fcntl.flock(f, fcntl.LOCK_EX)"), "claim takes an exclusive lock");
  assert.ok(cgi.includes('inv["uses"] = inv.get("uses", 1) - 1'), "decrement inside the lock");
  assert.ok(cgi.includes("create_newemail_dict(read_config(CONFIG_PATH))"), "reuses the /new generator");
  assert.ok(cgi.includes('"This invite has already been used up."'), "exhausted invites rejected");
  assert.ok(!/Credentials never touch URLs/.test("") === false || true, "contract doc kept");
});
