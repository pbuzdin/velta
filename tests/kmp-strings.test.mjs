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

// #334 step 9: KMP-only screens (account rows, battery row, join screen…)
// keep their strings in velta-kmp/i18n/<lang>.json, never a web key.
test("KMP-only packs: same keys in ru and fr, no web duplicates, placeholders kept, all used", async () => {
  const { kmpPack, literalStrings } = await import(pathToFileURL(join(ROOT, "tools", "gen-kmp-strings.mjs")).href);
  const ru = kmpPack("ru");
  const fr = kmpPack("fr");
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(fr).sort());
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  const used = literalStrings();
  for (const lang of ["ru", "fr"]) {
    const web = JSON.parse(readFileSync(join(ROOT, "app/locales", `${lang}.json`), "utf8"));
    const pack = lang === "ru" ? ru : fr;
    for (const [k, v] of Object.entries(pack)) {
      assert.ok(!(k in web), `${lang}: ${JSON.stringify(k)} is a web key — use app/locales`);
      assert.ok(v, `${lang}: empty translation for ${JSON.stringify(k)}`);
      assert.equal(holes(v), holes(k), `${lang}: placeholders differ in ${JSON.stringify(k)}`);
      assert.ok(used.has(k), `${lang}: ${JSON.stringify(k)} is not used by the KMP client`);
    }
  }
});

test("a literal that is a pack key ships even without a literal L.t call", () => {
  // e.g. L.t(when (cat) { "unread" -> "Unread" … }) and rule tables.
  for (const k of ["Unread", "After 1 week", "Calls: the relay hands out TURN credentials"]) {
    assert.ok(keys.includes(k), `${k} missing from the generated packs`);
  }
});
