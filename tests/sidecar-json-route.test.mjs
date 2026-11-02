import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
const sidecar = readFileSync(new URL("../velta-app/src-tauri/src/sidecar.rs", import.meta.url), "utf8");

test("#201 sidecar reader parses JSON once and routes on envelope id", () => {
  assert.ok(!lib.includes('contains("\\"id\\":\\"wxdc-")'), "no substring match on wxdc- id");
  assert.ok(!lib.includes('contains("\\"id\\":")'), "no substring match on any id");
  assert.ok(!sidecar.includes('contains("\\"id\\":\\"wxdc-")'), "no substring match on wxdc- id in sidecar.rs");
  assert.match(sidecar, /match route_sidecar_line\(&line\)/);
  assert.match(sidecar, /fn route_sidecar_line\(line: &str\) -> Route/);
  assert.match(sidecar, /fn nested_id_is_not_the_envelope_id/);
  assert.match(sidecar, /malformed_json_is_still_emitted/);
});
