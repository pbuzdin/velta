//! #424: desktop sidecar built from the SAME shim crate as the KMP cdylib.
//!
//! A small, deliberate re-implementation of what `deltachat-rpc-server` does:
//! one yerpc JSON-lines session over stdio — a line on stdin is `sendLine`,
//! an `emit_line` from the session is a line on stdout, framing
//! byte-compatible. Everything Velta adds in the shim (keyed-DB migration
//! `db_key`, the p2p loop, attachment crypto) rides along automatically,
//! which is the point of the unification: "the shim supports X" is a single
//! fact again.
//!
//! Desktop keeps a sidecar PROCESS (crash isolation preserved); Android
//! keeps the in-process cdylib. JSON-RPC stays the only core contract.
//!
//! Env, mirroring the JNI `startCore` arguments:
//! - `VELTA_ACCOUNTS_DIR` — accounts root (required)
//! - `VELTA_DB_KEY` — 64-hex DEK; empty/absent = keyless (upstream behavior)

use std::io::BufRead;

fn main() {
    // release-version-pins.test.mjs runs this before anything else: print the
    // vendored core's version (the binary's identity) and exit.
    if std::env::args().any(|a| a == "--version") {
        println!("velta-rpc-server {}", deltachat::constants::DC_VERSION_STR.trim());
        return;
    }
    let accounts_dir = match std::env::var("VELTA_ACCOUNTS_DIR") {
        Ok(dir) if !dir.is_empty() => dir,
        _ => {
            eprintln!("velta-rpc-server: VELTA_ACCOUNTS_DIR is required");
            std::process::exit(2);
        }
    };
    let db_key = std::env::var("VELTA_DB_KEY").unwrap_or_default();

    // Same start path the JNI entry uses: db-key prepare + worker + session.
    if velta_rpc_shim::start_core(accounts_dir, db_key) != 1 {
        eprintln!("velta-rpc-server: core failed to start");
        std::process::exit(1);
    }

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.is_empty() {
            continue;
        }
        // -1 = no live session (worker died): stop pumping, the shell
        // notices via the sidecar-status surface and respawns us.
        if velta_rpc_shim::send_line(line) != 0 {
            break;
        }
    }
    velta_rpc_shim::stop_core();
}
