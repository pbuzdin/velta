import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #106: PWA reload could lose the session. Two worker-side holes:
//   1. restore() silently skipped when OPFS was unavailable → empty core
//      looked like a fresh install → JsonRpcCore.init() add_account()ed a
//      stray account, and the interval checkpoint rewrote the good OPFS
//      snapshot over it. Boot now fails loudly — no RPC is answered until
//      the snapshot is confirmed restored.
//   2. checkpoint() ran removeEntry BEFORE walking memfs, so a mid-walk
//      throw left OPFS wiped. The snapshot is now staged before the delete.
// These tests drive the real worker script with a fake OPFS and a data:-URL
// glue module (same realm, so the fake reports through globalThis).

const src = readFileSync(new URL("../app/js/worker-wasm.js", import.meta.url), "utf8");

// Fresh module execution per test: data:-URL imports are cached by URL, so
// cache-bust with a comment. The fake glue reports through globalThis.
let glueSeq = 0;
const glueUrl = () => "data:text/javascript;base64," + Buffer.from(`
const G = globalThis.__glue = { order: [], calls: [], listResult: [], failList: false };
async function default_() { G.order.push("module"); }
async function init() {
  G.order.push("init");
  return { receive() {} };
}
async function vfs_list(p) {
  G.calls.push(["list", p]);
  if (G.failList) throw new Error("vfs boom");
  return G.listResult;
}
function vfs_read(p) { G.calls.push(["read", p]); return new Uint8Array([1, 2]); }
function vfs_write(p) { G.calls.push(["write", p]); G.order.push("vfs_write:" + p); }
function vfs_mkdirp() {}
export { default_ as default, init, vfs_list, vfs_read, vfs_write, vfs_mkdirp };
//v${++glueSeq}
`).toString("base64");

function fakeOpfs(spec = {}) {
  // spec: { name: Uint8Array (file) | { dir: spec } }
  const calls = { removeEntry: 0, written: [] };
  const fileHandle = (bytes) => ({
    kind: "file",
    getFile: async () => ({ arrayBuffer: async () => bytes.buffer }),
    createWritable: async () => ({
      write: (b) => { calls.written.push(b); },
      close: async () => {},
    }),
  });
  const dirHandle = (children) => ({
    kind: "directory",
    entries: async function* () { for (const [n, h] of Object.entries(children)) yield [n, h]; },
    getDirectoryHandle: async (name) => children[name] ?? (children[name] = dirHandle({})),
    getFileHandle: async (name) => children[name] ?? (children[name] = fileHandle(new Uint8Array())),
    removeEntry: async (name) => { calls.removeEntry++; delete children[name]; },
  });
  const build = (s) => {
    const children = {};
    for (const [name, v] of Object.entries(s)) {
      children[name] = v instanceof Uint8Array ? fileHandle(v) : dirHandle(build(v.dir));
    }
    return children;
  };
  return { root: dirHandle(build(spec)), calls };
}

function loadWorker(navigator_) {
  const posted = [];
  const self = { postMessage: (m) => posted.push(m), onmessage: null };
  new Function("self", "navigator", "setInterval", src)(self, navigator_, () => ({ unref() {} }));
  return {
    posted,
    boot: async (extra = {}) => { await self.onmessage({ data: { type: "boot", glueUrl: glueUrl(), ...extra } }); },
    msg: (data) => self.onmessage({ data }),
  };
}

test("boot restores the OPFS snapshot before the core init answers RPC", async () => {
  const opfs = fakeOpfs({ accounts: { dir: { "x.toml": new Uint8Array([9]) } } });
  const w = loadWorker({ storage: { getDirectory: async () => opfs.root } });
  await w.boot({ persist: true });
  assert.deepEqual(globalThis.__glue.order, ["module", "vfs_write:/accounts/x.toml", "init"]);
  assert.deepEqual(w.posted, [{ type: "ready" }]);
});

test("boot fails loudly when OPFS is unavailable — no core init, no stray account", async () => {
  const w = loadWorker({ storage: { getDirectory: async () => { throw new Error("denied"); } } });
  await w.boot({ persist: true });
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0].type, "boot-error");
  assert.match(w.posted[0].error, /OPFS unavailable/);
  assert.ok(!globalThis.__glue.order.includes("init"), "core must not init without its snapshot");
});

test("checkpoint stages the snapshot before the destructive removeEntry", async () => {
  const opfs = fakeOpfs();
  const w = loadWorker({ storage: { getDirectory: async () => opfs.root } });
  await w.boot({ persist: true });
  globalThis.__glue.listResult = ["/accounts/a.toml"];
  globalThis.__glue.failList = true;
  w.msg({ type: "checkpoint" });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(opfs.calls.removeEntry, 0, "walk failure must not wipe OPFS");

  globalThis.__glue.failList = false;
  w.msg({ type: "checkpoint" });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(opfs.calls.removeEntry, 1);
  assert.equal(opfs.calls.written.length, 1, "a.toml rewritten");
});
