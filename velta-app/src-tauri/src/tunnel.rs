//! Optional DNS tunnel (Android and Windows).
//!
//! The soar-tunnel Go library (velta-app/soar-tunnel/cmd/libsoartunnel, a
//! `-buildmode=c-shared` C ABI) is `libsoartunnel.so` in the APK's jniLibs on
//! Android and `soartunnel.dll` next to the sidecar in the Windows bundle;
//! both are loaded at runtime with libloading. It runs a local SOCKS5 proxy that connects directly while the network is
//! normal and through a soar DNS tunnel when the relays are blocked
//! (allowlist-only mobile internet). The core reaches the relays through that
//! proxy via `proxy_url`.
//!
//! Nothing is configured until the user accepts a `velta://tunnel?…` link:
//! the server zone and key never live in this repository. Without the link
//! (or without the library in the build) the app behaves exactly as upstream.
//!
//! Everything platform-specific sits in `platform` (where the library is,
//! the network's DNS resolvers, how the core's accounts are reached: the
//! in-process accounts manager on Android, JSON-RPC to the sidecar on
//! Windows). A new desktop target (macOS) only needs another `platform`
//! module, a library build and the cfg lists below.

use serde_json::Value;

#[cfg(target_os = "android")]
#[path = "tunnel_android.rs"]
mod platform;
#[cfg(windows)]
#[path = "tunnel_windows.rs"]
mod platform;

#[cfg(any(target_os = "android", windows))]
mod imp {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int, c_longlong};
    use std::path::PathBuf;
    use std::collections::{HashSet, VecDeque};
    use std::sync::{Mutex, OnceLock};
    use tauri::{Emitter, Manager};
    use super::platform;

    type StrFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
    type StatusFn = unsafe extern "C" fn(c_int) -> *mut c_char;
    type VoidFn = unsafe extern "C" fn();
    type FreeFn = unsafe extern "C" fn(*mut c_char);
    type GenFn = unsafe extern "C" fn() -> c_longlong;

    struct Lib {
        _lib: libloading::Library,
        parse: StrFn,
        start: StrFn,
        stop: VoidFn,
        status: StatusFn,
        set_mode: StrFn,
        // Loaded to check the ABI; network changes restart the tunnel instead.
        _net_changed: VoidFn,
        free: FreeFn,
        route_gen: GenFn,
    }

    static LIB: OnceLock<Result<Lib, String>> = OnceLock::new();
    /// The proxy URL the core should use, or None when the tunnel is not installed.
    static PROXY_URL: Mutex<Option<String>> = Mutex::new(None);
    /// Network resolvers + operator the running tunnel was started with.
    static LAST_NET: Mutex<Option<(Value, String)>> = Mutex::new(None);
    static APPLIER: OnceLock<()> = OnceLock::new();
    /// Serializes start/stop/install/remove.
    static OP: Mutex<()> = Mutex::new(());
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    /// Accounts being exported or transferred: our proxy is kept off them so
    /// a backup never carries this device's 127.0.0.1 tunnel port.
    static DETACHED: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

    #[cfg_attr(not(windows), allow(dead_code))]
    pub(super) fn app_handle() -> Option<tauri::AppHandle> {
        APP.get().cloned()
    }

    fn is_detached(id: u32) -> bool {
        DETACHED.lock().unwrap().as_ref().is_some_and(|s| s.contains(&id))
    }
    /// Recent shell-side tunnel events for the Velta Diagnostics chat. Kept
    /// here (not only emitted) so lines logged while the WebView sleeps are
    /// still shown once it polls tunnel_status.
    static SHELL_EVENTS: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());

    /// Logs a tunnel event to the shell log and the diagnostics ring, and
    /// wakes the page so it shows up in Velta Diagnostics at once.
    fn tlog(level: &str, msg: &str) {
        crate::log(&format!("dns tunnel: {msg}"));
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
        if let Some(app) = APP.get() {
            let _ = app.emit("velta-tunnel-log", ());
        }
    }

    /// Every proxy URL this module writes starts with this; anything else in
    /// `proxy_url` is the user's own proxy and is left alone.
    const OURS: &str = "socks5://velta-tunnel:";

    fn lib() -> Result<&'static Lib, String> {
        LIB.get_or_init(|| unsafe {
            let l = libloading::Library::new(platform::lib_path(APP.get()))
                .map_err(|e| format!("DNS tunnel library not available: {e}"))?;
            macro_rules! sym {
                ($name:literal, $t:ty) => {
                    *l.get::<$t>($name)
                        .map_err(|e| format!("{}: {e}", String::from_utf8_lossy($name)))?
                };
            }
            let parse = sym!(b"VeltaTunnelParseLink\0", StrFn);
            let start = sym!(b"VeltaTunnelStart\0", StrFn);
            let stop = sym!(b"VeltaTunnelStop\0", VoidFn);
            let status = sym!(b"VeltaTunnelStatus\0", StatusFn);
            let set_mode = sym!(b"VeltaTunnelSetMode\0", StrFn);
            let _net_changed = sym!(b"VeltaTunnelNetworkChanged\0", VoidFn);
            let free = sym!(b"VeltaTunnelFree\0", FreeFn);
            let route_gen = sym!(b"VeltaTunnelRouteGen\0", GenFn);
            Ok(Lib { _lib: l, parse, start, stop, status, set_mode, _net_changed, free, route_gen })
        })
        .as_ref()
        .map_err(|e| e.clone())
    }

    /// Copies and frees a JSON string returned by the library; {"error": …} becomes Err.
    fn take(lib: &Lib, p: *mut c_char) -> Result<Value, String> {
        if p.is_null() {
            return Err("DNS tunnel library returned nothing".into());
        }
        let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        unsafe { (lib.free)(p) };
        let v: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        if let Some(e) = v.get("error").and_then(Value::as_str) {
            return Err(e.to_string());
        }
        Ok(v)
    }

    fn call(f: impl Fn(&Lib) -> StrFn, arg: &str) -> Result<Value, String> {
        let lib = lib()?;
        let c = CString::new(arg).map_err(|e| e.to_string())?;
        take(lib, unsafe { f(lib)(c.as_ptr()) })
    }

    /// The network the tunnel runs on: {"dns": ["10.0.0.1:53", …],
    /// "transport": …, plus the SIM operator and Private DNS on Android
    /// (NetInfo.kt) or the adapters' resolvers on Windows.
    fn network_info() -> Option<Value> {
        platform::network_info()
    }

    /// What decides the path set: the network's resolvers and the SIM operator.
    fn network_key(info: &Value) -> (Value, String) {
        let op = info["sim_operator"].as_str().filter(|s| !s.is_empty()).or(info["network_operator"].as_str()).unwrap_or("");
        (info["dns"].clone(), op.to_string())
    }

    fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
        Some(app.path().app_local_data_dir().ok()?.join("tunnel.json"))
    }

    fn load_config(app: &tauri::AppHandle) -> Option<Value> {
        let s = std::fs::read_to_string(config_path(app)?).ok()?;
        serde_json::from_str(&s).ok()
    }

    fn save_config(app: &tauri::AppHandle, cfg: &Value) -> Result<(), String> {
        let path = config_path(app).ok_or("no app data dir")?;
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&path, serde_json::to_string(cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }

    /// Starts (or restarts) the library from a stored config, adding the
    /// current network's resolvers and operator (never persisted). Reuses
    /// the saved port so the accounts' proxy_url stays valid across restarts.
    fn start(app: &tauri::AppHandle, mut cfg: Value) -> Result<(), String> {
        let _ = APP.set(app.clone());
        let mut run = cfg.clone();
        let net = network_info();
        if let Some(info) = &net {
            let (dns, op) = network_key(info);
            run["system_resolvers"] = dns;
            run["operator"] = Value::from(op);
        }
        let res = call(|l| l.start, &run.to_string()).or_else(|e| {
            if run["listen"].as_str() == Some("127.0.0.1:0") {
                return Err(e);
            }
            tlog("warning", &format!("saved port unavailable ({e}); picking a new one"));
            run["listen"] = Value::from("127.0.0.1:0");
            call(|l| l.start, &run.to_string())
        })?;
        let addr = res["addr"].as_str().ok_or("no listen address")?.to_string();
        cfg["listen"] = Value::from(addr.clone());
        save_config(app, &cfg)?;
        *LAST_NET.lock().unwrap() = net.as_ref().map(network_key);
        let user = cfg["user"].as_str().unwrap_or_default();
        let pass = cfg["pass"].as_str().unwrap_or_default();
        *PROXY_URL.lock().unwrap() = Some(format!("socks5://{user}:{pass}@{addr}"));
        tlog("info", &format!(
            "started on {addr}, mode {}, network resolvers {}, operator {}",
            cfg["mode"].as_str().unwrap_or("auto"),
            run["system_resolvers"].as_array().map_or(0, |a| a.len()),
            run["operator"].as_str().unwrap_or("?"),
        ));
        start_applier(app.clone());
        Ok(())
    }

    /// Restarts the tunnel when the network's resolvers or the operator
    /// changed (Wi-Fi <-> mobile, SIM swap): soar's path set is fixed per
    /// client, and the restart re-probes the network from scratch.
    fn check_network(app: &tauri::AppHandle) {
        let _g = OP.lock().unwrap();
        if PROXY_URL.lock().unwrap().is_none() {
            return;
        }
        let Some(info) = network_info() else { return };
        let key = network_key(&info);
        let changed = LAST_NET.lock().unwrap().as_ref() != Some(&key);
        if !changed {
            return;
        }
        tlog("info", "network resolvers or operator changed; restarting the tunnel");
        if let Some(cfg) = load_config(app) {
            if let Err(e) = start(app, cfg) {
                tlog("error", &format!("restart failed: {e}"));
            }
        }
    }

    /// Keeps every profile's proxy_url in line with the tunnel (on install,
    /// on removal, and every minute so profiles added later pick it up) and
    /// follows network changes even while the WebView sleeps.
    fn start_applier(app: tauri::AppHandle) {
        APPLIER.get_or_init(|| {
            tauri::async_runtime::spawn(async move {
                loop {
                    apply_proxy().await;
                    check_network(&app);
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                }
            });
            // Route watcher: when the router switches direct <-> tunnel (mode
            // change, allowlist detected, tunnel restart) it closes the old
            // route's connections; the core would only reconnect after its own
            // retry delay, so tell it the network changed right away.
            tauri::async_runtime::spawn(async move {
                let mut last: Option<i64> = None;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    let Ok(lib) = lib() else { continue };
                    let generation = unsafe { (lib.route_gen)() };
                    if last.is_some_and(|l| l != generation) {
                        if platform::maybe_network().await {
                            tlog("info", "route changed; asked the core to reconnect now");
                        }
                    }
                    last = Some(generation);
                }
            });
        });
    }

    pub(super) async fn apply_proxy() {
        let Some(ids) = platform::account_ids().await else { return };
        let desired = PROXY_URL.lock().unwrap().clone();
        for id in ids {
            let Some((cur, enabled)) = platform::proxy_config(id).await else { continue };
            // An account in the middle of an export gets no tunnel proxy.
            let desired = if is_detached(id) { None } else { desired.clone() };
            let ours = cur.starts_with(OURS);
            let mut changed = false;
            let result = match &desired {
                // A proxy the user set up themselves wins over the tunnel.
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
                tlog("warning", &format!("proxy update for account {id} failed: {e}"));
            } else if changed {
                // set_config only affects NEW connections: without a restart
                // the open IMAP/SMTP sessions keep bypassing (or keep using)
                // the proxy until they drop on their own.
                tlog("info", &format!("proxy {} for account {id}; restarting its IO", if desired.is_some() { "set" } else { "cleared" }));
                platform::restart_io(id).await;
            }
        }
    }

    /// Called once the core is up: restart the tunnel if one is installed.
    pub fn boot(app: &tauri::AppHandle) {
        let _ = APP.set(app.clone());
        // Always run the proxy keeper, tunnel or not: a profile restored from
        // a backup (or received from another device) can carry a stale
        // tunnel proxy pointing at a local port nothing listens on, which
        // stops all its mail. The keeper clears or updates it.
        start_applier(app.clone());
        let _g = OP.lock().unwrap();
        let Some(cfg) = load_config(app) else { return };
        if let Err(e) = start(app, cfg) {
            tlog("error", &format!("start failed: {e}"));
        }
    }

    pub fn preview(link: &str) -> Result<Value, String> {
        let cfg = call(|l| l.parse, link)?;
        Ok(serde_json::json!({
            "zone": cfg["zone"],
            "resolvers": cfg["effective_resolvers"],
            "canaries": cfg["canaries"],
        }))
    }

    pub fn install(app: &tauri::AppHandle, link: &str) -> Result<(), String> {
        let _g = OP.lock().unwrap();
        let mut cfg = call(|l| l.parse, link)?;
        if let Some(o) = cfg.as_object_mut() {
            o.remove("effective_resolvers");
        }
        start(app, cfg)?;
        tauri::async_runtime::spawn(apply_proxy());
        Ok(())
    }

    /// What a share link needs from the stored config: only the values the
    /// original link carried (zone, key, extra resolvers, canaries).
    pub fn link(app: &tauri::AppHandle) -> Result<Value, String> {
        let cfg = load_config(app).ok_or("No DNS tunnel is set up")?;
        Ok(serde_json::json!({
            "zone": cfg["zone"],
            "key": cfg["key"],
            "resolvers": cfg.get("resolvers").cloned().unwrap_or(Value::Null),
            "canaries": cfg.get("canaries").cloned().unwrap_or(Value::Null),
        }))
    }

    pub fn remove(app: &tauri::AppHandle) -> Result<(), String> {
        let _g = OP.lock().unwrap();
        if let Ok(lib) = lib() {
            unsafe { (lib.stop)() };
        }
        *PROXY_URL.lock().unwrap() = None;
        *LAST_NET.lock().unwrap() = None;
        if let Some(path) = config_path(app) {
            let _ = std::fs::remove_file(path);
        }
        tlog("info", "removed");
        tauri::async_runtime::spawn(apply_proxy());
        Ok(())
    }

    pub fn status(app: &tauri::AppHandle, events: i32) -> Value {
        let installed = load_config(app).is_some();
        let mut v = match lib() {
            Ok(lib) => take(lib, unsafe { (lib.status)(events) }).unwrap_or_else(|e| serde_json::json!({"error": e})),
            Err(e) => serde_json::json!({"available": false, "error": e}),
        };
        v["installed"] = Value::from(installed);
        if v.get("available").is_none() {
            v["available"] = Value::from(true);
        }
        if let Some(net) = network_info() {
            v["network"] = net;
        }
        v["shell_events"] = Value::from(SHELL_EVENTS.lock().unwrap().iter().cloned().collect::<Vec<_>>());
        v
    }

    pub fn set_mode(app: &tauri::AppHandle, mode: &str) -> Result<(), String> {
        let _g = OP.lock().unwrap();
        call(|l| l.set_mode, mode)?;
        if let Some(mut cfg) = load_config(app) {
            cfg["mode"] = Value::from(mode);
            save_config(app, &cfg)?;
        }
        Ok(())
    }

    /// The WebView reports a "change" on every mobile bandwidth estimate, so
    /// only a real change of resolvers/operator does anything (a restart).
    /// Before a backup export or a second-device transfer: drop our proxy
    /// from the account (and keep it off) so the backup doesn't carry it.
    pub async fn backup_begin(id: u32) {
        DETACHED.lock().unwrap().get_or_insert_with(HashSet::new).insert(id);
        apply_proxy().await;
        tlog("info", &format!("account {id}: tunnel proxy removed for a backup or transfer"));
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

    pub fn network_changed(app: &tauri::AppHandle) {
        check_network(app);
    }
}

#[cfg(any(target_os = "android", windows))]
pub use imp::boot;

/// No tunnel on this platform: nothing to start.
#[cfg(not(any(target_os = "android", windows)))]
pub fn boot(_app: &tauri::AppHandle) {}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_preview(link: String) -> Result<Value, String> {
    imp::preview(&link)
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_install(app: tauri::AppHandle, link: String) -> Result<(), String> {
    imp::install(&app, &link)
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_link(app: tauri::AppHandle) -> Result<Value, String> {
    imp::link(&app)
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_remove(app: tauri::AppHandle) -> Result<(), String> {
    imp::remove(&app)
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_status(app: tauri::AppHandle, events: Option<i32>) -> Value {
    imp::status(&app, events.unwrap_or(0))
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_set_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    imp::set_mode(&app, &mode)
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_network_changed(app: tauri::AppHandle) {
    imp::network_changed(&app)
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub async fn tunnel_backup_begin(account_id: u32) -> Result<(), String> {
    imp::backup_begin(account_id).await;
    Ok(())
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub async fn tunnel_backup_end(account_id: u32) -> Result<(), String> {
    imp::backup_end(account_id).await;
    Ok(())
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub async fn tunnel_reapply() -> Result<(), String> {
    imp::reapply().await;
    Ok(())
}

// macOS / Linux: no library build yet; report it unavailable. `unsupported`
// tells the page this is the platform, not a broken install.
#[cfg(not(any(target_os = "android", windows)))]
const UNAVAILABLE: &str = "The DNS tunnel is not available on this platform yet (Android and Windows only)";

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_preview(link: String) -> Result<Value, String> {
    let _ = link;
    Err(UNAVAILABLE.into())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_install(link: String) -> Result<(), String> {
    let _ = link;
    Err(UNAVAILABLE.into())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_link() -> Result<Value, String> {
    Err(UNAVAILABLE.into())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_remove() -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_status(events: Option<i32>) -> Value {
    let _ = events;
    serde_json::json!({"available": false, "installed": false, "unsupported": true, "platform": std::env::consts::OS, "error": UNAVAILABLE})
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_set_mode(mode: String) -> Result<(), String> {
    let _ = mode;
    Err(UNAVAILABLE.into())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_network_changed() {}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_backup_begin(account_id: u32) -> Result<(), String> {
    let _ = account_id;
    Ok(())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_backup_end(account_id: u32) -> Result<(), String> {
    let _ = account_id;
    Ok(())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_reapply() -> Result<(), String> {
    Ok(())
}
