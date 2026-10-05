#!/usr/bin/env python3
"""apply-wasm-core-patches.py — opt-in landing path for Velta's wasm core ports.

This is NOT a fork of experintellia/slothfulchat-web. Velta owns a forward-port
of chatmail/core 2.62+ for wasm32 (today living in a side tree on the spike
host). We reuse MPL-2.0 (or dual MPL/GPL) *ideas* from the prototype patches;
we do not import the GPL web app / desktop UI.

Relationship to tools/apply-core-patches.py:
  - apply-core-patches.py  → Velta's 13 production patches (Android/desktop).
  - THIS script            → wasm32-only ports; MUST stay opt-in so native CI
                             and production AppImage/APK builds never apply it.

Current status (Day 5):
  Source of truth is still the side tree (see docs/research/wasm-patches/).
  Discrete patch files are not yet extracted into this repo. `apply` refuses
  to modify master `core/` until that extraction lands and is reviewed.

Usage (from repo root):
  python3 tools/apply-wasm-core-patches.py status
  python3 tools/apply-wasm-core-patches.py list
  python3 tools/apply-wasm-core-patches.py apply   # refused until patches exist
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
README = os.path.join(ROOT, "docs", "research", "wasm-patches", "README.md")

# Planned WASM-CORE units (names match spike inventory). Empty until extracted
# from the side tree into docs/research/wasm-patches/*.patch (or equivalent).
PLANNED = [
    "0001-wasm-target-gate-deps-tokio-shim-rusqlite",
    "0002-wasm-deltachat-time-js-clock",
    "0003-wasm-http-proxy-stubs-rustls-ring",
    "0004-wasm-fs-shim-path_exists",
    "0005-wasm-ws-tcp-imap-smtp",
    "0006-wasm-js-clock-call-sites",
    "0007-wasm-blob-sync-fs",
    "0010-wasm-http-fetch",
    # plus Velta-specific follow-ups: mail-builder 0.5 web-time, wasm connect_tcp
]


def cmd_status() -> int:
    print("Velta wasm core patch home: OPT-IN (this script), not applied to master core/.")
    print("Ownership: Velta-owned port of chatmail core 2.62+ (not a slothfulchat-web fork).")
    print(f"Docs: {README}")
    print(f"Planned units: {len(PLANNED)} (none extracted into-repo yet).")
    print("Side tree (spike host): /workspace/velta-wasm-port — Day 4 artifact + Day 5 native check.")
    print("Master core/: untouched by this tool until `apply` is implemented for real patches.")
    return 0


def cmd_list() -> int:
    for name in PLANNED:
        print(f"  [planned] {name}")
    return 0


def cmd_apply() -> int:
    print(
        "REFUSED: no discrete wasm patch files in docs/research/wasm-patches/ yet.\n"
        "Source of truth remains the side tree. Do not merge experimental core into\n"
        "master core/ until native+wasm gates are green and patches are reviewed.\n"
        "See docs/research/wasm-patches/README.md.",
        file=sys.stderr,
    )
    return 2


def main(argv: list[str]) -> int:
    op = (argv[1] if len(argv) > 1 else "status").lower()
    if op in ("status", "verify"):
        return cmd_status()
    if op == "list":
        return cmd_list()
    if op == "apply":
        return cmd_apply()
    print(__doc__)
    print(f"Unknown op: {op}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
