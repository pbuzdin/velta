// Export / transfer / import progress view (transfer-progress.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stageFor, progressModel, progressHtml, formatBytes, createTransferTracker, STAGES } from "../app/js/transfer-progress.js";

test("stageFor maps permille per job kind", () => {
  assert.equal(stageFor("send", 0, false), "waiting");
  assert.equal(stageFor("receive", 0, false), "preparing");
  assert.equal(stageFor("send", 400, true), "sending");
  assert.equal(stageFor("receive", 400, true), "receiving");
  assert.equal(stageFor("export", 1, true), "exporting");
  assert.equal(stageFor("import", 999, true), "importing");
  assert.equal(stageFor("receive", 1000, true), "done");
  assert.equal(stageFor("send", 0, true), "failed");
});

test("progress bar: native <progress>, aria label, percent; indeterminate while waiting", () => {
  const h = progressHtml(progressModel({ kind: "send", stage: "sending", permille: 456 }));
  assert.match(h, /<progress class="xfer-bar" max="1000" value="456" aria-label="Sending profile"/);
  assert.match(h, />45%</);
  assert.match(h, /role="status" aria-live="polite"/);
  const w = progressHtml(progressModel({ kind: "send", stage: "waiting" }));
  assert.match(w, /<progress class="xfer-bar" aria-label/);
  assert.doesNotMatch(w, /value=/);
  assert.doesNotMatch(w, /xfer-pct/);
});

test("sizes only when a total is known; failure shows the escaped reason", () => {
  assert.equal(progressModel({ kind: "receive", stage: "receiving", permille: 500 }).size, "");
  assert.equal(progressModel({ kind: "receive", stage: "receiving", permille: 500, total: 2 * 1024 * 1024 }).size, "1.0 MB / 2.0 MB");
  assert.equal(formatBytes(512), "512 B");
  const f = progressHtml(progressModel({ kind: "receive", stage: "failed", error: "closed <by> peer" }));
  assert.match(f, /is-failed/);
  assert.match(f, /Failed: closed &lt;by&gt; peer/);
});

test("tracker follows ImexProgress and notifies Android, clearing on finish", async () => {
  const listeners = new Set();
  const core = { addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f) };
  const notes = [];
  const invoke = async (cmd, a) => { notes.push([cmd, a.permille]); };
  const tr = createTransferTracker({ core, kind: "receive", invoke });
  const fire = p => [...listeners].forEach(f => f({ detail: { progress: p } }));
  tr.attach(null);
  fire(1); fire(250); fire(250);
  assert.equal(tr.state.stage, "receiving");
  fire(1000);
  assert.equal(tr.state.stage, "done");
  assert.equal(listeners.size, 0);
  assert.deepEqual(notes.map(n => n[0]), Array(notes.length).fill("transfer_notify"));
  assert.deepEqual(notes.map(n => n[1]), [-2, 1, 250, -1]); // deduped per percent
});

test("tracker: 0 after progress = failed", () => {
  const listeners = new Set();
  const core = { addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f) };
  const tr = createTransferTracker({ core, kind: "send" });
  [...listeners].forEach(f => f({ detail: { progress: 10 } }));
  [...listeners].forEach(f => f({ detail: { progress: 0 } }));
  assert.equal(tr.state.stage, "failed");
});

test("wired into send, receive, export and import; Android notification command exists", () => {
  const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
  for (const k of ["send", "receive", "export", "import"]) assert.match(app, new RegExp(`createTransferTracker\\(\\{ core[^}]*kind: "${k}"`));
  const rs = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(rs, /generate_handler!\[[^\]]*transfer_notify/);
  const kt = readFileSync(new URL("../velta-app/src-tauri/gen/android/app/src/main/java/org/velta/CoreService.kt", import.meta.url), "utf8");
  assert.match(kt, /fun transferProgress\(context: Context, permille: Int, title: String, text: String\)/);
  assert.match(kt, /setProgress\(1000/);
});

test("all stage and title strings translated in ru and fr", () => {
  const keys = [...Object.values(STAGES), "Sending profile", "Receiving profile", "Exporting backup", "Importing backup", "Cancelled"];
  for (const l of ["ru", "fr"]) {
    const j = JSON.parse(readFileSync(new URL(`../app/locales/${l}.json`, import.meta.url), "utf8"));
    for (const k of keys) assert.ok(j[k], `${l}: ${k}`);
  }
});
