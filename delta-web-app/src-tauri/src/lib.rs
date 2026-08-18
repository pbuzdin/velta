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

fn log_dir() -> PathBuf {
    LOG_DIR
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| {
            let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
            Path::new(&local_app_data).join("Velta").join("logs")
        })
}

pub fn set_log_dir(path: PathBuf) {
    *LOG_DIR.lock().unwrap() = Some(path);
}

pub fn log(_msg: &str) {
    // Logging to velta.log is disabled for stable releases.
    // let log_file = log_dir().join("velta.log");
    // let _ = std::fs::create_dir_all(log_dir());
    // let _ = OpenOptions::new()
    //     .create(true)
    //     .append(true)
    //     .open(log_file)
    //     .and_then(|mut f| {
    //         let now = std::time::SystemTime::now()
    //             .duration_since(std::time::UNIX_EPOCH)
    //             .unwrap_or_default();
    //         let line = format!("[{}.{:03}] {}\n", now.as_secs(), now.subsec_millis(), _msg);
    //         f.write_all(line.as_bytes())
    //     });
}

pub fn maybe_extract_deeplink(arg: &str) -> Option<String> {
    if arg.starts_with("dcaccount:") || arg.starts_with("https://i.delta.chat/") || arg.starts_with("OPENPGP4FPR:") {
        return Some(arg.to_string());
    }
    if arg.starts_with("web+dcaccount:") {
        return Some(arg.replacen("web+dcaccount:", "", 1));
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
    log(&format!("rpc -> {}", request));
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

    let accounts = Accounts::new(accounts_dir, true).await?;
    let accounts = Arc::new(RwLock::new(accounts));
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
            log(&format!("rpc <- {line}"));
            app.emit("dc-rpc", line).ok();
        }
    });

    // Process incoming JSON-RPC requests.
    tokio::spawn(async move {
        while let Some(line) = req_rx.recv().await {
            log(&format!("rpc -> {line}"));
            let session = session.clone();
            tokio::spawn(async move {
                session.handle_incoming(&line).await;
            });
        }
    });

    Ok(req_tx)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            log("setup started");

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
            set_log_dir(log_dir_path);

            let accounts = accounts_dir(app.handle());
            let _ = std::fs::create_dir_all(&accounts);
            log(&format!("accounts directory: {}", accounts.display()));

            #[cfg(target_os = "android")]
            {
                let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
                let tx = rt.block_on(init_android_core(app.handle().clone(), accounts)).map_err(|e| e.to_string())?;
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
                                            log(&format!("rpc <- {line}",));
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
        .invoke_handler(tauri::generate_handler![js_log, rpc, get_initial_deeplink, get_sidecar_status])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                if let Some(url) = urls.first() {
                    let s = url.to_string();
                    log(&format!("deeplink opened: {s}"));
                    _app.emit("deeplink", s).ok();
                }
            }
        });
}
