# Tauri shell — improvement notes

Observations gathered 2026-11-01/02 while building the KMP client (#192),
which required deep reads of `velta-app/src-tauri/`. Every item cites its
location; several are already *mitigated* in comments — those are listed
because the mitigation has a maintenance cost worth revisiting. This is not
a criticism of past decisions: most of this machinery exists because the
single-web-codebase trick carried Velta a long way. The KMP client (#192) is
the exit path for the worst of it; the rest is worth fixing in place.

## Architecture / maintainability

1. **`lib.rs` is a ~4,100-line monolith.** Sidecar lifecycle, db-key/crypto,
   biometrics, DNS tunnel, websocket transport, C3 probing, webxdc serving,
   p2p, scheduled messages, lufi, push, logging — one file. Every feature
   lands in the same module; the recent encryption work (db_key, cryptex)
   alone spans hundreds of lines there. *Improvement:* split into modules
   along the seams that already exist (the `mod` declarations at the bottom
   of the file show where the cuts go).

2. **Three core transports to keep in sync.** Desktop = `deltachat-rpc-server`
   sidecar over stdio; Android = core linked into `libvelta_app.so` +
   in-process yerpc session; PWA = wasm. Every core patch must survive all
   three. The KMP client adds a fourth (its own shim). *Improvement:* the
   JSON-RPC surface is the contract — audit that no shell reaches around it
   (see §4 for the one known violation).

3. **Checked-in generated Android project.** `velta-app/src-tauri/gen/android`
   is committed, and CI patches it with `sed` (applicationId swap for
   side-by-side test builds, build-android.yml). The Kotlin stdlib version
   is hand-pinned in `gen/android/app/build.gradle.kts` ("2.2.20 (was
   1.9.25): the UnifiedPush connector pulls kotlin-stdlib"). *Improvement:*
   a small Gradle script/property file instead of sed; consider whether the
   gen project can be regenerated safely at all.

## Sidecar / IPC (desktop)

4. **Sidecar respawn machinery is intricate by its own admission.**
   `spawn_sidecar` ("reader/wait threads ride each spawn; the managed
   RpcState only has its stdin swapped on a respawn", lib.rs §317-322). Each
   respawn swaps `stdin` under a mutex while the old process dies — correct
   today, but the design is hard to test and every failure mode is a
   comment. *Improvement:* a small state machine with one owner, or the
   KMP-style in-process shim once the desktop story converges.

5. **JSON routing by substring in the hot path.** The sidecar reader thread
   decides where a line goes via `line.contains("\"id\":\"wxdc-")` and
   `line.contains("\"id\":")` (lib.rs §395-405). It works, but it is
   string-matching on serialized JSON for control flow — one nested object
   with an `id` field breaks routing silently. *Improvement:* parse once,
   route on typed fields.

6. **Log-volume control by suppression.** "do not log every line — it's the
   hot path and would grow velta.log unbounded" (lib.rs §392). The
   alternative isn't suppressing — it's sampling/rate-limiting at the
   logger, so failures stay visible (see §Diagnostics).

## Android shell

7. **`std::env::set_var` at runtime after threads exist.**
   `init_android_core` sets `VELTA_DB_KEY` via `env::set_var` twice
   (lib.rs §4161-4172, DEK override + startup path). Rust has deprecated
   runtime env mutation for exactly this reason (process-global, unsound
   with concurrent readers). *Improvement:* pass the DEK explicitly into
   `Accounts::new`-adjacent setup, or set it once in `main` before any
   thread spawns. (The KMP shim does the latter — the only moment env
   mutation cannot race a reader.)

7b. **#178 Android encryption: the 2b93f521 fix was REGRESSED by the phase-4 merge — re-verify on device.**
    Updated 2026-11-02 after re-auditing master. Chronology (all verified
    via git):
    - 4ad489a4 (phase 2) added `VeltaKeystore.kt` with an undersized wrap
      blob (`1 + iv.size + dek.size` = 45 B vs the 48 B GCM output).
    - **2b93f521 (v1.4.89) fixed it** with a shared `pack(iv, ct)` helper
      sized from the actual ciphertext, plus a layout test.
    - **58d7915e (phase 4, merged after) reintroduced the old inline
      pattern** in `create()` (line ~70) and `storePlainWrap()` (line ~99)
      — `pack()` is gone from the file again. Classic merge regression: the
      phase-4 branch was cut before the fix and landed after it.
    Current master state (verified 11-02): both wrap sites are undersized;
    `VeltaLock.kt` has the correct `ct.size` math, so only the phase-2 file
    regressed. Net: **Android Tauri installs (v1.4.89/v1.4.90 included) run
    keyless — phase 2 encryption is inert.**
    - Also observed: the file calls `setStrongBoxBacked`, which does not
      exist in android-36's `KeyGenParameterSpec.Builder` (verified against
      the SDK jar — only `setIsStrongBoxBacked` is declared). The file as
      written shouldn't compile against compileSdk 36, yet the Android CI
      built it — which source state the Android build actually compiles
      needs checking (`build-velta-android-wsl.sh` on current master is the
      decisive test).
    *Fix:* re-apply 2b93f521 (it's in git history), fix the method name,
    and wire the layout test into CI so the regression can't recur. The
    KMP port (`velta-kmp/.../core/VeltaKeystore.kt`, `5917eaab`) carries
    both fixes and a verified unwrap path. Phase 4 (app lock) builds on
    the same custody — do not re-ship it until this lands.

8. **WebView ceiling (the headline).** The Android app is a WebView + 44 MB
   of Rust in one process: input latency, scroll cost, lifecycle fights
   (the bg-notify work), and no access to native notification/foreground
   primitives without JNI bridges per feature. The KMP client (#192) is the
   strategic fix; until switchover, every Android fix lands in both.

9. **Dual DEK key-passing paths.** Desktop hands the key to the sidecar via
   env; Android sets it in-process (db_key.rs header). Two code paths for
   one security property — each needs its own review on every change.
   *Improvement:* single documented entry point (see §7).

## Push

10. **Upstream VAPID key hardcoded.** `UnifiedPushService.kt` VAPID_KEY is
    the chatmail notifier key; the 🐴 comment says it: a self-hosted relay
    with its own notifier keypair gets rejected by VAPID-verifying
    providers. *Improvement:* make it a build-time config the relay
    deployment sets (and pair with the relay-side notifier project,
    PLAN-UNIFIEDPUSH.MD items 1-3).

11. **Push settings state split across three places.** UnifiedPushBridge
    prefs (opted_out/last_push), the connector's saved distributor, and the
    Rust-side registration state. A "what does the user actually get"
    question requires reading all three. *Improvement:* one status object
    computed on demand (the JNI `status()` JSON is a good start — make it
    the only source).

## Diagnostics / logging

12. **Unbounded mpsc for logs.** The non-blocking logger (lib.rs §150-160)
    pushes onto an *unbounded* channel; a stalled writer thread grows
    memory silently. *Improvement:* bounded channel + drop-oldest with a
    drop counter (that counter is the diagnostic).

13. **Logging defaults OFF, and for a privacy-honest reason.** LOG_ENABLED
    is false by default because the log mirrors message content outside the
    account db (V-09/#66). The cost: default diagnostics are blind.
    *Improvement:* a redacting logger (hash addresses, truncate bodies) so
    logs can default ON without the privacy cost.

14. **Past silent-failure archaeology in comments.** "the old fallback
    silently failed on every log call" (Android log dir), "dropping it lost
    those events" (bg event batches, #21/#22). These are fixed, but the
    pattern — silent failure in plumbing — recurs. *Improvement:* the
    KMP-style `connect ok` heartbeat line: one log line on every successful
    startup stage, so absence is diagnosable.

## Release hygiene

15. **Bundled binary staleness.** `velta-app/src-tauri/binaries/` ships
    `deltachat-rpc-server-x86_64-pc-windows-msvc.exe` = **2.63.0** while the
    vendored core is 2.66 — local demo binaries drift until rebuilt.
    `velta-app/README.md` still says "1.4.9 / core 2.60.0" while releases
    are at 1.4.90. *Improvement:* version-stamp the README from CI, and
    build sidecars in the same pipeline as the vendored core so they can't
    drift (the KMP repo's `shim` job is the pattern).

16. **`tauri.ios.conf.json` exists with no viable path.** Tauri iOS is not
    production-grade; the config suggests an option that isn't one.
    *Improvement:* delete or comment out with the reason, so nobody burns
    time on it.

## Latent platform traps (from the KMP port)

17. **FragmentActivity + ActivityResultRegistry: "lower 16 bits" crash.**
    Caught live in the KMP port (slice 12): launching a registered
    ActivityResult launcher on a `FragmentActivity`-derived activity throws
    `IllegalArgumentException: Can only use lower 16 bits for requestCode`
    when the registry-generated code exceeds 16 bits. The Tauri gen/android
    activity derives from AppCompatActivity (→ FragmentActivity), so the
    same crash waits for the first `startActivityForResult`-based feature
    (scanner, file picker result, …). *Fix pattern:* route results through
    a process-wide singleton (the KMP approach) or a dedicated plain
    Activity.

18. **biometric 1.1.0 drags in fragment < 1.3.** The KMP release build's
    lintVital gate failed with
    `InvalidFragmentVersionForActivityResult` — biometric 1.1.0 depends on
    an old fragment that breaks the ActivityResult API on
    FragmentActivity. The Tauri gen project uses biometric 1.1.0 with no
    explicit fragment dependency (verified: no fragment line in its
    build.gradle.kts) — latent for any activity-result feature there.
    *Fix:* explicit `androidx.fragment:fragment-ktx` 1.8.x (KMP:
    `5917eaab`).

## What the shell already does well (keep these patterns)

- The **non-blocking logger** concept (bounded work pending, §12 aside).
- **bg_events orphan forwarding** — event batches taken off the core queue
  still reach the WebView even after their waiter gave up (#21/#22).
- The **biometric DEK flow** (override → pending → bail "app-locked" →
  retry) — error-as-control-flow, but documented at every turn.
- **`volume_encryption_status`** — honest reporting (on/off/unknown) instead
  of claiming encryption that isn't there.
- The **sidecar reader hot-path discipline** — someone measured before
  choosing what not to log.

## Cross-links

- KMP rebuild rationale + plan: issue #192, `velta-kmp/docs/PHASES.md`
- Core-side patches referenced: quilt #11/#14/#15/#20/#21/#22/#23 (see
  `core/` quilt series and VENDORISSUES.MD)
- Push relay-side prerequisites: PLAN-UNIFIEDPUSH.MD items 1-3
