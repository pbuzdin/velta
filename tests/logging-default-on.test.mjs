import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const log = read("../velta-app/src-tauri/src/log.rs");
const lib = read("../velta-app/src-tauri/src/lib.rs");
const app = read("../app/js/app.js");
const ui = read("../app/js/ui.js");

test("#196 logger: bounded channel, drop-newest, default OFF", () => {
  assert.match(log, /sync_channel::<String>\(CHANNEL_CAP\)/);
  assert.match(log, /const CHANNEL_CAP: usize = 8192/);
  assert.match(log, /Drop-newest/);
  assert.match(log, /TrySendError::Full/);
  assert.match(log, /AtomicBool::new\(false\)/);
  assert.match(log, /RATE_PER_SEC: u64 = 50/);
  assert.match(log, /starts_with\("boot:"\)/);
  assert.match(log, /!msg\.starts_with\("boot:"\) && !LOG_ENABLED/);
  assert.match(log, /fn read_tail/);
  assert.match(log, /TAIL_MAX: u64 = 512 \* 1024/);
  assert.match(log, /fn boot_writes_when_logging_off/);
});

test("#196 redaction: emails, quoted bodies, t= query values", () => {
  assert.match(log, /foo@\*\*\*/);
  assert.match(log, /redact_chat_link/);
  assert.match(log, /truncate_quoted/);
  assert.match(log, /SECRET_BODY_MUST_NOT_LEAK/);
  assert.match(log, /fn bounded_channel_drops_newest_and_counts/);
});

test("#196 frontend: missing velta-logging is off", () => {
  assert.match(app, /velta-logging"\) === "1"/);
  assert.equal((app.match(/velta-logging"\) !== "0"/g) || []).length, 0);
  assert.match(app, /Default OFF/);
  assert.match(ui, /velta-logging"\) === "1"/);
});

test("#196 About Velta: file-logging switch and copy/share log", () => {
  assert.match(ui, /data-file-logging-sw/);
  assert.match(ui, /data-log-copy/);
  assert.match(ui, /data-log-share/);
  assert.match(ui, /read_log_file/);
  assert.match(ui, /t\("File logging"\)/);
  assert.match(ui, /t\("Copy log"\)/);
  assert.match(lib, /fn read_log_file/);
  assert.match(lib, /read_log_file,/);
});
