# SQLCipher upgrade/rollback harness (Day 11, scratch tool)

Not built by CI and never part of `core/`. Reproduces the Day 11 test of the
series' native SQLCipher bump (libsqlite3-sys 0.35→0.38.2 ⇒ SQLCipher
4.6.1→4.14.0) on a real-schema Velta account DB.

```sh
# two crates sharing main.rs; outside the repo
for n in stock series; do mkdir -p /tmp/sqlc/$n/src; cp main.rs /tmp/sqlc/$n/src/; done
# stock  -> deltachat = { path = "<repo>/core" },                 rusqlite = "=0.37.0"; cp core/Cargo.lock
# series -> deltachat = { path = "<apply-on-copy>/core" },         rusqlite = "=0.40.2"; cp <copy>/core/Cargo.lock
# + anyhow = "1", tokio = { version = "1", features = ["full"] }, empty [workspace]
cargo build --release   # in each (rustup stable, not /usr/bin rustc 1.85)

S=stock/target/release/d11-sqlc-stock; N=series/target/release/d11-sqlc-series
db=/tmp/sqlc/run/dc.db; P=""    # P="s3cret" for the legacy encrypted mode
$S write $db "$P" 1-stock-create      # 4.6.1 creates via full migrations
$N read  $db "$P" 2-series-open       # upgrade: 4.14.0 opens
$N write $db "$P" 3-series-write      # 4.14.0 writes
$S read  $db "$P" 4-rollback-stock-open
$S write $db "$P" 5-rollback-stock-write
$N read  $db "$P" 6-series-reopen
```

Each step prints `cipher_version`, `sqlite_version()`, `integrity_check`,
`dbversion`, row counts and `ui.d11.*` marker rows.
