use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, OnceLock};

use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};
use tokio::net::TcpListener;

// V-01/#61: the loopback bridges authenticate clients with a per-start
// random token. /health stays open (the transport probe), /rpc and the
// WebSocket upgrade require it. The token reaches the legitimate client
// out-of-band: JNI (same-process MainActivity shows it for pairing) and
// the `velta-bridge-token` localStorage key on the PWA side.
static BRIDGE_TOKEN: LazyLock<String> = LazyLock::new(|| {
    // 16 bytes of OS entropy, hex — no extra dependency.
    let mut buf = [0u8; 16];
    match std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf)) {
        Ok(()) => {}
        Err(e) => loge(&format!("bridge token: urandom unavailable ({e}) — falling back to time-seeded")),
    }
    if buf == [0u8; 16] {
        // urandom failed: degrade to a time-derived value rather than a
        // constant (weakest acceptable, still not hardcoded).
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0x9E3779B97F4A7C15);
        for (i, chunk) in buf.chunks_mut(8).enumerate() {
            let v = ((t >> (i * 32)) ^ t.wrapping_mul(0x2545F4914F6CDD1D)) as u64;
            for (j, b) in chunk.iter_mut().enumerate() {
                *b = (v >> (j * 8)) as u8;
            }
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
});

fn bridge_token() -> String {
    BRIDGE_TOKEN.clone()
}
use tokio::sync::{broadcast, RwLock};
use tokio_tungstenite::tungstenite::Message;
use yerpc::{RpcClient, RpcSession};

use deltachat_jsonrpc::api::{Accounts, CommandApi};

static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();
// std lock, not tokio's: deliver_to_java runs inside the core's forwarder
// task, where tokio's blocking_read() panics (and kills the forwarder).
static RPC_LISTENER: OnceLock<std::sync::RwLock<Option<GlobalRef>>> = OnceLock::new();
// The service runtime (nativeStart forgets it): JNI threads have no tokio
// context, so nativeRpc spawns through this handle.
static RUNTIME: OnceLock<tokio::runtime::Handle> = OnceLock::new();
static SESSION: OnceLock<RwLock<Option<RpcSession<CommandApi>>>> = OnceLock::new();
static BROADCAST: OnceLock<broadcast::Sender<String>> = OnceLock::new();

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
    let Some(listener_ref) = RPC_LISTENER.get().and_then(|l| l.read().ok()?.clone()) else {
        return;
    };
    let Ok(jstr) = env.new_string(line) else { return };
    let _ = env.call_method(
        &listener_ref,
        "onRpcMessage",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&jstr)],
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
    let _ = RPC_LISTENER.set(std::sync::RwLock::new(None));
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
            while let Some(msg) = StreamExt::next(&mut out_rx).await {
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
    let _ = RUNTIME.set(rt.handle().clone());

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
        set_listener(listener, None);
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
    let Some(rt) = RUNTIME.get() else {
        loge("nativeRpc: core runtime not started");
        return;
    };
    rt.spawn(async move {
        session.handle_incoming(&line).await;
    });
}

fn set_listener(lock: &std::sync::RwLock<Option<GlobalRef>>, value: Option<GlobalRef>) {
    *lock.write().unwrap_or_else(|e| e.into_inner()) = value;
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
        set_listener(listener_map, None);
        return;
    }
    match env.new_global_ref(listener) {
        Ok(g) => set_listener(listener_map, Some(g)),
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

    // V-01/#61: the client's FIRST message must be the bridge token. The
    // broadcast subscription below only happens after the check, so an
    // unauthenticated peer never sees a single core event. The read is
    // time-boxed so a silent socket can't hold resources.
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), StreamExt::next(&mut read)).await;
    match first {
        Ok(Some(Ok(Message::Text(line)))) if line.trim_matches('"') == bridge_token() => {}
        _ => {
            loge("ws auth: missing/invalid token — closing");
            return Ok(());
        }
    }
    logi("ws client authenticated");

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
    while let Some(msg) = StreamExt::next(&mut read).await {
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

// Every core response goes out on BROADCAST (the core has one RpcClient),
// and HTTP and WS clients each number their requests from 1. The bridge
// therefore gives each HTTP request a bridge-unique id, waits on the
// broadcast for the response that carries it, and puts the caller's id back.
static HTTP_RPC_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

// Longer than the client's event long-poll backstop (rpc-core
// EVENT_POLL_TIMEOUT_MS, 240 s): get_next_event_batch parks until an event
// exists, and answering it early would drop the batch the core then sends.
const HTTP_RPC_CEILING: std::time::Duration = std::time::Duration::from_secs(600);

#[derive(Debug, PartialEq)]
enum HttpRpc {
    Reply(String),
    /// A notification (no id): the core sends nothing back.
    NoContent,
    BadRequest(&'static str),
    NotReady,
    Timeout,
}

/// The request with its id swapped for `tag`, plus the caller's id (None for
/// a notification). Batches are refused: rpc-core never sends them.
fn tag_http_request(
    body: &str,
    tag: &serde_json::Value,
) -> Result<(String, Option<serde_json::Value>), &'static str> {
    let mut req: serde_json::Value = serde_json::from_str(body).map_err(|_| "invalid JSON")?;
    let obj = req.as_object_mut().ok_or("expected one JSON-RPC request object")?;
    let orig = match obj.get("id") {
        None | Some(serde_json::Value::Null) => None,
        Some(id) => Some(id.clone()),
    };
    if orig.is_some() {
        obj.insert("id".into(), tag.clone());
    }
    Ok((req.to_string(), orig))
}

/// `line` with the caller's id restored if it answers `tag`, else None.
fn untag_http_response(line: &str, tag: &serde_json::Value, orig: &serde_json::Value) -> Option<String> {
    let mut msg: serde_json::Value = serde_json::from_str(line).ok()?;
    let obj = msg.as_object_mut()?;
    if obj.get("id") != Some(tag) || obj.contains_key("method") {
        return None;
    }
    obj.insert("id".into(), orig.clone());
    Some(msg.to_string())
}

/// One POST /rpc body through the core session, like a WS line, returning
/// the matching response.
async fn http_rpc(body: &str) -> HttpRpc {
    let tag = serde_json::Value::String(format!(
        "velta-http-{}",
        HTTP_RPC_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let (line, orig) = match tag_http_request(body, &tag) {
        Ok(v) => v,
        Err(e) => return HttpRpc::BadRequest(e),
    };
    let session = match SESSION.get() {
        Some(s) => s.read().await.clone(),
        None => None,
    };
    let (Some(session), Some(broadcast)) = (session, BROADCAST.get()) else {
        return HttpRpc::NotReady;
    };
    let Some(orig) = orig else {
        tokio::spawn(async move { session.handle_incoming(&line).await });
        return HttpRpc::NoContent;
    };
    // Subscribe before the request goes in, or a fast reply is missed.
    let mut rx = broadcast.subscribe();
    tokio::spawn(async move { session.handle_incoming(&line).await });
    let wait = async {
        loop {
            match rx.recv().await {
                Ok(out) => {
                    if let Some(reply) = untag_http_response(&out, &tag, &orig) {
                        return Some(reply);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    loge(&format!("http rpc: broadcast lagged by {n}"));
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    };
    match tokio::time::timeout(HTTP_RPC_CEILING, wait).await {
        Ok(Some(reply)) => HttpRpc::Reply(reply),
        Ok(None) => HttpRpc::NotReady,
        Err(_) => HttpRpc::Timeout,
    }
}

fn http_respond(request: tiny_http::Request, status: u16, body: String, content_type: &str) {
    let response = tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap());
    let _ = request.respond(response);
}

async fn run_http_bridge() -> anyhow::Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], 20809));
    let server = tiny_http::Server::http(addr).map_err(|e| anyhow::anyhow!("bind http: {e}"))?;
    logi(&format!("http bridge listening on {addr}"));
    let rt = tokio::runtime::Handle::current();

    // tiny_http blocks: accept on a blocking thread and answer each /rpc in
    // its own task, so a parked event long-poll doesn't hold up the rest.
    tokio::task::spawn_blocking(move || {
        for mut request in server.incoming_requests() {
            let url = request.url().to_string();
            let method = request.method().to_string();
            logi(&format!("http {method} {url}"));

            match (method.as_str(), url.as_str()) {
                ("GET", "/health") => http_respond(request, 200, "ok".into(), "text/plain"),
                ("POST", "/rpc") => {
                    // V-01/#61: authenticated endpoint — the bearer token must
                    // match the per-start bridge token; /health stays open for
                    // the transport probe.
                    let auth_ok = request.headers().iter().any(|h| {
                        // HeaderField::equiv is case-insensitive.
                        h.field.equiv("Authorization")
                            && h.value.as_str() == format!("Bearer {}", bridge_token())
                    });
                    if !auth_ok {
                        loge("http rpc: unauthorized (missing/invalid token)");
                        http_respond(request, 401, "unauthorized".into(), "text/plain");
                        continue;
                    }
                    let mut body = String::new();
                    if let Err(e) = request.as_reader().read_to_string(&mut body) {
                        loge(&format!("http rpc read body: {e}"));
                        http_respond(request, 400, "bad request".into(), "text/plain");
                        continue;
                    }
                    rt.spawn(async move {
                        let outcome = http_rpc(&body).await;
                        tokio::task::spawn_blocking(move || match outcome {
                            HttpRpc::Reply(line) => http_respond(request, 200, line, "application/json"),
                            HttpRpc::NoContent => http_respond(request, 204, String::new(), "text/plain"),
                            HttpRpc::BadRequest(e) => http_respond(request, 400, e.into(), "text/plain"),
                            HttpRpc::NotReady => http_respond(request, 503, "core not ready".into(), "text/plain"),
                            HttpRpc::Timeout => http_respond(request, 504, "timeout".into(), "text/plain"),
                        });
                    });
                }
                _ => http_respond(request, 404, "not found".into(), "text/plain"),
            }
        }
    })
    .await
    .context("http bridge accept loop")?;
    Ok(())
}

/// V-01/#61: the bridge token, readable by the service APK's own UI (same
/// process) for pairing a loopback client. Never exposed over the network.
#[no_mangle]
pub extern "system" fn Java_org_velta_coreservice_RpcService_nativeGetBridgeToken<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
) -> JString<'local> {
    match env.new_string(bridge_token()) {
        Ok(s) => s,
        Err(e) => {
            loge(&format!("nativeGetBridgeToken: {e}"));
            match env.new_string("") {
                Ok(s) => s,
                Err(_) => JString::from(JObject::null()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn tag_swaps_the_id_and_keeps_the_rest() {
        let tag = json!("velta-http-7");
        let (line, orig) =
            tag_http_request(r#"{"jsonrpc":"2.0","id":1,"method":"get_system_info","params":[]}"#, &tag).unwrap();
        assert_eq!(orig, Some(json!(1)));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v, json!({"jsonrpc":"2.0","id":"velta-http-7","method":"get_system_info","params":[]}));
    }

    #[test]
    fn tag_notifications_and_bad_bodies() {
        let tag = json!("t");
        let (line, orig) = tag_http_request(r#"{"jsonrpc":"2.0","method":"x"}"#, &tag).unwrap();
        assert_eq!(orig, None);
        assert!(!line.contains("\"t\""));
        assert_eq!(tag_http_request(r#"{"jsonrpc":"2.0","id":null,"method":"x"}"#, &tag).unwrap().1, None);
        assert!(tag_http_request("not json", &tag).is_err());
        assert!(tag_http_request(r#"[{"jsonrpc":"2.0","id":1,"method":"x"}]"#, &tag).is_err());
    }

    #[test]
    fn untag_only_matches_its_own_response() {
        let (tag, orig) = (json!("velta-http-3"), json!(42));
        let reply = untag_http_response(r#"{"jsonrpc":"2.0","id":"velta-http-3","result":5}"#, &tag, &orig).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&reply).unwrap(), json!({"jsonrpc":"2.0","id":42,"result":5}));
        // another client's response with the caller's own numeric id
        assert_eq!(untag_http_response(r#"{"jsonrpc":"2.0","id":42,"result":1}"#, &tag, &orig), None);
        assert_eq!(untag_http_response(r#"{"jsonrpc":"2.0","id":"velta-http-30","result":1}"#, &tag, &orig), None);
        assert_eq!(untag_http_response("garbage", &tag, &orig), None);
    }

    /// POST /rpc against a real core session wired like nativeStart: the
    /// response comes back with the caller's id, a parked long-poll doesn't
    /// block other requests, and a WS client's same-numbered request doesn't
    /// steal the reply. One test: SESSION/BROADCAST are process statics and
    /// the forwarder lives on this runtime.
    #[test]
    fn http_rpc_round_trips_through_the_core() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!(
                "rpc_core-http-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
            ));
            let accounts = Accounts::new(dir.clone(), true).await.unwrap();
            let state = CommandApi::from_arc(Arc::new(RwLock::new(accounts))).await;
            let (client, mut out_rx) = RpcClient::new();
            let session = RpcSession::new(client.clone(), state);
            let (tx, _rx) = broadcast::channel(256);
            let _ = BROADCAST.set(tx);
            let _ = SESSION.set(RwLock::new(None));
            *SESSION.get().unwrap().write().await = Some(session.clone());
            tokio::spawn(async move {
                while let Some(msg) = StreamExt::next(&mut out_rx).await {
                    broadcast_line(&serde_json::to_string(&msg).unwrap());
                }
            });

            // A long-poll parks until an event exists; it must not hold up
            // the next request.
            let parked = tokio::spawn(async {
                http_rpc(r#"{"jsonrpc":"2.0","id":900,"method":"get_next_event","params":[]}"#).await
            });

            // A WS client's request with the same id 1 goes in alongside.
            let mut ws_view = BROADCAST.get().unwrap().subscribe();
            let ws_session = session.clone();
            tokio::spawn(async move {
                ws_session
                    .handle_incoming(r#"{"jsonrpc":"2.0","id":1,"method":"get_all_account_ids","params":[]}"#)
                    .await
            });
            let out = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                http_rpc(r#"{"jsonrpc":"2.0","id":1,"method":"get_system_info","params":[]}"#),
            )
            .await
            .expect("http_rpc answered while a long-poll is parked");
            let HttpRpc::Reply(line) = out else { panic!("expected a reply, got {out:?}") };
            let v: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(v["id"], json!(1));
            assert!(v["result"]["deltachat_core_version"].is_string(), "{v}");

            // The WS client still gets its own id-1 response (unchanged).
            let ws_reply = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    let l = ws_view.recv().await.unwrap();
                    let m: Value = serde_json::from_str(&l).unwrap();
                    if m["id"] == json!(1) {
                        return m;
                    }
                }
            })
            .await
            .unwrap();
            assert!(ws_reply["result"].is_array(), "{ws_reply}");

            assert_eq!(http_rpc(r#"{"jsonrpc":"2.0","method":"get_system_info"}"#).await, HttpRpc::NoContent);
            assert!(matches!(http_rpc("{").await, HttpRpc::BadRequest(_)));
            assert!(!parked.is_finished(), "the long-poll stays parked (no early 504)");
            parked.abort();
            let _ = std::fs::remove_dir_all(dir);
        });
    }
}
