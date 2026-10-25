import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mem = new Map();
globalThis.localStorage = {
  getItem: k => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};
const {
  bytesFromBase64, normalizeMirror, mirrorList, addMirror, removeMirror, rememberMirror,
  recordApp, recentApps, parseCatalog, loadCatalog,
  DEFAULT_MIRROR, APPS_KEY, MIRRORS_KEY, MIRROR_OK_KEY, MAX_MIRRORS,
} = await import("../app/js/app-browser.js");

test("bytesFromBase64 accepts standard base64 without padding", () => {
  assert.deepEqual([...bytesFromBase64("")], []);
  assert.deepEqual([...bytesFromBase64("YQ")], [0x61]);
  assert.deepEqual([...bytesFromBase64("YWI")], [0x61, 0x62]);
  assert.deepEqual([...bytesFromBase64("YWI=")], [0x61, 0x62]);
});

test("recent apps: 10, newest first, per account, same filename collapses", () => {
  mem.clear();
  for (let i = 0; i < 12; i++) recordApp(1, { name: "A" + i, file: "/b/" + i, filename: "a" + i + ".xdc" });
  recordApp(1, { name: "Again", file: "/b/new", filename: "a3.xdc" });
  const list = recentApps(1);
  assert.equal(list.length, 10);
  assert.equal(list[0].name, "Again");
  assert.equal(list[0].file, "/b/new");
  assert.equal(list.filter(a => a.filename.toLowerCase() === "a3.xdc").length, 1);
  assert.deepEqual(recentApps(2), []);
  assert.equal(recordApp(1, { name: "Nope" }), null);
});

test("corrupt app storage degrades to empty", () => {
  mem.set(APPS_KEY, "{nope");
  assert.deepEqual(recentApps(1), []);
  recordApp(1, { name: "Calc", file: "/blob/c", filename: "c.xdc" });
  assert.equal(recentApps(1)[0].name, "Calc");
});

test("mirrors: normalize, default stays, extras cap, last success goes first", () => {
  mem.clear();
  assert.equal(normalizeMirror("  https://apps.testrun.org/xdcget-lock.json  "), DEFAULT_MIRROR);
  assert.equal(normalizeMirror("http://127.0.0.1:8080/cat/"), "http://127.0.0.1:8080/cat");
  assert.equal(normalizeMirror("ftp://x"), null);
  assert.equal(normalizeMirror("https://user:pw@host"), null);
  assert.equal(normalizeMirror("not a url"), null);
  assert.deepEqual(mirrorList(), [DEFAULT_MIRROR]);
  assert.equal(addMirror("https://m2.example/"), "https://m2.example");
  assert.equal(addMirror("https://m1.example"), "https://m1.example");
  assert.equal(addMirror(DEFAULT_MIRROR), DEFAULT_MIRROR);
  assert.deepEqual(mirrorList(), [DEFAULT_MIRROR, "https://m2.example", "https://m1.example"]);
  rememberMirror("https://m1.example/");
  assert.deepEqual(mirrorList(), ["https://m1.example", DEFAULT_MIRROR, "https://m2.example"]);
  for (let i = 0; i < MAX_MIRRORS; i++) addMirror("https://full" + i + ".example");
  assert.equal(addMirror("https://overflow.example"), null);
  assert.equal(JSON.parse(mem.get(MIRRORS_KEY)).length, MAX_MIRRORS);
  removeMirror("https://m1.example");
  assert.equal(mem.get(MIRROR_OK_KEY) ?? null, null);
  assert.ok(!mirrorList().includes("https://m1.example"));
  removeMirror(DEFAULT_MIRROR);
  assert.ok(mirrorList().includes(DEFAULT_MIRROR));
});

const calc = {
  app_id: "nelson9608-calculator-xdc",
  name: "Calculator",
  description: "Simple Calculator\nUse this",
  url: "https://github.com/nelson9608/Calculator-xdc/releases/download/V1.0.0/Calculator-2.xdc",
  cache_relname: "nelson9608-calculator-xdc-V1.0.0.xdc",
};

test("parseCatalog prefers the answering mirror's cache file", () => {
  const [app] = parseCatalog(JSON.stringify([calc]), "https://apps.testrun.org/");
  assert.equal(app.name, "Calculator");
  assert.equal(app.fileUrl, "https://apps.testrun.org/nelson9608-calculator-xdc-V1.0.0.xdc");
  assert.equal(app.filename, "nelson9608-calculator-xdc-V1.0.0.xdc");
  assert.equal(app.description, "Simple Calculator Use this");
  const [fallback] = parseCatalog(JSON.stringify([
    { name: "X", cache_relname: "../secret.xdc", url: "https://ok.example/files/a.xdc" },
    { name: "Bad", url: "javascript:alert(1)" },
  ]), "https://m.example");
  assert.equal(fallback.fileUrl, "https://ok.example/files/a.xdc");
  assert.equal(fallback.filename, "a.xdc");
  assert.equal(parseCatalog(JSON.stringify([{ name: "Bad", url: "javascript:alert(1)" }]), "https://m.example").length, 0);
  assert.deepEqual(parseCatalog("{", "https://m.example"), []);
  assert.deepEqual(parseCatalog("{}", "https://m.example"), []);
});

test("loadCatalog skips a dead mirror and an empty index", async () => {
  const get = async (url) => {
    if (url.startsWith("https://dead")) throw new Error("down");
    if (url.startsWith("https://empty")) return "[]";
    if (url.startsWith("https://ok")) return JSON.stringify([calc]);
    throw new Error("no");
  };
  const r = await loadCatalog(["https://dead.example", "https://empty.example", "https://ok.example/"], get);
  assert.equal(r.base, "https://ok.example");
  assert.equal(r.apps[0].fileUrl, "https://ok.example/nelson9608-calculator-xdc-V1.0.0.xdc");
  await assert.rejects(() => loadCatalog(["https://dead.example", "https://empty.example"], get), /Empty catalog/);
  await assert.rejects(() => loadCatalog(["https://dead.example"], get), /down/);
});

test("attach menu and catalog fetch are wired", () => {
  const cv = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(cv, /appendAttachLists\(/);
  assert.match(cv, /openAppBrowser\(/);
  assert.match(cv, /getHttpResponse\(url, ms\)/);
  const browser = readFileSync(new URL("../app/js/app-browser.js", import.meta.url), "utf8");
  assert.match(browser, /Browse apps…/);
  assert.match(browser, /summary/);
  assert.match(browser, /"Apps"/);
  assert.match(browser, /"Commands"/);
  const rpc = readFileSync(new URL("../app/js/rpc-core.js", import.meta.url), "utf8");
  assert.match(rpc, /get_http_response/);
});
