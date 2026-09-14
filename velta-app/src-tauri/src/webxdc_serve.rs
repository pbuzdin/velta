// webxdc_serve.rs — serving webxdc app files over the webxdc:// protocol.
//
// The WebView cannot relay its own asset fetches, so the handler performs
// real JSON-RPC round-trips to the core: requests use string ids prefixed
// "wxdc-", which the response forwarders route back into wxdc_pending
// (see RpcState). Every served app gets its own origin (webxdc://localhost
// on mac/linux, http://webxdc.localhost on Windows/Android), so the app's
// scripts stay outside the host page's CSP and origin.

use tauri::Manager;

use crate::{guess_mime, percent_decode, RpcState};

pub const WEBXDC_SHIM: &str = include_str!("webxdc-shim.js");

pub fn webxdc_resolve_line(app: &tauri::AppHandle, line: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { return; };
    let Some(id) = value.get("id").and_then(|v| v.as_str()).map(str::to_string) else { return; };
    let state = app.state::<RpcState>();
    let sender = state.wxdc_pending.lock().unwrap().remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(line.to_string());
    }
}

async fn webxdc_rpc(
    app: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = format!(
        "wxdc-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let request = serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    {
        // Scope the State borrow: the response arrives via the forwarders
        // (reader thread / android task) while this future is suspended.
        let state = app.state::<RpcState>();
        state.send_rpc(&request.to_string())?;
        state.wxdc_pending.lock().unwrap().insert(id, tx);
    }
    let line = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| "webxdc request timed out".to_string())?
        .map_err(|_| "webxdc request dropped".to_string())?;
    let value: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    if let Some(err) = value.get("error") {
        return Err(format!("webxdc rpc error: {err}"));
    }
    Ok(value.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

pub async fn webxdc_serve(
    app: tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .header("Access-Control-Allow-Origin", "*")
            .body(b"not found".to_vec())
            .unwrap()
    };
    let uri = request.uri().to_string();
    // http://webxdc.localhost/<account>/<msg>/<path> and webxdc://localhost/<...>
    let rest = match uri.split_once("://") {
        Some((_, rest)) => match rest.split_once('/') {
            Some((_, rest)) => rest,
            None => return not_found(),
        },
        None => return not_found(),
    };
    let rest = rest.split('?').next().unwrap_or(rest);
    let mut segments = rest.split('/');
    let account: u32 = match segments.next().and_then(|s| s.parse().ok()) {
        Some(v) => v,
        None => return not_found(),
    };
    let msg: u32 = match segments.next().and_then(|s| s.parse().ok()) {
        Some(v) => v,
        None => return not_found(),
    };
    let path = segments.collect::<Vec<_>>().join("/");
    let path = percent_decode(&path);
    let path = if path.is_empty() { "index.html".to_string() } else { path };

    if path == "__velta-shim.js" {
        return tauri::http::Response::builder()
            .header("Content-Type", "text/javascript; charset=utf-8")
            .header("Cache-Control", "no-cache")
            .body(WEBXDC_SHIM.as_bytes().to_vec())
            .unwrap();
    }

    let is_index = path == "index.html";
    let base64_blob = match webxdc_rpc(&app, "get_webxdc_blob", serde_json::json!([account, msg, path])).await {
        Ok(serde_json::Value::String(b64)) => b64,
        _ => return not_found(),
    };
    let mut bytes = match data_encoding::BASE64_NOPAD.decode(base64_blob.trim_end_matches('=').as_bytes()) {
        Ok(b) => b,
        Err(_) => return not_found(),
    };

    if is_index {
        // Inject the shim before the app's own scripts run so
        // window.webxdc exists by the time app code executes.
        let html = String::from_utf8_lossy(&bytes).to_string();
        let head_at = html
            .find("<head")
            .and_then(|i| html[i..].find('>').map(|j| i + j + 1))
            .unwrap_or(0);
        let mut injected = String::with_capacity(html.len() + 128);
        injected.push_str(&html[..head_at]);
        injected.push_str("<script src=\"__velta-shim.js\"></script>");
        injected.push_str(&html[head_at..]);
        bytes = injected.into_bytes();
    }

    let mime = guess_mime(&path).to_string();
    tauri::http::Response::builder()
        .header("Content-Type", mime)
        .header("Cache-Control", "no-cache")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap()
}
