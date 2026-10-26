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

/// The saved tunnels (pure list logic, unit-tested on any host).
#[cfg(any(target_os = "android", windows, test))]
#[path = "tunnel_store.rs"]
pub mod store;

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
    use super::platform;
    use super::store;

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
    /// The WebSocket transport's proxy URL (ws_transport.rs). The same
    /// keeper writes it; the DNS tunnel's wins if both are ever set.
    static WS_PROXY_URL: Mutex<Option<String>> = Mutex::new(None);
    /// Network resolvers + operator the running tunnel was started with.
    static LAST_NET: Mutex<Option<(Value, String)>> = Mutex::new(None);
    static APPLIER: OnceLock<()> = OnceLock::new();
    /// Serializes start/stop/install/remove.
    static OP: Mutex<()> = Mutex::new(());
    static HOST: Mutex<Option<crate::Host>> = Mutex::new(None);
    /// Accounts being exported or transferred: our proxy is kept off them so
    /// a backup never carries this device's 127.0.0.1 tunnel port.
    static DETACHED: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

    #[cfg_attr(not(windows), allow(dead_code))]
    pub(super) fn app_handle() -> Option<tauri::AppHandle> {
        HOST.lock().unwrap().as_ref().and_then(|h| h.app().cloned())
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
        let host = HOST.lock().unwrap().clone();
        if let Some(host) = host {
            host.emit("velta-tunnel-log", ());
        }
    }

    /// Every proxy URL this module writes starts with this; anything else in
    /// `proxy_url` is the user's own proxy and is left alone.
    const OURS: &str = "socks5://velta-tunnel:";

    pub fn set_ws_proxy(url: Option<String>) {
        *WS_PROXY_URL.lock().unwrap() = url;
        tauri::async_runtime::spawn(async {
            apply_proxy().await;
            // Same proxy URL, other upstream: reconnect now.
            platform::maybe_network().await;
        });
    }

    /// A DNS tunnel is selected in the saved list.
    pub fn dns_tunnel_active(app: &crate::Host) -> bool {
        store::active_id(&load_store(app)).is_some()
    }

    /// The WebSocket transport is being turned on: stop the DNS tunnel.
    pub fn deactivate_for_ws(app: &crate::Host) {
        if dns_tunnel_active(app) {
            let _ = select(app, None);
            tlog("info", "stopped: the WebSocket transport is in use now");
        }
    }

    fn lib() -> Result<&'static Lib, String> {
        LIB.get_or_init(|| unsafe {
            let l = libloading::Library::new(platform::lib_path(app_handle().as_ref()))
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

    fn data_dir(app: &crate::Host) -> Option<PathBuf> {
        app.data_dir()
    }

    fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
    }

    /// The saved tunnels. On the first run after an upgrade the old
    /// single-tunnel `tunnel.json` becomes the list's only (active) entry;
    /// it is deleted only once `tunnels.json` is written.
    fn load_store(app: &crate::Host) -> Value {
        let Some(dir) = data_dir(app) else { return store::empty() };
        if let Ok(s) = std::fs::read_to_string(dir.join(store::FILE)) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                if v.is_object() {
                    return v;
                }
            }
        }
        let legacy = dir.join(store::LEGACY_FILE);
        let Some(old) = std::fs::read_to_string(&legacy).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
            return store::empty();
        };
        let migrated = store::migrate(&old, "", now());
        match save_store(app, &migrated) {
            Ok(()) => {
                let _ = std::fs::remove_file(&legacy);
                tlog("info", "saved tunnel moved into the tunnel list");
            }
            Err(e) => tlog("warning", &format!("couldn't save the tunnel list: {e}")),
        }
        migrated
    }

    fn save_store(app: &crate::Host, st: &Value) -> Result<(), String> {
        let dir = data_dir(app).ok_or("no app data dir")?;
        let _ = std::fs::create_dir_all(&dir);
        // Write-then-rename: a crash mid-write never loses the list.
        let tmp = dir.join(format!("{}.tmp", store::FILE));
        std::fs::write(&tmp, serde_json::to_string(st).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, dir.join(store::FILE)).map_err(|e| e.to_string())
    }

    /// The active tunnel's run config, if one is selected.
    fn load_config(app: &crate::Host) -> Option<Value> {
        let st = load_store(app);
        store::run_config(&st, store::active_id(&st)?)
    }

    /// Stops the library and takes our proxy off every profile.
    fn stop_running() {
        if let Ok(lib) = lib() {
            unsafe { (lib.stop)() };
        }
        *PROXY_URL.lock().unwrap() = None;
        *LAST_NET.lock().unwrap() = None;
        tauri::async_runtime::spawn(apply_proxy());
    }

    /// Starts (or restarts) the library from a stored config, adding the
    /// current network's resolvers and operator (never persisted). Reuses
    /// the saved port so the accounts' proxy_url stays valid across restarts.
    fn start(app: &crate::Host, mut cfg: Value) -> Result<(), String> {
        *HOST.lock().unwrap() = Some(app.clone());
        // One at a time: the DNS tunnel and the WebSocket transport both
        // set the profiles' proxy.
        crate::ws_transport::deactivate_for_tunnel(app);
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
        // The port belongs to the list, not the tunnel: switching keeps it.
        let mut st = load_store(app);
        st["listen"] = Value::from(addr.clone());
        save_store(app, &st)?;
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
    fn check_network(app: &crate::Host) {
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

    /// Health check (audit item 5): the tunnel's local SOCKS listener must
    /// accept connections. A library whose proxy died in the background
    /// otherwise leaves every account failing silently; restart it.
    fn check_alive(app: &crate::Host) {
        let _g = OP.lock().unwrap();
        let url = PROXY_URL.lock().unwrap().clone();
        let Some(addr) = url.as_deref().and_then(super::proxy_listen_addr) else { return };
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2)).is_ok() {
            return;
        }
        tlog("warning", &format!("tunnel proxy not answering on {addr}; restarting it"));
        if let Some(cfg) = load_config(app) {
            if let Err(e) = start(app, cfg) {
                tlog("error", &format!("restart failed: {e}"));
            }
        }
    }

    /// Keeps every profile's proxy_url in line with the tunnel (on install,
    /// on removal, and every minute so profiles added later pick it up) and
    /// follows network changes even while the WebView sleeps.
    fn start_applier(app: crate::Host) {
        APPLIER.get_or_init(|| {
            tauri::async_runtime::spawn(async move {
                loop {
                    apply_proxy().await;
                    check_network(&app);
                    check_alive(&app);
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
        let desired = PROXY_URL.lock().unwrap().clone().or_else(|| WS_PROXY_URL.lock().unwrap().clone());
        for id in ids {
            let Some((cur, enabled)) = platform::proxy_config(id).await else { continue };
            // An account in the middle of an export gets no tunnel proxy.
            let desired = if is_detached(id) { None } else { desired.clone() };
            let ours = cur.starts_with(OURS) || cur.starts_with(crate::ws_transport::OURS);
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
    pub fn boot(app: &crate::Host) {
        *HOST.lock().unwrap() = Some(app.clone());
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

    /// What the confirmation shows; `existing` is the saved tunnel with
    /// the same zone+key ({"id", "label", "active"}) or null.
    pub fn preview(app: &crate::Host, link: &str) -> Result<Value, String> {
        let cfg = call(|l| l.parse, link)?;
        let st = load_store(app);
        let existing = store::find_duplicate(&st, cfg["zone"].as_str().unwrap_or(""), cfg["key"].as_str().unwrap_or(""))
            .map_or(Value::Null, |t| serde_json::json!({
                "id": t["id"], "label": t["label"],
                "active": store::active_id(&st) == t["id"].as_str(),
            }));
        Ok(serde_json::json!({
            "zone": cfg["zone"],
            "resolvers": cfg["effective_resolvers"],
            "canaries": cfg["canaries"],
            "existing": existing,
            "count": store::tunnels(&st).len(),
        }))
    }

    /// Saves the link's tunnel (same zone+key: the saved one) and, with
    /// `activate`, switches to it. Returns {"id", "existing"}.
    pub fn install(app: &crate::Host, link: &str, label: &str, activate: bool) -> Result<Value, String> {
        let _g = OP.lock().unwrap();
        let cfg = call(|l| l.parse, link)?;
        let mut st = load_store(app);
        let (id, existing) = store::add(&mut st, &cfg, label, now());
        if activate {
            store::select(&mut st, Some(&id))?;
        }
        save_store(app, &st)?;
        tlog("info", &format!("tunnel {id} {}", if existing { "already saved" } else { "saved" }));
        if activate {
            start(app, store::run_config(&st, &id).ok_or("No such tunnel")?)?;
            tauri::async_runtime::spawn(apply_proxy());
        }
        Ok(serde_json::json!({"id": id, "existing": existing}))
    }

    /// Saved tunnels for the settings sheet (no keys).
    pub fn list(app: &crate::Host) -> Value {
        store::public_list(&load_store(app))
    }

    /// Activates a saved tunnel, or none (stops it).
    pub fn select(app: &crate::Host, id: Option<&str>) -> Result<(), String> {
        let _g = OP.lock().unwrap();
        let mut st = load_store(app);
        store::select(&mut st, id)?;
        save_store(app, &st)?;
        match id {
            Some(id) => {
                tlog("info", &format!("switching to tunnel {id}"));
                start(app, store::run_config(&st, id).ok_or("No such tunnel")?)?;
                tauri::async_runtime::spawn(async {
                    apply_proxy().await;
                    // Same proxy URL, new tunnel: reconnect now.
                    platform::maybe_network().await;
                });
            }
            None => {
                stop_running();
                tlog("info", "no tunnel selected; stopped");
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

    /// Deletes a saved tunnel; deleting the active one stops it.
    pub fn delete(app: &crate::Host, id: &str) -> Result<(), String> {
        let _g = OP.lock().unwrap();
        let mut st = load_store(app);
        let was_active = store::delete(&mut st, id)?;
        save_store(app, &st)?;
        if was_active {
            stop_running();
        }
        tlog("info", &format!("tunnel {id} deleted{}", if was_active { "; stopped" } else { "" }));
        Ok(())
    }

    /// What a share link needs: only the values the original link carried
    /// (zone, key, extra resolvers, canaries) and the label. Default: active.
    pub fn link(app: &crate::Host, id: Option<&str>) -> Result<Value, String> {
        let st = load_store(app);
        let id = id.or(store::active_id(&st)).ok_or("No DNS tunnel is set up")?;
        store::link(&st, id).ok_or_else(|| "No such tunnel".into())
    }

    /// Older pages' "Remove the tunnel": deletes the active one.
    pub fn remove(app: &crate::Host) -> Result<(), String> {
        let st = load_store(app);
        match store::active_id(&st) {
            Some(id) => delete(app, &id.to_string()),
            None => Ok(()),
        }
    }

    pub fn status(app: &crate::Host, events: i32) -> Value {
        let st = load_store(app);
        let active = store::active_id(&st).and_then(|id| store::find(&st, id)).cloned();
        let mut v = match lib() {
            Ok(lib) => take(lib, unsafe { (lib.status)(events) }).unwrap_or_else(|e| serde_json::json!({"error": e})),
            Err(e) => serde_json::json!({"available": false, "error": e}),
        };
        // installed: at least one tunnel is saved (the drawer row shows).
        v["installed"] = Value::from(!store::tunnels(&st).is_empty());
        v["count"] = Value::from(store::tunnels(&st).len());
        v["active"] = active.as_ref().map_or(Value::Null, |t| t["id"].clone());
        v["active_label"] = active.as_ref().map_or(Value::Null, |t| t["label"].clone());
        if v["zone"].is_null() {
            if let Some(t) = &active {
                v["zone"] = t["zone"].clone();
            }
        }
        if v.get("available").is_none() {
            v["available"] = Value::from(true);
        }
        if let Some(net) = network_info() {
            v["network"] = net;
        }
        v["shell_events"] = Value::from(SHELL_EVENTS.lock().unwrap().iter().cloned().collect::<Vec<_>>());
        v
    }

    pub fn set_mode(app: &crate::Host, mode: &str) -> Result<(), String> {
        let _g = OP.lock().unwrap();
        call(|l| l.set_mode, mode)?;
        let mut st = load_store(app);
        if let Some(id) = store::active_id(&st).map(str::to_string) {
            store::set_mode(&mut st, &id, mode)?;
            save_store(app, &st)?;
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

    pub fn network_changed(app: &crate::Host) {
        check_network(app);
    }
}

#[cfg(any(target_os = "android", windows))]
pub use imp::{boot, deactivate_for_ws, dns_tunnel_active, set_ws_proxy};

/// No tunnel on this platform: nothing to start.
#[cfg(not(any(target_os = "android", windows)))]
pub fn boot(_app: &crate::Host) {}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_preview(app: tauri::AppHandle, link: String) -> Result<Value, String> {
    imp::preview(&crate::Host::from_app(&app), &link)
}

/// Saves the link's tunnel; `activate` (default true) also switches to it.
#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_install(app: tauri::AppHandle, link: String, label: Option<String>, activate: Option<bool>) -> Result<Value, String> {
    imp::install(&crate::Host::from_app(&app), &link, label.as_deref().unwrap_or(""), activate.unwrap_or(true))
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_link(app: tauri::AppHandle, id: Option<String>) -> Result<Value, String> {
    imp::link(&crate::Host::from_app(&app), id.as_deref())
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_list(app: tauri::AppHandle) -> Value {
    imp::list(&crate::Host::from_app(&app))
}

/// id null: no tunnel (stops the running one).
#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_select(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    imp::select(&crate::Host::from_app(&app), id.as_deref())
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_rename(app: tauri::AppHandle, id: String, label: String) -> Result<(), String> {
    imp::rename(&crate::Host::from_app(&app), &id, &label)
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    imp::delete(&crate::Host::from_app(&app), &id)
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_remove(app: tauri::AppHandle) -> Result<(), String> {
    imp::remove(&crate::Host::from_app(&app))
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_status(app: tauri::AppHandle, events: Option<i32>) -> Value {
    imp::status(&crate::Host::from_app(&app), events.unwrap_or(0))
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_set_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    imp::set_mode(&crate::Host::from_app(&app), &mode)
}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn tunnel_network_changed(app: tauri::AppHandle) {
    imp::network_changed(&crate::Host::from_app(&app))
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

/// Points every profile at the running proxy now (boot: before IO starts).
#[cfg(any(target_os = "android", windows))]
#[cfg_attr(windows, allow(dead_code))]
pub async fn reapply_proxy() {
    imp::reapply().await;
}
#[cfg(not(any(target_os = "android", windows)))]
#[allow(dead_code)]
pub async fn reapply_proxy() {}

/// host:port of a proxy URL this app wrote ("socks5://user:pass@127.0.0.1:N").
#[cfg_attr(not(any(target_os = "android", windows)), allow(dead_code))]
pub(crate) fn proxy_listen_addr(url: &str) -> Option<std::net::SocketAddr> {
    url.rsplit('@').next()?.trim_end_matches('/').parse().ok()
}

#[cfg(test)]
mod health_tests {
    #[test]
    fn listen_addr_from_our_proxy_urls() {
        assert_eq!(super::proxy_listen_addr("socks5://u:p@127.0.0.1:4242"), Some("127.0.0.1:4242".parse().unwrap()));
        assert_eq!(super::proxy_listen_addr("socks5://velta-ws:secret@127.0.0.1:9/"), Some("127.0.0.1:9".parse().unwrap()));
        assert_eq!(super::proxy_listen_addr("socks5://no-port"), None);
    }
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
pub fn tunnel_install(link: String, label: Option<String>, activate: Option<bool>) -> Result<Value, String> {
    let _ = (link, label, activate);
    Err(UNAVAILABLE.into())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_link(id: Option<String>) -> Result<Value, String> {
    let _ = id;
    Err(UNAVAILABLE.into())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_list() -> Value {
    serde_json::json!({"active": null, "tunnels": []})
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_select(id: Option<String>) -> Result<(), String> {
    let _ = id;
    Err(UNAVAILABLE.into())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_rename(id: String, label: String) -> Result<(), String> {
    let _ = (id, label);
    Err(UNAVAILABLE.into())
}

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn tunnel_delete(id: String) -> Result<(), String> {
    let _ = id;
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
