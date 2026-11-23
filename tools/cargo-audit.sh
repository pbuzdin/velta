#!/usr/bin/env bash
# Runs cargo-audit on the shipped lockfiles, ignoring only the advisories
# listed in tools/audit-allowlist.txt (#55). Fails on anything new.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
args=()
while read -r id _; do
  [[ -z "$id" || "$id" == \#* ]] && continue
  args+=(--ignore "$id")
done < "$root/tools/audit-allowlist.txt"
rc=0
for d in velta-app/src-tauri velta-kmp/native/rpc-shim; do
  echo "== cargo audit: $d"
  cargo audit --file "$root/$d/Cargo.lock" "${args[@]}" || rc=1
done
exit $rc
