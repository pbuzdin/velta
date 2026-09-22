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
   core version (2.61.0 since 1.4.24).
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
