import test from "node:test";
import assert from "node:assert/strict";
import { isSendFailureDiagnostic, createRelaySendErrorState } from "../app/js/diagnostics.js";
import { MockCore } from "../app/js/mock-core.js";

// #102: core send failures surface as a transient "sending delayed" state on
// the relay line — classification, raise/clear state machine, 60s toast
// throttle, and the MockCore demo twin.

test("classification: send pipeline failures only, warning/error only", () => {
  const FAIL = "send_smtp_messages failed: Failed to send message: Retry.";
  assert.equal(isSendFailureDiagnostic("warning", FAIL), true);
  assert.equal(isSendFailureDiagnostic("error", "Failed to send message: 5xx"), true);
  assert.equal(isSendFailureDiagnostic("error", "send_smtp_messages failed: connection refused"), true);
  // Info chatter never raises — "SMTP connected" etc.
  assert.equal(isSendFailureDiagnostic("info", FAIL), false);
  assert.equal(isSendFailureDiagnostic("info", "SmtpConnected"), false);
  assert.equal(isSendFailureDiagnostic("warning", "IMAP connection lost"), false);
  assert.equal(isSendFailureDiagnostic("warning", ""), false);
});

test("state machine: raises once, toasts error-level max once per 60s, clears", () => {
  let t = 0;
  const s = createRelaySendErrorState({ now: () => t, toastGapMs: 60000 });

  let r = s.note("warning");
  assert.deepEqual(r, { raised: true, toast: false }, "warnings raise but never toast");
  r = s.note("warning"); // scheduler repeats every pass
  assert.deepEqual(r, { raised: false, toast: false });

  t = 30_000;
  r = s.note("error");
  assert.deepEqual(r, { raised: false, toast: true }, "first error toasts");

  t = 50_000;
  r = s.note("error");
  assert.deepEqual(r, { raised: false, toast: false }, "within 60s: no toast spam");

  t = 95_000;
  assert.equal(s.note("error").toast, true, "after 60s an error toasts again");

  assert.equal(s.active, true);
  assert.equal(s.clear(), true);
  assert.equal(s.active, false);
  assert.equal(s.clear(), false, "clear is idempotent");
  assert.deepEqual(s.note("warning"), { raised: true, toast: false }, "re-raises after clear");
});

test("MockCore twin: _sendFailureMode holds sends and emits the core's warning; success emits smtp-message-sent", async () => {
  const mock = new MockCore();
  mock._simTimer?.unref();
  const events = [];
  const on = name => e => events.push([name, e.detail?.level, e.detail?.message]);
  for (const name of ["diagnostic", "smtp-message-sent", "msg-state", "send-activity"]) mock.addEventListener(name, on(name));

  mock._sendFailureMode = true;
  const chat = mock.chats.find(c => c.kind === "group") || mock.chats[0];
  const id = await mock.sendMessage(chat.id, { text: "stuck" });
  assert.equal(chat.messages.find(m => m.id === id)?.state, "pending", "send held pending");
  assert.ok(events.some(([n, l, m]) => n === "diagnostic" && l === "warning" && isSendFailureDiagnostic("warning", m)),
    "emits the same warning the real scheduler logs");

  events.length = 0;
  mock._sendFailureMode = false;
  await mock.sendMessage(chat.id, { text: "flows again" });
  await new Promise(r => setTimeout(r, 450));
  assert.ok(events.some(([n]) => n === "smtp-message-sent"), "recovery path emits the clear signal");
});
