// Chat-list timestamps: local calendar days, never a weekday for >6 days.
process.env.TZ = "Europe/Moscow";
import test from "node:test";
import assert from "node:assert/strict";
const { formatListTime, formatDay, calendarDaysAgo } = await import("../app/js/format.js");

const L = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = L(2026, 10, 15, 2, 57); // Thu 02:57 MSK, the bug report
const wd = (t) => new Date(t).toLocaleDateString([], { weekday: "short" });
const md = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });

test("today shows HH:MM", () => {
  assert.equal(formatListTime(L(2026, 10, 15, 0, 5), NOW), "00:05");
});
test("yesterday, even 3 minutes ago across midnight", () => {
  assert.match(formatListTime(L(2026, 10, 14, 23, 54), NOW), /^yesterday$/i);
  assert.match(formatListTime(L(2026, 10, 14, 0, 1), NOW), /^yesterday$/i);
});
test("2..6 calendar days ago -> weekday", () => {
  for (let d = 9; d <= 13; d++) assert.equal(formatListTime(L(2026, 10, d, 23, 59), NOW), wd(L(2026, 10, d)));
  assert.equal(formatListTime(L(2026, 10, 9, 0, 1), NOW), wd(L(2026, 10, 9)));
});
test("last Thursday never shows a bare weekday (<7*24h but 7 calendar days)", () => {
  const t = L(2026, 10, 8, 23, 0); // ~4h short of 7*24h
  assert.equal(calendarDaysAgo(t, NOW), 7);
  assert.equal(formatListTime(t, NOW), md(t));
  assert.notEqual(formatListTime(L(2026, 10, 8, 3, 0), NOW), wd(NOW));
});
test("older same-year -> month day; prior year -> with year", () => {
  assert.equal(formatListTime(L(2026, 10, 3), NOW), md(L(2026, 10, 3)));
  assert.match(formatListTime(L(2025, 12, 31), NOW), /2025/);
});
test("future timestamp (clock skew) never gets a weekday", () => {
  const t = L(2026, 10, 17);
  assert.equal(formatListTime(t, NOW), md(t));
});
test("week boundary across month/year and DST", () => {
  const now = L(2027, 1, 2, 1, 0); // Sat
  assert.equal(formatListTime(L(2026, 12, 27, 2, 0), now), wd(L(2026, 12, 27)));
  assert.match(formatListTime(L(2026, 12, 26, 23, 0), now), /2026/);
  process.env.TZ = "Europe/Berlin"; // DST ended Oct 25 2026
  const n2 = new Date(2026, 9, 26, 0, 30).getTime();
  assert.equal(calendarDaysAgo(new Date(2026, 9, 25, 0, 30).getTime(), n2), 1);
  assert.equal(calendarDaysAgo(new Date(2026, 9, 24, 23, 59).getTime(), n2), 2);
  process.env.TZ = "Europe/Moscow";
});
test("formatDay uses calendar days", () => {
  assert.equal(formatDay(L(2026, 10, 15, 0, 1), NOW), "Today");
  assert.equal(formatDay(L(2026, 10, 14, 0, 1), NOW), "Yesterday");
  assert.equal(formatDay(L(2025, 3, 1), NOW).includes("2025"), true);
});
