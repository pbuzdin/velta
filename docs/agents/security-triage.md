# Security triage — agent notes

Where the security-audit state lives and how to treat scanner findings.

## Surfaces

- `SECURITYAUDIT.MD` — the human ledger: scan identity, triage verdicts,
  per-finding status. Committed (b2a85a3). #24 closed against it.
- `SECURITYAUDIT.TRIAGE.json` (#73) — the MACHINE-READABLE subset: every
  pattern finding triaged as a false positive, keyed by file + sink +
  scanner rule, with the evidence. Static-scan tooling (pre-commit hooks,
  CI scanners) should suppress a hit matching a ledger entry instead of
  blocking. Extend this file (not the MD) when a new FP is triaged.
- `EXPECTED-FINDINGS.MD` — the post-fixture-clean-baseline expectation
  (~230 findings) with per-area user/relay-facing classification.
- `#55` — dependency advisories inherited from the vendored core (iroh /
  deltachat pins); re-check per core bump.

## Policy

Only user-facing and relay-facing findings are acted on; vendored tooling,
dev rigs and fixtures are out of scope. The Mimosa pre-commit hook
hard-blocks commits over the five known first-party FPs when its L3 scan
runs (enforcement is intermittent — disk-pressure dependent, usually
degrading to `scanner_enobufs` warn mode). No rescan can clear pattern FPs
on first-party code: the remedy is the triage ledger, not "fix and rescan".
