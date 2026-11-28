// Source pins for the desktop shell cleanup (#610, #611, #615); the Rust
// behaviour has unit tests in lib.rs (`backup_scratch_tests`).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rs = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
const fn = (name) => {
  const i = rs.indexOf(name);
  assert.ok(i >= 0, name);
  return rs.slice(i, rs.indexOf("\n}\n", i));
};

test("the unused extract_zip_entries command is gone (#610)", () => {
  assert.doesNotMatch(rs, /extract_zip_entries|ExtractEntry/);
  assert.match(rs, /extract_zip_file,/);
});

test("lock_now and process start purge decrypted open-docs copies on desktop (#611)", () => {
  assert.match(fn("async fn lock_now("), /purge_open_docs\(&app\)/);
  assert.match(rs, /#\[cfg\(not\(target_os = "android"\)\)\]\s*purge_open_docs\(app\.handle\(\)\);/);
  assert.match(fn("fn purge_open_docs("), /remove_dir_all\(base\.join\(OPEN_DOCS_DIR\)\)/);
});

test("gunzipped backups go to an owner-only scratch file that is swept (#615)", () => {
  const b = fn("fn prep_backup_blocking(");
  assert.match(b, /backup_scratch_file\(/);
  assert.doesNotMatch(b, /File::create\(&dest\)/);
  assert.match(fn("fn backup_scratch_file("), /create_new\(true\)/);
});
