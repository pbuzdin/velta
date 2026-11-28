// The webxdc host bridge is per open app and per account:
// - a bridge response goes back only to the app that asked, never to whichever
//   app is open when a slow call (file picker, RPC) settles (#614);
// - the trusted-app verdict cache is keyed by a per-account message id, so it
//   is cleared with the other per-account caches on an account switch (#618).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const m = readFileSync(new URL("../app/js/webxdc-manager.js", import.meta.url), "utf8");

function body(re) {
  const i = m.search(re);
  assert.ok(i >= 0, `${re} present`);
  let depth = 0, j = m.indexOf("{", i);
  for (let k = j; k < m.length; k++) {
    if (m[k] === "{") depth++;
    else if (m[k] === "}" && --depth === 0) return m.slice(j, k + 1);
  }
  throw new Error("unbalanced");
}

test("bridge responses are delivered only while the asking app is still the active one", () => {
  const h = body(/function onWindowMessage\(/);
  assert.match(h, /const asker = active;/);
  assert.match(h, /if \(active === asker\) post\(payload, asker\)/);
  assert.doesNotMatch(h, /\.then\(\(result\) => post\(/, "no direct post to the current `active`");
  assert.doesNotMatch(h, /\.catch\(\(error\) => post\(/);
  assert.match(body(/function post\(/), /target\?\.iframe\?\.contentWindow\?\.postMessage/);
});

test("account-changing clears the trust cache with the other per-account caches", () => {
  const h = body(/addEventListener\("account-changing"/);
  for (const c of ["serials.clear()", "infoCache.clear()", "trustCache.clear()"]) assert.ok(h.includes(c), c);
});

test("a stale trust promise cannot evict a newer entry", () => {
  assert.match(m, /trustCache\.get\(msgId\) === p\) trustCache\.delete\(msgId\)/);
});
