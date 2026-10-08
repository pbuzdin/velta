import test from "node:test";
import assert from "node:assert/strict";
import { wasmBlobHref } from "../app/js/media.js";

const base = "https://example.test/app/";
const path = "/accounts/u/dc.db-blobs/a.jpg";

test("wasm account blobs are served under the app, not the site root", () => {
  const href = wasmBlobHref(path, base);
  const url = new URL(href);
  assert.equal(url.origin + url.pathname, "https://example.test/app/blob");
  assert.equal(url.searchParams.get("p"), path);
  assert.equal(wasmBlobHref("/etc/passwd", base), "");
  assert.equal(wasmBlobHref("/accounts/../secret", base), "");
});
