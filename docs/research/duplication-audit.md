# Duplication audit — HEAD 1b3d74b, 2026-10-15 (fixes applied the same day)

Tool: `npx jscpd@4 --min-lines 8 --min-tokens 50 --max-size 5mb` (the large-file override is needed: by default jscpd silently skips app.js, chat-view.js, main.css and lib.rs/p2p.rs).
Scope: app/js (no vendor), app/css, app/webxdc, velta-app/src-tauri/src, tools, tests, .github/workflows. core/ excluded.

**Overall: 1.12 % lines (639/56,857), 1.29 % tokens, 46 clones.** JS 1.0 %, Rust 1.46 %, bash 23.5 %, YAML 0.7 %, CSS 0 %, Python 0 %.
**After the fixes (f9314e5): 0.44 % lines (252/56,656), 23 clones** — same jscpd settings.

Low overall. The real value is in small helpers that jscpd can't see (under 8 lines) and that have already drifted apart.

## Ranked findings

1. **Status: fixed** (36f4466; also folded format.js escInfo/escTime). **HTML escaping, 4 copies, drifted.** components.js:417 `escapeHtml` (canonical), p2p.js:316 `escapeHtml_`, tunnel.js:24 `esc`, ws-relays.js:163 `esc`.
   Drift: ws-relays uses `String(s)`, the others `String(s ?? "")`, so null/undefined renders as the literal text "null"/"undefined". Also components.js:420 `escapeAttr` re-replaces `"` after escapeHtml has already escaped it, which is a no-op.
   Fix: import `escapeHtml` from components.js (or move it to format.js). Risk: very low.
2. **Status: fixed** (41c7dfb; 10 blocks → with_android_env/with_android_class, lock order kept; set_devtools and tunnel.rs left as-is — different shape). **Android JNI boilerplate in Rust, 11–12 copies.** lib.rs:1685, 1727, 2328, 2372, 2470, 2613, 2724, 3497, 3543, 3561, 3581, 2847 (set_devtools; formatting differs). Each repeats the lock of APP_CONTEXT, APP_JAVA_VM and the class cache, then attach_current_thread with the same error strings. About 10 lines × 12 ≈ 100 lines.
   Fix: `fn with_android_env<R>(class: &Mutex<Option<GlobalRef>>, f: impl FnOnce(&mut JNIEnv, &JObject, &JClass) -> Result<R,String>)`. Risk: low to medium (lock ordering must stay the same; Android-only, so it needs a device build to test).
3. **Status: fixed** (1aab9d8; all three use link_preview_agent: direct without a proxy, proxy-only with one). **Bounded HTTPS fetch in Rust, 3 copies.** lib.rs:298 fetch_page_title, :353 expand_invite_link, :484 link preview. All do the https check, a 5 s ureq agent, `take(256*1024)` and lossy UTF-8.
   Drift: the first two return `Ok(empty)` on a fetch failure, the link preview returns `Err("fetch failed")`. The link preview also uses `link_preview_agent(proxy)`, while the other two ignore the proxy. That could be a privacy/proxy bug.
   Fix: `fn fetch_capped(agent, url) -> Option<String>`. Risk: low, but first decide whether the proxy should apply to all three.
4. **Status: fixed** (ca1d177; mm:ss padded everywhere, h:mm:ss from 1 h). **Duration mm:ss formatting, 5 copies, drifted.** calls.js:229 and :323 (`formatDuration`, zero-padded minutes "05:07"), components.js:254, chat-view.js:2136 and :3398 (no minute padding, "5:07").
   Fix: one `formatDuration(s, {padMin})` in format.js. Risk: very low. The inconsistency is visible to users (call timer vs. voice-message length).
5. **Status: not done** — not in the approved fix list, and it is the #25 event-loss path; leave until it can be soak-tested. **JSON-RPC send/timeout block.** rpc-core.js:359-372 vs :407-420 (14 lines): send, promise-catch, sync-catch, pending cleanup. The second copy only differs by keeping the entry on timeout (onLate).
   Fix: `_sendTracked(id, line, reject)`, shared by both, leaving timeout policy to each caller. Risk: medium. This is the issue #25 event-loss path, so keep the onLate semantics and run rpc-event-poll.test / single-reader.test.
6. **Status: fixed** (8be5066; app/js/tauri.js; p2p.js keeps its bound invoke). **`rustLog` duplicated.** rpc-core.js:74-84 and transport.js:42-52. In addition, `__TAURI__.core.invoke || __TAURI__.invoke` resolution is open-coded in 42 places across 16 files.
   Fix: a single `tauri.js` exporting `invoke()`, `isTauri`, `isAndroid`, `rustLog`. Risk: low. Many touch-points, but each change is mechanical.
7. **Status: fixed** (8be5066). **Platform detection drift.** app.js:3386 `/Android/` (case-sensitive) vs ui.js:623/630/830 `/android/i`, plus local-chat.js:29 `isTauri()` and ui.js:833.
   Fix: put these in the same `tauri.js` as #6. Risk: very low. Right now the case-sensitive regex matches the same UAs in practice.
8. **Status: fixed** (46bb4a8; stepList + trackPhases, also the receive-profile step list). **Configure-progress phase stepper in app.js.** app.js:4941-4952 vs 5255-5266, and 5146/5167, 5229/5314 (about 45 lines). `runCreate` already exists, but the add-relay flow re-implements the phases/onProg/listener logic.
   Fix: build the add-relay flow on `runCreate` or extract `trackPhases(phases)`. Risk: low.
9. **Status: fixed** (cf5c8b6; -aarch64 scripts are thin wrappers). **WSL Android build/sign scripts.** tools/wsl-android-build{,-aarch64}.sh share 55 of 59 lines (diff: only `--target aarch64` and comment wording). The sign scripts differ only in the apk path (universal vs arm64).
   Fix: one script with `TARGET=${1:-universal}`. Risk: very low (dev-only).
10. **Status: fixed** for chat-account-isolation, share-receive, chat-msg-update-hardening (f9314e5); scroll-restore keeps its fixed-geometry fake, the small rpc/lufi/trackers stubs were left (too small). **Test DOM scaffolding.** tests/chat-account-isolation.test.mjs:13-72 & 78-122 vs tests/share-receive.test.mjs:10-70 & 155-198 (~105 lines), plus partial copies in scroll-restore, app-account-isolation, rpc-event-poll/single-reader/network-io-gate and lufi/trackers/link-preview-setting. Each has a hand-rolled fake `Element`/document.
    Fix: `tests/helpers/fake-dom.mjs`. Risk: low, but the fakes have diverged slightly (scrollHeight etc.), so merge them as a superset.

## Minor / skipped
- local-chat.js:38 `colorFor` (hsl hash) vs avatar.js `colorForGroup`: these colour different things (local peers vs. fingerprint-derived avatars). Unifying them would change existing colours. Skipped unless a visual match is wanted.
- local-chat.js:1457 `toast` is a lazy-import shim around ui.js toast, used to avoid a circular import. Intentional.
- Hex encoding repeated at avatar.js:178/236 and worker-wasm.js:183: only 1 line each, and the worker can't import UI modules. Trivial.
- p2p.rs 922/1027, 959/1064, 1611/1743, 2754/3270, 5162/5248: 9–12-line repeats of frame-parsing/error mapping, already near the minimum size. Low value; fold them in if p2p.rs gets refactored anyway.
- p2p.js 460/534 and chat-view.js 3491/3516: 9-line local repeats. Trivial.
- wasm-core-opt-in.yml 223/239: one repeated step pair. A YAML anchor or composite action isn't worth it for 9 lines.
- CSS: no jscpd clones. Five selectors are declared twice in main.css (`:root`, `.drawer-head`, `.acct-switch > summary`, `.acct-switch > summary svg`, `li.failed .step-ico::after`). These are likely intentional overrides or theme blocks; check them when editing.
- Python tools: no clones (apply-core-patches vs apply-wasm-core-patches have different logic).
- Date formatting is already centralised in format.js. diagnostics.js:121 builds its own toLocaleTimeString with seconds, which is intentional.
