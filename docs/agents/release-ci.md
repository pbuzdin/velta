# Release CI & sidecar builds — agent notes

Incidents and recipes for the release pipelines (`.github/workflows/`), the
Windows sidecar rebuild, and the OpenSSL/Perl build-time dependency.

## Incident 1 (v1.4.24): BOM in `tauri.conf.json` killed BOTH release workflows

**Symptom.** The `Release` workflow for tag `v1.4.24` failed on both jobs
(`windows / build-windows` and `android / build-android`) ~10 minutes in, at
the `velta-app v1.4.24` custom-build-script step:

```
unable to parse JSON Tauri config file at .../tauri.conf.json because
expected value at line 1 column 1
```

"line 1 column 1" means the very first byte was not `{` — the file carried a
UTF-8 BOM (`EF BB BF`).

**Root cause.** The version bump (`1.4.23` → `1.4.24`) rewrote
`tauri.conf.json` with PowerShell 5.1 `Set-Content -Encoding UTF8`, which
always writes a BOM. Five other files swept the same way (sw.js, mock-core.js,
main.css, README.md, AGENTS.md) also got BOMs; every parser except
tauri-build's JSON loader tolerated them, so local syntax checks passed and
the failure only surfaced in CI.

**Fix.** Strip the leading `EF BB BF` bytes from all six files. Rule (also in
AGENTS §6.2): never rewrite repo files with `Set-Content -Encoding UTF8`;
use `[IO.File]::WriteAllText`/`WriteAllBytes` (BOM-less UTF-8), or verify and
strip BOMs of every touched file before committing.

**Detection gap worth remembering.** `node --check`, `JSON.parse`, cargo
(TOML), and all browsers accept a BOM; only tauri-build rejects it. A BOM in
`tauri.conf.json` costs a full 10-minute CI run before failing — check for it
whenever a scripted edit touches that file.

## Incident 2 (v1.4.44): macOS release died on a Windows-only helper

**Symptom.** Tag `v1.4.44` built Windows and Android, then
`macos / build-macos` failed in "Build Tauri macOS app + DMG". The release
and notify jobs were skipped, so nothing was published.

```
error: function `chat_link_with_token` is never used
   --> src/lib.rs
    = note: `-D dead-code` implied by `-D warnings`
```

**Root cause.** The function only builds the `velta://chat?…&t=` link, and
its only caller is the `#[cfg(target_os = "windows")]` toast handler.
`build-macos.yml` and `build-windows.yml` both export
`RUSTFLAGS=-D warnings`. On macOS the helper is dead code. Android does
not set that flag, so its job passed.

**Fix.** Compile the helper on Windows only, the same `cfg` as its caller.
Any new function used from a single platform's code needs that `cfg` too,
or the next macOS (or Windows) release fails the same way.

The same failure hit the first `v1.5.2` tag (`41622053781`): Windows and
Android passed, `macos / build-macos` rejected unused `hello_wrap_path`
and `hello_wrap_ct` in `db_key.rs`. No GitHub release had been published,
so the lightweight tag was moved to `7c73c606`, which compiles
`hello_wrap_path` on Windows only and `hello_wrap_ct` on Windows and in
tests. The tag push started rebuild `41631815133`.

## Incident 3 (v1.5.4): three tag moves in one evening

The 1.5.4 tag was pushed three times before a release actually published.
Each failure was caught before or during the build, nothing was published
from a broken tag, but the pattern is worth memorizing.

**Move 1 — boot TDZ, caught pre-build.** The #286 failover restore
(`43026862`) re-applied `d9a8f9bf`'s hunks verbatim, including the
mid-module `relayFailoverLog` declaration that `3e697cb1` had already
moved to module top. With the app's top-level-await boot starting earlier
in the file, mock boot died with `Cannot access 'relayFailoverLog' before
initialization` and the demo chat list never rendered — the e2e smoke
timed out on `.chat-item` "Ada Byron". Running `scripts/e2e-smoke.mjs`
locally (with `CHROMIUM_PATH` pointed at Edge; Playwright browsers are not
installed locally) reproduces it in seconds. **Before tagging, run the
e2e smoke, not just the node suite** — the fake-DOM suite does not
execute the real boot order. The fix also taught the smoke the current
blobfile probe origin (`http://blobfile.localhost/__velta-probe`,
scheme-as-hostname, next to the packaged `blobfile://` shape).

**Move 2 — `unused_unsafe` denial, caught by CI.** `build-windows` died
in 7m43s: the new Hello prompt focuser had `unsafe { GetForegroundWindow() }`
nested inside an outer `unsafe` block — an `unused_unsafe` WARNING locally
but a denial under CI's `-D warnings`. Local plain `cargo check` never
shows it as an error, so it slipped through. **Before tagging, run
`RUSTFLAGS="-D warnings" cargo check`** — and with the vendored
perl/nasm PATH from §4.3.1, because a wiped or flag-changed target
rebuilds `openssl-sys` from source and fails without them.

**Move 3 — tag raced a `gh pr merge`.** `gh pr merge` writes its merge
commit to REMOTE master only; the local checkout keeps its own tip, so a
tag pushed from the local tip silently missed the just-merged PR. Pushing
master then fails non-fast-forward, and a retag from the unrebased head
still misses the PR. Recipe that reconciles without touching the
ever-dirty quilt `core/` tree:

```bash
git fetch origin
git worktree add ../retag-wt origin/master
cd ../retag-wt && git cherry-pick <local-tip-sha> && git push origin HEAD:master
cd - && git pull --rebase --autostash origin master   # autostash round-trips the quilt dirt
git tag -f v1.5.4 && git push -f origin v1.5.4        # then cancel stale Release runs
```

Cancel every Release run that is not on the final tag commit
(`gh run list --workflow Release`), or two runs publish two releases.
Final state: tag `v1.5.4` = `56b7fabb`, run `42387847522`, all platforms
green, release published with full assets.

## Linux assets on the release job (master `178d745b`, not in v1.5.4)

`release.yml` calls `build-linux.yml` and uploads three artifacts next to
the Windows, Android, and macOS files:

- `Velta_<version>_amd64.deb` — Debian 12+ and Ubuntu 23.04+
- `Velta_<version>_amd64.AppImage` — other distros with glibc 2.36+ and webkit2gtk-4.1
- `velta-bin-<version>-1-x86_64.pkg.tar.zst` — Arch, `pacman -U`, not the AUR

The build runs in a Debian 12 container and checks that every packaged ELF
needs at most glibc 2.36. Ubuntu 22.04 (glibc 2.35) is out of range. Linux
has no self-update manifest. v1.5.4's release job did not download these
artifacts; a `workflow_dispatch` of `build-linux.yml` can still produce them
on its own.

## Windows sidecar rebuild (local, verified on 2026-09-22 for core 2.61.0)

1. Toolchain, vendored locally (gitignored, ~150 MB total):
   - `tools/strawberry-perl/` — Strawberry Perl 5.32.1.1 **64bit-portable**
     zip. NB: the 5.38.x portable URL 404s on strawberryperl.com; the
     5.32.1.1 one works. Extract, no relocation script present in the zip.
   - `tools/nasm/` — NASM 2.16.03 win64 zip, extracted with
     `--strip-components=1`.
   - Probe before building: `perl -e "use Locale::Maketext::Simple"` and
     `nasm -v` with the PATH below. This is exactly the module Git Bash perl
     lacks (the 13-minute dead build from §4.3.1).
2. Build (from repo root, ~15 min from scratch):

   ```powershell
   $env:PATH = "$PWD\tools\strawberry-perl\perl\bin;$PWD\tools\strawberry-perl\c\bin;$PWD\tools\nasm;$env:PATH"
   cargo build -p deltachat-rpc-server --release   # in core/
   ```

   Watch out: build from `core/` but compose PATH from the *repo root*
   absolute path — `$PWD\tools\...` inside `core/` silently yields a PATH
   without perl and openssl-sys fails with `Command 'perl' not found`.
3. Verify: `deltachat-rpc-server.exe --version` must print the vendored
   core version (2.62.0 since 1.4.33; was 2.61.0 in 1.4.24–1.4.32).
4. Copy to all three destinations:
   - `velta-app/src-tauri/binaries/deltachat-rpc-server-x86_64-pc-windows-msvc.exe`
   - `velta-app/src-tauri/binaries/deltachat-rpc-server.exe`
   - `deltachat-backend/windows-x86_64/deltachat-rpc-server.exe`

CI does the equivalent via chocolatey StrawberryPerl + NASM
(`build-windows.yml`). The `gh run view <id> --log-failed` grep that finds
this class of failure fast: `Select-String "unable to parse|error: failed"`.

## Can we drop Perl and OpenSSL? (assessed 2026-09-22: no, and why)

Why they exist at all:

- `rusqlite` with `bundled-sqlcipher-vendored-openssl` builds SQLCipher from
  source; SQLCipher's encryption needs a libcrypto, and on Windows/Android
  there is no OS-provider option (CommonCrypto is Apple-only) — OpenSSL it is.
- OpenSSL built from source runs `perl Configure` — Perl is OpenSSL's own
  build tool, not a Velta choice. NASM only feeds OpenSSL's asm kernels.

Options considered and rejected:

1. **`OPENSSL_NO_ASM=1`** — drops the NASM requirement (documented fallback,
   slightly slower OpenSSL). Does NOT drop Perl. Viable if NASM ever rots.
2. **Prebuilt OpenSSL (vcpkg/system)** — removes the source build (and Perl)
   but replaces it with per-platform prebuilts that must match MSVC/NDK
   ABIs; more packaging surface, weaker supply-chain story than vendored
   source. Not worth it for a build-time-only cost.
3. **rustls everywhere** — TLS is increasingly rustls already (2.61.0 ships
   rustls 0.23.45), but SQLCipher still needs libcrypto; rustls cannot
   substitute.
4. **Plain SQLite without SQLCipher** — removes OpenSSL entirely but the
   account database (keys, message plaintext) is then unencrypted at rest.
   Security regression; out of the question.

Conclusion: Perl + NASM are build-time-only (never shipped in artifacts),
CI installs them automatically, and the local toolchain is vendored under
`tools/` (gitignored). The cost is ~15 minutes of build time; every
alternative either breaks security or adds more moving parts than it
removes.

## Incident 4 (v1.5.5): aapt2 rejects `&apos;` in values-fr

The Android "Sending…" notification's French string shipped as
`Envoi d&apos;un message…` in `values-fr/bg_strings.xml`. The Windows-side
build and all Kotlin compilation passed, but CI's
`mergeUniversalReleaseResources` died with "Failed to flatten XML for
resource 'bg_sending' — Invalid unicode escape sequence in string"
(run 42740251545). The repo's own convention in `values-fr/strings.xml`
is a backslash-escaped literal apostrophe (`l\'envoyer`) — aapt2's
flattener handles that form everywhere it is already used. Fix: write
`Envoi d\'un message` (commit `535f6197`); run 42743151158 went green.

Rules:
- In `gen/android/app/src/main/res/values*/`, escape apostrophes as `\'`
  (match `strings.xml`), never as `&apos;`.
- Kotlin errors and resource errors surface in different stages — a green
  `cargo check` says nothing about `values-*` XML; only the Gradle
  resource merge does. Dispatch `build-android.yml` before tagging when a
  release touches `res/`.
