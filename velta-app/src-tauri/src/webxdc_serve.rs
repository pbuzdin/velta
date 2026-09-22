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

// Webxdc apps must have no network access (webxdc spec). The app's CSP in
// tauri.conf.json does not cover custom-protocol responses, so every
// webxdc response carries its own policy: only the webxdc origin plus
// data:/blob:, no remote hosts, no WebRTC. 'unsafe-inline'/'unsafe-eval'
// stay allowed for scripts because apps (and the injected
// __TAURI_INTERNALS__ stub) rely on them. Same policy shape as Delta Chat
// desktop. The webxdc origins are listed explicitly next to 'self': the
// frame is sandboxed into an opaque origin, and the app's own assets must
// keep loading no matter how the WebView resolves 'self' there.
pub const WEBXDC_CSP: &str = "default-src 'self' http://webxdc.localhost https://webxdc.localhost webxdc://localhost; \
    style-src 'self' http://webxdc.localhost https://webxdc.localhost webxdc://localhost 'unsafe-inline' blob:; \
    font-src 'self' http://webxdc.localhost https://webxdc.localhost webxdc://localhost data: blob:; \
    script-src 'self' http://webxdc.localhost https://webxdc.localhost webxdc://localhost 'unsafe-inline' 'unsafe-eval' blob:; \
    connect-src 'self' http://webxdc.localhost https://webxdc.localhost webxdc://localhost data: blob:; \
    img-src 'self' http://webxdc.localhost https://webxdc.localhost webxdc://localhost data: blob:; \
    media-src 'self' http://webxdc.localhost https://webxdc.localhost webxdc://localhost data: blob:; \
    frame-src 'self' http://webxdc.localhost https://webxdc.localhost webxdc://localhost data: blob:; \
    webrtc 'block'";

static WXDC_RPC_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// Last app whose index.html was served. Spec-violating apps built with
// absolute asset paths ("/assets/…" — vite's default base "/") drop the
// /<account>/<msg>/ prefix, and those requests arrive with no app context.
// Velta opens exactly one webxdc app at a time, so un-prefixed paths
// resolve against the app that is currently open. Ceiling: with several
// Velta windows open, a closed app's assets may resolve against a stale
// entry — harmless (still 404 unless names collide).
static OPEN_APP: std::sync::Mutex<Option<(u32, u32)>> = std::sync::Mutex::new(None);

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
    // A counter, not a timestamp: parallel asset requests could share a
    // nanosecond stamp (100 ns clock resolution on Windows), and a colliding
    // id overwrote the first waiter in wxdc_pending.
    let id = format!(
        "wxdc-{}",
        WXDC_RPC_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let request = serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    {
        // Scope the State borrow: the response arrives via the forwarders
        // (reader thread / android task) while this future is suspended.
        // Register the waiter BEFORE sending, or a fast response can arrive
        // while no one is registered and get dropped.
        let state = app.state::<RpcState>();
        state.wxdc_pending.lock().unwrap().insert(id.clone(), tx);
        if let Err(e) = state.send_rpc(&request.to_string()) {
            state.wxdc_pending.lock().unwrap().remove(&id);
            return Err(e);
        }
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
    // Absolute-path apps ("/assets/…") carry no <account>/<msg> prefix —
    // resolve against the currently open app (see OPEN_APP above).
    let (account, msg, path) = match (
        segments.next().and_then(|s| s.parse::<u32>().ok()),
        segments.next().and_then(|s| s.parse::<u32>().ok()),
    ) {
        (Some(account), Some(msg)) => (account, msg, segments.collect::<Vec<_>>().join("/")),
        _ => {
            let fallback = *OPEN_APP.lock().unwrap();
            match fallback {
                Some((account, msg)) => (account, msg, rest.to_string()),
                None => return not_found(),
            }
        }
    };
    let path = percent_decode(&path);
    let path = if path.is_empty() { "index.html".to_string() } else { path };

    // Some apps load `<script src="webxdc.js">` (the webxdc dev-server
    // convention). The shim is injected into index.html anyway, but alias
    // the path to it so those requests stop 404ing.
    if path == "__velta-shim.js" || path == "webxdc.js" {
        return tauri::http::Response::builder()
            .header("Content-Type", "text/javascript; charset=utf-8")
            .header("Cache-Control", "no-cache")
            .body(WEBXDC_SHIM.as_bytes().to_vec())
            .unwrap();
    }

    let is_index = path == "index.html";
    if is_index {
        // Remember the app being opened — its absolute-path subresource
        // requests resolve against this (see OPEN_APP above).
        *OPEN_APP.lock().unwrap() = Some((account, msg));
    }
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
        // window.webxdc exists by the time app code executes. Also stub
        // __TAURI_INTERNALS__: WebView2 runs Tauri's core+plugin init
        // scripts in opaque-origin frames too, and the plugin guests crash
        // with "Cannot read properties of undefined (reading 'plugins')"
        // because the internals object was never defined here. The stub
        // lands before them (document-created scripts run first), the
        // frame never legitimately uses Tauri APIs, and the console stays
        // clean so real app errors are visible.
        let html = String::from_utf8_lossy(&bytes).to_string();
        let head_at = html
            .find("<head")
            .and_then(|i| html[i..].find('>').map(|j| i + j + 1))
            .unwrap_or(0);
        let mut injected = String::with_capacity(html.len() + 256);
        injected.push_str(&html[..head_at]);
        injected.push_str("<script>window.__TAURI_INTERNALS__=window.__TAURI_INTERNALS__||{plugins:{},metadata:{}};</script>");
        injected.push_str("<script src=\"__velta-shim.js\"></script>");
        injected.push_str(&html[head_at..]);
        bytes = injected.into_bytes();
    }

    let mime = guess_mime(&path).to_string();
    tauri::http::Response::builder()
        .header("Content-Type", mime)
        .header("Cache-Control", "no-cache")
        .header("Content-Security-Policy", WEBXDC_CSP)
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap()
}
