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

// Optional second log location on the shared external storage, where adb can
// read it on non-rooted devices (/storage/emulated/0/Android/data/<id>/files).
static MIRROR_LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn set_mirror_log_dir(path: PathBuf) {
    *MIRROR_LOG_DIR.lock().unwrap() = Some(path);
}

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
                if let Some(mirror) = MIRROR_LOG_DIR.lock().unwrap().clone() {
                    let _ = std::fs::create_dir_all(&mirror);
                    let mirror_file = mirror.join("velta.log");
                    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&mirror_file) {
                        use std::io::Write;
                        let _ = f.write_all(msg.as_bytes());
                    }
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

// ---------- blobfile:// — Range-aware media serving ----------

// The default asset protocol on Android is served by the plain
// WebViewAssetLoader, which ignores Range requests. Video files whose moov
// atom sits at the end of the file (most phone recordings) then can't be
// played: the media player must seek to the end to read the index and back
// into the data. This custom protocol answers Range requests with proper
// 206 responses so <video>/<audio> can seek inside any blob.

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn guess_mime(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "mp4" | "m4v" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "3gp" => "video/3gpp",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

// "bytes=a-b" | "bytes=a-" | "bytes=-n" → inclusive (start, end)
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let rest = header.trim().strip_prefix("bytes=")?;
    let (start_s, end_s) = rest.split_once('-')?;
    if start_s.is_empty() {
        let n: u64 = end_s.parse().ok()?;
        if n == 0 || len == 0 {
            return None;
        }
        let start = len.saturating_sub(n);
        Some((start, len - 1))
    } else {
        let start: u64 = start_s.parse().ok()?;
        if start >= len {
            return None;
        }
        let end = if end_s.is_empty() { len - 1 } else { end_s.parse::<u64>().ok()?.min(len - 1) };
        if start > end {
            return None;
        }
        Some((start, end))
    }
}

fn serve_blob_file(app: &tauri::AppHandle, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let not_found = |msg: &str| {
        tauri::http::Response::builder()
            .status(404)
            .header("Access-Control-Allow-Origin", "*")
            .body(msg.as_bytes().to_vec())
            .unwrap()
    };

    let uri = request.uri().to_string();
    log(&format!(
        "blobfile request: uri={} range={:?}",
        uri,
        request.headers().get("range").and_then(|v| v.to_str().ok())
    ));
    // http://blobfile.localhost/<encoded-abs-path> (Windows/Android),
    // blobfile://localhost/<encoded-abs-path>        (macOS/Linux)
    let path_part = match uri.find("localhost/") {
        Some(i) => &uri[i + "localhost/".len()..],
        None => return not_found("bad uri"),
    };
    let path_part = path_part.split('?').next().unwrap_or(path_part);
    let file = percent_decode(path_part);

    // Only serve files that live inside the accounts directory (blobs,
    // uploads) — never anything else on the filesystem. Canonicalize both
    // sides: on Android the core reports blobs under /data/user/0 (a symlink
    // to /data/data), so a raw prefix check would wrongly reject everything.
    let accounts = accounts_dir(app);
    let accounts_canon = std::fs::canonicalize(&accounts).unwrap_or(accounts.clone());
    let fpath = std::path::Path::new(&file);
    let fpath_canon = fpath.canonicalize().unwrap_or_else(|_| fpath.to_path_buf());
    log(&format!(
        "blobfile check: accounts_canon={} file_canon={}",
        accounts_canon.display(),
        fpath_canon.display()
    ));
    if !fpath_canon.starts_with(&accounts_canon) {
        log("blobfile FORBIDDEN");
        return not_found("forbidden");
    }
    let serve_path = fpath_canon.to_string_lossy().to_string();

    let meta = match std::fs::metadata(&serve_path) {
        Ok(m) if m.is_file() => m,
        _ => return not_found("not found"),
    };
    let len = meta.len();
    let mime = guess_mime(&serve_path);

    if let Some(range) = request.headers().get("range").and_then(|v| v.to_str().ok().map(|s| s.to_string())) {
        if let Some((start, end)) = parse_range(&range, len) {
            use std::io::{Read, Seek, SeekFrom};
            let take = (end - start + 1) as usize;
            let mut buf = vec![0u8; take];
            let mut filled = 0usize;
            if let Ok(mut f) = std::fs::File::open(&serve_path) {
                if f.seek(SeekFrom::Start(start)).is_ok() {
                    while filled < take {
                        match f.read(&mut buf[filled..]) {
                            Ok(0) => break,
                            Ok(n) => filled += n,
                            Err(_) => break,
                        }
                    }
                }
            }
            buf.truncate(filled);
            return tauri::http::Response::builder()
                .status(206)
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
                .header("Content-Range", format!("bytes {}-{}/{}", start, start + filled as u64 - 1, len))
                .header("Content-Length", filled)
                .body(buf)
                .unwrap();
        }
        return tauri::http::Response::builder()
            .status(416)
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Range", format!("bytes */{}", len))
            .body(Vec::new())
            .unwrap();
    }

    match std::fs::read(&serve_path) {
        Ok(data) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
            .header("Content-Length", data.len())
            .body(data)
            .unwrap(),
        Err(_) => not_found("read error"),
    }
}

// ---------- Android: copy a picked content:// attachment to app storage ----------

// The system file picker returns content:// URIs that neither tauri-plugin-fs
// nor the Delta Chat core can read directly. Copy the bytes into our uploads
// directory via the Android ContentResolver and return the real path.
#[cfg(target_os = "android")]
static APP_JAVA_VM: Mutex<Option<jni::JavaVM>> = Mutex::new(None);

// ---------- local media HTTP server ----------
//
// WebView2 (Windows) does not fire WebResourceRequested for <video>/<audio>
// element requests, so custom protocols cannot serve media there. A loopback
// HTTP server with Range support works on every platform and every WebView.
static MEDIA_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
static MEDIA_TOKEN: Mutex<String> = Mutex::new(String::new());

#[tauri::command]
fn media_base_url() -> String {
    // Runs on every platform now: the Android asset protocol serves the first
    // range chunk but fails mid-file reads (moov-at-end videos can't demux),
    // so <video> sources ride the loopback server everywhere.
    let port = MEDIA_PORT.load(std::sync::atomic::Ordering::Relaxed);
    let token = MEDIA_TOKEN.lock().unwrap().clone();
    format!("http://127.0.0.1:{port}/{token}")
}

// ---------- video poster cache ----------
//
// Posters are extracted in the WebView (hidden <video> over a blob URL, seek,
// canvas) and persisted as WebP next to the account database, so a frame is
// decoded only once per file. The cached image is served through the asset
// protocol — plain GETs work fine there even though range reads don't.

fn poster_target(src: &str) -> Option<PathBuf> {
    let p = std::path::Path::new(src);
    let dir = p.parent()?;
    let stem = p.file_stem()?.to_string_lossy();
    let poster_dir = if dir.file_name()?.to_string_lossy() == "dc.db-blobs" {
        dir.parent()?.join("velta-posters")
    } else {
        dir.join("velta-posters")
    };
    Some(poster_dir.join(format!("{stem}.webp")))
}

fn scoped_accounts_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let canon = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    // Canonicalize both sides: Windows canonical paths carry a \\?\ prefix
    // while accounts_dir() doesn't.
    let accounts = accounts_dir(app);
    let accounts_canon = std::fs::canonicalize(&accounts).unwrap_or_else(|_| accounts);
    if !canon.starts_with(accounts_canon) {
        return Err("path outside the accounts directory".into());
    }
    Ok(canon)
}

#[tauri::command]
fn poster_cache_path(app: tauri::AppHandle, src: String) -> Result<serde_json::Value, String> {
    scoped_accounts_path(&app, &src)?;
    let target = poster_target(&src).ok_or("cannot derive poster path")?;
    let exists = target.is_file();
    Ok(serde_json::json!({ "path": target.to_string_lossy(), "exists": exists }))
}

#[tauri::command]
fn read_media_bytes(app: tauri::AppHandle, src: String) -> Result<tauri::ipc::Response, String> {
    let canon = scoped_accounts_path(&app, &src)?;
    let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn write_poster(app: tauri::AppHandle, src: String, bytes: Vec<u8>) -> Result<String, String> {
    scoped_accounts_path(&app, &src)?;
    let target = poster_target(&src).ok_or("cannot derive poster path")?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

fn start_media_server(accounts: PathBuf) {
    std::thread::Builder::new()
        .name("media-http".into())
        .spawn(move || {
            // Prefer the fixed port: the static CSP whitelist references it.
            // Fall back to an ephemeral port (media may then be CSP-blocked —
            // logged loudly) rather than losing media entirely.
            let listener = match std::net::TcpListener::bind("127.0.0.1:20810") {
                Ok(l) => l,
                Err(_) => match std::net::TcpListener::bind("127.0.0.1:0") {
                    Ok(l) => {
                        log("media http: port 20810 busy, bound ephemeral — media-src CSP mismatch possible");
                        l
                    }
                    Err(e) => {
                        log(&format!("media server bind failed: {e}"));
                        return;
                    }
                },
            };
            let port = match listener.local_addr() {
                Ok(a) => a.port(),
                Err(_) => return,
            };
            MEDIA_PORT.store(port, std::sync::atomic::Ordering::Relaxed);
            log(&format!("media http server on 127.0.0.1:{port}"));
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let accounts = accounts.clone();
                std::thread::spawn(move || {
                    // Connection-level diagnostics reach logcat via stderr.
                    let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_else(|_| "?".into());
                    eprintln!("[media] accept from {peer}");
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        serve_media_connection(&mut stream, &accounts);
                    }));
                    if result.is_err() {
                        eprintln!("[media] serve_media_connection PANICKED for {peer}");
                    }
                    eprintln!("[media] done {peer}");
                });
            }
        })
        .ok();
}

fn serve_media_connection(stream: &mut std::net::TcpStream, accounts: &PathBuf) {
    use std::io::{Read, Write};
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));

    // read the request head (request line + headers)
    let mut head = Vec::new();
    let mut buf = [0u8; 2048];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                head.extend_from_slice(&buf[..n]);
                if head.windows(4).any(|w| w == b"

") || head.len() > 64 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let head = String::from_utf8_lossy(&head);
    let mut lines = head.split("
");
    let request_line = lines.next().unwrap_or("");
    let mut path = "";
    let mut range: Option<String> = None;
    for part in request_line.split(' ') {
        if part.starts_with('/') {
            path = part;
        }
    }
    for line in lines {
        if let Some(v) = line.strip_prefix("Range: ").or_else(|| line.strip_prefix("range: ")) {
            range = Some(v.to_string());
        }
    }

    let mut not_found = || {
        let _ = stream.write_all(
            b"HTTP/1.1 404 Not Found
Content-Length: 0
Connection: close

",
        );
    };

    // path: /<token>/<percent-encoded-abs-path>
    let rest = match path.split_once('/') {
        Some((_, rest)) => rest,
        None => return not_found(),
    };
    let token = MEDIA_TOKEN.lock().unwrap().clone();
    let (url_token, enc_path) = match rest.split_once('/') {
        Some(v) => v,
        None => {
            eprintln!("[media] 404: no token/path separator in {path:?}");
            return not_found();
        }
    };
    if url_token != token {
        eprintln!("[media] 404: token mismatch (got {url_token:?})");
        return not_found();
    }
    let file = percent_decode(enc_path);
    eprintln!("[media] request {file} range={range:?}");

    let accounts_canon = std::fs::canonicalize(accounts).unwrap_or_else(|_| accounts.clone());
    let fpath = std::path::Path::new(&file);
    let fpath_canon = fpath.canonicalize().unwrap_or_else(|_| fpath.to_path_buf());
    if !fpath_canon.starts_with(&accounts_canon) {
        return not_found();
    }
    let serve_path = fpath_canon.to_string_lossy().to_string();
    let meta = match std::fs::metadata(&serve_path) {
        Ok(m) if m.is_file() => m,
        _ => return not_found(),
    };
    let len = meta.len();
    let mime = guess_mime(&serve_path);

    let mut headers = format!(
        "HTTP/1.1 200 OK
Content-Type: {mime}
Accept-Ranges: bytes
Access-Control-Allow-Origin: *
"
    );
    let mut body = match std::fs::read(&serve_path) {
        Ok(d) => d,
        Err(_) => return not_found(),
    };
    if let Some(range) = &range {
        if let Some((start, end)) = parse_range(range, len) {
            let take = (end - start + 1) as usize;
            body.truncate(take);
            headers = format!(
                "HTTP/1.1 206 Partial Content
Content-Type: {mime}
Accept-Ranges: bytes
Access-Control-Allow-Origin: *
Content-Range: bytes {start}-{end}/{len}
Content-Length: {take}
"
            );
        }
    }
    headers.push_str(&format!("Content-Length: {}
Connection: close

", body.len()));
    if stream.write_all(headers.as_bytes()).is_err() {
        return;
    }
    let _ = stream.write_all(&body);
    let _ = stream.flush();
}
#[cfg(target_os = "android")]
static APP_CONTEXT: Mutex<Option<jni::objects::GlobalRef>> = Mutex::new(None);

// Called from MainActivity.onCreate (Kotlin) with the application context.
// Storing it lets Rust commands use the Android ContentResolver (e.g. for
// reading content:// attachments picked through the system file picker).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_MainActivity_setApplicationContext(
    env: jni::JNIEnv,
    _class: jni::objects::JClass,
    context: jni::objects::JObject,
) {
    let vm = match env.get_java_vm() {
        Ok(vm) => vm,
        Err(e) => {
            log(&format!("setApplicationContext: get_java_vm failed: {e}"));
            return;
        }
    };
    let global = match env.new_global_ref(&context) {
        Ok(g) => g,
        Err(e) => {
            log(&format!("setApplicationContext: new_global_ref failed: {e}"));
            return;
        }
    };
    *APP_JAVA_VM.lock().unwrap() = Some(vm);
    *APP_CONTEXT.lock().unwrap() = Some(global);
    log("application context stored for Rust commands");
}

// Desktop has no ContentResolver; the command exists on every platform so the
// frontend can always call it — on desktop it just reports unsupported.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn resolve_content_uri(_app: tauri::AppHandle, _uri: String, _filename: String) -> Result<String, String> {
    Err("picking attachments is only supported on mobile".into())
}

#[cfg(target_os = "android")]
#[tauri::command]
fn resolve_content_uri(app: tauri::AppHandle, uri: String, filename: String) -> Result<String, String> {
    use tauri::path::BaseDirectory;

    // The application context was handed over from MainActivity.onCreate
    // (see setApplicationContext below) and is stored as a global ref.
    let ctx_guard = APP_CONTEXT.lock().unwrap();
    let context = ctx_guard
        .as_ref()
        .map(|r| r.as_obj().clone())
        .ok_or("application context was not handed over yet")?;
    let vm_guard = APP_JAVA_VM.lock().unwrap();
    let vm_ref = vm_guard.as_ref().ok_or("jvm was not handed over yet")?;
    let mut env = vm_ref.attach_current_thread().map_err(|e| format!("jvm attach: {e}"))?;

    let uri_j = env.new_string(&uri).map_err(|e| e.to_string())?;
    let uri_class = env.find_class("android/net/Uri").map_err(|e| e.to_string())?;
    let uri_obj = env
        .call_static_method(&uri_class, "parse", "(Ljava/lang/String;)Landroid/net/Uri;", &[(&uri_j).into()])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    let cr = env
        .call_method(&context, "getContentResolver", "()Landroid/content/ContentResolver;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    // Query the display name (keeps the real filename + extension, so the
    // attachment is sent as image/video instead of a generic file).
    let mut display_name = String::new();
    let proj_str = env.new_string("_display_name").map_err(|e| e.to_string())?;
    let proj = env
        .new_object_array(1, "java/lang/String", &proj_str)
        .map_err(|e| e.to_string())?;
    let null_obj = jni::objects::JObject::null();
    let cursor = env
        .call_method(
            &cr,
            "query",
            "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
            &[
                (&uri_obj).into(),
                (&proj).into(),
                (&null_obj).into(),
                (&null_obj).into(),
                (&null_obj).into(),
            ],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let _ = env.exception_clear();
    if !cursor.is_null() {
        if let Err(e) = env.call_method(&cursor, "moveToFirst", "()Z", &[]) {
            log(&format!("cursor moveToFirst: {e}"));
        }
        let _ = env.exception_clear();
        let name_obj = env
            .call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[jni::objects::JValue::Int(0)])
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        if !name_obj.is_null() {
            let name_jstr = jni::objects::JString::from(name_obj);
            display_name = env.get_string(&name_jstr).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
        }
        if let Err(e) = env.call_method(&cursor, "close", "()V", &[]) {
            log(&format!("cursor close: {e}"));
        }
        let _ = env.exception_clear();
    }

    // Keep the real filename (with extension) so the attachment is typed as
    // image/video rather than a generic file.
    let base_name = if display_name.is_empty() {
        if filename.is_empty() { "attachment.bin".to_string() } else { filename.clone() }
    } else {
        display_name.replace(['/', '\\'], "_")
    };
    let dest = app
        .path()
        .resolve(&format!("uploads/{}", base_name), BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let is = env
        .call_method(&cr, "openInputStream", "(Landroid/net/Uri;)Ljava/io/InputStream;", &[(&uri_obj).into()])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    if env.exception_check().map_err(|e| e.to_string())? {
        let _ = env.exception_clear();
        return Err("openInputStream failed for this content uri".into());
    }

    let dest_str = dest.to_string_lossy().to_string();
    let _ = &display_name;
    let dest_j = env.new_string(&dest_str).map_err(|e| e.to_string())?;
    let file_obj = env
        .new_object("java/io/File", "(Ljava/lang/String;)V", &[(&dest_j).into()])
        .map_err(|e| e.to_string())?;
    let parent = env
        .call_method(&file_obj, "getParentFile", "()Ljava/io/File;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    if !parent.is_null() {
        if let Err(e) = env.call_method(&parent, "mkdirs", "()Z", &[]) {
            log(&format!("mkdirs error: {e}"));
        }
        let _ = env.exception_clear();
    }

    let fos = env
        .new_object("java/io/FileOutputStream", "(Ljava/io/File;)V", &[(&file_obj).into()])
        .map_err(|e| e.to_string())?;

    let buf = env.new_byte_array(64 * 1024).map_err(|e| e.to_string())?;
    let buf_obj: jni::objects::JObject = buf.into();
    let mut copy_result: Result<(), String> = Ok(());
    loop {
        if copy_result.is_err() {
            break;
        }
        let n = match env.call_method(&is, "read", "([B)I", &[(&buf_obj).into()]) {
            Ok(v) => match v.i() {
                Ok(n) => n,
                Err(e) => {
                    copy_result = Err(format!("InputStream.read: {e}"));
                    break;
                }
            },
            Err(e) => {
                copy_result = Err(format!("InputStream.read: {e}"));
                break;
            }
        };
        if n < 0 {
            break;
        }
        if let Err(e) = env.call_method(
            &fos,
            "write",
            "([BII)V",
            &[(&buf_obj).into(), jni::objects::JValue::Int(0), jni::objects::JValue::Int(n)],
        ) {
            copy_result = Err(format!("FileOutputStream.write: {e}"));
            break;
        }
    }

    if let Err(e) = env.call_method(&fos, "close", "()V", &[]) {
        log(&format!("fos close error: {e}"));
    }
    if let Err(e) = env.call_method(&is, "close", "()V", &[]) {
        log(&format!("is close error: {e}"));
    }
    let _ = env.exception_clear();

    copy_result?;
    log(&format!("resolve_content_uri copied {} -> {}", uri, dest_str));
    Ok(dest_str)
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
    // Shared with the background init task: setup() stores None immediately
    // and the async core-init task fills it in once the RPC session is ready.
    #[cfg(target_os = "android")]
    tx: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>>,

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
            #[cfg(target_os = "android")]
            {
                let ext_logs = PathBuf::from("/storage/emulated/0/Android/data")
                    .join(app.config().identifier.clone())
                    .join("files")
                    .join("logs");
                set_mirror_log_dir(ext_logs);
            }
            // The loopback media server runs on every platform: Android's
            // asset protocol (WebViewAssetLoader) answers the first range
            // request but fails mid-file reads, so moov-at-end videos die in
            // the demuxer there; the server's real 206 responses fix playback.
            {
                *MEDIA_TOKEN.lock().unwrap() = {
                    let nanos = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
                        .unwrap_or(0);
                    format!("{:016x}", nanos ^ ((std::process::id() as u64) << 32))
                };
                start_media_server(accounts_dir(&app.handle()));
            }

            log("setup started");

            let accounts = accounts_dir(app.handle());
            let _ = std::fs::create_dir_all(&accounts);
            log(&format!("accounts directory: {}", accounts.display()));

            #[cfg(target_os = "android")]
            {
                let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
                log("initializing embedded Android core (non-blocking)");

                // Share the sender handle with the background init task.
                // Setup must return immediately so WebView creation is not
                // delayed, and core initialization continues asynchronously.
                // Until tx is set, rpc() calls report "not running", which
                // lets the frontend retry instead of dead-ending on startup.
                let tx_holder: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>> = std::sync::Arc::new(std::sync::Mutex::new(None));

                // Spawn the init task through a cloned handle: rt itself is
                // moved into RpcState below to keep the runtime alive for the
                // whole session.
                let spawn_handle = rt.handle().clone();

                app.manage(RpcState {
                    _rt: rt,
                    tx: tx_holder.clone(),
                });

                let handle = app.handle().clone();
                let status_handle = app.handle().clone();
                spawn_handle.spawn(async move {
                    match init_android_core(handle, accounts).await {
                        Ok(tx) => {
                            log("android core RPC session ready");
                            *tx_holder.lock().unwrap() = Some(tx);
                            set_sidecar_status(&status_handle, serde_json::json!({"running": true, "stage": "ready"}));
                        }
                        Err(e) => {
                            log(&format!("embedded Android core initialization failed: {e}"));
                            set_sidecar_status(&status_handle, serde_json::json!({"running": false, "stage": "error", "message": e.to_string()}));
                        }
                    }
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
        .register_uri_scheme_protocol("blobfile", |ctx, request| {
            let mut response = serve_blob_file(ctx.app_handle(), request);
            // no-store keeps the WebView from caching media responses, so
            // deleted/updated blobs are never served stale.
            response.headers_mut().insert("Cache-Control", "no-store".parse().unwrap());
            response.map(|body| std::borrow::Cow::Owned(body))
        })
        .invoke_handler(tauri::generate_handler![js_log, rpc, get_initial_deeplink, get_sidecar_status, get_accounts_dir, resolve_upload_path, resolve_content_uri, media_base_url, poster_cache_path, read_media_bytes, write_poster]);

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