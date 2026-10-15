import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { isValidXdc, prepareBuiltinXdc } = await import("../app/js/builtin-xdc.js");
const XDC = new Uint8Array(readFileSync(new URL("../app/builtin/send-direct.xdc", import.meta.url)));
const HTML = new TextEncoder().encode("<!doctype html><html><body>index fallback</body></html>");

test("#138 committed send-direct.xdc validates; html/empty/truncated do not", () => {
  assert.ok(isValidXdc(XDC));
  assert.equal(isValidXdc(new Uint8Array()), false);
  assert.equal(isValidXdc(HTML), false);
  assert.equal(isValidXdc(XDC.slice(0, XDC.length - 30)), false);
});

test("#138 Tauri path uses the bundled-bytes command, never fetch", async () => {
  const calls = [];
  const p = await prepareBuiltinXdc("send-direct", {
    invoke: async (cmd, args) => { calls.push([cmd, args]); return "/data/uploads/send-direct-1.xdc"; },
    fetchImpl: () => { throw new Error("fetch must not be used"); },
  });
  assert.equal(p, "/data/uploads/send-direct-1.xdc");
  assert.deepEqual(calls, [["prepare_builtin_xdc", { name: "send-direct" }]]);
  await assert.rejects(prepareBuiltinXdc("send-direct", { invoke: async () => "" }));
  await assert.rejects(prepareBuiltinXdc("send-direct", { invoke: async () => { throw new Error("x"); } }));
});

test("#138 PWA path refuses a 404 or non-zip body and never writes it", async () => {
  let wrote = 0;
  const writeFile = async () => { wrote++; return "/uploads/x.xdc"; };
  const base = "https://velta.example/";
  const res = (ok, body, status = 200) => async () => ({ ok, status, arrayBuffer: async () => body.buffer });
  await assert.rejects(prepareBuiltinXdc("send-direct", { fetchImpl: res(false, HTML, 404), baseURI: base, writeFile }), /404/);
  await assert.rejects(prepareBuiltinXdc("send-direct", { fetchImpl: res(true, HTML), baseURI: base, writeFile }), /damaged/);
  assert.equal(wrote, 0);
  assert.equal(await prepareBuiltinXdc("send-direct", { fetchImpl: res(true, XDC), baseURI: base, writeFile }), "/uploads/x.xdc");
  assert.equal(wrote, 1);
});

test("#138 chat-view sends send-direct only via prepareBuiltinXdc, and the shell bundles it", () => {
  const cv = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.ok(!/fetch\(new URL\("builtin\//.test(cv));
  const fn = cv.slice(cv.indexOf("async _sendDirectApp()"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));
  assert.ok(body.indexOf("prepareBuiltinXdc") >= 0 && body.indexOf("prepareBuiltinXdc") < body.indexOf("_sendArchivedAware"));
  const rs = readFileSync(new URL("../velta-app/src-tauri/src/builtin_xdc.rs", import.meta.url), "utf8");
  assert.match(rs, /include_bytes!\("\.\.\/\.\.\/\.\.\/app\/builtin\/send-direct\.xdc"\)/);
  const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /generate_handler!\[[^\]]*\bprepare_builtin_xdc\b/);
});
