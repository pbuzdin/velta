SOCKS5 proxy completion archive

The following part files contain one Base64-encoded ZIP split at 45,000-byte boundaries:
  part-00 ... part-16 (when all parts are present)

On Linux/macOS, from this directory:
  cat part-* > SOCKS5-proxy-completion.zip.b64
  base64 -d SOCKS5-proxy-completion.zip.b64 > SOCKS5-proxy-completion.zip

Expected ZIP SHA-256:
  c6e11e5543d18ebbc0c00605c07ad99f3e55dbbccbfe1b4fb710cb9109987199

Apply to feat/socks5-proxy at bb5c606a2116af686b53374b515d4a8d1fe0d13e:
1. Extract the ZIP over the repository root, preserving paths.
2. Delete every path listed in DELETE-OLD-DNS-FILES.txt.
3. Review with: git status --short && git diff --stat
4. Run: node --test tests/
5. Commit and push. Rust compilation must run in CI.

Verification at packaging time: 1,228 JavaScript tests passed, 0 failed.

After committing the extracted changes, remove this .agent-artifacts directory.
