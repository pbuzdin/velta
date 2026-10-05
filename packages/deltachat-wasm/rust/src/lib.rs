//! Minimal browser entry for chatmail core (Velta wasm spike).
//!
//! JSON-RPC over a JS callback (core → JS) and [`DeltaChat::receive`] (JS → core).
//! No OPFS persistence / crypto-offload / accounts.toml heal — those stay in
//! the prototype until ported deliberately.

use std::path::PathBuf;
use std::sync::Arc;

use deltachat_jsonrpc::api::{Accounts, CommandApi};
use tokio::sync::RwLock;
use wasm_bindgen::prelude::*;
use yerpc::{RpcClient, RpcSession};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

#[wasm_bindgen]
pub struct DeltaChat {
    session: RpcSession<CommandApi>,
}

/// Starts core with accounts at `/accounts` (in-memory memfs).
///
/// `on_message` receives every outgoing JSON-RPC message as a string.
/// `ws_proxy_url` optional (e.g. `ws://127.0.0.1:8641`); without it, networking fails.
/// `persist` is accepted for API compatibility but ignored in this minimal spike
/// (always ephemeral).
#[wasm_bindgen]
pub async fn init(
    on_message: js_sys::Function,
    ws_proxy_url: Option<String>,
    _persist: bool,
) -> Result<DeltaChat, JsValue> {
    console_error_panic_hook::set_once();

    if let Some(url) = ws_proxy_url {
        deltachat::net::ws_tcp::set_ws_proxy_url(url);
    }

    let accounts = Accounts::new(PathBuf::from("/accounts"), true)
        .await
        .map_err(|e| JsValue::from_str(&format!("failed to create accounts: {e:#}")))?;
    let accounts = Arc::new(RwLock::new(accounts));
    let state = CommandApi::from_arc(accounts).await;

    let (client, out_receiver) = RpcClient::new();
    let session = RpcSession::new(client, state);

    wasm_bindgen_futures::spawn_local(async move {
        while let Ok(message) = out_receiver.recv().await {
            match serde_json::to_string(&message) {
                Ok(message) => {
                    let _ = on_message.call1(&JsValue::NULL, &JsValue::from_str(&message));
                }
                Err(err) => console_error(&format!("failed to serialize RPC message: {err}")),
            }
        }
    });

    Ok(DeltaChat { session })
}

fn fs_err(err: std::io::Error) -> JsValue {
    JsValue::from_str(&err.to_string())
}

#[wasm_bindgen]
impl DeltaChat {
    pub fn receive(&self, message: String) {
        let session = self.session.clone();
        wasm_bindgen_futures::spawn_local(async move {
            session.handle_incoming(&message).await;
        });
    }

    pub fn fs_read(&self, path: String) -> Result<js_sys::Uint8Array, JsValue> {
        let data = tokio::fs::sync_read(&path).map_err(fs_err)?;
        Ok(js_sys::Uint8Array::from(data.as_slice()))
    }

    pub fn fs_write(&self, path: String, data: &[u8]) -> Result<(), JsValue> {
        tokio::fs::sync_write(&path, data).map_err(fs_err)
    }

    pub fn fs_remove(&self, path: String) -> Result<(), JsValue> {
        tokio::fs::sync_remove(&path).map_err(fs_err)
    }

    pub fn fs_exists(&self, path: String) -> bool {
        tokio::fs::sync_exists(&path)
    }

    pub fn fs_mkdirp(&self, path: String) -> Result<(), JsValue> {
        tokio::fs::sync_create_dir_all(&path).map_err(fs_err)
    }
}
