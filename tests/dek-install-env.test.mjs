import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rs = (p) => readFileSync(new URL(`../velta-app/src-tauri/src/${p}`, import.meta.url), "utf8");
const lib = rs("lib.rs");
const sidecar = rs("sidecar.rs");
const dbKey = rs("db_key.rs");

test("#202 only db_key::install_env writes VELTA_DB_KEY", () => {
  assert.match(dbKey, /pub fn install_env\(raw: &str\)/);
  assert.match(dbKey, /std::env::set_var\("VELTA_DB_KEY"/);
  assert.equal(
    (dbKey.match(/std::env::set_var\("VELTA_DB_KEY"/g) || []).length,
    1,
    "one set_var in db_key.rs"
  );
  assert.doesNotMatch(lib, /std::env::set_var\("VELTA_DB_KEY"/);
  assert.match(lib, /db_key::install_env\(&raw\)/);
  assert.equal((lib.match(/db_key::install_env\(/g) || []).length, 2, "both Android sites");
});

test("#202 desktop sidecar still uses child env, not parent set_var", () => {
  const spawn = sidecar.slice(sidecar.indexOf("fn spawn_sidecar"), sidecar.indexOf("fn resolve_web_line"));
  assert.match(spawn, /cmd\.env\("VELTA_DB_KEY", raw\)/);
  assert.doesNotMatch(spawn, /install_env|set_var/);
});
