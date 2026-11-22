//! In-process deltachat core for the Velta KMP Android client (#192, #357).
//!
//! One JSON-lines session, same framing as `deltachat-rpc-server`. Kotlin
//! calls `sendLine`; responses call `RpcShim.onNativeLine`. There is no
//! listening port — other apps cannot open the core. The session ends with
//! `RpcShim.onNativeExit`.
//!
//! `velta_set_push_device_token` used to be answered here, before yerpc;
//! it is on the JSON-RPC surface since #225 and dispatches normally.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use deltachat_jsonrpc::api::{Accounts, CommandApi};
use futures_util::StreamExt;
#[cfg(target_os = "android")]
use jni::objects::{GlobalRef, JClass, JString, JValue};
#[cfg(target_os = "android")]
use jni::{JNIEnv, JavaVM};
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;
use yerpc::{RpcClient, RpcSession};

pub mod p2p;
mod db_key;
mod loop_host;

/// Engine log line. `p2p.rs` calls this; it is not the core session log.
/// stderr ALWAYS: in the desktop sidecar (#424) stdout is the RPC channel —
/// a log line there would corrupt the JSON-lines framing. On Android this
/// surfaces in logcat like any println.
pub(crate) fn log(msg: &str) {
    eprintln!("velta-shim: {msg}");
}

pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).expect("OS random source unavailable");
    bytes
}

/// Per-start stop signal (#224). A stale permit must not kill the next session.
static STOP: std::sync::RwLock<Option<Arc<tokio::sync::Notify>>> = std::sync::RwLock::new(None);

/// `true` only while a session accepts `send_line`. `stop_core` clears it
/// before the worker thread has exited, so a later start waits and opens
/// a new Accounts instead of reusing a dying one.
static SERVING: AtomicBool = AtomicBool::new(false);

/// Serializes start and stop. Held across the previous worker's join so two
/// `Accounts` never open the same directory.
static START_LOCK: Mutex<()> = Mutex::new(());

static WORKER: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

static LIVE: Mutex<Option<mpsc::UnboundedSender<String>>> = Mutex::new(None);

#[cfg(target_os = "android")]
static VM: Mutex<Option<JavaVM>> = Mutex::new(None);
#[cfg(target_os = "android")]
static SHIM_CLASS: Mutex<Option<GlobalRef>> = Mutex::new(None);

/// Clears the session when the worker exits, including panic, and (on
/// Android) tells Kotlin. Constructed only after `Accounts::new` succeeds.
struct SessionGuard;

impl SessionGuard {
    fn arm() -> Self {
        SERVING.store(true, Ordering::SeqCst);
        SessionGuard
    }
}

#[cfg(target_os = "android")]
impl Drop for SessionGuard {
    fn drop(&mut self) {
        SERVING.store(false, Ordering::SeqCst);
        if let Ok(mut live) = LIVE.lock() {
            *live = None;
        }
        jni_on_exit();
    }
}

/// Desktop bin: the process ending IS the session end — no callback.
#[cfg(not(target_os = "android"))]
impl Drop for SessionGuard {
    fn drop(&mut self) {
        SERVING.store(false, Ordering::SeqCst);
        if let Ok(mut live) = LIVE.lock() {
            *live = None;
        }
    }
}

/// One yerpc session. `incoming` is `send_line`. `outgoing` is one JSON
/// object per line, no trailing newline. Ends on [stop] or a dropped sender.
async fn run_session(
    state: CommandApi,
    accounts: Arc<RwLock<Accounts>>,
    mut incoming: mpsc::UnboundedReceiver<String>,
    outgoing: mpsc::Sender<String>,
    stop: Arc<tokio::sync::Notify>,
) {
    let (client, mut out_receiver) = RpcClient::new();
    let session = RpcSession::new(client.clone(), state);
    let mut tasks: Vec<JoinHandle<()>> = Vec::new();
    loop {
        tokio::select! {
            biased;
            _ = stop.notified() => break,
            incoming = incoming.recv() => match incoming {
                Some(line) => {
                    let session = session.clone();
                    let handle = tokio::spawn(async move {
                        session.handle_incoming(&line).await;
                    });
                    tasks.retain(|h| !h.is_finished());
                    tasks.push(handle);
                }
                None => break,
            },
            outgoing_msg = out_receiver.next() => match outgoing_msg {
                Some(message) => match serde_json::to_string(&message) {
                    Ok(line) => {
                        if outgoing.send(line).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => eprintln!("velta-rpc-shim: encode failed: {e}"),
                },
                None => break,
            },
        }
    }
    for handle in tasks {
        handle.abort();
    }
}

fn worker_main(
    accounts_dir: String,
    stop: Arc<tokio::sync::Notify>,
    ready: std::sync::mpsc::Sender<i32>,
) {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("velta-rpc-shim: tokio runtime failed: {e}");
            let _ = ready.send(-1);
            return;
        }
    };
    rt.block_on(async move {
        let accounts = match Accounts::new(PathBuf::from(&accounts_dir), true).await {
            Ok(accounts) => Arc::new(RwLock::new(accounts)),
            Err(e) => {
                eprintln!("velta-rpc-shim: Accounts::new failed: {e:#}");
                let _ = ready.send(-3);
                return;
            }
        };
        let state = CommandApi::from_arc(accounts.clone()).await;
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, mut out_rx) = mpsc::channel(64);
        *LIVE.lock().expect("live") = Some(in_tx);
        let _ended = SessionGuard::arm();
        let _ = ready.send(1);
        let session = tokio::spawn({
            let stop = stop.clone();
            async move {
                run_session(state, accounts, in_rx, out_tx, stop).await;
            }
        });
        while let Some(line) = out_rx.recv().await {
            // #424: one emit hook, two transports — Android calls back into
            // Kotlin over JNI, the desktop bin prints to stdout.
            emit_line(&line);
        }
        session.abort();
        let _ = session.await;
    });
}

/// Opens one session. Returns 1, or -1 (generic) / -3 (`Accounts::new`).
/// A session that is already serving returns 1 without a second `Accounts`.
///
/// `db_key` is the 64-hex database-encryption DEK. The vendored core reads
/// `VELTA_DB_KEY` when accounts open (patch #20). Set it here, before the
/// worker exists. Empty string = keyless (upstream behavior).
pub(crate) fn start_core(accounts_dir: String, db_key: String) -> i32 {
    let _lock = START_LOCK.lock().expect("start lock");
    if SERVING.load(Ordering::SeqCst) {
        return 1;
    }
    if let Some(prev) = WORKER.lock().expect("worker").take() {
        let _ = prev.join();
    }
    if !db_key.is_empty() {
        // #259 step 2: convert pre-#20 plaintext databases first (patch #20
        // never falls back — an unmigrated profile would stay closed). When
        // a migration fails with nothing already encrypted, the key stays
        // off this start and the retry happens next boot.
        let prep = db_key::prepare(std::path::Path::new(&accounts_dir), Some(&db_key));
        crate::log(&format!(
            "db-key prepare: migrated {} already {} locked {}",
            prep.migrated, prep.already, prep.locked
        ));
        if prep.use_key {
            std::env::set_var("VELTA_DB_KEY", &db_key);
        } else {
            crate::log("running keyless this start; retrying migration next boot");
        }
    }
    let stop = Arc::new(tokio::sync::Notify::new());
    *STOP.write().expect("stop lock") = Some(stop.clone());
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let handle = match std::thread::Builder::new()
        .name("velta-rpc-shim".into())
        .spawn(move || worker_main(accounts_dir, stop, ready_tx))
    {
        Ok(handle) => handle,
        Err(e) => {
            eprintln!("velta-rpc-shim: thread spawn failed: {e}");
            return -1;
        }
    };
    *WORKER.lock().expect("worker") = Some(handle);
    match ready_rx.recv_timeout(Duration::from_secs(60)) {
        Ok(code) => code,
        Err(_) => {
            eprintln!("velta-rpc-shim: core did not become ready");
            -1
        }
    }
}

/// Signals the session to end. Idempotent. Does not join: the next
/// `start_core` joins the worker so this call stays non-blocking (#224).
pub(crate) fn stop_core() -> i32 {
    let _lock = START_LOCK.lock().expect("start lock");
    SERVING.store(false, Ordering::SeqCst);
    if let Some(stop) = STOP.write().expect("stop lock").take() {
        stop.notify_one();
    }
    if let Ok(mut live) = LIVE.lock() {
        *live = None;
    }
    0
}

pub(crate) fn send_line(line: String) -> i32 {
    let guard = match LIVE.lock() {
        Ok(guard) => guard,
        Err(_) => return -1,
    };
    match guard.as_ref() {
        Some(tx) => match tx.send(line) {
            Ok(()) => 0,
            Err(_) => -1,
        },
        None => -1,
    }
}

#[cfg(target_os = "android")]
/// Cache the VM and `RpcShim` from the Java thread that called `startCore`.
/// `FindClass` from the worker later would use the system loader and miss it.
fn remember_vm(env: &mut JNIEnv) -> bool {
    let vm = match env.get_java_vm() {
        Ok(vm) => vm,
        Err(e) => {
            eprintln!("velta-rpc-shim: JavaVM: {e}");
            return false;
        }
    };
    let class = match env.find_class("org/velta/kmp/core/RpcShim") {
        Ok(class) => class,
        Err(e) => {
            let _ = env.exception_clear();
            eprintln!("velta-rpc-shim: RpcShim class: {e}");
            return false;
        }
    };
    let global = match env.new_global_ref(class) {
        Ok(global) => global,
        Err(e) => {
            let _ = env.exception_clear();
            eprintln!("velta-rpc-shim: global ref: {e}");
            return false;
        }
    };
    *VM.lock().expect("vm") = Some(vm);
    *SHIM_CLASS.lock().expect("class") = Some(global);
    true
}

#[cfg(target_os = "android")]
pub(crate) fn jni_call(method: &str, line: Option<&str>) {
    let vm = {
        let guard = match VM.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        let Some(vm) = guard.as_ref() else {
            return;
        };
        // JavaVM is a raw pointer with no Drop. Copy it so the callback can
        // re-enter send_line without taking this mutex.
        match unsafe { JavaVM::from_raw(vm.get_java_vm_pointer()) } {
            Ok(vm) => vm,
            Err(_) => return,
        }
    };
    let class = match SHIM_CLASS.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return,
    };
    let Some(class) = class else {
        return;
    };
    let mut env = match vm.attach_current_thread() {
        Ok(env) => env,
        Err(e) => {
            eprintln!("velta-rpc-shim: attach failed: {e}");
            return;
        }
    };
    let call = if let Some(line) = line {
        let s = match env.new_string(line) {
            Ok(s) => s,
            Err(e) => {
                let _ = env.exception_clear();
                eprintln!("velta-rpc-shim: string alloc failed: {e}");
                return;
            }
        };
        env.call_static_method(
            &class,
            method,
            "(Ljava/lang/String;)V",
            &[JValue::Object(s.as_ref())],
        )
    } else {
        env.call_static_method(&class, method, "()V", &[])
    };
    if let Err(e) = call {
        let _ = env.exception_clear();
        eprintln!("velta-rpc-shim: {method} failed: {e}");
    }
}

#[cfg(target_os = "android")]
fn jni_on_line(line: &str) {
    jni_call("onNativeLine", Some(line));
}

/// One outgoing JSON line from the session. Android: JNI callback into
/// Kotlin (`RpcShim.onNativeLine`). Desktop bin (#424): stdout, one line
/// with a trailing `\n` — byte-compatible with deltachat-rpc-server.
#[cfg(target_os = "android")]
fn emit_line(line: &str) {
    jni_on_line(line);
}

#[cfg(not(target_os = "android"))]
fn emit_line(line: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

#[cfg(target_os = "android")]
fn jni_on_exit() {
    jni_call("onNativeExit", None);
}

#[cfg(target_os = "android")]
pub(crate) fn jni_on_loop_line(line: &str) {
    jni_call("onLoopLine", Some(line));
}

#[cfg(target_os = "android")]
pub(crate) fn jni_on_loop_exit() {
    jni_call("onLoopExit", None);
}

// Desktop bin (#424): the p2p loop has no Java host to report to. The loop
// still runs for local chat; its lines are dropped at this boundary.
#[cfg(not(target_os = "android"))]
pub(crate) fn jni_on_loop_line(_line: &str) {}
#[cfg(not(target_os = "android"))]
pub(crate) fn jni_on_loop_exit() {}

/// JNI: `RpcShim.startLoop(accountsDir) -> 1`, or -1. Does not open a port.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_kmp_core_RpcShim_startLoop<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    accounts_dir: JString<'local>,
) -> i32 {
    if !remember_vm(&mut env) {
        return -1;
    }
    let dir: String = match env.get_string(&accounts_dir) {
        Ok(s) => s.into(),
        Err(_) => return -1,
    };
    loop_host::start_loop(dir)
}

/// JNI: `RpcShim.stopLoop() -> 0`. Idempotent.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_kmp_core_RpcShim_stopLoop(
    _env: JNIEnv,
    _class: JClass,
) -> i32 {
    loop_host::stop_loop()
}

/// JNI: `RpcShim.sendLoopLine(line) -> 0`, or -1 when the engine is not up.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_kmp_core_RpcShim_sendLoopLine(
    mut env: JNIEnv,
    _class: JClass,
    line: JString,
) -> i32 {
    let line: String = match env.get_string(&line) {
        Ok(s) => s.into(),
        Err(_) => return -1,
    };
    loop_host::send_loop_line(line)
}

/// JNI: `RpcShim.startCore(accountsDir, dbKey) -> 1`, or a negative code.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_kmp_core_RpcShim_startCore<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    accounts_dir: JString<'local>,
    db_key: JString<'local>,
) -> i32 {
    if !remember_vm(&mut env) {
        return -1;
    }
    let dir: String = match env.get_string(&accounts_dir) {
        Ok(s) => s.into(),
        Err(_) => return -1,
    };
    let key: String = match env.get_string(&db_key) {
        Ok(s) => s.into(),
        Err(_) => String::new(),
    };
    start_core(dir, key)
}

/// JNI: `RpcShim.stopCore() -> 0`. Idempotent.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_kmp_core_RpcShim_stopCore(
    _env: JNIEnv,
    _class: JClass,
) -> i32 {
    stop_core()
}

/// JNI: `RpcShim.sendLine(line) -> 0`, or -1 when no session is serving.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_kmp_core_RpcShim_sendLine(
    mut env: JNIEnv,
    _class: JClass,
    line: JString,
) -> i32 {
    let line: String = match env.get_string(&line) {
        Ok(s) => s.into(),
        Err(_) => return -1,
    };
    send_line(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #259 step 2: a plaintext account database migrates to SQLCipher, the
    /// encrypted copy verifies, the backup drops on the confirming second
    /// run, and the key is allowed this session.
    #[test]
    fn plaintext_db_migrates_and_verifies() {
        let root = std::env::temp_dir().join(format!(
            "velta-shim-dbkey-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let account = root.join("1");
        std::fs::create_dir_all(&account).expect("mkdir");
        let db = account.join("dc.db");
        {
            let conn = rusqlite::Connection::open(&db).expect("plain open");
            conn.execute_batch(
                "CREATE TABLE msgs (id INTEGER PRIMARY KEY, txt TEXT);
                 CREATE TABLE chats (id INTEGER PRIMARY KEY);
                 CREATE TABLE contacts (id INTEGER PRIMARY KEY);
                 CREATE TABLE config (keyname TEXT PRIMARY KEY, value TEXT);
                 CREATE TABLE keypairs (id INTEGER PRIMARY KEY);
                 INSERT INTO msgs (txt) VALUES ('hello'), ('loop');
                 INSERT INTO config (keyname, value) VALUES ('addr', 'a@example.org');",
            )
            .expect("schema");
        }
        let key = "a".repeat(64);

        let first = db_key::prepare(&root, Some(&key));
        assert_eq!(first.migrated, 1, "one plaintext db converted");
        assert!(first.use_key, "key allowed after a clean migration");

        // The live db is encrypted now and still holds the data.
        let conn = rusqlite::Connection::open(&db).expect("open enc");
        conn.pragma_update(None, "key", format!("x'{key}'")).expect("key");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM msgs", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 2, "rows survived the export");
        let addr: String = conn
            .query_row("SELECT value FROM config WHERE keyname='addr'", [], |r| r.get(0))
            .expect("addr");
        assert_eq!(addr, "a@example.org", "identity survived");
        drop(conn);

        // Second run: already ours, and the backup is proven stale and dropped.
        let second = db_key::prepare(&root, Some(&key));
        assert_eq!(second.already, 1);
        assert!(!account.join("dc.db.plain.bak").exists(), "backup dropped");

        std::fs::remove_dir_all(&root).ok();
    }

    /// A migration failure with nothing already encrypted must NOT hand the
    /// core a key: opening the plaintext tree with a key would close it.
    /// A schema missing the count tables fails the export verification.
    #[test]
    fn failed_migration_keeps_the_session_keyless() {
        let root = std::env::temp_dir().join(format!(
            "velta-shim-dbkey-fail-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let account = root.join("1");
        std::fs::create_dir_all(&account).expect("mkdir");
        {
            let conn = rusqlite::Connection::open(account.join("dc.db")).expect("plain open");
            conn.execute_batch("CREATE TABLE other (x TEXT); INSERT INTO other VALUES ('x');")
                .expect("schema");
        }

        let prep = db_key::prepare(&root, Some(&"b".repeat(64)));
        assert_eq!(prep.migrated, 0, "the export verification failed");
        assert!(!prep.use_key, "no key when the migration failed");
        assert!(
            opens_plain(&account.join("dc.db")),
            "the plaintext db is untouched"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    fn opens_plain(path: &std::path::Path) -> bool {
        let Ok(conn) = rusqlite::Connection::open(path) else {
            return false;
        };
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
            .is_ok()
    }

    /// #225: the push token registers through the standard surface — no
    /// pre-dispatch intercept anymore.
    #[tokio::test]
    async fn push_token_answers_through_the_session() {
        let dir = std::env::temp_dir().join(format!(
            "velta-shim-push-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let accounts = Arc::new(RwLock::new(
            Accounts::new(dir.clone(), true).await.expect("accounts"),
        ));
        let state = CommandApi::from_arc(accounts.clone()).await;
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let stop = Arc::new(tokio::sync::Notify::new());
        let task = tokio::spawn(run_session(state, accounts, in_rx, out_tx, stop));
        in_tx
            .send(
                r#"{"jsonrpc":"2.0","id":7,"method":"set_push_device_token","params":["webpush:x|key|auth"]}"#.into(),
            )
            .expect("send");
        let line = tokio::time::timeout(Duration::from_secs(10), out_rx.recv())
            .await
            .expect("timed out")
            .expect("session closed");
        assert!(line.contains("\"result\":null"), "reply: {line}");
        drop(in_tx);
        let _ = task.await;
    }

    /// #357: the session is a channel. Nothing in this test binds a port,
    /// and the response still carries the core version.
    #[tokio::test]
    async fn session_answers_get_system_info_without_a_socket() {
        let dir = std::env::temp_dir().join(format!(
            "velta-shim-session-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let accounts = Arc::new(RwLock::new(
            Accounts::new(dir.clone(), true).await.expect("accounts"),
        ));
        let state = CommandApi::from_arc(accounts.clone()).await;
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let stop = Arc::new(tokio::sync::Notify::new());
        let task = tokio::spawn(run_session(state, accounts, in_rx, out_tx, stop));
        in_tx
            .send(r#"{"jsonrpc":"2.0","id":1,"method":"get_system_info","params":[]}"#.into())
            .expect("send");
        let line = tokio::time::timeout(Duration::from_secs(10), out_rx.recv())
            .await
            .expect("timed out")
            .expect("session closed");
        assert!(
            line.contains("deltachat_core_version"),
            "reply: {line}"
        );
        drop(in_tx);
        let _ = task.await;
    }

    /// No session, no listener: a caller that is not inside this process
    /// has nothing to connect to, and `send_line` fails closed.
    #[test]
    fn send_line_without_a_session_fails() {
        assert_eq!(
            send_line(
                r#"{"jsonrpc":"2.0","id":1,"method":"get_system_info","params":[]}"#.into()
            ),
            -1
        );
    }

    #[test]
    fn stop_core_without_shim_is_a_noop() {
        assert_eq!(stop_core(), 0);
    }

    /// The stop signal is consumed by the notify: after stop_core takes the
    /// Notify, a NEW start installs a fresh one, so a stale permit can never
    /// kill a later session.
    #[tokio::test]
    async fn stop_signal_is_per_start() {
        let stop = Arc::new(tokio::sync::Notify::new());
        *STOP.write().expect("stop lock") = Some(stop.clone());
        let waiter = {
            let stop = stop.clone();
            tokio::spawn(async move { stop.notified().await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(stop_core(), 0);
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("waiter must wake on stop")
            .expect("join");
        assert!(
            STOP.read().expect("stop lock").is_none(),
            "stop consumed the signal"
        );
    }
}
