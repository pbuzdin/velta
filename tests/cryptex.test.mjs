import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const cx = await import("../app/js/cryptex.js");
const { EXCLUDED_STORAGE_KEYS } = await import("../app/js/settings-transfer.js");

test("link round trip: https://server/<id>#<password>", () => {
  const url = cx.cryptexLink("https://drop.gluek.info", "abc-defg-hij", "Pw9xYzAbCdEfGhJkLmNpQrSt");
  assert.equal(url, "https://drop.gluek.info/abc-defg-hij#Pw9xYzAbCdEfGhJkLmNpQrSt");
  const text = cx.cryptexMessageText({ name: "a.zip", size: 10, url, expiresAt: 0 }, n => `${n} B`, () => "1 Nov 12:00");
  assert.match(text, /^📦 a\.zip \(10 B\)\nhttps:\/\/drop\.gluek\.info\/abc-defg-hij#Pw9x\S+\nAvailable until 1 Nov 12:00/);
  assert.deepEqual(cx.parseCryptexLink(text), { server: "https://drop.gluek.info", id: "abc-defg-hij", password: "Pw9xYzAbCdEfGhJkLmNpQrSt" });
});

test("parser ignores Lufi links, plain urls and links without a password", () => {
  assert.equal(cx.parseCryptexLink("https://upload.disroot.org/r/AbCdEf#a2V5a2V5a2V5a2V5a2V5a2V5"), null);
  assert.equal(cx.parseCryptexLink("see https://drop.gluek.info/abc-defg-hij"), null);
  assert.equal(cx.parseCryptexLink("https://example.com/page#section"), null);
  assert.equal(cx.parseCryptexLink("https://x.org/sub/abc-def#p%20w").server, "https://x.org/sub");
  assert.equal(cx.parseCryptexLink("https://x.org/sub/abc-def#p%20w").password, "p w");
});

test("limits: 1 GB pre-check, retention up to 7 days, default 7d", () => {
  assert.equal(cx.cryptexPrecheck(1024 ** 3), null);
  assert.match(cx.cryptexPrecheck(1024 ** 3 + 1), /1 GB/);
  assert.match(cx.cryptexPrecheck(0), /empty/);
  assert.equal(cx.CRYPTEX_DEFAULT_RETENTION, "7d");
  for (const r of cx.CRYPTEX_RETENTIONS) assert.ok(cx.retentionMs(r) > 0 && cx.retentionMs(r) <= 7 * 86400e3, r);
});

test("API key and records stay local and out of settings export", () => {
  cx.setCryptexApiKey("  k  ");
  assert.equal(cx.cryptexApiKey(), "k");
  cx.setCryptexApiKey("");
  assert.equal(store.has("velta-cryptex-key"), false);
  for (const k of ["velta-cryptex-key", "velta-cryptex-server", "velta-cryptex-files", "velta-large-provider"]) assert.ok(EXCLUDED_STORAGE_KEYS.includes(k), k);
  cx.rememberCryptexUpload(1, 5, { server: "https://s", id: "a-b", password: "p", name: "n", size: 1, expiresAt: 9 });
  assert.equal(cx.cryptexUploadFor(1, 5).id, "a-b");
  cx.markCryptexDeleted(1, 5);
  assert.equal(cx.cryptexUploadFor(1, 5).deleted, true);
  assert.throws(() => cx.normalizeCryptexServer("http://drop.gluek.info"));
  assert.equal(cx.normalizeCryptexServer("drop.gluek.info/"), "https://drop.gluek.info");
});

test("unreachable errors offer the other provider; refusals do not", () => {
  assert.ok(cx.looksUnreachable("server not reachable: dns failed"));
  assert.ok(cx.looksUnreachable("HTTP 502"));
  assert.equal(cx.looksUnreachable("Authentication required to create Cryptex items in private mode"), false);
});

test("wiring: Rust-only network, provider fallback, receiver card, delete", () => {
  const lf = readFileSync(new URL("../app/js/large-file.js", import.meta.url), "utf8");
  for (const cmd of ["cryptex_create", "cryptex_open", "cryptex_fetch", "cryptex_destroy", "cryptex_new_password"]) assert.ok(lf.includes(`"${cmd}"`), cmd);
  assert.match(lf, /Upload with \{name\} instead\?/);
  assert.doesNotMatch(lf, /fetch\(/, "no renderer fetch: CORS blocks app origins");
  const cv = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
  assert.match(cv, /cryptexCardHtml\(m\.text, \{ canFetch: largeFileAvailable\(\) \}\)/);
  assert.match(cv, /data-cryptex-dl/);
  const rs = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const cmd of ["cryptex_create", "cryptex_open", "cryptex_fetch", "cryptex_destroy", "cryptex_progress", "cryptex_cancel"]) assert.ok(rs.includes(`cryptex::${cmd}`), cmd);
});

test("no Cryptex API key anywhere in the repo", () => {
  const root = new URL("../", import.meta.url).pathname;
  const skip = new Set([".git", "node_modules", "target", "core", "vendor"]);
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (skip.has(n)) continue;
      const p = `${d}/${n}`;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.size < 2e6 && /\.(js|mjs|rs|json|md|html|css|toml|kt|ts)$/.test(n)) {
        assert.doesNotMatch(readFileSync(p, "utf8"), /\bcx_[A-Za-z0-9_-]{20,}/, p);
      }
    }
  };
  walk(root.replace(/\/$/, ""));
});
