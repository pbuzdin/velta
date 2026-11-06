//! Sidecar lifecycle + JSON-RPC line routing (#201 / #205).
//!
//! Parse each stdout line once and route on the *envelope* `id`. A nested
//! object that happens to carry `"id"` must not steal the dispatch.

use serde::Deserialize;
#[cfg(not(target_os = "android"))]
use tauri::{Emitter, Manager};

#[cfg(not(target_os = "android"))]
use crate::webxdc_serve::webxdc_resolve_line;
#[cfg(not(target_os = "android"))]
use crate::{accounts_dir, set_attachment_db_key, set_sidecar_status, Host, RpcState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    /// Envelope id starts with `wxdc-`.
    Webxdc,
    /// Envelope has some other id — try `resolve_web_line`, else emit.
    Web,
    /// No envelope id, or the line is not JSON: emit as `velta-rpc`.
    Emit,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    id: Option<serde_json::Value>,
}

pub(crate) fn route_sidecar_line(line: &str) -> Route {
    let Ok(env) = serde_json::from_str::<Envelope>(line) else {
        return Route::Emit;
    };
    match env.id {
        Some(serde_json::Value::String(id)) if id.starts_with("wxdc-") => Route::Webxdc,
        Some(_) => Route::Web,
        None => Route::Emit,
    }
}

#[cfg(not(target_os = "android"))]
use std::fs::OpenOptions;
#[cfg(not(target_os = "android"))]
use std::io::{BufRead, BufReader};
#[cfg(not(target_os = "android"))]
use std::process::{Command, Stdio};
#[cfg(not(target_os = "android"))]
use std::sync::Mutex;

/// The live sidecar process, so a lock/unlock can respawn it (the key rides
/// the process env, so re-keying means a new process).
#[cfg(not(target_os = "android"))]
static SIDECAR_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
const SIDECAR_NAME: &str = "deltachat-rpc-server.exe";
#[cfg(target_os = "macos")]
const SIDECAR_NAME: &str = "deltachat-rpc-server";
// #295: Linux packages install Velta's core as /usr/bin/velta-rpc-server so
// they never clash with distro `deltachat-rpc-server` packages. Only
// absolute candidates below are tried; PATH is never searched.
#[cfg(all(unix, not(any(target_os = "macos", target_os = "android"))))]
const SIDECAR_NAME: &str = "velta-rpc-server";

#[cfg(not(target_os = "android"))]
fn find_sidecar(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::path::BaseDirectory;

    let candidates = [
        app.path()
            .resolve(SIDECAR_NAME, BaseDirectory::Resource)
            .ok(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join(SIDECAR_NAME))),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("resources").join(SIDECAR_NAME))),
        std::env::current_exe()
            .ok()
            .and_then(|p| {
                p.parent()
                    .map(|p| p.join("..").join("resources").join(SIDECAR_NAME))
            })
            .map(|p| p.canonicalize().unwrap_or(p)),
    ];

    candidates.into_iter().flatten().find(|c| c.is_file())
}

/// Spawn (or respawn) the rpc-server sidecar with `key` as its env. The
/// reader thread rides each spawn; the child stays in SIDECAR_CHILD so the
/// next spawn (lock/unlock respawn) can kill it — never hand it to a
/// wait thread, or the respawn would leak the previous core next to the
/// new one. The managed RpcState only has its stdin swapped on a respawn.
/// `first` runs the one-time proxy boots. `probe_db_lock` is the caller's job.
#[cfg(not(target_os = "android"))]
pub(crate) fn spawn_sidecar(app: &tauri::AppHandle, key: Option<String>, first: bool) {
    set_attachment_db_key(key.as_deref());
    if let Some(mut child) = SIDECAR_CHILD.lock().unwrap().take() {
        crate::log("stopping the previous sidecar");
        let _ = child.kill();
        let _ = child.wait();
    }
    let accounts = accounts_dir(app);
    let Some(sidecar_path) = find_sidecar(app) else {
        crate::log(
            "sidecar not found; continuing with mock/remote transports available to frontend",
        );
        set_sidecar_status(
            app,
            serde_json::json!({"running": false, "stage": "missing", "error": "sidecar not found"}),
        );
        return;
    };
    crate::log(&format!("starting sidecar at {}", sidecar_path.display()));
    set_sidecar_status(
        app,
        serde_json::json!({"running": true, "stage": "starting"}),
    );

    let stderr_file = crate::log::log_dir().join("sidecar-stderr.log");
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_file)
        .map(Stdio::from)
        .unwrap_or_else(|e| {
            crate::log(&format!(
                "could not open sidecar stderr log: {e}; sending stderr to null"
            ));
            Stdio::null()
        });

    let mut cmd = Command::new(&sidecar_path);
    if let Some(raw) = &key {
        cmd.env("VELTA_DB_KEY", raw);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd
        .current_dir(&accounts)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .spawn()
    {
        Ok(mut child) => {
            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            *SIDECAR_CHILD.lock().unwrap() = Some(child);
            match app.try_state::<RpcState>() {
                Some(st) => st.replace_stdin(stdin),
                None => {
                    app.manage(RpcState::desktop(stdin));
                }
            }
            crate::log("boot: sidecar spawned");
            crate::log("boot: rpc session ready");
            set_sidecar_status(app, serde_json::json!({"running": true, "stage": "ready"}));
            if first {
                // Re-apply the selected SOCKS5 proxy before the page can start IO.
                crate::proxy::boot(&Host::from_app(app));
                crate::ws_transport::boot(&Host::from_app(app));
                crate::log("boot: transports booted");
            }

            let app_handle = app.clone();
            std::thread::spawn(move || {
                crate::log("sidecar reader thread started");
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    match line {
                        Ok(line) => {
                            // NOTE: do not log every line -- it's the
                            // hot path. Route on the typed envelope id
                            // (#201); malformed JSON is still emitted.
                            match route_sidecar_line(&line) {
                                Route::Webxdc => {
                                    webxdc_resolve_line(&app_handle, &line);
                                }
                                Route::Web => {
                                    if !resolve_web_line(&app_handle, &line) {
                                        app_handle.emit("velta-rpc", line).ok();
                                    }
                                }
                                Route::Emit => {
                                    app_handle.emit("velta-rpc", line).ok();
                                }
                            }
                        }
                        Err(e) => {
                            crate::log(&format!("sidecar stdout error: {e}"));
                        }
                    }
                }
                crate::log("sidecar reader thread ended");
                set_sidecar_status(
                    &app_handle,
                    serde_json::json!({"running": false, "stage": "stopped"}),
                );
            });

            // The child stays in SIDECAR_CHILD: the reader thread above
            // reports "stopped" when stdout closes, and the next spawn's
            // kill()+wait() reaps it. Taking it here would make every
            // respawn (lock/unlock) leak the previous keyed core.
        }
        Err(e) => {
            crate::log(&format!("failed to start sidecar: {e}"));
            set_sidecar_status(
                app,
                serde_json::json!({"running": false, "stage": "error", "error": e.to_string()}),
            );
        }
    }
}

#[cfg(not(target_os = "android"))]
fn resolve_web_line(app: &tauri::AppHandle, line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    let id = match value.get("id") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(n) if n.is_number() => n.to_string(),
        _ => return false,
    };
    let state = app.state::<RpcState>();
    match state.take_web_pending(&id) {
        Some(tx) => {
            let _ = tx.send(line.to_string());
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_id_is_not_the_envelope_id() {
        let nested_wxdc = r#"{"jsonrpc":"2.0","id":"web-1","result":{"id":"wxdc-nested","foo":1}}"#;
        assert_eq!(
            route_sidecar_line(nested_wxdc),
            Route::Web,
            "top-level id wins; nested wxdc- must not route as webxdc"
        );

        let top_wxdc = r#"{"jsonrpc":"2.0","id":"wxdc-abc","result":{"id":"other"}}"#;
        assert_eq!(route_sidecar_line(top_wxdc), Route::Webxdc);

        let nested_only = r#"{"jsonrpc":"2.0","method":"event","params":{"id":"wxdc-nested"}}"#;
        assert_eq!(
            route_sidecar_line(nested_only),
            Route::Emit,
            "no top-level id → emit, even if a nested id looks like wxdc-"
        );
    }

    #[test]
    fn malformed_json_is_still_emitted() {
        assert_eq!(route_sidecar_line("not json"), Route::Emit);
        assert_eq!(route_sidecar_line(""), Route::Emit);
        assert_eq!(route_sidecar_line("{"), Route::Emit);
    }

    #[test]
    fn numeric_and_null_ids() {
        assert_eq!(route_sidecar_line(r#"{"id":1,"result":{}}"#), Route::Web);
        assert_eq!(
            route_sidecar_line(r#"{"id":null,"result":{}}"#),
            Route::Emit
        );
        assert_eq!(route_sidecar_line(r#"{"result":{}}"#), Route::Emit);
    }
}
