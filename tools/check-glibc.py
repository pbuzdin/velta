#!/usr/bin/env python3
"""Reject packaged ELFs whose imported GLIBC versions exceed the baseline."""
import re
import subprocess
import sys
from pathlib import Path


def required_versions(version_info):
    # Definitions describe exports, not requirements. Static ELFs have no needs.
    needs = version_info.partition("Version needs section")[2]
    return [tuple(map(int, v.split(".")))
            for v in re.findall(r"Name: GLIBC_(\d+(?:\.\d+)+)\b", needs)]


def check(limit, roots):
    maximum = (0,)
    count = 0
    failed = False
    for root in roots:
        root = Path(root)
        if not root.exists():
            raise FileNotFoundError(root)
        paths = sorted(root.rglob("*")) if root.is_dir() else [root]
        root_count = 0
        for path in paths:
            # Symlinks point at files already checked, or at host libraries.
            if path.is_symlink() or not path.is_file():
                continue
            with path.open("rb") as stream:
                if stream.read(4) != b"\x7fELF":
                    continue
            info = subprocess.check_output(
                ["readelf", "--version-info", "--wide", str(path)], text=True)
            versions = required_versions(info)
            highest = max(versions, default=(0,))
            maximum = max(maximum, highest)
            count += 1
            root_count += 1
            version = ".".join(map(str, highest)) if versions else "none"
            print(f"{path}: max required GLIBC {version}")
            if highest > limit:
                print(f"ERROR: {path} exceeds GLIBC {'.'.join(map(str, limit))}",
                      file=sys.stderr)
                failed = True
        if not root_count:
            raise ValueError(f"No ELF files found in {root}")
    print(f"Checked {count} ELFs; maximum required GLIBC {'.'.join(map(str, maximum))}")
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("Usage: check-glibc.py MAX_VERSION FILE_OR_DIRECTORY [...]")
    sys.exit(check(tuple(map(int, sys.argv[1].split("."))), sys.argv[2:]))
