//! Android side of the DNS tunnel (tunnel.rs): libsoartunnel.so from the
//! APK's jniLibs, NetInfo.kt for the network, the in-process core.

use serde_json::Value;

use deltachat::config::Config;

pub fn lib_path(_app: Option<&tauri::AppHandle>) -> std::path::PathBuf {
    "libsoartunnel.so".into()
}

/// NetInfo.kt snapshot: {"dns": ["10.0.0.1:53", …], "sim_operator": "25001",
/// "transport": "cellular", "private_dns": false, …}.
pub fn network_info() -> Option<Value> {
    // Keep the guard bound: the JObject borrows the GlobalRef inside it.
    let ctx_guard = crate::APP_CONTEXT.lock().unwrap();
    let context = ctx_guard.as_ref().map(|r| r.as_obj())?;
    let vm_guard = crate::APP_JAVA_VM.lock().unwrap();
    let mut env = vm_guard.as_ref()?.attach_current_thread().ok()?;
    let class_guard = crate::APP_NETINFO_CLASS.lock().unwrap();
    let class_ref = class_guard.as_ref()?;
    let out = env
        .call_static_method(class_ref, "snapshot", "(Landroid/content/Context;)Ljava/lang/String;", &[(&context).into()])
        .ok()?;
    let jstr = jni::objects::JString::from(out.l().ok()?);
    let s = env.get_string(&jstr).ok()?.to_string_lossy().into_owned();
    serde_json::from_str(&s).ok()
}

type Accounts = std::sync::Arc<tokio::sync::RwLock<deltachat_jsonrpc::api::Accounts>>;

fn accounts() -> Option<Accounts> {
    crate::ANDROID_ACCOUNTS.lock().unwrap().clone()
}

/// None until the core is up.
pub async fn account_ids() -> Option<Vec<u32>> {
    Some(accounts()?.read().await.get_all())
}

/// (proxy_url, proxy_enabled) of one account.
pub async fn proxy_config(id: u32) -> Option<(String, bool)> {
    let ctx = accounts()?.read().await.get_account(id)?;
    let url = ctx.get_config(Config::ProxyUrl).await.ok().flatten().unwrap_or_default();
    let enabled = ctx.get_config_bool(Config::ProxyEnabled).await.unwrap_or(false);
    Some((url, enabled))
}

pub async fn set_config(id: u32, key: &str, value: Option<&str>) -> Result<(), String> {
    let ctx = accounts().ok_or("core not running")?.read().await.get_account(id).ok_or("no such account")?;
    let key: Config = key.parse().map_err(|_| format!("unknown key {key}"))?;
    ctx.set_config(key, value).await.map_err(|e| e.to_string())
}

pub async fn restart_io(id: u32) {
    let Some(a) = accounts() else { return };
    let ctx = a.read().await.get_account(id);
    if let Some(ctx) = ctx {
        ctx.restart_io_if_running().await;
    }
}

/// Tells the core the network changed; false when it is not up yet.
pub async fn maybe_network() -> bool {
    let Some(a) = accounts() else { return false };
    // Never hold the account manager lock across the interrupts: they can
    // wait out an IO restart, and a queued writer would then block every
    // UI RPC (chat switching hung behind it).
    let contexts: Vec<_> = {
        let accounts = a.read().await;
        accounts.get_all().into_iter().filter_map(|id| accounts.get_account(id)).collect()
    };
    for ctx in contexts {
        ctx.maybe_network().await;
    }
    true
}
