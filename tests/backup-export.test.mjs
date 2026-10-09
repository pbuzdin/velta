import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backupDownloadName, gzipBytes, gunzipBytes } from "../app/js/identity-backup.js";

// #104: the PWA's Export backup tab was Tauri-picker-gated and dead in the
// browser. The wasm branch writes the core's .tar into memfs and ships it
// byte-identical as a browser download (a zip wrapper would need unpacking
// before every restore — desktop import takes the .tar directly).

test("download filename: sanitized addr + ISO date, .tar extension", () => {
  assert.equal(backupDownloadName("you@nine.testrun.org", "2026-10-08"),
    "velta-backup-you_nine.testrun.org-2026-10-08.tar");
  assert.equal(backupDownloadName("We!rd+Addr@example.co.uk", "2026-01-02"),
    "velta-backup-We_rd_Addr_example.co.uk-2026-01-02.tar");
  assert.equal(backupDownloadName("", "2026-01-02"), "velta-backup-profile-2026-01-02.tar");
  assert.equal(backupDownloadName(null, "2026-01-02"), "velta-backup-profile-2026-01-02.tar");
});

const source = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const stripped = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

test("export pane: wasm branch gates on the wasm backend and downloads; desktop branch keeps its picker", () => {
  assert.ok(stripped.includes("async function runBackupExport("), "runBackupExport exists");
  const gate = stripped.indexOf("core.backend?.kind === \"worker-wasm\" && !!core.transport?.readCoreFileList");
  assert.ok(gate !== -1, "pwaExport gate on backend kind + memfs read");
  assert.ok(stripped.includes("await runBackupExport(pass || null)"), "pane drives the wasm flow");
  assert.ok(stripped.includes("await core.exportBackup(dest, pass || null)"), "desktop/Android path unchanged");
  assert.ok(stripped.includes("backupDownloadName(state.account?.addr"), "download rides backupDownloadName");
  assert.ok(stripped.includes("tauriInvoke(\"plugin:dialog|open\""), "desktop picker kept");
  assert.ok(stripped.includes("Backup export needs the desktop app or the Velta PWA"), "dead-end case explains itself");
});

test("gzip: CompressionStream round-trips, output carries the gzip magic", async () => {
  const bytes = new TextEncoder().encode("velta-backup-payload ".repeat(2000));
  const gz = await gzipBytes(bytes);
  assert.ok(gz.length < bytes.length, "repetitive payload compresses");
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  assert.deepEqual(await gunzipBytes(gz), bytes);
});

test("export ships gzip (with matching name) and restore preps it through the shell", () => {
  assert.ok(stripped.includes("await gzipBytes(bytes)"), "export compresses when the platform offers it");
  assert.ok(stripped.includes('base + ".gz"'), ".gz suffix only when actually compressed");
  assert.ok(stripped.includes('invoke("prep_backup", { path: picked })'), "restore routes through the shell prep");
});

const swGen = readFileSync(new URL("../scripts/build-pwa.mjs", import.meta.url), "utf8");
test("generated sw.js knows how to decompress nothing but must route notification taps", () => {
  assert.ok(swGen.includes("notificationclick"), "notificationclick handler in SW template");
  assert.ok(swGen.includes("velta-notification-click"), "tap handover message type");
  assert.ok(swGen.includes("velta-pending-notification"), "cold-start stash round-trip");
});
