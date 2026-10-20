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

/// Module-level memfs bindings — usable before [`init`] so the JS worker can
/// restore a persisted OPFS snapshot into the memfs ahead of core startup.

#[wasm_bindgen]
pub fn vfs_read(path: String) -> Result<js_sys::Uint8Array, JsValue> {
    let data = tokio::fs::sync_read(&path).map_err(fs_err)?;
    Ok(js_sys::Uint8Array::from(data.as_slice()))
}

#[wasm_bindgen]
pub fn vfs_write(path: String, data: &[u8]) -> Result<(), JsValue> {
    tokio::fs::sync_write(&path, data).map_err(fs_err)
}

#[wasm_bindgen]
pub fn vfs_remove(path: String) -> Result<(), JsValue> {
    tokio::fs::sync_remove(&path).map_err(fs_err)
}

#[wasm_bindgen]
pub fn vfs_mkdirp(path: String) -> Result<(), JsValue> {
    tokio::fs::sync_create_dir_all(&path).map_err(fs_err)
}

#[wasm_bindgen]
pub fn vfs_exists(path: String) -> bool {
    tokio::fs::sync_exists(&path)
}

/// Lists a memfs directory as absolute paths; directories carry a trailing `/`.
#[wasm_bindgen]
pub async fn vfs_list(path: String) -> Result<js_sys::Array, JsValue> {
    use futures_core::Stream;
    use std::task::{Context, Poll};

    let rd = tokio::fs::read_dir(&path).await.map_err(fs_err)?;
    let arr = js_sys::Array::new();
    // ReadDir is a ready snapshot; drain it with a noop waker instead of
    // pulling an async runtime across the JS boundary.
    let mut cx = Context::from_waker(std::task::Waker::noop());
    let mut stream = std::pin::pin!(rd);
    loop {
        match stream.as_mut().poll_next(&mut cx) {
            Poll::Ready(Some(Ok(entry))) => {
                let p = entry.path().to_string_lossy().to_string();
                if tokio::fs::sync_is_dir(&p) {
                    arr.push(&JsValue::from_str(&format!("{p}/")));
                } else {
                    arr.push(&JsValue::from_str(&p));
                }
            }
            Poll::Ready(Some(Err(e))) => return Err(fs_err(e)),
            Poll::Ready(None) | Poll::Pending => break,
        }
    }
    Ok(arr)
}

// SQLite does not live in the memfs: rusqlite on wasm32 opens every
// database in sqlite-wasm-rs's in-memory VFS. Without these bindings the
// OPFS snapshot saved only accounts.toml and the blob dirs, so a reload came
// back with the account listed but its dc.db empty (unconfigured) — #123/#126.
type MemVfs = sqlite_wasm_rs::MemVfsUtil<sqlite_wasm_rs::WasmOsCallback>;

fn is_db_side_file(name: &str) -> bool {
    name.ends_with("-journal") || name.ends_with("-wal") || name.ends_with("-shm")
}

/// Main database files currently held by the in-memory SQLite VFS.
#[wasm_bindgen]
pub fn sqlite_list() -> js_sys::Array {
    let arr = js_sys::Array::new();
    for name in MemVfs::new().list() {
        if !is_db_side_file(&name) {
            arr.push(&JsValue::from_str(&name));
        }
    }
    arr
}

/// Bytes of one in-memory database (consistent between JS turns: a
/// transaction never spans an await on the single-threaded worker).
#[wasm_bindgen]
pub fn sqlite_export(name: String) -> Result<js_sys::Uint8Array, JsValue> {
    let bytes = MemVfs::new()
        .export_db(&name)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(js_sys::Uint8Array::from(bytes.as_slice()))
}

/// Put a saved database back before core init opens it.
#[wasm_bindgen]
pub fn sqlite_import(name: String, data: &[u8]) -> Result<(), JsValue> {
    let util = MemVfs::new();
    util.delete_db(&name);
    match util.import_db(&name, data) {
        Ok(()) => Ok(()),
        // Not a plain SQLite header (SQLCipher): keep the bytes as they are.
        Err(_) => util
            .import_db_unchecked(&name, data, 4096)
            .map_err(|e| JsValue::from_str(&e.to_string())),
    }
}

#[wasm_bindgen]
pub struct DeltaChat {
    session: RpcSession<CommandApi>,
    accounts: Arc<RwLock<Accounts>>,
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
    let state = CommandApi::from_arc(accounts.clone()).await;

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

    Ok(DeltaChat { session, accounts })
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

    pub async fn fs_list(&self, path: String) -> Result<js_sys::Array, JsValue> {
        vfs_list(path).await
    }

    /// Web Push: hand the core a device token (`webpush:<endpoint>|<p256dh>|<auth>`).
    /// Shared by every account (`Accounts::set_push_device_token`); each
    /// account's IMAP loop encrypts it for the notifier and stores it in
    /// METADATA `/private/devicetoken` when its relay advertises XDELTAPUSH.
    /// In-memory only: the page calls this again on every boot.
    pub async fn set_push_device_token(&self, token: String) -> Result<(), JsValue> {
        let accounts = self.accounts.read().await;
        accounts
            .set_push_device_token(&token)
            .map_err(|e| JsValue::from_str(&format!("{e:#}")))?;
        // Wake idle loops so the registration does not wait for the next IDLE timeout.
        accounts.maybe_network().await;
        Ok(())
    }
}
