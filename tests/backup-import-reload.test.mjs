import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const app = src("app/js/app.js");

// #331: the wasm core reaches OPFS only through the 8 s checkpoint. A timer
// reload after "import finished" comes back to an older snapshot and shows
// the welcome screen over a restored-but-empty profile.

test("import completion reloads only after the checkpoint (#331)", () => {
  // The helper gates the reload on the core's persist/checkpoint.
  assert.match(app, /function reloadAfterPersist\(\)/);
  assert.match(app, /reloadAfterPersist\(\) \{[\s\S]*?core\._persist\?\.\(\)[\s\S]*?location\.reload\(\)/);
  // No timer-based reloads are left anywhere in the app shell.
  assert.doesNotMatch(app, /location\.reload\(\), 800/);
  // All three import-completion paths use it (profile management, identity
  // backup restore, welcome-screen restore).
  assert.ok((app.match(/(?<!function )reloadAfterPersist\(\)/g) || []).length >= 3);
});

test("the identity-restore path still saves before reloading (#126)", () => {
  const i = app.indexOf("importSelfKeys");
  const tail = app.slice(i, i + 800);
  assert.match(tail, /await core\.transport\.checkpoint\?\.\(\)/);
});
