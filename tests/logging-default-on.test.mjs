import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const log = read("../velta-app/src-tauri/src/log.rs");
const app = read("../app/js/app.js");

test("#196 logger: bounded channel, drop-newest, default ON", () => {
  assert.match(log, /sync_channel::<String>\(CHANNEL_CAP\)/);
  assert.match(log, /const CHANNEL_CAP: usize = 8192/);
  assert.match(log, /Drop-newest/);
  assert.match(log, /TrySendError::Full/);
  assert.match(log, /AtomicBool::new\(true\)/);
  assert.match(log, /RATE_PER_SEC: u64 = 50/);
  assert.match(log, /starts_with\("boot:"\)/);
});

test("#196 redaction: emails, quoted bodies, t= query values", () => {
  assert.match(log, /foo@\*\*\*/);
  assert.match(log, /redact_chat_link/);
  assert.match(log, /truncate_quoted/);
  assert.match(log, /SECRET_BODY_MUST_NOT_LEAK/);
  assert.match(log, /fn bounded_channel_drops_newest_and_counts/);
});

test("#196 frontend: missing velta-logging is on", () => {
  assert.match(app, /velta-logging"\) !== "0"/);
  assert.equal((app.match(/velta-logging"\) === "1"/g) || []).length, 0);
  assert.match(app, /Default ON \(#196\)/);
});
