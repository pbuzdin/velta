import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SETTINGS, EXCLUDED_STORAGE_KEYS, HEADER, MAX_TEXT, serializeSettings, parseSettings,
  diffSettings, applySettings, readSettings, looksLikeSettings,
} from "../app/js/settings-transfer.js";

// Export settings → Saved Messages, Apply these settings (settings-transfer.js).
const APP = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const VIEW = readFileSync(new URL("../app/js/chat-view.js", import.meta.url), "utf8");
const UI = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");

function store(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}
const DAY = new Date(2026, 9, 18, 13, 5);

test("serialize: header with date, one key: value line per setting, stable order", () => {
  const text = serializeSettings(store(), DAY);
  const lines = text.split("\n");
  assert.equal(lines[0], `${HEADER} (2026-10-18)`);
  assert.deepEqual(lines.slice(1, 1 + SETTINGS.length).map(l => l.split(":")[0]), SETTINGS.map(s => s.key));
  assert.match(lines.at(-1), /^\(.*Apply these settings\.\)$/);
  assert.equal(serializeSettings(store(), DAY), text, "deterministic");
  // Stock values on a fresh device.
  assert.match(text, /^theme: auto$/m);
  assert.match(text, /^interface-scale: normal$/m);
  assert.match(text, /^message-text-size: 15\.5$/m);
  assert.match(text, /^message-corners: default$/m);
  assert.match(text, /^accent-color: default$/m);
  assert.match(text, /^bottom-bar-buttons: chats, contacts, calls, qr$/m);
  assert.match(text, /^auto-download-limit: none$/m);
  assert.match(UI, /"1048576", "1 MB"/);
  assert.doesNotMatch(UI, /655360|640 KB/);
  assert.doesNotMatch(text, /#/, "no '#': it would render as a hashtag button");
});

test("round trip: every setting survives serialize → parse → apply on a fresh device", () => {
  const src = store({
    "dw-theme": "light", "velta-ui-scale": "1.15", "velta-msg-font-size": "21", "velta-bubble-radius": "0",
    "velta-accent": "#3fa34d", "velta-hyphens": "0", "velta-bar-hidden": '["calls","qr"]',
    "velta-cats-hidden": '["bots","system"]', "velta-notify": "0", "velta-notify-mentions": "1",
    "velta-notify-text": "0", "velta-media-quality": "1", "velta-compress-photos": "0",
    "velta-download-limit": "5242880", "velta-link-preview": "picture", "velta-strip-trackers": "0",
    "velta-send-enter": "0", "velta-mdns": "0", "velta-remember-scroll": "0", "velta-p2p-typing": "0",
  });
  const parsed = parseSettings(serializeSettings(src, DAY));
  assert.ok(parsed);
  assert.equal(parsed.date, "2026-10-18");
  assert.deepEqual(parsed.ignored, []);
  assert.deepEqual(parsed.invalid, []);
  const dst = store();
  applySettings(dst, parsed.values);
  assert.deepEqual(readSettings(dst), readSettings(src));
  assert.equal(dst.getItem("velta-accent"), "#3fa34d");
  assert.equal(dst.getItem("velta-bar-hidden"), '["calls","qr"]');
  assert.equal(dst.getItem("velta-download-limit"), "5242880");
  assert.deepEqual(diffSettings(dst, parsed.values), [], "applied = no diff left");
  // Defaults written back remove their keys (absent = default pattern).
  const back = parseSettings(serializeSettings(store(), DAY));
  applySettings(dst, back.values);
  for (const k of ["velta-ui-scale", "velta-msg-font-size", "velta-bubble-radius", "velta-accent", "velta-hyphens", "velta-notify", "velta-link-preview"]) {
    assert.equal(dst.getItem(k), null, k);
  }
});

test("whitelist and exclusions: private and per-device keys never leave the device", () => {
  const secrets = Object.fromEntries(EXCLUDED_STORAGE_KEYS.map(k => [k, `SECRET-${k}`]));
  const text = serializeSettings(store({ ...secrets, "velta-identity": "-----BEGIN", "velta-ws-relays": '["wss://relay.example.org"]' }), DAY);
  assert.doesNotMatch(text, /SECRET|BEGIN|relay\.example|wss:/);
  const exported = new Set(SETTINGS.flatMap(s => s.lsKeys));
  for (const k of EXCLUDED_STORAGE_KEYS) assert.ok(!exported.has(k), `${k} is excluded`);
  for (const k of ["velta-bcc-self-choice", "velta-push", "velta-bridge-token", "velta-invite-hosts", "velta-p2p", "velta-notify-bg", "velta-lufi-server"]) {
    assert.ok(EXCLUDED_STORAGE_KEYS.includes(k), `${k} listed as excluded`);
  }
  assert.doesNotMatch(SETTINGS.map(s => s.key).join(" "), /relay|transport|push|proxy|tunnel|key|addr|bcc|multi-device|device-info/);
  // A crafted block cannot reach non-whitelisted storage.
  const dst = store();
  const p = parseSettings(`${HEADER}\nvelta-push: on\nproxy: socks5://x\nbcc-self: on\ntheme: dark`);
  assert.deepEqual(p.ignored, ["velta-push", "proxy", "bcc-self"]);
  applySettings(dst, p.values);
  assert.deepEqual([...dst.m.keys()], ["dw-theme"]);
});

test("parser is strict: header, key lines, notes and blanks only", () => {
  assert.equal(parseSettings("hello"), null);
  assert.equal(parseSettings("Velta settings v2\ntheme: dark"), null, "other versions");
  assert.equal(parseSettings("Re: Velta settings v1\ntheme: dark"), null, "header must lead");
  assert.equal(parseSettings(`${HEADER}\ntheme: dark\nplease apply this asap`), null, "free text mixed in");
  assert.equal(parseSettings(`${HEADER}\n`), null, "no settings at all");
  assert.equal(parseSettings(`${HEADER}\nfoo: bar`), null, "nothing known");
  assert.ok(parseSettings(`\n\n${HEADER}\n\ntheme: dark\n(note)\n`));
  assert.equal(parseSettings("x".repeat(MAX_TEXT + 1)), null);
  assert.equal(parseSettings(`${HEADER}\ntheme: ${"a".repeat(300)}`), null, "line too long");
  assert.equal(parseSettings(`${HEADER}\n` + "theme: dark\n".repeat(100)), null, "too many lines");
  assert.equal(parseSettings(null), null);
  assert.equal(parseSettings({ toString: () => `${HEADER}\ntheme: dark` }), null, "strings only");
  assert.ok(looksLikeSettings(`${HEADER} (2026-10-18)\ntheme: dark`));
  assert.ok(!looksLikeSettings("my Velta settings v1"));
  // Prototype keys are not settings (no Object lookups on message data).
  assert.equal(parseSettings(`${HEADER}\n__proto__: x\ntheme: dark`), null, "keys are [a-z][a-z0-9-]*");
  const p = parseSettings(`${HEADER}\nconstructor: y\nhas-own-property: z\ntheme: dark`);
  assert.deepEqual(p.ignored, ["constructor", "has-own-property"]);
  assert.ok(!Object.hasOwn(p.values, "constructor"));
  assert.deepEqual(Object.keys(p.values), ["theme"]);
});

test("the retired 640 KB auto-download preset is kept as 1 MB", () => {
  const stored = store({ "velta-download-limit": "655360" });
  assert.equal(readSettings(stored)["auto-download-limit"], "1MB");
  assert.equal(stored.getItem("velta-download-limit"), "1048576");
  const parsed = parseSettings(`${HEADER}\nauto-download-limit: 640KB`);
  assert.deepEqual(parsed.invalid, []);
  assert.equal(parsed.values["auto-download-limit"], "1MB");
  const dst = store();
  applySettings(dst, parsed.values);
  assert.equal(dst.getItem("velta-download-limit"), "1048576");
});

test("invalid values are skipped, numbers clamped, duplicates: first wins", () => {
  const p = parseSettings([HEADER,
    "theme: neon", "interface-scale: huge", "message-text-size: 99px", "message-corners: -3",
    "accent-color: javascript:alert(1)", "hyphenation: maybe", "bottom-bar-buttons: chats, rm -rf",
    "chat-categories: system, people, people", "auto-download-limit: 1TB", "notifications: OFF",
    "send-on-enter: off", "send-on-enter: on", "message-corners: 7 px",
  ].join("\n"));
  assert.deepEqual(p.invalid.sort(), ["accent-color", "auto-download-limit", "bottom-bar-buttons", "hyphenation", "interface-scale", "message-corners", "theme"].sort());
  assert.equal(p.values["message-text-size"], "22", "clamped to the max");
  assert.equal(p.values["message-corners"], "7", "the valid later line is used after an invalid one");
  assert.equal(p.values["chat-categories"], "people, system", "canonical order, deduped");
  assert.equal(p.values.notifications, "off");
  assert.equal(p.values["send-on-enter"], "off", "first valid value wins");
  assert.equal(parseSettings(`${HEADER}\nmessage-text-size: 3`).values["message-text-size"], "10");
  assert.equal(parseSettings(`${HEADER}\nmessage-text-size: 16.3`).values["message-text-size"], "16.5");
  assert.equal(parseSettings(`${HEADER}\naccent-color: #3FA34D`).values["accent-color"], "3fa34d");
});

test("diff lists only changed settings, current → new, in settings order", () => {
  const ls = store({ "dw-theme": "dark", "velta-accent": "#8774e1" });
  const p = parseSettings(`${HEADER}\naccent-color: 3fa34d\ntheme: dark\nmessage-text-size: 18`);
  const d = diffSettings(ls, p.values);
  assert.deepEqual(d, [
    { key: "message-text-size", label: "Message text size", from: "15.5", to: "18" },
    { key: "accent-color", label: "Accent color", from: "8774e1", to: "3fa34d" },
  ]);
  const applied = applySettings(ls, p.values);
  assert.deepEqual(applied.map(c => c.key), ["message-text-size", "accent-color"]);
  assert.equal(ls.getItem("velta-msg-font-size"), "18");
  assert.deepEqual(diffSettings(ls, p.values), []);
});

test("wiring: drawer button, Saved-Messages-only bubble action, confirm before apply", () => {
  assert.match(UI, /data-act="export-settings"/);
  assert.match(UI, /if \(act === "export-settings"\) onExportSettings\?\.\(\);/);
  assert.match(APP, /onExportSettings: \(\) => exportSettingsToSaved\(\)/);
  // Self-chat: the chat list's "saved" item, else create_chat_by_contact_id(1).
  assert.match(APP, /c\.kind === "saved"[\s\S]{0,200}createChatByContactId\?\.\(1\)/);
  assert.match(VIEW, /this\.chat\?\.kind === "saved" && m\.from === 1 && !m\.fwdFrom && !m\.originalMsgId\s*&& looksLikeSettings\(m\.text\) && parseSettings\(m\.text\)/);
  assert.match(APP, /if \(e\.detail\?\.chatKind !== "saved"\) return;/);
  // Apply only after the diff modal resolves true; settle before close.
  assert.match(APP, /if \(!\(await settingsDiffModal\(changes, parsed\)\)\) return;\s*const applied = applySettings\(localStorage, parsed\.values\);/);
  assert.match(APP, /ok\.addEventListener\("click", \(\) => \{ resolve\(true\); close\(\); \}\);/);
  // Manual only: nothing calls the export outside the drawer handler.
  assert.equal((APP.match(/exportSettingsToSaved\(/g) || []).length, 2, "definition + drawer handler");
});
