import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNetWatch } from "../app/js/net-watch.js";

// VPN toggle bug: IO was stopped on `offline` and only `online` could resume.
function harness(opts) {
  const calls = [];
  let t = 0, online = true, timers = [];
  const core = {
    async setNetworkIo(on) { calls.push(on ? "resume" : "pause"); return true; },
    async nudgeNetwork() { calls.push("nudge"); return true; },
  };
  const w = createNetWatch({
    core, isOnline: () => online, now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: h => { timers = timers.filter(x => x !== h); },
    opts,
  });
  const advance = async ms => {
    t += ms;
    for (const h of timers.filter(h => h.at <= t)) { timers = timers.filter(x => x !== h); h.fn(); }
    await w.idle();
  };
  return { w, calls, advance, set: v => { online = v; } };
}

test("brief loss (VPN switch) never stops IO, only nudges", async () => {
  const h = harness();
  h.set(false); h.w.onOffline(); await h.w.idle();
  await h.advance(3000);
  h.set(true); await h.w.onSignal("online");
  await h.advance(20000);
  assert.ok(!h.calls.includes("pause"));
  assert.equal(h.w.paused, false);
});

test("sustained loss pauses; foreground signal resumes without an online event", async () => {
  const h = harness();
  h.set(false); h.w.onOffline(); await h.advance(11000);
  assert.equal(h.w.paused, true);
  h.set(true); await h.w.onSignal("visible");
  assert.equal(h.w.paused, false);
  assert.deepEqual(h.calls.filter(c => c !== "nudge"), ["pause", "resume"]);
});

test("missed online event: periodic tick resumes", async () => {
  const h = harness();
  h.set(false); h.w.onOffline(); await h.advance(11000);
  h.set(true); // no event fired
  await h.w.tick();
  assert.equal(h.w.paused, false);
});

test("navigator.onLine stuck false: tick resumes after the ceiling", async () => {
  const h = harness();
  h.set(false); h.w.onOffline(); await h.advance(11000);
  await h.advance(60000); await h.w.tick();
  assert.equal(h.w.paused, true);
  await h.advance(70000); await h.w.tick();
  assert.equal(h.w.paused, false);
});

test("signal while running just nudges maybe_network", async () => {
  const h = harness();
  await h.w.onSignal("connection");
  assert.deepEqual(h.calls, ["nudge"]);
});

test("app.js no longer wires offline straight to stop_io; native emits velta-network", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.ok(!app.includes('addEventListener("offline", () => core?.setNetworkIo?.(false))'));
  assert.ok(app.includes("createNetWatch"));
  const rs = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.ok(rs.includes('"velta-network"'));
});

test("pauseIo:false (Android) never stops IO on a long loss, only nudges", async () => {
  const h = harness({ pauseIo: false });
  h.set(false); h.w.onOffline(); await h.advance(60000);
  await h.w.tick(); await h.advance(200000);
  assert.ok(!h.calls.includes("pause"), h.calls.join(","));
  assert.equal(h.w.paused, false);
  assert.ok(h.calls.includes("nudge"));
});

test("app.js disables the IO pause on Android", () => {
  const src = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  assert.ok(src.includes("opts: { pauseIo: !isAndroid() }"));
});
