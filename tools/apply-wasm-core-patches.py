#!/usr/bin/env python3
"""apply-wasm-core-patches.py — opt-in wasm ports for Velta's chatmail core.

Velta-owned forward-port of chatmail/core 2.62+ for wasm32. Reuses MPL patch
*ideas* only — not a fork of slothfulchat-web; no GPL UI.

Relationship to tools/apply-core-patches.py:
  - apply-core-patches.py  → Velta's 13 production patches (Android/desktop).
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
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCH_HOME = ROOT / "docs" / "research" / "wasm-patches"
SERIES_DIR = PATCH_HOME / "series"
SERIES_FILE = PATCH_HOME / "SERIES"
SUPPORT = PATCH_HOME / "support"
README = PATCH_HOME / "README.md"
DEFAULT_DEST = ROOT / ".wasm-core-apply"
MASTER_CORE = ROOT / "core"


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
            die(f"missing patch listed in SERIES: {p}")
        out.append(p)
    return out


def cmd_status() -> int:
    patches = series_patches() if SERIES_DIR.is_dir() else []
    print("Velta wasm core patch home: OPT-IN.")
    print("Ownership: Velta-owned port of chatmail core 2.62+ (not a slothfulchat-web fork).")
    print(f"Docs: {README}")
    print(f"Patches extracted: {len(patches)} in {SERIES_DIR}")
    print(f"Support crates: {SUPPORT}")
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
    if not (SUPPORT / "crates" / "tokio-wasm-shim").is_dir():
        die(f"support shim missing: {SUPPORT / 'crates' / 'tokio-wasm-shim'}")
    dest_root.mkdir(parents=True, exist_ok=True)
    core_dst = dest_root / "core"
    print(f"Copying master core/ → {core_dst}")
    _copy_tree(MASTER_CORE, core_dst)
    print(f"Copying support crates → {dest_root}")
    _copy_tree(SUPPORT / "crates", dest_root / "crates")
    _copy_tree(SUPPORT / "vendor-crates", dest_root / "vendor-crates")
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


def cmd_apply_on_copy(dest: Path, force_master: bool) -> int:
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
        if not (crates / "tokio-wasm-shim").exists():
            _copy_tree(SUPPORT / "crates", crates)
        if not (vendors / "async-imap").exists():
            _copy_tree(SUPPORT / "vendor-crates", vendors)
        return 0

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
        return 0

    core_dir = prepare_copy(dest)
    apply_patches_to_core(core_dir)
    print(f"Workspace ready at {dest}")
    print("Next: cd that core/ && cargo check -p deltachat --lib --target wasm32-unknown-unknown --no-default-features")
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
    shim = root / "crates" / "tokio-wasm-shim" / "Cargo.toml"
    if not shim.is_file():
        die(f"verify-copy FAILED: missing {shim}", code=2)
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
        choices=["status", "verify", "list", "apply", "apply-on-copy", "verify-copy"],
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
    args = ap.parse_args(argv[1:])

    if args.op in ("status", "verify"):
        return cmd_status()
    if args.op == "list":
        return cmd_list()
    if args.op == "apply":
        return cmd_apply_refuse_master()
    if args.op == "apply-on-copy":
        return cmd_apply_on_copy(args.dest, args.i_know_this_writes_to_master_core)
    if args.op == "verify-copy":
        return cmd_verify_copy(args.dest)
    die(f"unknown op {args.op}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
