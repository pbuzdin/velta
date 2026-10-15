import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { tauriInvoke, invoke, isTauri, isAndroid, rustLog } from "../app/js/tauri.js";

test("tauri.js resolves the shell lazily", async () => {
  const saved = { window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  try {
    globalThis.window = {};
    assert.equal(tauriInvoke(), null);
    assert.equal(isTauri(), false);
    await assert.rejects(invoke("x"));
    rustLog("no shell: must not throw");
    const calls = [];
    globalThis.window = { __TAURI__: { core: { invoke: async (c, a) => { calls.push([c, a]); return 7; } } } };
    assert.equal(isTauri(), true);
    assert.equal(await invoke("cmd", { a: 1 }), 7);
    rustLog("hi");
    assert.deepEqual(calls, [["cmd", { a: 1 }], ["js_log", { msg: "hi" }]]);
    globalThis.window = { __TAURI__: { invoke: async () => "v1" } };
    assert.equal(await tauriInvoke()("x"), "v1");
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Linux; android 14)" }, configurable: true });
    assert.equal(isAndroid(), true);
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (X11; Linux)" }, configurable: true });
    assert.equal(isAndroid(), false);
  } finally {
    globalThis.window = saved.window;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
  }
});

test("no module open-codes the invoke lookup, rustLog or a case-sensitive Android check", () => {
  const dir = new URL("../app/js/", import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith(".js") && f !== "tauri.js")) {
    const js = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(js, /__TAURI__\??\.core\?\.invoke \|\| (window\.)?__TAURI__\??\.invoke/, f);
    assert.doesNotMatch(js, /function rustLog\(/, f);
    assert.doesNotMatch(js, /\/Android\/\.test\(/, f);
  }
});
