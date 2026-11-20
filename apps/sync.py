#!/usr/bin/env python3
"""Re-sync the static xdcget catalog mirror at velta.cc/apps/ from upstream.

Downloads xdcget-lock.json plus every cache_relname/icon_relname the lock
lists, skips files already present at the right size, prunes anything the
lock no longer lists. Usage:  python apps/sync.py [upstream_base]
"""
import concurrent.futures as cf
import json, pathlib, sys, urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://apps.testrun.org").rstrip("/")
# Apps never listed in our mirror, by app_id — survives re-syncs.
BLOCKLIST = {"muslim-prayer-times"}
HERE = pathlib.Path(__file__).resolve().parent
KEEP = {"xdcget-lock.json", "sync.py"}

def get(rel):
    with urllib.request.urlopen(BASE + "/" + rel, timeout=120) as r:
        return r.read()

def size_of(rel):
    req = urllib.request.Request(BASE + "/" + rel, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers.get("Content-Length") or -1)

def fetch(rel):
    dest = HERE / rel
    try:
        if dest.exists() and dest.stat().st_size == size_of(rel):
            return rel, 0
    except Exception:
        pass
    dest.write_bytes(get(rel))
    return rel, 1

def main():
    lock = [a for a in json.loads(get("xdcget-lock.json")) if a.get("app_id") not in BLOCKLIST]
    need = {"xdcget-lock.json"}
    for a in lock:
        need.add(a["cache_relname"])
        need.add(a["icon_relname"])
    with cf.ThreadPoolExecutor(8) as ex:
        results = list(ex.map(fetch, sorted(need)))
    (HERE / "xdcget-lock.json").write_bytes(get("xdcget-lock.json"))
    gone = 0
    for p in HERE.iterdir():
        if p.is_file() and p.name not in need and p.name not in KEEP:
            p.unlink()
            gone += 1
    total = sum(p.stat().st_size for p in HERE.iterdir() if p.is_file())
    print(f"{len(lock)} apps, {len(need)} files ({sum(n for _, n in results)} fetched, {gone} pruned), {total/1e6:.0f} MB total")

if __name__ == "__main__":
    main()
