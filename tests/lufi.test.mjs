import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const store = {};
globalThis.localStorage = {
  getItem(k) { return Object.hasOwn(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; },
};
const L = await import("../app/js/lufi.js");
const sjcl = (await import("../app/vendor/sjcl.mjs")).default;

// Minimal in-memory Lufi /upload + /download, same checks as Controller/Files.pm.
function mockServer({ failAt = -1 } = {}) {
  const files = new Map();
  let n = 0;
  const frames = [];
  return {
    files, frames,
    transport: {
      async send(text) {
        frames.push(text);
        const [json, payload] = text.split("XXMOJOXX");
        const meta = JSON.parse(json);
        if (meta.cancel) { files.delete(meta.id); return JSON.stringify({ action: "cancel", success: true, i: meta.i }); }
        if (meta.part === failAt) return JSON.stringify({ success: false, msg: "<b>No space left</b>" });
        let short = meta.id;
        if (meta.part === 0) { short = `S${++n}x`; files.set(short, { meta, parts: [], token: `tok${n}` }); }
        const f = files.get(short);
        assert.ok(f, "slice for unknown id");
        f.parts[meta.part] = payload;
        return JSON.stringify({ success: true, i: meta.i, j: meta.part, parts: meta.total, short, token: f.token,
          name: meta.name, size: meta.size, delay: Math.min(meta.delay, 15), created_at: 1_800_000_000, duration: 0 });
      },
      closed: 0,
      async close() { this.closed++; },
    },
  };
}
const reader = (bytes) => async (j) => Buffer.from(bytes.subarray(j * L.LUFI_SLICE, (j + 1) * L.LUFI_SLICE)).toString("base64");

test("vendored SJCL is byte-identical to the copy Lufi serves", () => {
  const src = readFileSync(new URL("../app/vendor/sjcl.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf('"use strict";var sjcl='), src.lastIndexOf("export default sjcl;"));
  assert.equal(createHash("sha256").update(body).digest("hex"),
    "d09a8688f37c7442bb1e6699b46efb191d9281ef05a492586fa0f54dc4e5110a");
});

test("multi-slice upload decrypts the way lufi-down.js does", async () => {
  const bytes = randomBytes(L.LUFI_SLICE * 2 + 123);
  const srv = mockServer();
  const seen = [];
  const res = await L.lufiUpload({ server: "https://lufi.example", file: { name: "a b.bin", size: bytes.length, type: "" },
    readSlice: reader(bytes), transport: srv.transport, delay: 30, onProgress: (p) => seen.push(p.phase) });
  assert.equal(srv.frames.length, 3);
  assert.equal(srv.transport.closed, 1);
  const f = srv.files.get(res.short);
  // lufi-down.js: JSON.parse(payload) -> sjcl.decrypt(key, string) -> base64.
  const key = new URL(res.url).hash.slice(1);
  const out = Buffer.concat(f.parts.map(p => Buffer.from(sjcl.decrypt(key, JSON.parse(p)), "base64")));
  assert.ok(out.equals(bytes));
  // SJCL defaults the download page expects; one salt per file, fresh IVs.
  const objs = f.parts.map(p => JSON.parse(JSON.parse(p)));
  for (const o of objs) assert.deepEqual([o.mode, o.ks, o.ts, o.iter, o.v, o.cipher], ["ccm", 128, 64, 10000, 1, "aes"]);
  assert.equal(new Set(objs.map(o => o.salt)).size, 1);
  assert.equal(new Set(objs.map(o => o.iv)).size, 3);
  // Slices 2..n reference the id from the first reply; meta matches lufi-up.js.
  const metas = srv.frames.map(t => JSON.parse(t.split("XXMOJOXX")[0]));
  assert.deepEqual(metas.map(m => m.id), [null, res.short, res.short]);
  assert.deepEqual(Object.keys(metas[0]).sort(), ["del_at_first_view", "delay", "i", "id", "name", "part", "size", "total", "type", "zipped"]);
  // server clamps delay -> the reply wins
  assert.equal(res.delay, 15);
  assert.equal(res.expiresAt, 1_800_000_000 + 15 * 86400);
  assert.equal(res.url, `https://lufi.example/r/${res.short}#${key}`);
  assert.equal(res.deleteUrl, `https://lufi.example/d/${res.short}/${f.token}`);
  assert.equal(key.length, 44);
  assert.ok(seen.includes("encrypt") && seen.includes("sent"));
});

test("an empty file is one slice", async () => {
  assert.equal(L.partCount(0), 1);
  assert.equal(L.partCount(L.LUFI_SLICE), 1);
  assert.equal(L.partCount(L.LUFI_SLICE + 1), 2);
  const srv = mockServer();
  const res = await L.lufiUpload({ server: "https://x.example", file: { name: "e", size: 0 }, readSlice: async () => "", transport: srv.transport, delay: 1 });
  assert.equal(srv.frames.length, 1);
  assert.ok(res.short);
});

test("cancel tells the server to drop the partial file, then throws", async () => {
  const bytes = randomBytes(L.LUFI_SLICE * 3);
  const srv = mockServer();
  const ctrl = new AbortController();
  await assert.rejects(L.lufiUpload({ server: "https://x.example", file: { name: "c", size: bytes.length }, readSlice: reader(bytes),
    transport: srv.transport, delay: 1, signal: ctrl.signal,
    onProgress: (p) => { if (p.phase === "sent" && p.part === 1) ctrl.abort(); } }), (e) => e instanceof L.LufiCancelled);
  const last = JSON.parse(srv.frames.at(-1).split("XXMOJOXX")[0]);
  assert.equal(last.cancel, true);
  assert.equal(srv.files.size, 0);
  assert.equal(srv.transport.closed, 1);
});

test("a server refusal surfaces its message without markup", async () => {
  const bytes = randomBytes(L.LUFI_SLICE + 5);
  const srv = mockServer({ failAt: 1 });
  await assert.rejects(L.lufiUpload({ server: "https://x.example", file: { name: "f", size: bytes.length }, readSlice: reader(bytes), transport: srv.transport, delay: 1 }),
    /^Error: No space left$/);
  assert.equal(srv.transport.closed, 1);
});

test("garbage replies and unsafe ids are errors", async () => {
  const t = (reply) => ({ send: async () => reply, close() {} });
  const run = (reply) => L.lufiUpload({ server: "https://x.example", file: { name: "f", size: 1 }, readSlice: async () => "QQ==", transport: t(reply), delay: 1 });
  await assert.rejects(run("<html>"), /Unexpected reply/);
  await assert.rejects(run(JSON.stringify({ success: true, short: "../x" })), /no file id/);
});

test("expiry choices respect max_delay and delay_for_size (disroot config)", () => {
  const disroot = { default_delay: 30, delay_for_size: { 0: 90, 100000000: 15, 1000000000: 2 }, max_delay: 90 };
  assert.deepEqual(L.lufiDelayChoices(disroot, 5000), { choices: [1, 7, 30, 90], dflt: 30, max: 90 });
  assert.deepEqual(L.lufiDelayChoices(disroot, 2e8), { choices: [1, 7, 15], dflt: 15, max: 15 });
  assert.deepEqual(L.lufiDelayChoices(disroot, 1.5e9), { choices: [1, 2], dflt: 2, max: 2 });
  // max_delay 0 = unlimited: "Never" is offered
  const open = L.lufiDelayChoices({ max_delay: 0, default_delay: 7 }, 10);
  assert.ok(open.choices.includes(0));
  assert.equal(open.dflt, 7);
  assert.equal(L.lufiDelayLabel(0), "Never");
  assert.equal(L.lufiDelayLabel(365), "1 year");
});

test("server setting: https only, normalized, default when unset", () => {
  assert.equal(L.lufiServer(), "https://upload.disroot.org");
  assert.equal(L.setLufiServer("lufi.example/sub/"), "https://lufi.example/sub");
  assert.equal(L.lufiServer(), "https://lufi.example/sub");
  assert.throws(() => L.normalizeLufiServer("http://lufi.example"), /https/);
  assert.throws(() => L.normalizeLufiServer("https://u:p@lufi.example"), /credentials/);
  L.setLufiServer("https://upload.disroot.org/");
  assert.equal(localStorage.getItem("velta-lufi-server"), null);
  assert.equal(L.lufiWsUrl("https://lufi.example/sub"), "wss://lufi.example/sub/upload");
});

test("message text carries name, size, link with #key, and parses back", () => {
  const url = "https://upload.disroot.org/r/Aez0HdTo#FiillVkyEccx1Jhg3LFV9atnkkDcSj+Nk0ZEKa6d7uw=";
  const text = L.lufiMessageText({ name: "movie.mkv", size: 1234, url, expiresAt: 1_800_000_000 }, (n) => `${n} B`, () => "D");
  assert.match(text, /movie\.mkv \(1234 B\)/);
  assert.ok(text.includes(url));
  assert.match(text, /Available until D/);
  assert.deepEqual(L.parseLufiLink(text), { server: "https://upload.disroot.org", short: "Aez0HdTo", key: "FiillVkyEccx1Jhg3LFV9atnkkDcSj+Nk0ZEKa6d7uw=" });
  assert.equal(L.parseLufiLink("https://example.org/r/x"), null);
});

test("deletion tokens are kept per account+message on this device only", () => {
  L.rememberLufiUpload(3, 41, { server: "https://s", short: "ab", token: "tk", url: "u", deleteUrl: "https://s/d/ab/tk", name: "n", size: 9, expiresAt: 5 });
  assert.equal(L.lufiUploadFor(3, 41).token, "tk");
  assert.equal(L.lufiUploadFor(4, 41), null);
  L.markLufiDeleted(3, 41);
  assert.equal(L.lufiUploadFor(3, 41).deleted, true);
});

test("chat-view offers Large file in the attach menu and message info", () => {
  const src = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(src, /label: "Large file"/);
  assert.match(src, /largeFileInfoHtml\(lufiUploadFor\(this\.core\.accountId, m\.id\)\)/);
  const lf = readFileSync(new URL("../app/js/large-file.js", import.meta.url), "utf8");
  // fail closed: proxy comes from shellProxy (throws when unknown), passed to every network command
  assert.match(lf, /await shellProxy\(\)/);
  for (const cmd of ["lufi_config", "lufi_ws_open", "lufi_delete"]) assert.match(lf, new RegExp(`"${cmd}", \\{[^}]*proxy`));
  const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const cmd of ["lufi_open_file", "lufi_read_slice", "lufi_close_file", "lufi_config", "lufi_ws_open", "lufi_ws_send", "lufi_ws_close", "lufi_delete"]) {
    assert.ok(lib.includes(`lufi::${cmd}`), `${cmd} registered`);
  }
  const rs = readFileSync(new URL("../velta-app/src-tauri/src/lufi.rs", import.meta.url), "utf8");
  assert.match(rs, /crate::link_preview_proxy\(proxy\)/);
});
