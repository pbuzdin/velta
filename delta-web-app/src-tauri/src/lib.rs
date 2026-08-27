use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "android"))]
use std::sync::Arc;
use std::sync::Mutex;

#[cfg(not(target_os = "android"))]
use std::io::{BufRead, BufReader};
#[cfg(not(target_os = "android"))]
use std::process::{ChildStdin, Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use tauri::{Emitter, Manager, State};

static LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static INITIAL_DEEPLINK: Mutex<Option<String>> = Mutex::new(None);
static SIDECAR_STATUS: Mutex<Option<serde_json::Value>> = Mutex::new(None);

// Non-blocking logger: messages are pushed onto an unbounded mpsc channel and
// written from a dedicated background thread, so log() never blocks the IPC /
// RPC hot path. On Android this is critical — the WebView event bridge and the
// JSON-RPC session both pass through the main thread context, and a
// synchronous file open+write per RPC round-trip was stalling the startup
// handshake long enough for the frontend's event.listen() to time out and
// fall back to demo mode.
static LOG_TX: Mutex<Option<std::sync::mpsc::Sender<String>>> = Mutex::new(None);

fn log_dir() -> PathBuf {
    LOG_DIR
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| {
            // Fallback when set_log_dir() hasn't run yet. On Android,
            // LOCALAPPDATA is unset and the process CWD is "/" (not writable),
            // so the old fallback silently failed on every log call. Prefer a
            // temp directory so log writes never block. The real path is set
            // by set_log_dir() early in setup() before any meaningful logging.
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                if !local_app_data.is_empty() {
                    return Path::new(&local_app_data).join("Velta").join("logs");
                }
            }
            std::env::temp_dir().join("velta-logs")
        })
}

pub fn set_log_dir(path: PathBuf) {
    *LOG_DIR.lock().unwrap() = Some(path);
    // Spawn the writer thread lazily on the first set_log_dir() call so it
    // points at the real log directory.
    ensure_log_writer();
}

fn ensure_log_writer() {
    let mut guard = LOG_TX.lock().unwrap();
    if guard.is_some() {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    *guard = Some(tx);
    drop(guard);

    // Capture the directory at spawn time — it won't change during the session.
    let dir = log_dir();
    std::thread::Builder::new()
        .name("velta-log-writer".into())
        .spawn(move || {
            let _ = std::fs::create_dir_all(&dir);
            for msg in rx {
                let log_file = dir.join("velta.log");
                let res = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_file)
                    .and_then(|mut f| {
                        use std::io::Write;
                        f.write_all(msg.as_bytes())
                    });
                // If the log file becomes unwritable (rotated, volume full),
                // don't kill the thread — just keep draining the channel so
                // log() callers never block.
                if res.is_err() {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        })
        .ok();
}

pub fn log(msg: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let line = format!("[{}.{:03}] {}\n", now.as_secs(), now.subsec_millis(), msg);
    // Non-blocking send. If the channel doesn't exist yet (before
    // set_log_dir) or the writer thread has died, the message is dropped —
    // never block the caller. On Android this is what was killing startup:
    // every RPC round-trip did a synchronous create_dir_all+open+write under
    // a global Mutex, blocking the JSON-RPC handshake.
    if let Some(tx) = LOG_TX.lock().unwrap().as_ref() {
        let _ = tx.send(line);
    }
}

pub fn maybe_extract_deeplink(arg: &str) -> Option<String> {
    if arg.starts_with("velta:") || arg.starts_with("dcaccount:") || arg.starts_with("https://i.delta.chat/") || arg.starts_with("OPENPGP4FPR:") {
        return Some(arg.to_string());
    }
    if arg.starts_with("web+dcaccount:") {
        return Some(arg.replacen("web+dcaccount:", "", 1));
    }
    if arg.starts_with("web+velta:") {
        return Some(arg.replacen("web+velta:", "", 1));
    }
    if let Some(pos) = arg.find("velta://") {
        return Some(arg[pos..].to_string());
    }
    if let Some(pos) = arg.find("dcaccount:") {
        return Some(arg[pos..].to_string());
    }
    if let Some(pos) = arg.find("https://i.delta.chat/") {
        return Some(arg[pos..].to_string());
    }
    if arg.starts_with("http://") || arg.starts_with("https://") {
        return Some(arg.to_string());
    }
    None
}

fn set_sidecar_status(app: &tauri::AppHandle, status: serde_json::Value) {
    *SIDECAR_STATUS.lock().unwrap() = Some(status.clone());
    app.emit("dc-sidecar-status", status).ok();
}

#[tauri::command]
fn get_sidecar_status() -> serde_json::Value {
    SIDECAR_STATUS.lock().unwrap().clone().unwrap_or_else(|| serde_json::json!({"running": false, "stage": "unknown"}))
}

#[tauri::command]
fn get_accounts_dir(app: tauri::AppHandle) -> String {
    accounts_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn resolve_upload_path(app: tauri::AppHandle, filename: String) -> String {
    use tauri::path::BaseDirectory;
    app.path()
        .resolve(&format!("uploads/{}", filename), BaseDirectory::AppLocalData)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

pub fn set_initial_deeplink_from_env() {
    if let Some(link) = std::env::args().skip(1).find_map(|a| maybe_extract_deeplink(&a)) {
        *INITIAL_DEEPLINK.lock().unwrap() = Some(link);
    }
}

#[tauri::command]
fn js_log(msg: String) {
    log(&msg);
}

#[tauri::command]
fn get_initial_deeplink() -> Option<String> {
    INITIAL_DEEPLINK.lock().unwrap().take()
}

struct RpcState {
    #[cfg(target_os = "android")]
    _rt: tokio::runtime::Runtime,
    #[cfg(target_os = "android")]
    tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>,

    #[cfg(not(target_os = "android"))]
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

impl RpcState {
    fn send_rpc(&self, request: &str) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            let guard = self.tx.lock().map_err(|e| e.to_string())?;
            if let Some(tx) = guard.as_ref() {
                tx.send(request.to_string()).map_err(|e| e.to_string())
            } else {
                Err("Delta Chat core is not running".to_string())
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            use std::io::Write;
            let mut guard = self.stdin.lock().map_err(|e| e.to_string())?;
            if let Some(stdin) = guard.as_mut() {
                stdin.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
                stdin.write_all(b"\n").map_err(|e| e.to_string())?;
                stdin.flush().map_err(|e| e.to_string())
            } else {
                Err("Delta Chat core sidecar is not running".to_string())
            }
        }
    }
}

#[tauri::command]
fn rpc(request: String, state: State<'_, RpcState>) -> Result<(), String> {
    // NOTE: do not log every request here. This command is on the JSON-RPC
    // hot path — even with the non-blocking logger, formatting a string per
    // RPC adds alloc pressure and grows velta.log unbounded. Use js_log from
    // the frontend for targeted diagnostics.
    state.send_rpc(&request)
}

#[cfg(not(target_os = "android"))]
fn find_sidecar(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::path::BaseDirectory;

    let candidates = [
        app.path().resolve("deltachat-rpc-server.exe", BaseDirectory::Resource).ok(),
        std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.join("deltachat-rpc-server.exe"))),
        std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.join("resources").join("deltachat-rpc-server.exe"))),
        std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.join("..").join("resources").join("deltachat-rpc-server.exe"))).map(|p| p.canonicalize().unwrap_or(p)),
    ];

    for candidate in candidates.into_iter().flatten() {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn accounts_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::path::BaseDirectory;
    app.path()
        .resolve("accounts", BaseDirectory::AppLocalData)
        .unwrap_or_else(|_| log_dir().join("..").join("accounts"))
}

#[cfg(target_os = "android")]
async fn init_android_core(
    app_handle: tauri::AppHandle,
    accounts_dir: PathBuf,
) -> anyhow::Result<tokio::sync::mpsc::UnboundedSender<String>> {
    use deltachat_jsonrpc::api::{Accounts, CommandApi};
    use futures_lite::stream::StreamExt;
    use std::sync::Arc;
    use tokio::sync::RwLock;
    use yerpc::{RpcClient, RpcSession};

    log(&format!("android accounts directory: {}", accounts_dir.display()));
    // Tell the frontend we're past the "starting" stage so the status pill
    // shows progress instead of looking stuck during Accounts::new().
    let _ = app_handle.emit("dc-sidecar-status", serde_json::json!({"running": true, "stage": "initializing"}));

    let accounts = Accounts::new(accounts_dir, true).await?;
    let accounts = Arc::new(RwLock::new(accounts));
    let _ = app_handle.emit("dc-sidecar-status", serde_json::json!({"running": true, "stage": "configuring"}));

    let state = CommandApi::from_arc(accounts.clone()).await;

    let (client, mut out_receiver) = RpcClient::new();
    let session = RpcSession::new(client.clone(), state);
    let (req_tx, mut req_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Forward JSON-RPC responses and events to the WebView.
    let app = app_handle.clone();
    tokio::spawn(async move {
        while let Some(message) = out_receiver.next().await {
            let line = match serde_json::to_string(&message) {
                Ok(line) => line,
                Err(e) => {
                    log(&format!("jsonrpc serialize error: {e}"));
                    continue;
                }
            };
            // NOTE: do not log every response — it's the hot path and would
            // grow velta.log unbounded. Errors are still logged below.
            if let Err(e) = app.emit("dc-rpc", &line) {
                log(&format!("android emit error: {e}"));
            }
        }
    });

    // Process incoming JSON-RPC requests.
    tokio::spawn(async move {
        while let Some(line) = req_rx.recv().await {
            // NOTE: do not log every request here either.
            let session = session.clone();
            tokio::spawn(async move {
                session.handle_incoming(&line).await;
            });
        }
    });

    log("android core RPC session and response forwarder ready");
    Ok(req_tx)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let log_dir_path = {
                #[cfg(target_os = "android")]
                {
                    app.path().app_local_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("logs")
                }
                #[cfg(not(target_os = "android"))]
                {
                    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
                    Path::new(&local_app_data).join("Velta").join("logs")
                }
            };
            // set_log_dir() must run BEFORE the first log() call, otherwise
            // the very first "setup started" line goes to the fallback path
            // (temp dir on Android) and the writer thread is bound to the
            // wrong directory for the whole session.
            set_log_dir(log_dir_path);
            log("setup started");

            let accounts = accounts_dir(app.handle());
            let _ = std::fs::create_dir_all(&accounts);
            log(&format!("accounts directory: {}", accounts.display()));

            #[cfg(target_os = "android")]
            {
                let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
                log("initializing embedded Android core");
                let tx = rt.block_on(init_android_core(app.handle().clone(), accounts)).map_err(|e| {
                    log(&format!("embedded Android core initialization failed: {e}"));
                    e.to_string()
                })?;

                // Keep the status command available for diagnostics.
                set_sidecar_status(app.handle(), serde_json::json!({"running": true, "stage": "ready"}));

                app.manage(RpcState {
                    _rt: rt,
                    tx: Mutex::new(Some(tx)),
                });
            }

            #[cfg(not(target_os = "android"))]
            {
                let app_handle = app.app_handle().clone();
                if let Some(sidecar_path) = find_sidecar(app.handle()) {
                    log(&format!("starting sidecar at {}", sidecar_path.display()));
                    set_sidecar_status(&app_handle, serde_json::json!({"running": true, "stage": "starting"}));

                    let stderr_file = log_dir().join("sidecar-stderr.log");
                    let stderr = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&stderr_file)
                        .map(Stdio::from)
                        .unwrap_or_else(|e| {
                            log(&format!("could not open sidecar stderr log: {e}; sending stderr to null"));
                            Stdio::null()
                        });

                    let mut cmd = Command::new(&sidecar_path);
                    #[cfg(windows)]
                    cmd.creation_flags(CREATE_NO_WINDOW);
                    match cmd
                        .current_dir(&accounts)
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(stderr)
                        .spawn()
                    {
                        Ok(mut child) => {
                            let stdin = child.stdin.take().unwrap();
                            let stdout = child.stdout.take().unwrap();

                            app.manage(RpcState {
                                stdin: Arc::new(Mutex::new(Some(stdin))),
                            });
                            set_sidecar_status(&app_handle, serde_json::json!({"running": true, "stage": "ready"}));

                            std::thread::spawn(move || {
                                log("sidecar reader thread started");
                                let reader = BufReader::new(stdout);
                                for line in reader.lines() {
                                    match line {
                                        Ok(line) => {
                                            // NOTE: do not log every line — it's the
                                            // hot path and would grow velta.log
                                            // unbounded. Errors are logged below.
                                            app_handle.emit("dc-rpc", line).ok();
                                        }
                                        Err(e) => {
                                            log(&format!("sidecar stdout error: {e}"));
                                        }
                                    }
                                }
                                log("sidecar reader thread ended");
                                set_sidecar_status(&app_handle, serde_json::json!({"running": false, "stage": "stopped"}));
                            });

                            std::thread::spawn(move || {
                                match child.wait() {
                                    Ok(status) => log(&format!("sidecar exited with {status}")),
                                    Err(e) => log(&format!("sidecar wait error: {e}")),
                                }
                            });
                        }
                        Err(e) => {
                            log(&format!("failed to start sidecar: {e}"));
                            set_sidecar_status(&app_handle, serde_json::json!({"running": false, "stage": "error", "error": e.to_string()}));
                        }
                    }
                } else {
                    log("sidecar not found; continuing with mock/remote transports available to frontend");
                    set_sidecar_status(&app_handle, serde_json::json!({"running": false, "stage": "missing", "error": "sidecar not found"}));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![js_log, rpc, get_initial_deeplink, get_sidecar_status, get_accounts_dir, resolve_upload_path]);

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|_app, argv, cwd| {
                log(&format!("single-instance args: {argv:?} cwd={cwd}"));
                // The deep-link plugin (with the single-instance feature) forwards
                // the URL to the running instance as a `deep-link://new-url` event.
            }))
            .plugin(tauri_plugin_deep_link::init());
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                if let Some(url) = urls.first() {
                    let s = url.to_string();
                    log(&format!("deeplink opened: {s}"));
                    *INITIAL_DEEPLINK.lock().unwrap() = Some(s.clone());
                    _app.emit("deeplink", s).ok();
                }
            }
        });
}