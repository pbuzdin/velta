//! SOCKS5 proxy support (every native app: Android, Windows, macOS, Linux).
//!
//! The user adds a proxy with a `velta://proxy?…` link (paste, deep link, QR
//! code, chat card); several can be saved (`proxies.json` in the app's data
//! dir), one or none is active. The active proxy's URL is written into every
//! profile's `proxy_url`/`proxy_enabled` by the keeper below — the same job
//! the archived DNS tunnel's keeper did, except there is no local listener:
//! the proxy is a server the user (or a friend) runs, on this device, the
//! LAN or the internet.
//!
//! A proxy_url the user configured themselves is never replaced: the keeper
//! only touches values it wrote (`last_written` in the store), the
//! WebSocket transport's `socks5://velta-ws:` URLs, and stale
//! `socks5://velta-tunnel:` URLs left by the archived DNS tunnel (those
//! point at a 127.0.0.1 port nothing listens on anymore and are cleared).
//!
//! The SOCKS5 proxy and the WebSocket transport are mutually exclusive (the
//! core has one proxy_url): activating one turns the other off.
//!
//! Everything platform-specific sits in `platform` (the core's accounts are
//! reached through the in-process accounts manager on Android, JSON-RPC to
//! the sidecar on the desktops).

use serde_json::Value;

/// The saved proxies (pure list logic, unit-tested on any host).
#[path = "proxy_store.rs"]
pub mod store;

#[cfg(target_os = "android")]
#[path = "proxy_android.rs"]
mod platform;
#[cfg(not(target_os = "android"))]
#[path = "proxy_desktop.rs"]
mod platform;

/// Resume diagnostic (Android): account lock latency and connectivity.
#[cfg(target_os = "android")]
pub async fn log_resume_state() {
    platform::log_resume_state().await
}

mod imp {
    use super::platform;
    use super::store;
    use serde_json::Value;
    use std::collections::{HashSet, VecDeque};
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    /// The WebSocket transport's proxy URL (ws_transport.rs). The same
    /// keeper writes it; a selected SOCKS5 proxy wins if both are ever set.
    static WS_PROXY_URL: Mutex<Option<String>> = Mutex::new(None);
    static APPLIER: OnceLock<()> = OnceLock::new();
    /// Serializes install/select/delete.
    static OP: Mutex<()> = Mutex::new(());
    static HOST: Mutex<Option<crate::Host>> = Mutex::new(None);
    /// Accounts being exported or transferred: our proxy is kept off them so
    /// a backup never carries this device's proxy settings.
    static DETACHED: Mutex<Option<HashSet<u32>>> = Mutex::new(None);
    /// Recent shell-side proxy events for the Velta Diagnostics chat. Kept
    /// here (not only emitted) so lines logged while the WebView sleeps are
    /// still shown once it polls proxy_status.
    static SHELL_EVENTS: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());

    /// The archived DNS tunnel's marker: a stale value is keeper-owned and
    /// cleared on sight (its local port is gone with the tunnel).
    const LEGACY_TUNNEL: &str = "socks5://velta-tunnel:";

    #[cfg(not(target_os = "android"))]
    pub(super) fn app_handle() -> Option<tauri::AppHandle> {
        HOST.lock().unwrap().as_ref().and_then(|h| h.app().cloned())
    }

    fn is_detached(id: u32) -> bool {
        DETACHED.lock().unwrap().as_ref().is_some_and(|s| s.contains(&id))
    }

    /// Logs a proxy event to the shell log and the diagnostics ring, and
    /// wakes the page so it shows up in Velta Diagnostics at once.
    fn plog(level: &str, msg: &str) {
        crate::log(&format!("proxy: {msg}"));
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        {
            let mut ring = SHELL_EVENTS.lock().unwrap();
            ring.push_back(serde_json::json!({"t_ms": ms, "level": level, "msg": msg}));
            while ring.len() > 100 {
                ring.pop_front();
            }
        }
        let host = HOST.lock().unwrap().clone();
        if let Some(host) = host {
            host.emit("velta-proxy-log", ());
        }
    }

    fn data_dir(app: &crate::Host) -> Option<PathBuf> {
        app.data_dir()
    }

    fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
    }

    /// The saved proxies.
    pub fn load_store(app: &crate::Host) -> Value {
        let Some(dir) = data_dir(app) else { return store::empty() };
        if let Ok(s) = std::fs::read_to_string(dir.join(store::FILE)) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                if v.is_object() {
                    return v;
                }
            }
        }
        store::empty()
    }

    fn save_store(app: &crate::Host, st: &Value) -> Result<(), String> {
        let dir = data_dir(app).ok_or("no app data dir")?;
        let _ = std::fs::create_dir_all(&dir);
        // Write-then-rename: a crash mid-write never loses the list.
        let tmp = dir.join(format!("{}.tmp", store::FILE));
        std::fs::write(&tmp, serde_json::to_string(st).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, dir.join(store::FILE)).map_err(|e| e.to_string())
    }

    /// The proxy_url a profile should carry: the selected SOCKS5 proxy, else
    /// the WebSocket transport's local listener, else none.
    fn desired(st: &Value) -> Option<String> {
        store::active_url(st).or_else(|| WS_PROXY_URL.lock().unwrap().clone())
    }

    /// Is this proxy_url one the keeper may overwrite? What it last wrote,
    /// the WebSocket transport's own, or a stale DNS tunnel listener — never
    /// a proxy the user configured by hand.
    fn ours(cur: &str, st: &Value) -> bool {
        cur.starts_with(crate::ws_transport::OURS)
            || cur.starts_with(LEGACY_TUNNEL)
            || Some(cur) == st["last_written"].as_str()
            || Some(cur) == store::active_url(st).as_deref()
    }

    /// Keeps every profile's proxy_url in line with the selected proxy (on
    /// install, on removal, and every minute so profiles added later pick it
    /// up). Runs wherever the core runs, including the Android headless core.
    fn start_applier(app: crate::Host) {
        APPLIER.get_or_init(|| {
            tauri::async_runtime::spawn(async move {
                loop {
                    apply_proxy().await;
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                }
            });
        });
    }

    pub(super) async fn apply_proxy() {
        let Some(host) = HOST.lock().unwrap().clone() else { return };
        let Some(ids) = platform::account_ids().await else { return };
        let st = load_store(&host);
        let desired = desired(&st);
        for id in ids {
            let Some((cur, enabled)) = platform::proxy_config(id).await else { continue };
            // An account in the middle of an export gets no proxy.
            let desired = if is_detached(id) { None } else { desired.clone() };
            let ours = ours(&cur, &st);
            let mut changed = false;
            let result = match &desired {
                // A proxy the user set up themselves wins over ours.
                Some(_) if !cur.trim().is_empty() && !ours => Ok(()),
                Some(url) => {
                    let mut r = Ok(());
                    if &cur != url {
                        r = platform::set_config(id, "proxy_url", Some(url.as_str())).await;
                        changed = true;
                    }
                    if r.is_ok() && !enabled {
                        r = platform::set_config(id, "proxy_enabled", Some("1")).await;
                        changed = true;
                    }
                    r
                }
                None if ours => {
                    changed = true;
                    let r = platform::set_config(id, "proxy_url", None).await;
                    if r.is_ok() { platform::set_config(id, "proxy_enabled", Some("0")).await } else { r }
                }
                None => Ok(()),
            };
            if let Err(e) = result {
                plog("warning", &format!("proxy update for account {id} failed: {e}"));
            } else if changed {
                // set_config only affects NEW connections: without a restart
                // the open IMAP/SMTP sessions keep bypassing (or keep using)
                // the proxy until they drop on their own.
                plog("info", &format!("proxy {} for account {id}; restarting its IO", if desired.is_some() { "set" } else { "cleared" }));
                platform::restart_io(id).await;
            }
        }
        // Remember what the keeper wrote: that is what "ours" means on the
        // next run, after the app restarted.
        if st["last_written"].as_str() != desired.as_deref() {
            let mut st = st;
            st["last_written"] = desired.as_deref().map(Value::from).unwrap_or(Value::Null);
            if let Err(e) = save_store(&host, &st) {
                plog("warning", &format!("couldn't save the proxy list: {e}"));
            }
        }
    }

    /// Called once the core is up: point the profiles at the selected proxy.
    pub fn boot(app: &crate::Host) {
        *HOST.lock().unwrap() = Some(app.clone());
        // Always run the proxy keeper, selected proxy or not: a profile
        // restored from a backup (or received from another device) can carry
        // a stale proxy (this device's LAN address, the archived tunnel's
        // local port), which stops all its mail. The keeper clears or
        // updates it.
        start_applier(app.clone());
        tauri::async_runtime::spawn(apply_proxy());
    }

    /// The WebSocket transport's proxy: stored here and written by the same
    /// keeper (a selected SOCKS5 proxy wins; normally the two are never on
    /// at once).
    pub fn set_ws_proxy(url: Option<String>) {
        *WS_PROXY_URL.lock().unwrap() = url;
        tauri::async_runtime::spawn(async {
            apply_proxy().await;
            // Same proxy URL, other upstream: reconnect now.
            platform::maybe_network().await;
        });
    }

    /// A SOCKS5 proxy is selected in the saved list.
    pub fn socks_proxy_active(app: &crate::Host) -> bool {
        store::active_id(&load_store(app)).is_some()
    }

    /// The WebSocket transport is being turned on: deselect the proxy.
    pub fn deactivate_for_ws(app: &crate::Host) {
        if socks_proxy_active(app) {
            let _ = select(app, None);
            plog("info", "stopped: the WebSocket transport is in use now");
        }
    }

    /// Commands also remember the host so an early deep link can apply a proxy.
    fn touch(app: &crate::Host) {
        *HOST.lock().unwrap() = Some(app.clone());
    }

    pub fn install(app: &crate::Host, host: &str, port: u64, user: &str, pass: &str, label: &str, activate: bool) -> Result<Value, String> {
        touch(app);
        let _g = OP.lock().unwrap();
        let mut st = load_store(app);
        let (id, existing) = store::add(&mut st, host, port, user, pass, label, now())?;
        if activate {
            store::select(&mut st, Some(id.as_str()))?;
        }
        save_store(app, &st)?;
        plog("info", &format!("proxy {id} {}", if existing { "already saved" } else { "saved" }));
        if activate {
            // One at a time: the proxy and the WebSocket transport both set
            // the profiles' proxy.
            #[cfg(any(target_os = "android", windows))]
            crate::ws_transport::deactivate_for_proxy(app);
            tauri::async_runtime::spawn(async {
                apply_proxy().await;
                platform::maybe_network().await;
            });
        }
        Ok(serde_json::json!({"id": id, "existing": existing}))
    }

    /// Saved proxies for the settings sheet (no passwords).
    pub fn list(app: &crate::Host) -> Value {
        store::public_list(&load_store(app))
    }

    /// Activates a saved proxy, or none (mail connects directly).
    pub fn select(app: &crate::Host, id: Option<&str>) -> Result<(), String> {
        touch(app);
        let _g = OP.lock().unwrap();
        let mut st = load_store(app);
        store::select(&mut st, id)?;
        save_store(app, &st)?;
        match id {
            Some(id) => {
                plog("info", &format!("switching to proxy {id}"));
                #[cfg(any(target_os = "android", windows))]
                crate::ws_transport::deactivate_for_proxy(app);
                tauri::async_runtime::spawn(async {
                    apply_proxy().await;
                    // Same proxy URL, new proxy: reconnect now.
                    platform::maybe_network().await;
                });
            }
            None => {
                plog("info", "no proxy selected; mail connects directly");
                tauri::async_runtime::spawn(apply_proxy());
            }
        }
        Ok(())
    }

    pub fn rename(app: &crate::Host, id: &str, label: &str) -> Result<(), String> {
        let _g = OP.lock().unwrap();
        let mut st = load_store(app);
        store::rename(&mut st, id, label)?;
        save_store(app, &st)
    }

    /// Deletes a saved proxy; deleting the active one takes it off the
    /// profiles (mail connects directly).
    pub fn delete(app: &crate::Host, id: &str) -> Result<(), String> {
        touch(app);
        let _g = OP.lock().unwrap();
        let mut st = load_store(app);
        let was_active = store::delete(&mut st, id)?;
        save_store(app, &st)?;
        if was_active {
            tauri::async_runtime::spawn(apply_proxy());
        }
        plog("info", &format!("proxy {id} deleted{}", if was_active { "; mail connects directly" } else { "" }));
        Ok(())
    }

    /// What a share link needs: the server, credentials and label. Default:
    /// the active proxy.
    pub fn link(app: &crate::Host, id: Option<&str>) -> Result<Value, String> {
        let st = load_store(app);
        let id = id.or(store::active_id(&st)).ok_or("No SOCKS5 proxy is set up")?;
        store::link(&st, id).ok_or_else(|| "No such proxy".into())
    }

    pub fn status(app: &crate::Host) -> Value {
        let st = load_store(app);
        let active = store::active_id(&st).and_then(|id| store::find(&st, id)).cloned();
        let mut v = serde_json::json!({
            // installed: at least one proxy is saved (the drawer row shows).
            "installed": !store::proxies(&st).is_empty(),
            "count": store::proxies(&st).len(),
            "active": active.as_ref().map_or(Value::Null, |p| p["id"].clone()),
            "active_label": active.as_ref().map_or(Value::Null, |p| p["label"].clone()),
            "host": active.as_ref().map_or(Value::Null, |p| p["host"].clone()),
            "port": active.as_ref().map_or(Value::Null, |p| p["port"].clone()),
            "auth": active.as_ref().is_some_and(|p| !p["user"].as_str().unwrap_or("").is_empty()),
            "ws_active": WS_PROXY_URL.lock().unwrap().is_some(),
        });
        v["shell_events"] = Value::from(SHELL_EVENTS.lock().unwrap().iter().cloned().collect::<Vec<_>>());
        v
    }

    /// Before a backup export or a second-device transfer: drop our proxy
    /// from the account (and keep it off) so the backup doesn't carry it.
    pub async fn backup_begin(id: u32) {
        DETACHED.lock().unwrap().get_or_insert_with(HashSet::new).insert(id);
        apply_proxy().await;
        plog("info", &format!("account {id}: proxy removed for a backup or transfer"));
    }

    pub async fn backup_end(id: u32) {
        if let Some(s) = DETACHED.lock().unwrap().as_mut() {
            s.remove(&id);
        }
        apply_proxy().await;
    }

    /// After an import or a received transfer: fix the new profile's proxy
    /// now instead of at the next minute tick.
    pub async fn reapply() {
        apply_proxy().await;
    }
}

pub use imp::{boot, deactivate_for_ws, set_ws_proxy, socks_proxy_active};

/// Points every profile at the selected proxy now (boot: before IO starts).
pub async fn reapply_proxy() {
    imp::reapply().await;
}

#[tauri::command]
pub async fn proxy_install(app: tauri::AppHandle, host: String, port: u64, user: Option<String>, password: Option<String>, label: Option<String>, activate: Option<bool>) -> Result<Value, String> {
    imp::install(
        &crate::Host::from_app(&app),
        &host,
        port,
        user.as_deref().unwrap_or(""),
        password.as_deref().unwrap_or(""),
        label.as_deref().unwrap_or(""),
        activate.unwrap_or(true),
    )
}

#[tauri::command]
pub async fn proxy_list(app: tauri::AppHandle) -> Value {
    imp::list(&crate::Host::from_app(&app))
}

/// id null: no proxy (mail connects directly).
#[tauri::command]
pub async fn proxy_select(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    imp::select(&crate::Host::from_app(&app), id.as_deref())
}

#[tauri::command]
pub async fn proxy_rename(app: tauri::AppHandle, id: String, label: String) -> Result<(), String> {
    imp::rename(&crate::Host::from_app(&app), &id, &label)
}

#[tauri::command]
pub async fn proxy_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    imp::delete(&crate::Host::from_app(&app), &id)
}

#[tauri::command]
pub async fn proxy_link(app: tauri::AppHandle, id: Option<String>) -> Result<Value, String> {
    imp::link(&crate::Host::from_app(&app), id.as_deref())
}

#[tauri::command]
pub async fn proxy_status(app: tauri::AppHandle) -> Value {
    imp::status(&crate::Host::from_app(&app))
}

#[tauri::command]
pub async fn proxy_backup_begin(account_id: u32) -> Result<(), String> {
    imp::backup_begin(account_id).await;
    Ok(())
}

#[tauri::command]
pub async fn proxy_backup_end(account_id: u32) -> Result<(), String> {
    imp::backup_end(account_id).await;
    Ok(())
}

#[tauri::command]
pub async fn proxy_reapply() -> Result<(), String> {
    imp::reapply().await;
    Ok(())
}
