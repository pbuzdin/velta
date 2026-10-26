import test from "node:test";
import assert from "node:assert/strict";

const { extractTunnelLink, describeTunnel, tunnelReport, acceptTunnelLink, tunnelInstalled, refreshTunnelStatus, privateDnsWarning, pathLines, tunnelEventRows, initTunnelDiagnostics, pathsSummary, interceptionWarning } = await import("../app/js/tunnel.js");
const { classifyScannedCode } = await import("../app/js/qr-actions.js");

const LINK = `velta://tunnel?v=1&zone=t.example.org&key=${Buffer.alloc(32, 7).toString("base64url")}`;

test("only velta://tunnel links are tunnel links", () => {
  assert.equal(extractTunnelLink(`  ${LINK} `), LINK);
  assert.equal(extractTunnelLink("VELTA://tunnel?zone=x"), "VELTA://tunnel?zone=x");
  assert.equal(extractTunnelLink("velta://chat?chat=1&t=x"), null);
  assert.equal(extractTunnelLink("velta://tunnelx?zone=x"), null);
  assert.equal(extractTunnelLink("https://example.org/velta://tunnel"), null);
  assert.equal(extractTunnelLink(null), null);
});

test("a scanned tunnel QR is routed to the deep-link handler", () => {
  const deps = { parseInviteLink: () => null, isShortInviteLink: () => false };
  assert.equal(classifyScannedCode(LINK, deps), "tunnel");
});

test("status lines", () => {
  assert.equal(describeTunnel({ installed: false }).headline, "Not set up");
  assert.equal(describeTunnel({ installed: true, available: false, error: "no lib" }).headline, "Not running");
  assert.equal(describeTunnel({ installed: true, available: true, running: true, mode: "off", route: "direct" }).headline, "Off");
  assert.equal(describeTunnel({ installed: true, available: true, running: true, mode: "auto", route: "tunnel", state: "blocked" }).headline, "Through the tunnel");
  assert.match(describeTunnel({ installed: true, available: true, running: true, mode: "always", route: "tunnel" }).detail, /Always/);
  assert.equal(describeTunnel({ installed: true, available: true, running: true, mode: "auto", route: "direct", state: "offline" }).headline, "No network");
  assert.equal(describeTunnel({ installed: true, available: true, running: true, mode: "auto", route: "direct", state: "direct" }).headline, "Direct");
  assert.match(describeTunnel({ installed: true, available: true, running: true, mode: "auto", route: "direct", state: "relays-down" }).detail, /down/);
});

test("report carries routing state and events only", () => {
  const text = tunnelReport({
    zone: "t.example.org", resolvers: 21, soar: "v0.1", mode: "auto", route: "tunnel", state: "blocked",
    last_result: { relays: 2, relay_ok: 0, canary_ok: true }, relays: ["relay.example.org"],
    active: { direct: 0, tunnel: 2 }, stats: { tunnel: { conns: 5, fails: 1, up: 2048, down: 4096 } },
    events: [{ t: "2026-10-11T10:00:00Z", msg: "route direct -> tunnel (blocked)" }],
  }, { app: "1.4.65", now: new Date("2026-10-11T10:05:00Z") });
  assert.match(text, /relays ok 0\/2 {2}canary ok: true/);
  assert.doesNotMatch(text, /via tunnel/);
  assert.match(tunnelReport({ last_result: { relays: 1, relay_ok: 0, canary_ok: true, tunnel_checked: true, tunnel_ok: false }, events: [] }),
    /relays ok 0\/1 {2}canary ok: true {2}via tunnel ok: false/);
  assert.match(text, /tunnel: active 2, conns 5, fails 1, up 2 KB, down 4 KB/);
  assert.match(text, /route direct -> tunnel \(blocked\)/);
  assert.doesNotMatch(text, /pass|user/i);
});

function fakeShell(calls, { status = { installed: true, available: true, running: true } } = {}) {
  return async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "tunnel_preview") return { zone: "t.example.org", resolvers: 21 };
    if (cmd === "tunnel_status") return status;
    return null;
  };
}

test("a declined link changes nothing", async () => {
  const calls = [];
  let asked = "";
  const ok = await acceptTunnelLink(LINK, {
    invoke: fakeShell(calls),
    confirmModal: async (title, text) => { asked = text; return false; },
    toast() {}, errToast() {},
  });
  assert.equal(ok, false);
  assert.match(asked, /t\.example\.org/);
  assert.deepEqual(calls.map(c => c[0]), ["tunnel_status", "tunnel_preview"]);
});

test("an accepted link installs, refreshes and notifies", async () => {
  const calls = [];
  let changed = false;
  await refreshTunnelStatus(0, async () => ({ installed: false }));
  assert.equal(tunnelInstalled(), false);
  const ok = await acceptTunnelLink(LINK, {
    invoke: fakeShell(calls),
    confirmModal: async () => true,
    toast() {}, errToast() {},
    onChange: () => { changed = true; },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls.map(c => c[0]), ["tunnel_status", "tunnel_preview", "tunnel_install", "tunnel_status"]);
  assert.deepEqual(calls[2][1], { link: LINK });
  assert.equal(tunnelInstalled(), true);
  assert.equal(changed, true);
});

test("a rejected link never reaches the confirmation", async () => {
  let asked = false, err = "";
  const ok = await acceptTunnelLink(LINK, {
    invoke: async (cmd) => { if (cmd === "tunnel_status") return { installed: false }; throw new Error("key must be 32 bytes"); },
    confirmModal: async () => { asked = true; return true; },
    toast() {}, errToast: (m) => { err = m; },
  });
  assert.equal(ok, false);
  assert.equal(asked, false);
  assert.match(err, /32 bytes/);
});

test("Private DNS warning and network lines", () => {
  assert.equal(privateDnsWarning({ network: { private_dns: false } }), "");
  assert.match(privateDnsWarning({ network: { private_dns: true, private_dns_name: "x.dns.example" } }), /Private DNS is on \(x\.dns\.example\)/);
  const text = tunnelReport({ network: { transport: "cellular", sim_operator: "25001", operator_name: "MTS RUS", private_dns: false },
    network_resolvers: ["10.0.0.1:53"], events: [] });
  assert.match(text, /network: cellular {2}operator: 25001 MTS RUS {2}private dns: off/);
  assert.match(text, /network resolvers: 10\.0\.0\.1:53/);
});

test("path table: working paths first, durations in ms", () => {
  const lines = pathLines([
    { resolver: "77.88.8.8:853", transport: "dot", verified: false, successes: 0, loss: 1, name_len: 253, answer_limit: 0 },
    { resolver: "8.8.8.8:53", transport: "udp", verified: true, successes: 40, rtt: 62e6, loss: 0.15, name_len: 253, answer_limit: 1232 },
    { resolver: "77.88.8.1:53", transport: "udp", verified: true, successes: 3, rtt: 110e6, suspended: true, name_len: 253, answer_limit: 512 },
  ]);
  assert.equal(lines[0], "paths: 2/3 verified");
  assert.match(lines[1], /^ {2}8\.8\.8\.8:53 udp ok rtt=62ms loss=0\.15 answers=40 name=253 ans=1232$/);
  assert.match(lines[2], /77\.88\.8\.1:53 udp suspended rtt=110ms/);
  assert.match(lines[3], /77\.88\.8\.8:853 dot unverified rtt=- loss=1\.00 answers=0 name=253 ans=-$/);
  assert.deepEqual(pathLines(undefined), ["paths: none (tunnel not started)"]);
});

test("router and shell events merge in time order with levels", () => {
  const rows = tunnelEventRows({
    events: [
      { t: "2026-10-11T19:44:43.525831015Z", msg: "route direct -> tunnel (mode always)" },
      { t: "2026-10-11T19:45:00Z", msg: "state direct -> blocked (relays 0/1 ok, canary ok=true)" },
    ],
    shell_events: [{ t_ms: Date.parse("2026-10-11T19:44:50Z"), level: "info", msg: "proxy set for account 1; restarting its IO" }],
  });
  assert.deepEqual(rows.map(r => r.level + " " + r.msg.split(" ").slice(0, 3).join(" ")), [
    "info route direct ->",
    "info proxy set for",
    "warning state direct ->",
  ]);
});

test("diagnostics mirror appends only new events, across polls and UI reloads", async () => {
  const store = {};
  globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
  let status = { installed: true, events: [{ t: "2026-10-11T10:00:00Z", msg: "started" }], shell_events: [] };
  const invoke = async () => status;
  const lines = [];
  const append = (level, text) => lines.push(`${level}:${text}`);
  const a = initTunnelDiagnostics({ append, invoke, listen: null, intervalMs: 1e9 });
  await a.ready; a.stop();
  status = { installed: true, events: [...status.events, { t: "2026-10-11T10:00:05Z", msg: "direct dial x failed" }], shell_events: [] };
  const b = initTunnelDiagnostics({ append, invoke, listen: null, intervalMs: 1e9 }); // a UI reload
  await b.ready; b.stop();
  assert.deepEqual(lines, ["info:DNS tunnel: started", "warning:DNS tunnel: direct dial x failed"]);
});

test("sheet path summary: idle on the direct route, progress on the tunnel", () => {
  const paths = [{ verified: true }, { verified: false }, { verified: true }];
  assert.equal(pathsSummary({ route: "direct", paths }), "3 resolver paths ready · tunnel idle, mail goes direct");
  assert.equal(pathsSummary({ route: "tunnel", paths, session: false }), "2 of 3 resolver paths working · connecting…");
  assert.equal(pathsSummary({ route: "tunnel", paths, session: true }), "2 of 3 resolver paths working · session up");
  assert.equal(pathsSummary({ resolvers: 5 }), "5 resolvers");
});

test("DNS interception shows in the report and the sheet", () => {
  assert.equal(interceptionWarning({ dns_intercepted: false }), "");
  assert.match(interceptionWarning({ dns_intercepted: true, dns_egress: "114.114.114.114" }), /intercepts DNS \(answered via 114\.114\.114\.114\)/);
  assert.match(tunnelReport({ dns_intercepted: true, dns_egress: "37.252.230.153", events: [] }), /dns interception: yes, answered via 37\.252\.230\.153/);
  assert.match(tunnelReport({ dns_intercepted: false, events: [] }), /dns interception: no/);
});
