import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.VELTA_GEN_NO_WRITE = "1";
const { generateKmpStrings } = await import(
  pathToFileURL(join(ROOT, "tools", "gen-kmp-strings.mjs")).href
);

const { files, keys, missing } = generateKmpStrings();

test("generated packs are not stale", () => {
  for (const [name, body] of Object.entries(files)) {
    const committed = readFileSync(
      join(ROOT, "velta-kmp/composeApp/src/commonMain/kotlin/org/velta/kmp/ui", name),
      "utf8",
    );
    assert.equal(committed, body, `stale: run node tools/gen-kmp-strings.mjs (${name})`);
  }
});

test("every used key exists in BOTH packs (web is the source of truth)", () => {
  for (const lang of Object.keys(missing)) {
    assert.deepEqual(
      missing[lang],
      [],
      `keys missing from app/locales/${lang}.json: ${missing[lang].map((k) => JSON.stringify(k)).join(", ")}`,
    );
  }
});

test("packs are non-trivial (real port, not stubs)", () => {
  assert.ok(keys.length >= 30, `expected >= 30 used keys, got ${keys.length}`);
});
