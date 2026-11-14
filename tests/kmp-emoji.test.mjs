import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.VELTA_GEN_NO_WRITE = "1";
const { generateKmpEmoji, OUT } = await import(
  pathToFileURL(join(ROOT, "tools", "gen-kmp-emoji.mjs")).href
);

test("generated KMP emoji list is not stale", async () => {
  assert.equal(readFileSync(OUT, "utf8"), await generateKmpEmoji(), "stale: run node tools/gen-kmp-emoji.mjs");
});
