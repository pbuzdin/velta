// Scheduled messages ("Send later"): storage ops, presets across time
// zones / DST, no double send, catch-up, list rendering. docs/scheduled-messages.md
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyOp, emptyDoc, dueItems, nextWake, itemsFor, presetTime, toLocalInput, fromLocalInput,
  localStore, ScheduledRunner, STALE_SENDING_MS, isUncertainError, backoffMs,
} from "../app/js/scheduled.js";

const src = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");

function withTZ(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
}

function memStorage() {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

const add = (doc, extra = {}, now = 1000) => applyOp(doc, { op: "add", item: { accountId: 1, chatId: 7, text: "hi", dueAt: 5000, ...extra } }, now);

test("add validates and stores the documented fields", () => {
  const { doc, result } = add(emptyDoc(), { quoteId: 42 });
  assert.ok(result.id);
  const it = doc.items[0];
  assert.deepEqual(
    { accountId: it.accountId, chatId: it.chatId, text: it.text, quoteId: it.quoteId, dueAt: it.dueAt, createdAt: it.createdAt, status: it.status },
    { accountId: 1, chatId: 7, text: "hi", quoteId: 42, dueAt: 5000, createdAt: 1000, status: "pending" });
  assert.equal(add(emptyDoc(), { text: "   " }).result.error, "empty or too long");
  assert.equal(add(emptyDoc(), { dueAt: NaN }).result.error, "bad item");
  assert.equal(add(emptyDoc(), { chatId: null }).result.error, "bad item");
});

test("applyOp never mutates its input", () => {
  const d0 = emptyDoc();
  const { doc } = add(d0);
  assert.equal(d0.items.length, 0);
  const before = JSON.stringify(doc);
  applyOp(doc, { op: "remove", id: doc.items[0].id });
  assert.equal(JSON.stringify(doc), before);
});

test("update / remove refuse an item that is being sent", () => {
  let { doc, result: { id } } = add(emptyDoc());
  ({ doc } = applyOp(doc, { op: "claim", id }, 6000));
  assert.equal(applyOp(doc, { op: "update", id, text: "x" }).result, false);
  assert.equal(applyOp(doc, { op: "remove", id }).result, false);
  assert.equal(applyOp(doc, { op: "claim", id }).result, false, "second claim loses");
  ({ doc } = applyOp(doc, { op: "done", id }));
  assert.equal(doc.items.length, 0);
});

test("failure: error state, backoff, retried on wake, uncertain never auto-retried", () => {
  let { doc, result: { id } } = add(emptyDoc());
  ({ doc } = applyOp(doc, { op: "claim", id }, 5000));
  ({ doc } = applyOp(doc, { op: "fail", id, error: "offline" }, 5000));
  assert.equal(doc.items[0].status, "error");
  assert.equal(dueItems(doc, 5001).length, 0, "backoff respected by the timer");
  assert.equal(dueItems(doc, 5001, { wake: true }).length, 1, "app open / alarm retries");
  assert.equal(nextWake(doc), 5000 + backoffMs(1));
  ({ doc } = applyOp(doc, { op: "claim", id }, 6000));
  ({ doc } = applyOp(doc, { op: "fail", id, error: "rpc timed out", uncertain: true }, 6000));
  assert.equal(dueItems(doc, 1e15, { wake: true }).length, 0);
  assert.equal(nextWake(doc), null);
  assert.equal(applyOp(doc, { op: "claim", id }).result, false);
  // Explicit user action (Send now = update dueAt) clears it.
  ({ doc } = applyOp(doc, { op: "update", id, dueAt: 7000 }));
  assert.equal(dueItems(doc, 7000).length, 1);
});

test("recover turns stale 'sending' into an uncertain error, keeps fresh claims", () => {
  let { doc, result: { id } } = add(emptyDoc());
  ({ doc } = applyOp(doc, { op: "claim", id }, 10_000));
  assert.equal(applyOp(doc, { op: "recover" }, 10_000 + STALE_SENDING_MS - 1).result, 0);
  const r = applyOp(doc, { op: "recover" }, 10_000 + STALE_SENDING_MS);
  assert.equal(r.result, 1);
  assert.equal(r.doc.items[0].uncertain, true);
});

test("isUncertainError separates core refusals from lost requests", () => {
  assert.ok(isUncertainError(new Error("rpc response timed out (180s)")));
  assert.ok(!isUncertainError(new Error("chat 7 not found")));
});

test("dueItems / nextWake / itemsFor ordering and filtering", () => {
  let doc = emptyDoc();
  doc = add(doc, { dueAt: 300 }).doc;
  doc = add(doc, { dueAt: 100, chatId: 8 }).doc;
  doc = add(doc, { dueAt: 200, accountId: 2 }).doc;
  assert.deepEqual(dueItems(doc, 250).map(i => i.dueAt), [100, 200]);
  assert.equal(nextWake(doc), 100);
  assert.deepEqual(itemsFor(doc, 1).map(i => i.dueAt), [100, 300]);
  assert.deepEqual(itemsFor(doc, 1, 7).map(i => i.dueAt), [300]);
  assert.equal(itemsFor(doc, null).length, 3);
});

test("presets in the local zone: Moscow (no DST)", () => withTZ("Europe/Moscow", () => {
  const now = new Date(2026, 9, 26, 6, 30).getTime(); // Mon 06:30 MSK
  assert.equal(presetTime("hour", now), now + 3_600_000);
  assert.equal(new Date(presetTime("tonight", now)).getHours(), 20);
  const tm = new Date(presetTime("tomorrow", now));
  assert.deepEqual([tm.getDate(), tm.getHours()], [27, 9]);
  const mon = new Date(presetTime("monday", now));
  assert.deepEqual([mon.getDay(), mon.getDate(), mon.getHours()], [1, 2, 9], "Monday → NEXT Monday");
  assert.equal(presetTime("tonight", new Date(2026, 9, 26, 20, 30).getTime()), null, "past 20:00 → hidden");
  assert.equal(presetTime("nope", now), null);
}));

test("presets across a DST change keep wall-clock 09:00 (Berlin, New York)", () => {
  withTZ("Europe/Berlin", () => {
    // Sat 24 Oct 2026 12:00 CEST; clocks go back Sun 25 Oct 03:00 → 02:00.
    const now = new Date(2026, 9, 24, 12, 0).getTime();
    const mon = presetTime("monday", now);
    assert.equal(new Date(mon).getHours(), 9);
    assert.equal(new Date(mon).getDate(), 26);
    // Sat 12:00 → Mon 09:00 is 45h on the wall clock, 46h of real time.
    assert.equal(mon - now, (45 + 1) * 3_600_000, "45h wall-clock + the repeated hour");
    // Tomorrow from the day of the change.
    const sun = new Date(2026, 9, 25, 1, 30).getTime();
    assert.equal(new Date(presetTime("tomorrow", sun)).getHours(), 9);
  });
  withTZ("America/New_York", () => {
    // Sat 7 Mar 2026 22:00 EST; spring forward Sun 8 Mar 02:00 → 03:00.
    const now = new Date(2026, 2, 7, 22, 0).getTime();
    const tm = presetTime("tomorrow", now);
    assert.equal(new Date(tm).getHours(), 9);
    assert.equal(tm - now, 10 * 3_600_000, "11h wall-clock minus the skipped hour");
  });
});

test("datetime-local round trip in several zones; garbage is rejected", () => {
  for (const tz of ["UTC", "Europe/Moscow", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Chatham"]) {
    withTZ(tz, () => {
      const ms = fromLocalInput("2026-12-31T23:45");
      assert.equal(toLocalInput(ms), "2026-12-31T23:45", tz);
      const d = new Date(ms);
      assert.deepEqual([d.getHours(), d.getMinutes()], [23, 45]);
    });
  }
  withTZ("UTC", () => assert.equal(fromLocalInput("2026-10-26T06:30"), Date.UTC(2026, 9, 26, 6, 30)));
  assert.equal(fromLocalInput(""), null);
  assert.equal(fromLocalInput("2026-02-31T10:00"), null);
  assert.equal(fromLocalInput("tomorrow"), null);
});

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
}

test("runner: catch-up at start sends overdue once and removes it; future armed", async () => {
  let now = 10_000;
  const store = localStore(memStorage(), "k", () => now);
  await store.op({ op: "add", item: { accountId: 1, chatId: 7, text: "late", dueAt: 5_000 } });
  await store.op({ op: "add", item: { accountId: 1, chatId: 7, text: "later", dueAt: 70_000 } });
  const sent = [];
  const tm = fakeTimers();
  const r = new ScheduledRunner({ store, clock: () => now, timers: tm, send: async it => { sent.push(it.text); return { id: 1 }; } });
  await r.start();
  assert.deepEqual(sent, ["late"]);
  assert.equal(r.doc.items.length, 1);
  assert.equal(tm.timers.at(-1).ms, 60_000, "timer to the next due item");
  now = 70_000;
  await r.run(false);
  assert.deepEqual(sent, ["late", "later"]);
  assert.equal(r.doc.items.length, 0);
});

test("runner: concurrent runs and two runners on one store never double-send", async () => {
  const now = 10_000;
  const storage = memStorage();
  const store = localStore(storage, "k", () => now);
  await store.op({ op: "add", item: { accountId: 1, chatId: 7, text: "once", dueAt: 1 } });
  let sends = 0;
  const slowSend = async () => { sends++; await new Promise(r => setTimeout(r, 5)); return {}; };
  const a = new ScheduledRunner({ store, clock: () => now, timers: fakeTimers(), send: slowSend });
  const b = new ScheduledRunner({ store: localStore(storage, "k", () => now), clock: () => now, timers: fakeTimers(), send: slowSend });
  await Promise.all([a.run(true), a.run(true), b.run(true), a.run(false)]);
  await a.run(true);
  assert.equal(sends, 1);
});

test("runner: failure keeps the item with error, retried on next wake", async () => {
  let now = 10_000;
  const store = localStore(memStorage(), "k", () => now);
  await store.op({ op: "add", item: { accountId: 1, chatId: 7, text: "x", dueAt: 1 } });
  let fail = true;
  const r = new ScheduledRunner({ store, clock: () => now, timers: fakeTimers(), send: async () => { if (fail) throw new Error("no network"); return {}; } });
  await r.run(true);
  assert.equal(r.doc.items[0].status, "error");
  assert.equal(r.doc.items[0].error, "no network");
  fail = false;
  await r.run(false); // inside backoff: no retry from the periodic tick
  assert.equal(r.doc.items.length, 1);
  await r.run(true); // app resumed
  assert.equal(r.doc.items.length, 0);
});

test("runner: a timeout is uncertain and is not retried automatically", async () => {
  const now = 10_000;
  const store = localStore(memStorage(), "k", () => now);
  await store.op({ op: "add", item: { accountId: 1, chatId: 7, text: "x", dueAt: 1 } });
  let sends = 0;
  const r = new ScheduledRunner({ store, clock: () => now, timers: fakeTimers(), send: async () => { sends++; throw new Error("rpc response timed out (180s)"); } });
  await r.run(true);
  await r.run(true);
  assert.equal(sends, 1);
  assert.equal(r.doc.items[0].uncertain, true);
});

test("runner: send goes through the normal sendMessage with the item's account", () => {
  const app = src("app/js/app.js");
  assert.match(app, /core\.sendMessage\(it\.chatId, \{ text: it\.text, quoteId: it\.quoteId, accountId: it\.accountId \}\)/);
  const rpc = src("app/js/rpc-core.js");
  assert.match(rpc, /accountId: forAccount = null/);
  assert.match(rpc, /this\._call\("send_msg", accountId, chatId, data\)/);
});

test("runner: Android hands sending to the shell (nativeRun) and never sends itself", async () => {
  const store = localStore(memStorage(), "k", () => 10_000);
  await store.op({ op: "add", item: { accountId: 1, chatId: 7, text: "x", dueAt: 1 } });
  const calls = [];
  const r = new ScheduledRunner({ store, timers: fakeTimers(), send: () => { throw new Error("must not send"); }, nativeRun: async w => calls.push(w) });
  await r.run(true);
  assert.deepEqual(calls, [true]);
  assert.equal(r.doc.items.length, 1);
});

test("Rust send_params mirror rpc-core's text send", () => {
  const rs = src("velta-app/src-tauri/src/scheduled_store.rs");
  assert.match(rs, /"quotedMessageId": q, "quoted_message_id": q/);
});

test("Android: exact alarm permission and receiver wiring", () => {
  const m = src("velta-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml");
  assert.match(m, /android\.permission\.SCHEDULE_EXACT_ALARM/);
  assert.doesNotMatch(m, /<uses-permission android:name="android\.permission\.USE_EXACT_ALARM"/);
  for (const a of ["BOOT_COMPLETED", "MY_PACKAGE_REPLACED", "TIME_SET", "TIMEZONE_CHANGED"]) assert.match(m, new RegExp(`intent\\.action\\.${a}`));
  assert.match(m, /\.ScheduledAlarmReceiver/);
  const kt = src("velta-app/src-tauri/gen/android/app/src/main/java/org/velta/ScheduledAlarm.kt");
  assert.match(kt, /setExactAndAllowWhileIdle/);
  assert.match(kt, /setAndAllowWhileIdle/);
  assert.match(kt, /canScheduleExactAlarms\(\)/);
  assert.match(kt, /ACTION_REQUEST_SCHEDULE_EXACT_ALARM/);
  const lib = src("velta-app/src-tauri/src/lib.rs");
  assert.match(lib, /\("ScheduledAlarm", &APP_SCHEDULED_CLASS\)/);
  assert.match(lib, /scheduled::scheduled_op/);
});

test("list UI renders rows, status and actions (escaped)", async () => {
  const { installChatViewGlobals, installFakeDocument } = await import("./helpers/fake-dom.mjs");
  installChatViewGlobals();
  installFakeDocument();
  const { renderScheduledList } = await import("../app/js/scheduled-ui.js");
  const root = { innerHTML: "" };
  renderScheduledList(root, [], {});
  assert.match(root.innerHTML, /No scheduled messages/);
  let doc = add(emptyDoc(), { text: "<b>hi</b>" }).doc;
  const id = doc.items[0].id;
  doc = applyOp(doc, { op: "claim", id }, 1).doc;
  doc = applyOp(doc, { op: "fail", id, error: "offline" }, 1).doc;
  renderScheduledList(root, doc.items, { chatName: () => "Alice" });
  assert.match(root.innerHTML, /&lt;b&gt;hi&lt;\/b&gt;/);
  assert.match(root.innerHTML, /sched-row-err/);
  assert.match(root.innerHTML, /Failed, will retry: offline/);
  assert.match(root.innerHTML, /Alice/);
  for (const act of ["now", "time", "text", "del"]) assert.match(root.innerHTML, new RegExp(`data-act="${act}"`));
});

test("composer wiring: right-click/long-press, shortcut, menu item, chip", () => {
  const cv = src("app/js/chat-view.js");
  assert.match(cv, /send\.addEventListener\("contextmenu"/);
  assert.match(cv, /e\.key === "Enter" && e\.shiftKey && \(e\.ctrlKey \|\| e\.metaKey\)/);
  assert.match(cv, /label: "Send later", icon: ICO\.clock/);
  assert.match(cv, /renderScheduledChip\(\)/);
  assert.match(src("app/js/ui.js"), /data-act="scheduled"/);
});
