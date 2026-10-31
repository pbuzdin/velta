// #176: tunnel commands must not run on the Android main thread (sync Tauri
// commands do; the WebView's RPC responses need that thread), and the
// tunnel's blocking checks must not run on async workers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../velta-app/src-tauri/src/tunnel.rs", import.meta.url), "utf8");

test("every Android/Windows tunnel command is async and off the main thread", () => {
  const cmds = [...src.matchAll(/#\[cfg\(any\(target_os = "android", windows\)\)\]\n#\[tauri::command\]\npub (async )?fn (tunnel_\w+)/g)];
  assert.ok(cmds.length >= 12, `found ${cmds.length}`);
  for (const [, isAsync, name] of cmds) assert.ok(isAsync, `${name} is a sync command (main thread)`);
});

test("the applier runs check_network/check_alive in spawn_blocking", () => {
  assert.match(src, /spawn_blocking\(move \|\| \{\s*check_network\(&a\);\s*check_alive\(&a\);/);
});

test("Android core init boots the tunnel off the core runtime", () => {
  const lib = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /spawn_blocking\(\|\| tunnel::boot\(&Host::current\(\)\)\)/);
});
