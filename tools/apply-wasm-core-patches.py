#!/usr/bin/env python3
"""apply-wasm-core-patches.py — opt-in wasm ports for Velta's chatmail core.

Velta-owned forward-port of chatmail/core 2.62+ for wasm32. Reuses MPL patch
*ideas* only — not a fork of slothfulchat-web; no GPL UI.

Relationship to tools/apply-core-patches.py:
  - apply-core-patches.py  → Velta's production quilt (Android/desktop;
                              21 ops at core 2.63.0, 13 at this series' 2.62
                              baseline). This 10-patch series is FROZEN at
                              2.62: it does not apply to 2.63.0.
  - THIS script            → wasm32 ports; MUST stay opt-in.

Safety:
  - Default `apply` / `apply-on-copy` writes to a *copy* under
    `.wasm-core-apply/` (or --dest). It REFUSES to modify master `core/`
    unless --i-know-this-writes-to-master-core is passed (not for CI).
  - Production Release workflows must not invoke this script.

Usage (from repo root):
  python3 tools/apply-wasm-core-patches.py status
  python3 tools/apply-wasm-core-patches.py list
  python3 tools/apply-wasm-core-patches.py apply-on-copy
  python3 tools/apply-wasm-core-patches.py apply-on-copy --dest /tmp/velta-wasm-copy
  python3 tools/apply-wasm-core-patches.py verify-copy --dest /tmp/velta-wasm-copy
  python3 tools/apply-wasm-core-patches.py lock-status
  python3 tools/apply-wasm-core-patches.py refresh-lock --dest /tmp/velta-wasm-lock

Pinned lockfiles (Day 9):
  The series strips Cargo.lock hunks, so a bare copy would re-resolve ~37
  crates to "latest compatible" on every run (wasm-bindgen drift would break
  the pinned wasm-bindgen-cli; png drift changed a golden on Day 7).
  apply-on-copy therefore installs the committed locks from
  docs/research/wasm-patches/support/locks/ into the copy:
    core.Cargo.lock            -> <dest>/core/Cargo.lock
    deltachat-wasm.Cargo.lock  -> <dest>/packages/deltachat-wasm/rust/Cargo.lock
  PROVENANCE records the inputs (master core/Cargo.lock + series + support
  manifests). If they changed, apply-on-copy refuses until `refresh-lock` is
  run (or --no-pinned-lock is passed for an exploratory, unpinned copy).
  Master core/Cargo.lock is never written.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCH_HOME = ROOT / "docs" / "research" / "wasm-patches"
SERIES_DIR = PATCH_HOME / "series"
SERIES_FILE = PATCH_HOME / "series.txt"
SUPPORT = PATCH_HOME / "support"
README = PATCH_HOME / "README.md"
DEFAULT_DEST = ROOT / ".wasm-core-apply"
MASTER_CORE = ROOT / "core"
LOCKS = SUPPORT / "locks"
CORE_LOCK = LOCKS / "core.Cargo.lock"
WRAPPER_LOCK = LOCKS / "deltachat-wasm.Cargo.lock"
PROVENANCE = LOCKS / "PROVENANCE"
WRAPPER_REL = Path("packages") / "deltachat-wasm" / "rust"


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def series_patches() -> list[Path]:
    if SERIES_FILE.is_file():
        names = [
            ln.strip()
            for ln in SERIES_FILE.read_text().splitlines()
            if ln.strip() and not ln.strip().startswith("#")
        ]
    else:
        names = sorted(p.name for p in SERIES_DIR.glob("*.patch"))
    out = []
    for name in names:
        p = SERIES_DIR / name
        if not p.is_file():
            die(f"missing patch listed in series.txt: {p}")
        out.append(p)
    return out


def cmd_status() -> int:
    patches = series_patches() if SERIES_DIR.is_dir() else []
    print("Velta wasm core patch home: OPT-IN.")
    print("Ownership: Velta-owned port of chatmail core 2.62+ (not a slothfulchat-web fork).")
    print(f"Docs: {README}")
    print(f"Patches extracted: {len(patches)} in {SERIES_DIR}")
    print(f"Support crates: {SUPPORT}")
    wrap = ROOT / "packages" / "deltachat-wasm"
    print(f"MPL wrapper: {wrap} ({'yes' if wrap.is_dir() else 'missing'})")
    print(f"Default apply-on-copy dest: {DEFAULT_DEST} (gitignored)")
    print("Master core/: never modified by default commands.")
    return 0


def cmd_list() -> int:
    for p in series_patches():
        subj = ""
        for line in p.read_text(errors="replace").splitlines():
            if line.startswith("Subject:"):
                subj = line[len("Subject:") :].strip()
                break
        print(f"  {p.name}  {subj}")
    return 0


def _is_master_core(path: Path) -> bool:
    try:
        return path.resolve() == MASTER_CORE.resolve()
    except OSError:
        return False


def _copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(
        src,
        dst,
        ignore=shutil.ignore_patterns("target", ".git", "*.pdb"),
        symlinks=True,
    )


def prepare_copy(dest_root: Path) -> Path:
    """Create dest_root/{core,crates,vendor-crates} from master core + support."""
    if not MASTER_CORE.is_dir():
        die(f"master core missing: {MASTER_CORE}")
    if not (SUPPORT / "crates" / "velta-tokio-wasm").is_dir():
        die(f"support shim missing: {SUPPORT / 'crates' / 'velta-tokio-wasm'}")
    dest_root.mkdir(parents=True, exist_ok=True)
    core_dst = dest_root / "core"
    print(f"Copying master core/ → {core_dst}")
    _copy_tree(MASTER_CORE, core_dst)
    print(f"Copying support crates → {dest_root}")
    _copy_tree(SUPPORT / "crates", dest_root / "crates")
    _copy_tree(SUPPORT / "vendor-crates", dest_root / "vendor-crates")
    wrapper_src = ROOT / "packages" / "deltachat-wasm"
    if wrapper_src.is_dir():
        print(f"Copying packages/deltachat-wasm → {dest_root / 'packages' / 'deltachat-wasm'}")
        _copy_tree(wrapper_src, dest_root / "packages" / "deltachat-wasm")
    return core_dst


def apply_patches_to_core(core_dir: Path) -> None:
    patches = series_patches()
    if not patches:
        die("no patches in docs/research/wasm-patches/series/")
    for patch in patches:
        print(f"Applying {patch.name}")
        r = subprocess.run(
            ["git", "apply", "--whitespace=nowarn", str(patch)],
            cwd=core_dir,
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            die(
                f"FAILED applying {patch.name}:\n{r.stderr or r.stdout}",
                code=2,
            )
    marker = core_dir / ".velta-wasm-patches-applied"
    marker.write_text(
        "Applied Velta wasm series from docs/research/wasm-patches/series/\n"
        + "\n".join(p.name for p in patches)
        + "\n"
    )
    print(f"OK: {len(patches)} patches applied → {core_dir}")


# ---------------------------------------------------------------------------
# Pinned lockfiles (Day 9)
# ---------------------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def lock_inputs() -> dict[str, str]:
    """Hashes of everything that determines the copy's resolved lockfiles."""
    h = hashlib.sha256()
    for patch in series_patches():
        h.update(patch.name.encode() + b"\0" + patch.read_bytes() + b"\0")
    series_sha = h.hexdigest()
    h = hashlib.sha256()
    manifests = sorted(
        list(SUPPORT.glob("crates/**/Cargo.toml"))
        + list(SUPPORT.glob("vendor-crates/**/Cargo.toml"))
        + [ROOT / "packages" / "deltachat-wasm" / "rust" / "Cargo.toml"]
    )
    for m in manifests:
        h.update(str(m.relative_to(ROOT)).encode() + b"\0" + m.read_bytes() + b"\0")
    return {
        "master_core_cargo_lock_sha256": _sha256_file(MASTER_CORE / "Cargo.lock"),
        "series_sha256": series_sha,
        "support_manifests_sha256": h.hexdigest(),
    }


def read_provenance() -> dict[str, str]:
    out: dict[str, str] = {}
    if not PROVENANCE.is_file():
        return out
    for ln in PROVENANCE.read_text().splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#") or "=" not in ln:
            continue
        k, v = ln.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def lock_stale_reasons() -> list[str]:
    if not (CORE_LOCK.is_file() and WRAPPER_LOCK.is_file() and PROVENANCE.is_file()):
        return [f"pinned locks missing under {LOCKS}"]
    prov = read_provenance()
    reasons = []
    for k, v in lock_inputs().items():
        if prov.get(k) != v:
            reasons.append(f"{k}: pinned {prov.get(k, '<none>')[:16]}… != current {v[:16]}…")
    for k, f in (("core_lock_sha256", CORE_LOCK), ("wrapper_lock_sha256", WRAPPER_LOCK)):
        if prov.get(k) != _sha256_file(f):
            reasons.append(f"{k}: {f.name} edited by hand (sha mismatch with PROVENANCE)")
    return reasons


def require_fresh_locks() -> None:
    reasons = lock_stale_reasons()
    if reasons:
        sys.stdout.flush()
        die(
            "REFUSED: pinned wasm-core lockfiles are stale:\n  "
            + "\n  ".join(reasons)
            + "\nRefresh (maintainer, needs cargo + network):\n"
            "  python3 tools/apply-wasm-core-patches.py refresh-lock --dest /tmp/velta-wasm-lock\n"
            "or pass --no-pinned-lock for an exploratory, unpinned copy.",
            code=3,
        )


def install_pinned_locks(dest_root: Path) -> None:
    require_fresh_locks()
    shutil.copyfile(CORE_LOCK, dest_root / "core" / "Cargo.lock")
    wrap = dest_root / WRAPPER_REL
    if wrap.is_dir():
        shutil.copyfile(WRAPPER_LOCK, wrap / "Cargo.lock")
    (dest_root / "core" / ".velta-wasm-pinned-lock").write_text(PROVENANCE.read_text())
    print(f"Installed pinned locks from {LOCKS} (build with cargo --locked)")


def cmd_lock_status() -> int:
    print(f"Pinned locks: {LOCKS}")
    for k, v in read_provenance().items():
        print(f"  {k} = {v}")
    reasons = lock_stale_reasons()
    if reasons:
        print("STALE:\n  " + "\n  ".join(reasons))
        return 3
    print("lock-status OK: pinned locks match master core/Cargo.lock + series + support manifests")
    return 0


def _cargo_resolve(cwd: Path) -> None:
    print(f"Resolving lock in {cwd}")
    r = subprocess.run(
        ["cargo", "metadata", "--format-version", "1"],
        cwd=cwd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    sys.stderr.write(r.stderr)
    if r.returncode != 0:
        die(f"cargo metadata failed in {cwd}", code=4)


def cmd_refresh_lock(dest: Path) -> int:
    """Regenerate the pinned locks from a fresh apply-on-copy (never master core/)."""
    if _is_master_core(dest) or _is_master_core(dest / "core") or dest.resolve() == ROOT.resolve():
        die("REFUSED: refresh-lock needs a scratch --dest, not the repo / master core/", code=2)
    if dest.exists():
        shutil.rmtree(dest)
    core_dir = prepare_copy(dest)
    apply_patches_to_core(core_dir)
    # 1) core copy: start from master core/Cargo.lock (already copied) and let
    #    cargo add/upgrade only what the series needs (minimal re-resolve).
    _cargo_resolve(core_dir)
    # 2) wrapper is its own workspace: seed with the core copy lock so shared
    #    crates (png, rusqlite, wasm-bindgen, ...) stay identical to core.
    wrap = dest / WRAPPER_REL
    shutil.copyfile(core_dir / "Cargo.lock", wrap / "Cargo.lock")
    _cargo_resolve(wrap)
    LOCKS.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(core_dir / "Cargo.lock", CORE_LOCK)
    shutil.copyfile(wrap / "Cargo.lock", WRAPPER_LOCK)
    inputs = lock_inputs()
    wbg = _lock_version(WRAPPER_LOCK, "wasm-bindgen")
    lines = [
        "# Generated by tools/apply-wasm-core-patches.py refresh-lock — do not hand-edit.",
        "# Inputs that produced core.Cargo.lock / deltachat-wasm.Cargo.lock:",
        *(f"{k}={v}" for k, v in inputs.items()),
        f"core_lock_sha256={_sha256_file(CORE_LOCK)}",
        f"wrapper_lock_sha256={_sha256_file(WRAPPER_LOCK)}",
        f"wasm_bindgen_version={wbg}",
    ]
    PROVENANCE.write_text("\n".join(lines) + "\n")
    print(f"Pinned locks written to {LOCKS} (wasm-bindgen {wbg}). Commit them.")
    return 0


def _lock_version(lock: Path, name: str) -> str:
    lines = lock.read_text().splitlines()
    for i, ln in enumerate(lines):
        if ln.strip() == f'name = "{name}"' and i + 1 < len(lines):
            v = lines[i + 1].strip()
            if v.startswith("version = "):
                return v.split("=", 1)[1].strip().strip('"')
    return "?"


def cmd_apply_on_copy(dest: Path, force_master: bool, pinned: bool = True) -> int:
    if _is_master_core(dest) or _is_master_core(dest / "core"):
        if not force_master:
            die(
                "REFUSED: refuse to write master core/. Use apply-on-copy (default dest "
                f"{DEFAULT_DEST}) or pass a different --dest.\n"
                "To override (not for CI): --i-know-this-writes-to-master-core",
                code=2,
            )
        # Writing directly onto master core tree
        print("WARNING: writing wasm patches onto master core/ (explicit override)")
        apply_patches_to_core(MASTER_CORE)
        # Still need support crates next to repo root for Cargo path deps
        crates = ROOT / "crates"
        vendors = ROOT / "vendor-crates"
        if not (crates / "velta-tokio-wasm").exists():
            _copy_tree(SUPPORT / "crates", crates)
        if not (vendors / "async-imap").exists():
            _copy_tree(SUPPORT / "vendor-crates", vendors)
        return 0

    # Fail fast (before copying anything) if the pinned locks are stale.
    if pinned:
        require_fresh_locks()

    # dest is a workspace root containing core/
    if dest.name == "core" and dest.parent != ROOT:
        # user passed .../core
        core_dir = dest
        dest_root = dest.parent
        if not (dest_root / "crates").exists():
            _copy_tree(SUPPORT / "crates", dest_root / "crates")
            _copy_tree(SUPPORT / "vendor-crates", dest_root / "vendor-crates")
        if not core_dir.exists():
            die(f"missing {core_dir}")
        apply_patches_to_core(core_dir)
        if pinned:
            install_pinned_locks(dest_root)
        return 0

    core_dir = prepare_copy(dest)
    apply_patches_to_core(core_dir)
    if pinned:
        install_pinned_locks(dest)
    else:
        print("WARNING: --no-pinned-lock — cargo will re-resolve; build is NOT reproducible")
    print(f"Workspace ready at {dest}")
    print("Next: cd that core/ && cargo check --locked -p deltachat --lib --target wasm32-unknown-unknown --no-default-features")
    return 0


def cmd_verify_copy(dest: Path) -> int:
    core = dest / "core" if (dest / "core").is_dir() else dest
    marker = core / ".velta-wasm-patches-applied"
    need = [
        core / "src" / "net" / "ws_tcp.rs",
        core / "src" / "net" / "http_wasm.rs",
        core / "src" / "net" / "proxy_wasm.rs",
    ]
    missing = [str(p) for p in need if not p.is_file()]
    if missing:
        die("verify-copy FAILED, missing:\n  " + "\n  ".join(missing), code=2)
    if not marker.is_file():
        print("warning: marker .velta-wasm-patches-applied missing (patches may have been applied manually)")
    else:
        print(marker.read_text())
    # support layout
    root = core.parent
    shim = root / "crates" / "velta-tokio-wasm" / "Cargo.toml"
    if not shim.is_file():
        die(f"verify-copy FAILED: missing {shim}", code=2)
    pin = core / ".velta-wasm-pinned-lock"
    if pin.is_file():
        bad = []
        if _sha256_file(core / "Cargo.lock") != _sha256_file(CORE_LOCK):
            bad.append(f"{core / 'Cargo.lock'} differs from {CORE_LOCK}")
        wl = root / WRAPPER_REL / "Cargo.lock"
        if wl.is_file() and _sha256_file(wl) != _sha256_file(WRAPPER_LOCK):
            bad.append(f"{wl} differs from {WRAPPER_LOCK}")
        if bad:
            die("verify-copy FAILED (pinned lock drift):\n  " + "\n  ".join(bad), code=2)
        print("pinned locks: OK (copy locks == support/locks/)")
    else:
        print("warning: copy was made with --no-pinned-lock (unpinned resolve)")
    print(f"verify-copy OK: {core}")
    return 0


def cmd_apply_refuse_master() -> int:
    die(
        "REFUSED: bare `apply` does not modify master core/.\n"
        "Use: python3 tools/apply-wasm-core-patches.py apply-on-copy\n"
        "See docs/research/wasm-patches/README.md.",
        code=2,
    )
    return 2


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "op",
        nargs="?",
        default="status",
        choices=[
            "status",
            "verify",
            "list",
            "apply",
            "apply-on-copy",
            "verify-copy",
            "lock-status",
            "refresh-lock",
        ],
    )
    ap.add_argument(
        "--dest",
        type=Path,
        default=DEFAULT_DEST,
        help=f"workspace root for apply-on-copy (default: {DEFAULT_DEST})",
    )
    ap.add_argument(
        "--i-know-this-writes-to-master-core",
        action="store_true",
        help="dangerous: allow applying onto master core/ (not for CI)",
    )
    ap.add_argument(
        "--no-pinned-lock",
        action="store_true",
        help="apply-on-copy without installing support/locks/ (unpinned, exploratory)",
    )
    args = ap.parse_args(argv[1:])

    if args.op in ("status", "verify"):
        return cmd_status()
    if args.op == "list":
        return cmd_list()
    if args.op == "apply":
        return cmd_apply_refuse_master()
    if args.op == "apply-on-copy":
        return cmd_apply_on_copy(
            args.dest, args.i_know_this_writes_to_master_core, pinned=not args.no_pinned_lock
        )
    if args.op == "lock-status":
        return cmd_lock_status()
    if args.op == "refresh-lock":
        if args.dest == DEFAULT_DEST:
            die("refresh-lock needs an explicit scratch --dest", code=2)
        return cmd_refresh_lock(args.dest)
    if args.op == "verify-copy":
        return cmd_verify_copy(args.dest)
    die(f"unknown op {args.op}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
