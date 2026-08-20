use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use futures_lite::stream::StreamExt;
use futures_util::{SinkExt, StreamExt as WsStreamExt};
use jni::objects::{GlobalRef, JClass, JObject, JString, JValueOwned};
use jni::{JNIEnv, JavaVM};
use once_cell::sync::OnceCell;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio_tungstenite::tungstenite::Message;
use yerpc::{RpcClient, RpcSession};

use deltachat_jsonrpc::api::{Accounts, CommandApi};

static JAVA_VM: OnceCell<JavaVM> = OnceCell::new();
static RPC_LISTENER: OnceCell<RwLock<Option<GlobalRef>>> = OnceCell::new();
static SESSION: OnceCell<RwLock<Option<RpcSession<CommandApi>>>> = OnceCell::new();
static BROADCAST: OnceCell<broadcast::Sender<String>> = OnceCell::new();

fn loge(msg: &str) {
    log::error!("[rpc_core] {msg}");
}

fn logi(msg: &str) {
    log::info!("[rpc_core] {msg}");
}

/// deliver one JSON-RPC line from Rust to the Java listener (RpcService)
fn deliver_to_java(line: &str) {
    let Some(vm) = JAVA_VM.get() else { return };
    let Ok(mut env) = vm.attach_current_thread() else { return };
    let Some(listener_ref) = RPC_LISTENER.get().and_then(|l| l.blocking_read().clone()) else {
        return;
    };
    let Ok(jstr) = env.new_string(line) else { return };
    let _ = env.call_method(
        &listener_ref,
        "onRpcMessage",
        "(Ljava/lang/String;)V",
        &[JValueOwned::Object(JObject::from(jstr))],
    );
}

/// broadcast a line to every connected WebSocket client
fn broadcast_line(line: &str) {
    if let Some(tx) = BROADCAST.get() {
        let _ = tx.send(line.to_string());
    }
}

#[no_mangle]
pub extern "system" fn Java_org_velta_coreservice_RpcService_nativeInit(
    mut env: JNIEnv,
    _class: JClass,
) {
    let _ = android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("rpc_core"),
    );
    logi("nativeInit");
    let Ok(vm) = env.get_java_vm() else {
        loge("nativeInit: could not obtain JavaVM");
        return;
    };
    let _ = JAVA_VM.set(vm);
    let _ = RPC_LISTENER.set(RwLock::new(None));
    let _ = SESSION.set(RwLock::new(None));
    let (tx, _rx) = broadcast::channel(256);
    let _ = BROADCAST.set(tx);
}

#[no_mangle]
pub extern "system" fn Java_org_velta_coreservice_RpcService_nativeStart(
    mut env: JNIEnv,
    _class: JClass,
    accounts_dir: JString,
) {
    logi("nativeStart");
    let dir: String = match env.get_string(&accounts_dir) {
        Ok(s) => s.into(),
        Err(e) => {
            loge(&format!("nativeStart: invalid accounts_dir string: {e}"));
            return;
        }
    };
    let accounts_path = PathBuf::from(dir);
    if let Err(e) = std::fs::create_dir_all(&accounts_path) {
        // Java side will surface this; nothing else we can do here.
        loge(&format!("nativeStart: cannot create accounts dir {}: {e}", accounts_path.display()));
        return;
    }

    // Build the in-process core.
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            loge(&format!("nativeStart: tokio runtime failed: {e}"));
            return;
        }
    };

    let session = match rt.block_on(async move {
        let accounts = Accounts::new(accounts_path, true)
            .await
            .context("Accounts::new")?;
        let accounts = Arc::new(RwLock::new(accounts));
        let state = CommandApi::from_arc(accounts.clone()).await;

        let (client, mut out_rx) = RpcClient::new();
        let session = RpcSession::new(client.clone(), state);

        // forward every response/notification to Java listener and WS clients
        tokio::spawn(async move {
            while let Some(msg) = out_rx.next().await {
                match serde_json::to_string(&msg) {
                    Ok(line) => {
                        deliver_to_java(&line);
                        broadcast_line(&line);
                    }
                    Err(e) => loge(&format!("nativeStart: serialize: {e}")),
                }
            }
        });

        Ok::<RpcSession<CommandApi>, anyhow::Error>(session)
    }) {
        Ok(s) => s,
        Err(e) => {
            loge(&format!("nativeStart: core init failed: {e:#}"));
            return;
        }
    };

    if let Some(sess) = SESSION.get() {
        *sess.blocking_write() = Some(session);
    }

    // spawn the loopback WebSocket bridge
    rt.spawn(async move {
        if let Err(e) = run_ws_bridge().await {
            loge(&format!("ws bridge failed: {e:#}"));
        }
    });

    // spawn the loopback HTTP bridge (health + rpc)
    rt.spawn(async move {
        if let Err(e) = run_http_bridge().await {
            loge(&format!("http bridge failed: {e:#}"));
        }
    });

    // Keep the runtime alive for the lifetime of the process.
    std::mem::forget(rt);
    logi("nativeStart: core ready");
}

#[no_mangle]
pub extern "system" fn Java_org_velta_coreservice_RpcService_nativeStop(
    _env: JNIEnv,
    _class: JClass,
) {
    logi("nativeStop");
    if let Some(sess) = SESSION.get() {
        *sess.blocking_write() = None;
    }
    if let Some(listener) = RPC_LISTENER.get() {
        *listener.blocking_write() = None;
    }
}

#[no_mangle]
pub extern "system" fn Java_org_velta_coreservice_RpcService_nativeRpc(
    mut env: JNIEnv,
    _class: JClass,
    request: JString,
) {
    let line: String = match env.get_string(&request) {
        Ok(s) => s.into(),
        Err(_) => return,
    };
    let Some(sess) = SESSION.get() else { return };
    let Some(session) = sess.blocking_read().clone() else { return };
    tokio::spawn(async move {
        session.handle_incoming(&line).await;
    });
}

/// register a Java object that implements `onRpcMessage(String)`
#[no_mangle]
pub extern "system" fn Java_org_velta_coreservice_RpcService_nativeSetRpcListener(
    mut env: JNIEnv,
    _class: JClass,
    listener: JObject,
) {
    logi("nativeSetRpcListener");
    let Some(listener_map) = RPC_LISTENER.get() else {
        loge("nativeSetRpcListener: RPC_LISTENER not initialised");
        return;
    };
    if listener.is_null() {
        *listener_map.blocking_write() = None;
        return;
    }
    match env.new_global_ref(listener) {
        Ok(g) => *listener_map.blocking_write() = Some(g),
        Err(e) => loge(&format!("nativeSetRpcListener: {e}")),
    }
}

/* ---------------- WebSocket bridge on 127.0.0.1:20808 ---------------- */

async fn run_ws_bridge() -> anyhow::Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], 20808));
    let listener = TcpListener::bind(addr).await.context("bind ws")?;
    logi(&format!("ws bridge listening on {addr}"));

    loop {
        let (stream, peer) = listener.accept().await.context("accept ws")?;
        logi(&format!("ws client connected: {peer}"));
        tokio::spawn(async move {
            if let Err(e) = handle_ws_client(stream).await {
                loge(&format!("ws client {peer} error: {e:#}"));
            }
        });
    }
}

async fn handle_ws_client(stream: tokio::net::TcpStream) -> anyhow::Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await.context("ws handshake")?;
    let (mut write, mut read) = ws.split();

    let mut rx = BROADCAST
        .get()
        .context("broadcast not initialised")?
        .subscribe();

    // forward broadcast lines to this client
    let write_task = tokio::spawn(async move {
        while let Ok(line) = rx.recv().await {
            if write.send(Message::Text(line)).await.is_err() {
                break;
            }
        }
    });

    // forward incoming lines to the core
    while let Some(msg) = read.next().await {
        let msg = msg.context("ws read")?;
        if let Message::Text(line) = msg {
            let Some(sess) = SESSION.get() else { continue };
            let Some(session) = sess.read().await.clone() else { continue };
            tokio::spawn(async move {
                session.handle_incoming(&line).await;
            });
        }
    }

    write_task.abort();
    Ok(())
}

/* ---------------- HTTP bridge on 127.0.0.1:20809 ---------------- */

async fn run_http_bridge() -> anyhow::Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], 20809));
    let server = tiny_http::Server::http(addr).map_err(|e| anyhow::anyhow!("bind http: {e}"))?;
    logi(&format!("http bridge listening on {addr}"));

    for mut request in server.incoming_requests() {
        let url = request.url().to_string();
        let method = request.method().to_string();
        logi(&format!("http {method} {url}"));

        match (method.as_str(), url.as_str()) {
            ("GET", "/health") => {
                let response = tiny_http::Response::from_string("ok")
                    .with_status_code(200)
                    .with_header(
                        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..])
                            .unwrap(),
                    );
                let _ = request.respond(response);
            }
            ("POST", "/rpc") => {
                let mut body = String::new();
                if let Err(e) = request.as_reader().read_to_string(&mut body) {
                    loge(&format!("http rpc read body: {e}"));
                    let response = tiny_http::Response::from_string("bad request")
                        .with_status_code(400);
                    let _ = request.respond(response);
                    continue;
                }

                let Some(sess) = SESSION.get() else {
                    let response = tiny_http::Response::from_string("core not ready")
                        .with_status_code(503);
                    let _ = request.respond(response);
                    continue;
                };
                let Some(session) = sess.read().await.clone() else {
                    let response = tiny_http::Response::from_string("core not ready")
                        .with_status_code(503);
                    let _ = request.respond(response);
                    continue;
                };

                // The HTTP bridge is request/response only: we need to capture the
                // single response line for this request. We do this by creating a
                // temporary one-shot channel and a temporary RpcClient that forwards
                // only the matching response.
                let (tx, mut rx) = mpsc::channel::<String>(1);
                let (client, mut out_rx) = RpcClient::new();
                let session = session.clone();
                tokio::spawn(async move {
                    session.handle_incoming(&body).await;
                });
                tokio::spawn(async move {
                    while let Some(msg) = out_rx.next().await {
                        if let Ok(line) = serde_json::to_string(&msg) {
                            let _ = tx.send(line).await;
                            break;
                        }
                    }
                });

                let response = match tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    rx.recv(),
                )
                .await
                {
                    Ok(Some(line)) => tiny_http::Response::from_string(line)
                        .with_status_code(200)
                        .with_header(
                            tiny_http::Header::from_bytes(
                                &b"Content-Type"[..],
                                &b"application/json"[..],
                            )
                            .unwrap(),
                        ),
                    _ => tiny_http::Response::from_string("timeout")
                        .with_status_code(504),
                };
                let _ = request.respond(response);
            }
            _ => {
                let response = tiny_http::Response::from_string("not found")
                    .with_status_code(404);
                let _ = request.respond(response);
            }
        }
    }
    Ok(())
}
