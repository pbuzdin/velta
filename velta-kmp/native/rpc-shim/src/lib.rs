//! In-process deltachat core for the Velta KMP Android client (issue #192 P1b).
//!
//! Mirrors `deltachat-rpc-server/src/main.rs` (Accounts + CommandApi +
//! yerpc RpcSession) but serves **JSON Lines on a 127.0.0.1 TCP port**
//! instead of stdio, so the Kotlin client needs no exec'd sidecar binary —
//! the same in-process architecture the Tauri Android shell uses
//! (`init_android_core`), minus the Tauri event plumbing.
//!
//! **Auth (#334):** loopback is reachable by every app on the device, so a
//! bare port would hand the whole core (messages, keys, send-as-you) to any
//! app with INTERNET. Each `start_core` takes a per-launch random token from
//! the Kotlin side (SecureRandom, memory only). A connection must send that
//! token as its FIRST line within [AUTH_TIMEOUT]; anything else (wrong token,
//! no newline within [MAX_AUTH_LINE] bytes, silence) is dropped before a
//! single RPC line is read or any byte is written back.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use deltachat_jsonrpc::api::{Accounts, CommandApi};
use futures_util::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use yerpc::{RpcClient, RpcSession};

/// The current stop signal, installed by each `start_core` and taken by
/// `stop_core`. A fresh Notify per start means a stale permit can never kill
/// a later session (issue #224: the shim used to be start-only).
static STOP: std::sync::RwLock<Option<Arc<tokio::sync::Notify>>> = std::sync::RwLock::new(None);

/// Live client sessions, aborted on stop so no task keeps the Accounts (and
/// the sqlite handles) alive after the accept loop has ended.
static SESSIONS: Mutex<Vec<JoinHandle<()>>> = Mutex::new(Vec::new());

/// How long a fresh connection may take to present the token.
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

/// Upper bound on the auth line (the token is 64 hex chars); a longer line
/// is rejected without buffering it.
const MAX_AUTH_LINE: usize = 256;

/// Minimum accepted token length — `start_core` refuses weaker tokens.
const MIN_TOKEN_LEN: usize = 32;

/// Constant-time equality: the running time depends only on the lengths,
/// never on where the first differing byte is.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Reads the first line (byte-wise, capped at [MAX_AUTH_LINE]) and checks it
/// against `token`. False on mismatch, EOF, an over-long line or timeout.
async fn authenticate<R: AsyncRead + Unpin>(
    reader: &mut R,
    token: &str,
    timeout: Duration,
) -> bool {
    let read_line = async {
        let mut line = Vec::with_capacity(token.len() + 2);
        loop {
            let byte = reader.read_u8().await.ok()?;
            if byte == b'\n' {
                break;
            }
            if line.len() >= MAX_AUTH_LINE {
                return None;
            }
            line.push(byte);
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        Some(line)
    };
    match tokio::time::timeout(timeout, read_line).await {
        Ok(Some(line)) => ct_eq(&line, token.as_bytes()),
        _ => false,
    }
}

/// One yerpc session per connection: read request lines, dispatch them as
/// independent tasks, and forward responses/events back as JSON Lines.
/// `velta_set_push_device_token` is intercepted before dispatch: it is a
/// shim-only extension (Accounts::set_push_device_token is not on the
/// JSON-RPC surface, and the shim holds the accounts manager).
async fn serve_connection(
    state: CommandApi,
    accounts: Arc<RwLock<Accounts>>,
    stream: tokio::net::TcpStream,
    token: Arc<str>,
    auth_timeout: Duration,
) -> anyhow::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    // Auth gate (#334): nothing is dispatched or written before this passes.
    if !authenticate(&mut reader, &token, auth_timeout).await {
        anyhow::bail!("rejected unauthenticated connection");
    }
    let (client, mut out_receiver) = RpcClient::new();
    let session = RpcSession::new(client.clone(), state);
    let mut lines = reader.lines();

    loop {
        tokio::select! {
            incoming = lines.next_line() => match incoming? {
                Some(line) => {
                    if let Some(response) = push_token_intercept(&accounts, &line).await {
                        writer.write_all(response.as_bytes()).await?;
                        writer.write_all(b"\n").await?;
                        continue;
                    }
                    let session = session.clone();
                    tokio::spawn(async move {
                        session.handle_incoming(&line).await;
                    });
                }
                None => break,
            },
            outgoing = out_receiver.next() => match outgoing {
                Some(message) => {
                    let line = serde_json::to_string(&message)?;
                    writer.write_all(line.as_bytes()).await?;
                    writer.write_all(b"\n").await?;
                }
                None => break,
            },
        }
    }
    Ok(())
}

/// Answers `velta_set_push_device_token` directly and returns the JSON Lines
/// response, or None when the line is anything else (normal RPC dispatch).
async fn push_token_intercept(accounts: &Arc<RwLock<Accounts>>, line: &str) -> Option<String> {
    let obj: serde_json::Value = serde_json::from_str(line).ok()?;
    let method = obj.get("method")?.as_str()?;
    if method != "velta_set_push_device_token" {
        return None;
    }
    let id = obj.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let token = obj
        .get("params")
        .and_then(|p| p.get(0))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());

    let response = match token {
        Some(token) => match accounts.read().await.set_push_device_token(&token) {
            Ok(()) => serde_json::json!({"jsonrpc": "2.0", "id": id, "result": null}),
            Err(e) => serde_json::json!({
                "jsonrpc": "2.0", "id": id,
                "error": {"code": -1, "message": format!("push token failed: {e:#}")},
            }),
        },
        None => serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "error": {"code": -1, "message": "missing token param"},
        }),
    };
    Some(serde_json::to_string(&response).unwrap_or_default())
}

/// The accept loop: every connection must pass [authenticate] before it gets
/// a session. Ends on `stop`, aborting live sessions.
async fn serve(
    listener: TcpListener,
    token: Arc<str>,
    state: CommandApi,
    accounts: Arc<RwLock<Accounts>>,
    stop: Arc<tokio::sync::Notify>,
    auth_timeout: Duration,
    sessions: &'static Mutex<Vec<JoinHandle<()>>>,
) {
    loop {
        tokio::select! {
            _ = stop.notified() => {
                eprintln!("velta-rpc-shim: stop signal — shutting down");
                break;
            }
            accepted = listener.accept() => {
                let (stream, _peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(e) => {
                        eprintln!("velta-rpc-shim: accept failed: {e}");
                        continue;
                    }
                };
                let state = state.clone();
                let accounts = accounts.clone();
                let token = token.clone();
                let handle = tokio::spawn(async move {
                    if let Err(e) = serve_connection(state, accounts, stream, token, auth_timeout).await {
                        eprintln!("velta-rpc-shim: connection ended: {e:#}");
                    }
                });
                let mut live = sessions.lock().expect("sessions lock");
                live.retain(|h| !h.is_finished());
                live.push(handle);
            }
        }
    }
    // End the live client sessions so nothing keeps the Accounts
    // (and their sqlite handles) alive after the accept loop.
    for handle in sessions.lock().expect("sessions lock").drain(..) {
        handle.abort();
    }
}

/// Bind a loopback port synchronously (the port must be known before the
/// JNI call returns), then serve the core from a dedicated thread with its
/// own tokio runtime. Returns the port, or a distinct negative code:
/// -2 bind failed, -3 Accounts::new failed, -4 auth token too short.
///
/// `auth_token` is the per-launch connection secret (#334); it is kept only
/// in this process's memory and never logged.
///
/// `db_key` is the 64-hex database-encryption DEK (#178 port): the vendored
/// core reads `VELTA_DB_KEY` from the environment when accounts open
/// (patch #20), so it is set HERE — before the worker thread and the tokio
/// runtime exist, the only moment in this process where env mutation cannot
/// race a concurrent reader. Empty string = keyless (upstream behavior).
fn start_core(accounts_dir: String, db_key: String, auth_token: String) -> anyhow::Result<i32> {
    if auth_token.len() < MIN_TOKEN_LEN {
        eprintln!("velta-rpc-shim: refusing to start without a strong auth token");
        return Ok(-4);
    }
    let token: Arc<str> = Arc::from(auth_token);
    if !db_key.is_empty() {
        std::env::set_var("VELTA_DB_KEY", &db_key);
    }
    let std_listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("velta-rpc-shim: bind failed: {e:#}");
            return Ok(-2);
        }
    };
    let port = std_listener.local_addr()?.port() as i32;
    // tokio's from_std requires a non-blocking socket.
    std_listener.set_nonblocking(true)?;

    let stop = Arc::new(tokio::sync::Notify::new());
    *STOP.write().expect("stop lock") = Some(stop.clone());
    SESSIONS.lock().expect("sessions lock").clear();

    std::thread::Builder::new()
        .name("velta-rpc-shim".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            rt.block_on(async move {
                let accounts = match Accounts::new(PathBuf::from(&accounts_dir), true).await {
                    Ok(accounts) => Arc::new(RwLock::new(accounts)),
                    Err(e) => {
                        eprintln!("velta-rpc-shim: Accounts::new failed: {e:#}");
                        return;
                    }
                };
                let state = CommandApi::from_arc(accounts.clone()).await;
                let listener = match TcpListener::from_std(std_listener) {
                    Ok(listener) => listener,
                    Err(e) => {
                        eprintln!("velta-rpc-shim: listener handoff failed: {e}");
                        return;
                    }
                };
                eprintln!("velta-rpc-shim: serving core on 127.0.0.1:{port}");
                serve(
                    listener,
                    token,
                    state,
                    accounts,
                    stop,
                    AUTH_TIMEOUT,
                    &SESSIONS,
                )
                .await;
                // accounts/state drop here — databases close with the process
                // still alive, so a later start_core starts clean.
            });
        })?;

    Ok(port)
}

/// Signals the accept loop to end, aborts live sessions and clears the
/// installed stop signal. Returns 0 always (idempotent: no shim running =
/// nothing to do); the Kotlin side clears its cached port.
fn stop_core() -> i32 {
    if let Some(stop) = STOP.write().expect("stop lock").take() {
        stop.notify_one();
    }
    for handle in SESSIONS.lock().expect("sessions lock").drain(..) {
        handle.abort();
    }
    0
}

/// JNI entry: `org.velta.kmp.core.RpcShim.startCore(accountsDir, dbKey, authToken) -> port`.
/// Returns -1 on failure (the Kotlin side surfaces that as a connect error).
#[no_mangle]
pub extern "system" fn Java_org_velta_kmp_core_RpcShim_startCore<'local>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
    accounts_dir: jni::objects::JString<'local>,
    db_key: jni::objects::JString<'local>,
    auth_token: jni::objects::JString<'local>,
) -> i32 {
    let dir: String = match env.get_string(&accounts_dir) {
        Ok(s) => s.into(),
        Err(_) => return -1,
    };
    // An absent (null) key runs keyless — same as the empty string.
    let key: String = match env.get_string(&db_key) {
        Ok(s) => s.into(),
        Err(_) => String::new(),
    };
    // A missing token can't authenticate anyone: start_core refuses it.
    let token: String = match env.get_string(&auth_token) {
        Ok(s) => s.into(),
        Err(_) => String::new(),
    };
    match start_core(dir, key, token) {
        Ok(port) => port,
        Err(e) => {
            eprintln!("velta-rpc-shim: start failed: {e:#}");
            -1
        }
    }
}

/// JNI entry: `org.velta.kmp.core.RpcShim.stopCore() -> 0`. Idempotent.
#[no_mangle]
pub extern "system" fn Java_org_velta_kmp_core_RpcShim_stopCore(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
) -> i32 {
    stop_core()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn push_token_intercept_answers_and_stores() {
        let dir = std::env::temp_dir().join("velta-shim-intercept-test");
        let accounts = Arc::new(RwLock::new(
            Accounts::new(dir, true).await.expect("accounts"),
        ));

        let push_line = r#"{"jsonrpc":"2.0","id":7,"method":"velta_set_push_device_token","params":["webpush:x|key|auth"]}"#;
        let response = push_token_intercept(&accounts, push_line)
            .await
            .expect("push line must be intercepted");
        assert!(response.contains("\"result\":null"), "response: {response}");

        // A normal RPC line must NOT be intercepted.
        assert!(
            push_token_intercept(
                &accounts,
                r#"{"jsonrpc":"2.0","id":1,"method":"get_system_info","params":[]}"#
            )
            .await
            .is_none(),
            "regular RPC lines pass through"
        );
    }

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// Test servers track their sessions here, not in the production
    /// SESSIONS that stop_core drains (other tests call it concurrently).
    static TEST_SESSIONS: Mutex<Vec<JoinHandle<()>>> = Mutex::new(Vec::new());

    /// A real loopback server (temp accounts dir) behind the auth gate, with
    /// a short auth timeout so the silent-client case stays fast. Never
    /// stopped: the runtime of each #[tokio::test] tears it down.
    async fn auth_server(name: &str) -> u16 {
        let dir =
            std::env::temp_dir().join(format!("velta-shim-auth-{name}-{}", std::process::id()));
        let accounts = Arc::new(RwLock::new(
            Accounts::new(dir, true).await.expect("accounts"),
        ));
        let state = CommandApi::from_arc(accounts.clone()).await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(serve(
            listener,
            Arc::from(TOKEN),
            state,
            accounts,
            Arc::new(tokio::sync::Notify::new()),
            Duration::from_millis(500),
            &TEST_SESSIONS,
        ));
        port
    }

    /// Sends `preamble`, then a get_system_info request, and returns
    /// everything the server writes back until it closes (or 3 s pass).
    async fn exchange(port: u16, preamble: &[u8]) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        stream.write_all(preamble).await.expect("write preamble");
        let _ = stream
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"get_system_info\",\"params\":[]}\n",
            )
            .await;
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            match tokio::time::timeout_at(deadline, stream.read(&mut buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                Ok(Ok(n)) => {
                    out.extend_from_slice(&buf[..n]);
                    if out.contains(&b'\n') {
                        break;
                    }
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn ct_eq_matches_only_identical_bytes() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
        assert!(!ct_eq(b"", b"a"));
    }

    #[tokio::test]
    async fn unauthenticated_connection_is_rejected() {
        let port = auth_server("noauth").await;
        // The RPC line itself is the "first line" — it is not the token.
        let reply = exchange(port, b"").await;
        assert!(
            reply.is_empty(),
            "no byte may come back without the token: {reply}"
        );
    }

    #[tokio::test]
    async fn wrong_token_is_rejected() {
        let port = auth_server("wrong").await;
        let wrong = format!("{}\n", TOKEN.replace('0', "1"));
        assert!(exchange(port, wrong.as_bytes()).await.is_empty());
        // Prefix of the right token (length mismatch) fails too.
        assert!(exchange(port, format!("{}\n", &TOKEN[..40]).as_bytes())
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn oversized_auth_line_is_rejected() {
        let port = auth_server("huge").await;
        let huge = vec![b'a'; MAX_AUTH_LINE * 4];
        assert!(exchange(port, &huge).await.is_empty());
    }

    #[tokio::test]
    async fn silent_connection_is_closed_after_the_auth_timeout() {
        let port = auth_server("silent").await;
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let mut buf = [0u8; 16];
        let n = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut buf))
            .await
            .expect("server must close a silent client")
            .unwrap_or(0);
        assert_eq!(n, 0, "closed without data");
    }

    #[tokio::test]
    async fn correct_token_gets_rpc_responses() {
        let port = auth_server("ok").await;
        let reply = exchange(port, format!("{TOKEN}\n").as_bytes()).await;
        assert!(reply.contains("\"id\":1"), "reply: {reply}");
        assert!(reply.contains("\"result\""), "reply: {reply}");
        assert!(reply.contains("deltachat_core_version"), "reply: {reply}");
    }

    #[test]
    fn start_core_refuses_a_weak_token() {
        let dir = std::env::temp_dir().join("velta-shim-weak-token");
        assert_eq!(
            start_core(
                dir.to_string_lossy().into_owned(),
                String::new(),
                "short".into()
            )
            .unwrap(),
            -4
        );
        assert_eq!(
            start_core(
                dir.to_string_lossy().into_owned(),
                String::new(),
                String::new()
            )
            .unwrap(),
            -4
        );
    }

    #[test]
    fn stop_core_without_shim_is_a_noop() {
        // STOP is process-global and other tests in this binary may hold it
        // installed concurrently — only the return contract is asserted here;
        // the per-start signal semantics live in stop_signal_is_per_start.
        assert_eq!(stop_core(), 0);
    }

    /// The stop signal is consumed by the notify: after stop_core takes the
    /// Notify, a NEW start installs a fresh one, so a stale permit can never
    /// kill a later session.
    #[tokio::test]
    async fn stop_signal_is_per_start() {
        let stop = Arc::new(tokio::sync::Notify::new());
        *STOP.write().expect("stop lock") = Some(stop.clone());
        // A waiter registered BEFORE the notify must wake immediately.
        let waiter = {
            let stop = stop.clone();
            tokio::spawn(async move { stop.notified().await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(stop_core(), 0);
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("waiter must wake on stop")
            .expect("join");
        assert!(
            STOP.read().expect("stop lock").is_none(),
            "stop consumed the signal"
        );
    }
}
