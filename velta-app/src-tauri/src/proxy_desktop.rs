//! Desktop side of the SOCKS5 proxy keeper (proxy.rs): the core reached
//! over JSON-RPC (the deltachat-rpc-server sidecar). Same shape on every
//! desktop OS.

use serde_json::{json, Value};

fn app() -> Option<tauri::AppHandle> {
    super::imp::app_handle()
}

async fn call(method: &str, params: Value) -> Result<Value, String> {
    let app = app().ok_or("app not ready")?;
    crate::sidecar_call(&app, method, params).await
}

/// None until the sidecar answers.
pub async fn account_ids() -> Option<Vec<u32>> {
    let v = call("get_all_account_ids", json!([])).await.ok()?;
    serde_json::from_value(v).ok()
}

/// (proxy_url, proxy_enabled) of one account.
pub async fn proxy_config(id: u32) -> Option<(String, bool)> {
    let url = call("get_config", json!([id, "proxy_url"])).await.ok()?;
    let enabled = call("get_config", json!([id, "proxy_enabled"])).await.ok()?;
    Some((url.as_str().unwrap_or_default().to_string(), enabled.as_str() == Some("1")))
}

pub async fn set_config(id: u32, key: &str, value: Option<&str>) -> Result<(), String> {
    call("set_config", json!([id, key, value])).await.map(|_| ())
}

/// The sidecar has no restart_io_if_running: restart IO only for accounts
/// that are configured (the page starts IO for those at boot).
pub async fn restart_io(id: u32) {
    if call("is_configured", json!([id])).await.ok().and_then(|v| v.as_bool()) != Some(true) {
        return;
    }
    let _ = call("stop_io", json!([id])).await;
    let _ = call("start_io", json!([id])).await;
}

/// Tells the core the network changed; false when the sidecar is not up.
pub async fn maybe_network() -> bool {
    call("maybe_network", json!([])).await.is_ok()
}
