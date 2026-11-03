// #240 core watchdog: pure state machine + driver wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { step, initialState, WATCHDOG as W, PING_METHOD, startCoreWatchdog } from "../app/js/core-watchdog.js";
import { JsonRpcCore } from "../app/js/rpc-core.js";

const idle = { transfer: false, call: false };
function run(inputs, s = initialState(0)) {
  const actions = [];
  for (const i of inputs) { const r = step(s, i); s = r.state; actions.push(...r.actions); }
  return { s, actions, logs: actions.filter(a => a.type === "log").map(a => a.msg) };
}
const tick = (now, extra = {}) => ({ type: "tick", now, pingPendingMs: null, oldest: null, busy: idle, ...extra });

test("thresholds are the documented constants", () => {
  assert.equal(W.PING_EVERY_MS, 5000);
  assert.equal(W.PING_STALL_MS, 8000);
  assert.equal(W.RPC_STALL_MS, 10000);
  assert.equal(W.HUNG_RESTART_MS, 60000);
  assert.deepEqual(W.BACKOFF_MS, [1000, 5000, 30000]);
  assert.equal(W.MAX_RESTARTS, 3);
  assert.equal(W.RESTART_WINDOW_MS, 600000);
  assert.equal(PING_METHOD, "get_system_info");
});

test("healthy stays healthy under the thresholds", () => {
  const { s, actions } = run([tick(5000, { pingPendingMs: 7000, oldest: { method: "get_config", ms: 9000 } })]);
  assert.equal(s.status, "healthy");
  assert.deepEqual(actions, []);
});

test("healthy -> stalled (slow ping) -> recovered, logged with oldest method", () => {
  const { s, actions, logs } = run([
    tick(10000, { pingPendingMs: 8000, oldest: { method: "get_chatlist_items_by_entries", ms: 9500 } }),
    { type: "pong", now: 14000 },
  ]);
  assert.equal(s.status, "healthy");
  assert.deepEqual(actions.filter(a => a.type !== "log").map(a => a.type), ["show", "hide"]);
  assert.match(logs[0], /core unresponsive \(ping 8s, oldest: get_chatlist_items_by_entries 9\.5s\)/);
  assert.match(logs[1], /recovered after 13\.5s/); // dated from stall start (14000 - (10000 - 9500))
});

test("an old in-flight RPC alone marks the core stalled", () => {
  const { s } = run([tick(20000, { oldest: { method: "get_config", ms: 10000 } })]);
  assert.equal(s.status, "stalled");
});

test("a healthy ping does not recover while another RPC remains stuck", () => {
  let r = run([
    tick(10000, { oldest: { method: "get_config", ms: 10000 } }),
    { type: "pong", now: 12000, oldest: { method: "get_config", ms: 12000 } },
  ]);
  assert.equal(r.s.status, "stalled");
  assert.ok(!r.actions.some(a => a.type === "hide"));
  assert.ok(!r.logs.some(l => /recovered/.test(l)));
  r = run([{ type: "pong", now: 15000, oldest: null }], r.s);
  assert.equal(r.s.status, "healthy");
  assert.ok(r.actions.some(a => a.type === "hide"));
});

test("hung core is not killed early; auto-restart only after HUNG_RESTART_MS", () => {
  const o = { method: "get_chatlist_items_by_entries", ms: 10000 };
  let r = run([tick(10000, { oldest: o }), tick(30000, { oldest: { ...o, ms: 30000 } })]);
  assert.equal(r.s.status, "stalled");
  assert.ok(!r.actions.some(a => a.type === "restart"));
  r = run([tick(60000, { oldest: { ...o, ms: 60000 } })], r.s);
  assert.deepEqual(r.actions.find(a => a.type === "restart"), { type: "restart", kind: "hung", auto: true });
  assert.match(r.logs[0], /hung 60s — auto-restart \(oldest: get_chatlist_items_by_entries 60s\)/);
  r = run([{ type: "restarted", now: 61000, ok: true }], r.s);
  assert.equal(r.s.status, "healthy");
  assert.ok(r.actions.some(a => a.type === "hide"));
});

test("dead -> restart with backoff 1s, 5s, 30s, then cap -> persistent failure", () => {
  let r = run([{ type: "dead", now: 0, reason: "worker error" }]);
  assert.equal(r.s.status, "dead");
  assert.equal(r.s.nextRestartAt, 1000);
  r = run([tick(500)], r.s);
  assert.ok(!r.actions.some(a => a.type === "restart"), "waits for the backoff");
  r = run([tick(1000)], r.s);
  assert.deepEqual(r.actions.find(a => a.type === "restart"), { type: "restart", kind: "dead", auto: true });
  // restart did not help: failure counts as another death -> 5 s backoff
  r = run([{ type: "restarted", now: 1100, ok: false, error: "boom" }], r.s);
  assert.equal(r.s.status, "dead");
  assert.equal(r.s.nextRestartAt, 6100);
  r = run([tick(6100), { type: "restarted", now: 6200, ok: true }, { type: "dead", now: 7000 }], r.s);
  assert.equal(r.s.nextRestartAt, 37000);
  r = run([tick(37000), { type: "restarted", now: 37100, ok: true }, { type: "dead", now: 40000, reason: "again" }], r.s);
  assert.equal(r.s.status, "failed");
  assert.deepEqual(r.actions.find(a => a.type === "show"), { type: "show", status: "failed" });
  assert.ok(r.logs.some(l => /restart cap reached \(3 in 10 min\)/.test(l)));
  r = run([tick(100000)], r.s);
  assert.ok(!r.actions.some(a => a.type === "restart"), "failed is persistent");
});

test("cap window slides: old restarts stop counting after 10 min", () => {
  const s = { ...initialState(0), restarts: [0, 1, 2] };
  const r = run([{ type: "dead", now: W.RESTART_WINDOW_MS + 5 }], s);
  assert.equal(r.s.status, "dead");
});

test("auto-restart suppressed during a backup/transfer or a call (logged once)", () => {
  for (const busy of [{ transfer: true, call: false }, { transfer: false, call: true }]) {
    let r = run([tick(0, { oldest: { method: "get_config", ms: 10000 } }), tick(60000, { busy }), tick(65000, { busy })]);
    assert.equal(r.s.status, "stalled");
    assert.ok(!r.actions.some(a => a.type === "restart"));
    assert.equal(r.logs.filter(l => /auto-restart suppressed/.test(l)).length, 1);
    r = run([tick(70000)], r.s); // transfer/call over
    assert.ok(r.actions.some(a => a.type === "restart"));
    let d = run([{ type: "dead", now: 0 }, tick(2000, { busy })]);
    assert.ok(!d.actions.some(a => a.type === "restart"));
    assert.ok(d.logs.some(l => /suppressed/.test(l)));
  }
});

test("manual restart works from any state, including failed", () => {
  let r = run([{ type: "dead", now: 0 }], { ...initialState(0), restarts: [0, 0, 0] });
  assert.equal(r.s.status, "failed");
  r = run([{ type: "manual", now: 1 }], r.s);
  assert.deepEqual(r.actions.find(a => a.type === "restart"), { type: "restart", kind: "manual", auto: false });
});

test("resume grace: no stall right after returning to the foreground", () => {
  const r = run([{ type: "resume", now: 0 }, tick(3000, { oldest: { method: "get_config", ms: 40000 } })]);
  assert.equal(r.s.status, "healthy");
});

test("driver: pings get_system_info, shows/hides banner, logs oldest in-flight", async () => {
  let off = 0;
  const transport = { sent: [], setReceiver(fn) { this.receive = fn; }, send(l) { this.sent.push(JSON.parse(l)); } };
  const core = new JsonRpcCore(transport);
  transport.setReceiver(core._onLine);
  core._rpcLog = () => {};
  const ui = [], logs = [];
  const wd = startCoreWatchdog({ core, isBusy: () => idle, restart: async () => true,
    onShow: s => ui.push("show:" + s), onHide: () => ui.push("hide"), log: m => logs.push(m),
    doc: null, setIntervalFn: () => 0, now: () => Date.now() + off, W: { ...W, PING_TIMEOUT_MS: 200 } });
  core._callWithTimeout(200, "get_chatlist_items_by_entries", 1, [1]).catch(() => {});
  wd.tick();
  assert.equal(transport.sent.at(-1).method, "get_system_info");
  off = 12000; wd.tick();
  assert.deepEqual(ui, ["show:stalled"]);
  assert.match(logs[0], /oldest: get_chatlist_items_by_entries 12s/);
  for (const req of transport.sent) transport.receive(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(ui, ["show:stalled", "hide"]);
});

test("a client-timed-out RPC stays visible to the watchdog until its late answer", async () => {
  const transport = { sent: [], setReceiver(fn) { this.receive = fn; }, send(l) { this.sent.push(JSON.parse(l)); } };
  const core = new JsonRpcCore(transport);
  transport.setReceiver(core._onLine);
  core._rpcLog = () => {};
  const call = core._callWithTimeout(5, "get_config", 1, "configured_addr");
  await assert.rejects(call, /rpc timeout: get_config/);
  assert.equal(core.pending.size, 0);
  assert.equal(core.oldestInFlight().method, "get_config");
  const req = transport.sent[0];
  transport.receive(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }));
  assert.equal(core.oldestInFlight(), null);
});

test("reconnect forgets timed-out RPCs from the old connection", async () => {
  const transport = { reconnect: async () => true, setReceiver() {}, send() {} };
  const core = new JsonRpcCore(transport);
  core.accountId = 1;
  core._timedOut.set(99, { method: "get_config", started: Date.now() - 30000 });
  core._applyVeltaStrings = async () => {};
  core._call = async () => {};
  core._startIo = async () => {};
  core._invalidateChat = () => {};
  assert.equal(await core.reconnect(), true);
  assert.equal(core._timedOut.size, 0);
  assert.equal(core.oldestInFlight(), null);
});

test("app wires the banner, busy guards and the shared restart path", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(html, /id="core-banner"[^>]*role="status"/);
  assert.match(app, /coreWatchdog\.manual\(\)/);
  assert.match(app, /restart: async kind =>[\s\S]*restartCore\(kind\)/);
  assert.match(app, /imexRunning = p > 0 && p < 1000/);
  assert.match(app, /"accepting", "active"\]\.includes\(calls\.state\)/);
  for (const l of ["ru", "fr"]) {
    const d = JSON.parse(readFileSync(new URL(`../app/locales/${l}.json`, import.meta.url), "utf8"));
    for (const k of ["Core not responding", "Restart core", "Core stopped — restarting…", "Core stopped and could not be restarted"]) assert.ok(d[k], `${l}: ${k}`);
  }
});
