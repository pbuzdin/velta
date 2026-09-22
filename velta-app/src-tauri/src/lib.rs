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

// Public so the p2p-hub debug example can drive the engine headlessly.
pub mod p2p;

static LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static INITIAL_DEEPLINK: Mutex<Option<String>> = Mutex::new(None);
static SIDECAR_STATUS: Mutex<Option<serde_json::Value>> = Mutex::new(None);

// Non-blocking logger: messages are pushed onto an unbounded mpsc channel and
// written from a dedicated background thread, so log() never blocks the IPC /
// RPC hot path. On Android this is critical -- the WebView event bridge and the
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

    // Capture the directory at spawn time -- it won't change during the session.
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
                // don't kill the thread -- just keep draining the channel so
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
    // set_log_dir) or the writer thread has died, the message is dropped --
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
    app.emit("velta-sidecar-status", status).ok();
}

#[tauri::command]
fn get_sidecar_status() -> serde_json::Value {
    SIDECAR_STATUS.lock().unwrap().clone().unwrap_or_else(|| serde_json::json!({"running": false, "stage": "unknown"}))
}

/// Latest released Velta version for the drawer update banner. Shell-side
/// HTTP on purpose: the renderer's fetch of the cross-origin GitHub URL is
/// blocked by CORS (the release CDN sends no ACAO headers), and shell HTTP
/// is not CSP-bound — this hardcoded URL is the ONLY GitHub reach the app
/// has (see AGENTS.md §8). Bounded read + hard timeout like
/// fetch_page_title; any failure returns an empty string and the frontend
/// just shows no banner.
#[tauri::command]
async fn get_latest_version() -> Result<String, String> {
    const VERSION_URL: &str =
        "https://github.com/pbuzdin/velta/releases/latest/download/version.txt";
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(5))
            .build();
        let resp = match agent.get(VERSION_URL).call() {
            Ok(r) => r,
            Err(_) => return Ok(String::new()),
        };
        let mut body = Vec::new();
        use std::io::Read;
        let _ = resp
            .into_reader()
            .take(64 * 1024)
            .read_to_end(&mut body);
        Ok(String::from_utf8_lossy(&body).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Best-effort page <title> for the in-app browser bar. Bounded read (256 KB)
/// and a hard timeout — a slow or hostile page must not hang the bar. Any
/// failure is reported as an empty string; the bar falls back to the domain.
#[tauri::command]
async fn fetch_page_title(url: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("only https URLs are supported".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(5))
            .build();
        let resp = match agent.get(&url).call() {
            Ok(r) => r,
            Err(_) => return Ok(String::new()),
        };
        let mut body = Vec::new();
        use std::io::Read;
        let _ = resp
            .into_reader()
            .take(256 * 1024)
            .read_to_end(&mut body);
        let text = String::from_utf8_lossy(&body);
        let lower = text.to_ascii_lowercase();
        let Some(start) = lower.find("<title") else { return Ok(String::new()) };
        let Some(open_end) = lower[start..].find('>') else { return Ok(String::new()) };
        let from = start + open_end + 1;
        let Some(close) = lower[from..].find("</title") else { return Ok(String::new()) };
        let mut title = html_escape_decode(text[from..from + close].trim());
        if title.len() > 200 {
            title = title.chars().take(200).collect();
        }
        Ok(title)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn html_escape_decode(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Expand a short invite link (e.g. https://deltachat.id/<name>, the Delta
/// Chat username service): the page JS-redirects to the full
/// https://i.delta.chat/#FINGERPRINT… invite URL, so there is no HTTP 3xx to
/// follow — shell-side fetch (renderer fetch is CORS-blocked, same reason as
/// get_latest_version) and extract every URL candidate that carries a
/// 40-hex fingerprint after "/#". The frontend picks the candidate that
/// parses as a registered invite. Bounded read + hard timeout like
/// fetch_page_title; no candidates -> empty vec, and the UI degrades to a
/// plain link.
#[tauri::command]
async fn expand_invite_link(url: String) -> Result<Vec<String>, String> {
    if !url.starts_with("https://") {
        return Err("only https URLs are supported".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(5))
            .build();
        let resp = match agent.get(&url).call() {
            Ok(r) => r,
            Err(_) => return Ok(Vec::new()),
        };
        let mut body = Vec::new();
        use std::io::Read;
        let _ = resp
            .into_reader()
            .take(256 * 1024)
            .read_to_end(&mut body);
        let text = String::from_utf8_lossy(&body);
        let mut out = Vec::new();
        let mut from = 0;
        while let Some(pos) = text[from..].find("https://") {
            let start = from + pos;
            let end = text[start..]
                .find(['"', '\'', '<', '>', ' ', ')'])
                .map(|e| start + e)
                .unwrap_or(text.len());
            let candidate = &text[start..end];
            if let Some(fp) = candidate.split("/#").nth(1) {
                if fp.len() >= 40 && fp[..40].bytes().all(|b| b.is_ascii_hexdigit()) {
                    out.push(candidate.to_string());
                }
            }
            from = start + 8;
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
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
        .map(|p| {
            // The fs plugin's write_file does not create parent directories;
            // this command hands out paths it must guarantee are writable.
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            p.to_string_lossy().to_string()
        })
        .unwrap_or_default()
}

mod webxdc_serve;
use webxdc_serve::{webxdc_resolve_line, webxdc_serve};

// ---------- blobfile:// -- Range-aware media serving ----------

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
        "html" | "htm" | "xhtml" => "text/html", // HTML attachments render in the isolated viewer
        // webxdc assets: browsers hard-enforce MIME for module scripts
        // ("Expected a JavaScript-or-Wasm module script") and stylesheets,
        // so octet-stream breaks every bundler-built app.
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "wasm" => "application/wasm",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

// Origins of the app's own main window (Tauri serves the frontend at
// tauri://localhost on macOS/Linux and http(s)://tauri.localhost on
// Windows/Android). Only these may read blob/media responses cross-origin.
const APP_ORIGINS: &[&str] = &["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

/// CORS gate for the blob/media servers. Requests without an Origin header
/// (plain <img>/<video>/<audio> loads) pass and get no ACAO header. A request
/// that carries an Origin must be one of the app's own origins: sandboxed
/// frames (webxdc apps, the HTML viewer) send `Origin: null` and must never
/// be able to read files from the accounts directory.
/// Ok(Some(origin)) -> echo it in Access-Control-Allow-Origin; Err -> 403.
fn media_cors(origin: Option<&str>) -> Result<Option<String>, ()> {
    match origin {
        None => Ok(None),
        Some(o) if APP_ORIGINS.contains(&o) => Ok(Some(o.to_string())),
        Some(_) => Err(()),
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

    // Boot probe from media.js: an <img> load of this path proves the webview
    // dispatches custom-protocol requests at all (WebView2's media stack can
    // bypass them even when images through the same scheme work — the probe
    // is an <img>, so a 200 here vouches for the image pipeline exactly).
    // Anything answering keeps media on the loopback HTTP server chain.
    if path_part == "__velta-probe" {
        return tauri::http::Response::builder()
            .header("Content-Type", "text/plain")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-store")
            .body(b"ok".to_vec())
            .unwrap();
    }

    // Only the app's own window may read blobs cross-origin; sandboxed
    // frames (webxdc, HTML viewer) arrive with `Origin: null` and are
    // refused (see media_cors).
    let acao = match media_cors(request.headers().get("origin").and_then(|v| v.to_str().ok())) {
        Ok(acao) => acao,
        Err(()) => {
            log("blobfile FORBIDDEN (foreign origin)");
            return tauri::http::Response::builder().status(403).body(b"forbidden".to_vec()).unwrap();
        }
    };
    let cors = |b: tauri::http::response::Builder| match &acao {
        Some(origin) => b.header("Access-Control-Allow-Origin", origin.as_str()).header("Vary", "Origin"),
        None => b,
    };

    // Only serve files that live inside the accounts directory (blobs,
    // uploads) -- never anything else on the filesystem. Canonicalize both
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
            return cors(tauri::http::Response::builder())
                .status(206)
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
                .header("Content-Range", format!("bytes {}-{}/{}", start, start + filled as u64 - 1, len))
                .header("Content-Length", filled)
                .body(buf)
                .unwrap();
        }
        return cors(tauri::http::Response::builder())
            .status(416)
            .header("Content-Range", format!("bytes */{}", len))
            .body(Vec::new())
            .unwrap();
    }

    match std::fs::read(&serve_path) {
        Ok(data) => cors(tauri::http::Response::builder())
            .status(200)
            .header("Content-Type", mime)
            .header("Accept-Ranges", "bytes")
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
// protocol -- plain GETs work fine there even though range reads don't.

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

// Posters are extracted from a full in-memory copy of the media -- refuse to
// buffer oversized files into the IPC layer (the WebView's poster.js has its
// own fast-path check, but this is the enforced bound).
const MAX_MEDIA_IPC_BYTES: u64 = 128 * 1024 * 1024;

fn checked_media_read(canon: &std::path::Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(canon).map_err(|e| e.to_string())?;
    if meta.len() > MAX_MEDIA_IPC_BYTES {
        return Err(format!(
            "media file too large to read into memory ({} bytes > {MAX_MEDIA_IPC_BYTES})",
            meta.len()
        ));
    }
    std::fs::read(canon).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_media_bytes(app: tauri::AppHandle, src: String) -> Result<tauri::ipc::Response, String> {
    let canon = scoped_accounts_path(&app, &src)?;
    let bytes = checked_media_read(&canon)?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---------- incoming-message notifications ----------
//
// The WebView decides WHEN to notify (it knows document.hidden and which
// message is new); this command is only the bridge to the platform
// notification API. ponytail ceiling: clicking the notification focuses the
// app but does not deep-link to the chat (notification action events +
// window.show wiring left as the upgrade path).

// Windows renders the conversation style directly through
// tauri-winrt-notification: up to three text lines (chat name / sender /
// message) plus the sender's avatar cropped circular in the app-logo slot —
// the desktop counterpart of the Android MessagingStyle layout. The AUMID is
// the config identifier, the same identity the notification plugin uses.
#[cfg(target_os = "windows")]
#[tauri::command]
fn notify_incoming(
    app: tauri::AppHandle,
    title: String,
    body: String,
    chat_name: Option<String>,
    sender_name: Option<String>,
    sender_avatar: Option<String>,
) -> Result<(), String> {
    use tauri_winrt_notification::{IconCrop, Toast};

    let resolved_title = chat_name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&title);
    let mut toast = Toast::new(app.config().identifier.as_str()).title(resolved_title);
    // The sender row is meaningful only in groups (1:1 sender == title).
    if let Some(sender) = sender_name.as_deref() {
        if !sender.is_empty() && sender != resolved_title {
            toast = toast.text1(sender);
        }
    }
    toast = toast.text2(&body);
    if let Some(avatar) = sender_avatar.as_deref() {
        let path = std::path::Path::new(avatar);
        if path.exists() {
            toast = toast.icon(path, IconCrop::Circular, "sender avatar");
        }
    }
    toast.show().map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn notify_incoming(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

// ---------- background event draining (Android) ----------

// Whether the frontend UI can currently process core events itself. The JS
// side reports visibility via set_ui_visible; when the app is hidden the
// WebView's JS stalls (and the process would freeze without the foreground
// service), so the Rust-side background poller takes over event draining.
static UI_VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn set_ui_visible(visible: bool) {
    UI_VISIBLE.store(visible, std::sync::atomic::Ordering::SeqCst);
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
            // Fall back to an ephemeral port (media may then be CSP-blocked --
            // logged loudly) rather than losing media entirely.
            let listener = match std::net::TcpListener::bind("127.0.0.1:20810") {
                Ok(l) => l,
                Err(_) => match std::net::TcpListener::bind("127.0.0.1:0") {
                    Ok(l) => {
                        log("media http: port 20810 busy, bound ephemeral -- media-src CSP mismatch possible");
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
    use std::io::{Read, Seek, SeekFrom, Write};
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));

    // Read the request head (request line + headers) up to the blank line.
    // The terminator must be spelled with escapes: a raw CR/LF inside the
    // literal is normalized by rustc to a bare "\n\n", which never matches a
    // 4-byte window -- every request then sat until the 10 s read timeout.
    let mut head = Vec::new();
    let mut buf = [0u8; 2048];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                head.extend_from_slice(&buf[..n]);
                if head.windows(4).any(|w| w == b"\r\n\r\n") || head.len() > 64 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let head = String::from_utf8_lossy(&head);
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut path = "";
    let mut range: Option<String> = None;
    let mut origin: Option<String> = None;
    for part in request_line.split(' ') {
        if part.starts_with('/') {
            path = part;
        }
    }
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        if name.eq_ignore_ascii_case("range") {
            range = Some(value.to_string());
        } else if name.eq_ignore_ascii_case("origin") {
            origin = Some(value.to_string());
        }
    }

    let mut not_found = || {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };

    // Same CORS gate as the blobfile protocol: sandboxed frames send
    // `Origin: null` and must not read account files (see media_cors).
    let cors = match media_cors(origin.as_deref()) {
        Ok(Some(o)) => format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n"),
        Ok(None) => String::new(),
        Err(()) => {
            eprintln!("[media] 403: foreign origin {origin:?}");
            return not_found();
        }
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
        eprintln!("[media] 404: token mismatch");
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

    let mut file = match std::fs::File::open(&serve_path) {
        Ok(f) => f,
        Err(_) => return not_found(),
    };

    // Range request: seek to the offset and stream exactly the requested
    // interval. (The old path truncated the file from byte 0 without seeking,
    // serving the wrong bytes labelled as start-end and breaking video
    // seeking / moov-at-end demuxing.) An unusable Range header gets 416 --
    // never a whole-file read.
    if let Some(header) = &range {
        let Some((start, end)) = parse_range(header, len) else {
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\n{cors}Content-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            );
            return;
        };
        let take = end - start + 1;
        if file.seek(SeekFrom::Start(start)).is_err() {
            return not_found();
        }
        let headers = format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {mime}\r\nAccept-Ranges: bytes\r\n{cors}Content-Range: bytes {start}-{end}/{len}\r\nContent-Length: {take}\r\nConnection: close\r\n\r\n"
        );
        if stream.write_all(headers.as_bytes()).is_err() {
            return;
        }
        let mut remaining = take;
        let mut chunk = [0u8; 64 * 1024];
        while remaining > 0 {
            let want = std::cmp::min(chunk.len() as u64, remaining) as usize;
            match file.read(&mut chunk[..want]) {
                Ok(0) => break,
                Ok(n) => {
                    if stream.write_all(&chunk[..n]).is_err() {
                        break;
                    }
                    remaining -= n as u64;
                }
                Err(_) => break,
            }
        }
        let _ = stream.flush();
        return;
    }

    // Full GET: stream in chunks -- a large video must never be buffered whole.
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nAccept-Ranges: bytes\r\n{cors}Content-Length: {len}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(headers.as_bytes()).is_err() {
        return;
    }
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match file.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&chunk[..n]).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = stream.flush();
}
#[cfg(target_os = "android")]
static APP_CONTEXT: Mutex<Option<jni::objects::GlobalRef>> = Mutex::new(None);

// org.velta.InAppBrowser cached as a global ref: JNI FindClass for app
// classes is unreliable from Rust worker threads attached via
// attach_current_thread (wrong classloader context), so it is resolved once
// in setApplicationContext while running on a Java thread.
#[cfg(target_os = "android")]
static APP_INAPP_BROWSER_CLASS: Mutex<Option<jni::objects::GlobalRef>> = Mutex::new(None);

// org.velta.Notifications cached as a global ref for the same classloader
// reason as APP_INAPP_BROWSER_CLASS: messaging-style incoming-message
// notifications are posted from Rust through this Kotlin helper.
#[cfg(target_os = "android")]
static APP_NOTIFICATIONS_CLASS: Mutex<Option<jni::objects::GlobalRef>> = Mutex::new(None);

// Called from MainActivity.onCreate (Kotlin) with the application context.
// Storing it lets Rust commands use the Android ContentResolver (e.g. for
// reading content:// attachments picked through the system file picker).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_MainActivity_setApplicationContext(
    mut env: jni::JNIEnv,
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
    match env.find_class("org/velta/InAppBrowser") {
        Ok(class) => match env.new_global_ref(&class) {
            Ok(g) => {
                *APP_INAPP_BROWSER_CLASS.lock().unwrap() = Some(g);
            }
            Err(e) => log(&format!("setApplicationContext: InAppBrowser global ref failed: {e}")),
        },
        Err(e) => log(&format!("setApplicationContext: InAppBrowser find_class failed: {e}")),
    }
    match env.find_class("org/velta/Notifications") {
        Ok(class) => match env.new_global_ref(&class) {
            Ok(g) => {
                *APP_NOTIFICATIONS_CLASS.lock().unwrap() = Some(g);
            }
            Err(e) => log(&format!("setApplicationContext: Notifications global ref failed: {e}")),
        },
        Err(e) => log(&format!("setApplicationContext: Notifications find_class failed: {e}")),
    }
    log("application context stored for Rust commands");
}

// Desktop has no ContentResolver; the command exists on every platform so the
// frontend can always call it -- on desktop it just reports unsupported.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn resolve_content_uri(_app: tauri::AppHandle, _uri: String, _filename: String) -> Result<String, String> {
    Err("picking attachments is only supported on mobile".into())
}

// Desktop keeps its system-browser convention for message links; the in-app
// Custom Tab is an Android behavior.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn open_in_app_browser(_url: String) -> Result<(), String> {
    Err("in-app browser is only supported on Android".into())
}

/// Android: launch the URL in a Chrome Custom Tab (native, Telegram-style)
/// via InAppBrowser.kt. Uses the application context handed over from
/// MainActivity.onCreate. InAppBrowser.open falls back to a plain ACTION_VIEW
/// launch when no Custom Tabs provider resolves the session intent.
#[cfg(target_os = "android")]
#[tauri::command]
fn open_in_app_browser(url: String) -> Result<(), String> {
    let ctx_guard = APP_CONTEXT.lock().unwrap();
    let context = ctx_guard
        .as_ref()
        .map(|r| r.as_obj().clone())
        .ok_or("application context was not handed over yet")?;
    let vm_guard = APP_JAVA_VM.lock().unwrap();
    let vm_ref = vm_guard.as_ref().ok_or("jvm was not handed over yet")?;
    let mut env = vm_ref.attach_current_thread().map_err(|e| format!("jvm attach: {e}"))?;

    let class_guard = APP_INAPP_BROWSER_CLASS.lock().unwrap();
    let class_ref = class_guard
        .as_ref()
        .ok_or("InAppBrowser class was not cached at startup")?;
    let url_j = env.new_string(url).map_err(|e| e.to_string())?;
    let opened = env
        .call_static_method(
            class_ref,
            "open",
            "(Landroid/content/Context;Ljava/lang/String;)Z",
            &[(&context).into(), (&url_j).into()],
        )
        .map_err(|e| e.to_string())?
        .z()
        .map_err(|e| e.to_string())?;
    if !opened {
        // No Custom Tabs provider on the device: the frontend opens the
        // native WebView overlay next (better than a full browser switch).
        return Err("no custom tabs provider".into());
    }
    Ok(())
}

/// Android: second-WebView browser overlay (the no-Custom-Tabs-provider
/// fallback; a top-level browsing context, so X-Frame-Options cannot block
/// it). Desktop keeps its system-browser convention.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn open_webview_browser(_url: String) -> Result<(), String> {
    Err("webview browser is only supported on Android".into())
}

#[cfg(target_os = "android")]
#[tauri::command]
fn open_webview_browser(url: String) -> Result<(), String> {
    let ctx_guard = APP_CONTEXT.lock().unwrap();
    let context = ctx_guard
        .as_ref()
        .map(|r| r.as_obj().clone())
        .ok_or("application context was not handed over yet")?;
    let vm_guard = APP_JAVA_VM.lock().unwrap();
    let vm_ref = vm_guard.as_ref().ok_or("jvm was not handed over yet")?;
    let mut env = vm_ref.attach_current_thread().map_err(|e| format!("jvm attach: {e}"))?;

    let class_guard = APP_INAPP_BROWSER_CLASS.lock().unwrap();
    let class_ref = class_guard
        .as_ref()
        .ok_or("InAppBrowser class was not cached at startup")?;
    let url_j = env.new_string(url).map_err(|e| e.to_string())?;
    // openWebView posts to the main looper itself; it returns void and never
    // fails visibly (a missing activity attachment is logged in Kotlin).
    env.call_static_method(
        class_ref,
        "openWebView",
        "(Landroid/content/Context;Ljava/lang/String;)V",
        &[(&context).into(), (&url_j).into()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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
    // webxdc asset serving does request/response round-trips from Rust-side
    // protocol handlers (the WebView cannot relay its own asset fetches).
    // Those requests use string ids prefixed "wxdc-" so the response
    // forwarders hand them back here instead of emitting to the WebView.
    wxdc_pending: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
    // Background event poller (Android): get_next_event_batch round-trips
    // use ids prefixed "bg-", routed back here by the response forwarder.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    bg_pending: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
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
    // hot path -- even with the non-blocking logger, formatting a string per
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
    let _ = app_handle.emit("velta-sidecar-status", serde_json::json!({"running": true, "stage": "initializing"}));

    let accounts = Accounts::new(accounts_dir, true).await?;
    let accounts = Arc::new(RwLock::new(accounts));
    let _ = app_handle.emit("velta-sidecar-status", serde_json::json!({"running": true, "stage": "configuring"}));

    let state = CommandApi::from_arc(accounts.clone()).await;

    let (client, mut out_receiver) = RpcClient::new();
    let session = RpcSession::new(client.clone(), state);
    let (req_tx, mut req_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Forward JSON-RPC responses and events to the WebView.
    let app = app_handle.clone();
    tokio::spawn(async move {
        while let Some(message) = out_receiver.next().await {
            let is_wxdc = match &message {
                yerpc::Message::Response(response) => matches!(
                    &response.id,
                    Some(yerpc::Id::String(id)) if id.starts_with("wxdc-")
                ),
                _ => false,
            };
            if is_wxdc {
                if let Ok(line) = serde_json::to_string(&message) {
                    webxdc_resolve_line(&app, &line);
                }
                continue;
            }
            let is_bg = match &message {
                yerpc::Message::Response(response) => matches!(
                    &response.id,
                    Some(yerpc::Id::String(id)) if id.starts_with("bg-")
                ),
                _ => false,
            };
            if is_bg {
                if let Ok(line) = serde_json::to_string(&message) {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(id) = value.get("id").and_then(|v| v.as_str()).map(str::to_string) {
                            if let Some(sender) = app.state::<RpcState>().bg_pending.lock().unwrap().remove(&id) {
                                let _ = sender.send(line);
                            }
                        }
                    }
                }
                continue;
            }
            let line = match serde_json::to_string(&message) {
                Ok(line) => line,
                Err(e) => {
                    log(&format!("jsonrpc serialize error: {e}"));
                    continue;
                }
            };
            // NOTE: do not log every response -- it's the hot path and would
            // grow velta.log unbounded. Errors are still logged below.
            if let Err(e) = app.emit("velta-rpc", &line) {
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

// Round-trip a JSON-RPC call from Rust while the UI is hidden. Requests use
// ids prefixed "bg-"; the response forwarder routes them back through
// bg_pending (same pattern as the "wxdc-" webxdc round-trips).
#[cfg(target_os = "android")]
static BG_RPC_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(target_os = "android")]
async fn bg_rpc(
    tx: &tokio::sync::mpsc::UnboundedSender<String>,
    state: &RpcState,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = format!("bg-{}", BG_RPC_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let request = serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel::<String>();
    state.bg_pending.lock().unwrap().insert(id, resp_tx);
    tx.send(request.to_string()).map_err(|_| "core rpc channel closed".to_string())?;
    let line = tokio::time::timeout(std::time::Duration::from_secs(60), resp_rx)
        .await
        .map_err(|_| "bg rpc timed out".to_string())?
        .map_err(|_| "bg rpc dropped".to_string())?;
    let value: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    if let Some(err) = value.get("error") {
        return Err(format!("bg rpc error: {err}"));
    }
    Ok(value.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

// Post notifications for a drain cycle's incoming messages — one
// conversation per chat (MessagingStyle via org.velta.Notifications):
// group name as title, sender name as the second line, plain message text
// (never a "Group: text" prefix), sender avatar on the left, chat avatar
// on the right, and consecutive messages of one chat grouped into a single
// conversation. Falls back to plain title/body when the Kotlin side is not
// reachable (application context not handed over yet).
#[cfg(target_os = "android")]
async fn bg_notify_incoming(
    app: &tauri::AppHandle,
    tx: &tokio::sync::mpsc::UnboundedSender<String>,
    state: &RpcState,
    hits: Vec<(u32, u32, u32)>, // (account, chatId, msgId)
) {
    use tauri_plugin_notification::NotificationExt;

    // Oldest first so the newest message lands last in each conversation;
    // cap a burst so a 50-message flood does not spin 50 RPC round trips.
    let recent: Vec<&(u32, u32, u32)> = hits.iter().rev().take(8).collect();
    for &&(account, chat_id, msg_id) in recent.iter().rev() {
        let Ok(msg) = bg_rpc(tx, state, "get_message", serde_json::json!([account, msg_id])).await
        else {
            continue;
        };
        let text = msg
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let from_id = msg.get("fromId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let ts_ms = (msg.get("sortTimestamp").and_then(|v| v.as_i64()).unwrap_or(0) * 1000).max(0);

        let (chat_name, chat_avatar, chat_type) = match bg_rpc(
            tx,
            state,
            "get_basic_chat_info",
            serde_json::json!([account, chat_id]),
        )
        .await
        {
            Ok(c) => (
                c.get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("Velta")
                    .trim()
                    .to_string(),
                c.get("profileImage").and_then(|n| n.as_str()).map(str::to_string),
                c.get("chatType")
                    .and_then(|n| n.as_str())
                    .unwrap_or("Single")
                    .to_string(),
            ),
            Err(_) => ("Velta".to_string(), None, "Single".to_string()),
        };
        let is_group = chat_type != "Single";

        let (sender_name, sender_avatar) =
            match bg_rpc(tx, state, "get_contact", serde_json::json!([account, from_id])).await {
                Ok(c) => (
                    c.get("displayName")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .or_else(|| c.get("name").and_then(|v| v.as_str()))
                        .unwrap_or("Contact")
                        .to_string(),
                    c.get("profileImage").and_then(|v| v.as_str()).map(str::to_string),
                ),
                Err(_) => (if is_group { "Contact".to_string() } else { chat_name.clone() }, None),
            };

        if kotlin_notify_incoming(
            app,
            account,
            chat_id,
            is_group,
            &chat_name,
            chat_avatar.as_deref(),
            &sender_name,
            sender_avatar.as_deref(),
            &text,
            ts_ms,
        )
        .is_ok()
        {
            continue;
        }

        // Fallback: plain title/body (no "Group:" prefix — that was the bug).
        let title = if is_group { chat_name.clone() } else { sender_name.clone() };
        let _ = app.notification().builder().title(title).body(text).show();
    }
}

// Bridge to org.velta.Notifications.show over JNI (see the Kotlin source for
// the layout contract). Fails when the application context or the cached
// class is missing — the caller falls back to the plugin notification.
#[cfg(target_os = "android")]
#[allow(clippy::too_many_arguments)]
fn kotlin_notify_incoming(
    app: &tauri::AppHandle,
    account: u32,
    chat_id: u32,
    is_group: bool,
    chat_name: &str,
    chat_avatar: Option<&str>,
    sender_name: &str,
    sender_avatar: Option<&str>,
    text: &str,
    timestamp_ms: i64,
) -> Result<(), String> {
    let ctx_guard = APP_CONTEXT.lock().unwrap();
    let context = ctx_guard
        .as_ref()
        .map(|r| r.as_obj().clone())
        .ok_or("application context was not handed over yet")?;
    let vm_guard = APP_JAVA_VM.lock().unwrap();
    let vm_ref = vm_guard.as_ref().ok_or("jvm was not handed over yet")?;
    let mut env = vm_ref.attach_current_thread().map_err(|e| format!("jvm attach: {e}"))?;

    let class_guard = APP_NOTIFICATIONS_CLASS.lock().unwrap();
    let class_ref = class_guard
        .as_ref()
        .ok_or("Notifications class was not cached at startup")?;

    let chat_key = env.new_string(format!("{account}:{chat_id}")).map_err(|e| e.to_string())?;
    let chat_name_j = env.new_string(chat_name).map_err(|e| e.to_string())?;
    let chat_avatar_j = opt_jstring(&mut env, chat_avatar)?;
    let sender_name_j = env.new_string(sender_name).map_err(|e| e.to_string())?;
    let sender_avatar_j = opt_jstring(&mut env, sender_avatar)?;
    let text_j = env.new_string(text).map_err(|e| e.to_string())?;

    env.call_static_method(
        class_ref,
        "show",
        "(Landroid/content/Context;Ljava/lang/String;ZLjava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;J)V",
        &[
            (&context).into(),
            (&chat_key).into(),
            jni::objects::JValue::Bool(is_group as u8),
            (&chat_name_j).into(),
            (&chat_avatar_j).into(),
            (&sender_name_j).into(),
            (&sender_avatar_j).into(),
            (&text_j).into(),
            jni::objects::JValue::Long(timestamp_ms),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "android")]
fn opt_jstring<'local>(
    env: &mut jni::JNIEnv<'local>,
    value: Option<&str>,
) -> Result<jni::objects::JObject<'local>, String> {
    match value {
        Some(s) => Ok(env.new_string(s).map_err(|e| e.to_string())?.into()),
        None => Ok(jni::objects::JObject::null()),
    }
}

// Drain the core's event queue while the UI cannot: with the foreground
// service keeping the process alive, this is what turns background mail
// into notifications. Events consumed here never reach the frontend; the
// JS visibilitychange handler refetches the chat list and the open chat
// when the app becomes visible again.
#[cfg(target_os = "android")]
fn start_bg_event_poller(app: tauri::AppHandle, tx: tokio::sync::mpsc::UnboundedSender<String>) {
    tauri::async_runtime::spawn(async move {
        log("background event poller started");
        loop {
            if UI_VISIBLE.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
            let state = app.state::<RpcState>();
            match bg_rpc(&tx, &state, "get_next_event_batch", serde_json::json!([])).await {
                Ok(result) => {
                    let events = result.as_array().cloned().unwrap_or_default();
                    let mut hits: Vec<(u32, u32, u32)> = Vec::new();
                    for ev in &events {
                        if ev.pointer("/event/kind").and_then(|k| k.as_str()) != Some("IncomingMsg") {
                            continue;
                        }
                        hits.push((
                            ev.get("contextId").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                            ev.pointer("/event/chatId").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                            ev.pointer("/event/msgId").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                        ));
                    }
                    if !hits.is_empty() && !UI_VISIBLE.load(std::sync::atomic::Ordering::SeqCst) {
                        bg_notify_incoming(&app, &tx, &state, hits).await;
                    }
                }
                Err(_) => {
                    // Core not ready yet or the round-trip was dropped: back off.
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
    });
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
                // 128 random bits: the token is the only thing standing
                // between other local processes/users and the account files
                // this server can read, so it must not be derivable from the
                // start time or the PID.
                *MEDIA_TOKEN.lock().unwrap() = {
                    use rand::RngCore;
                    let mut bytes = [0u8; 16];
                    rand::rngs::OsRng.fill_bytes(&mut bytes);
                    data_encoding::HEXLOWER.encode(&bytes)
                };
                start_media_server(accounts_dir(&app.handle()));
            }

            log("setup started");

            let accounts = accounts_dir(app.handle());
            let _ = std::fs::create_dir_all(&accounts);
            log(&format!("accounts directory: {}", accounts.display()));

            // Local-only P2P chat engine -- independent of the Delta Chat core,
            // runs on Tauri's async runtime on every platform. Manage the exact
            // type the commands expect (P2pState itself, NOT a wrapper -- a
            // mismatch surfaces as "state not managed" at command time); the
            // engine fills in asynchronously so early p2p_* calls report
            // "still starting" instead of failing with an unmanaged-state error.
            {
                let p2p_dir = app
                    .path()
                    .resolve("p2p", tauri::path::BaseDirectory::AppLocalData);
                let state = p2p::P2pState::empty();
                let slot = state.slot();
                let enabled = state.enabled_flag();
                // Media blobs must sit under the accounts dir: the blobfile /
                // media-server pipeline refuses to serve anything outside it.
                let blobs_dir = accounts_dir(app.handle()).join("p2p-blobs");
                if let Ok(dir) = p2p_dir {
                    state.set_dir(dir.clone());
                    state.set_blobs(blobs_dir.clone());
                    p2p::spawn_startup(app.handle().clone(), slot, enabled, dir, blobs_dir);
                } else {
                    log("p2p data dir unavailable");
                }
                app.manage(state);
            }

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
                    wxdc_pending: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
                    bg_pending: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
                    _rt: rt,
                    tx: tx_holder.clone(),
                });

                let handle = app.handle().clone();
                let status_handle = app.handle().clone();
                let bg_handle = app.handle().clone();
                spawn_handle.spawn(async move {
                    match init_android_core(handle, accounts).await {
                        Ok(tx) => {
                            log("android core RPC session ready");
                            start_bg_event_poller(bg_handle, tx.clone());
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
                                wxdc_pending: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
                                bg_pending: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
                                stdin: Arc::new(Mutex::new(Some(stdin))),
                            });
                            set_sidecar_status(&app_handle, serde_json::json!({"running": true, "stage": "ready"}));

                            std::thread::spawn(move || {
                                log("sidecar reader thread started");
                                let reader = BufReader::new(stdout);
                                for line in reader.lines() {
                                    match line {
                                        Ok(line) => {
                                            // NOTE: do not log every line -- it's the
                                            // hot path and would grow velta.log
                                            // unbounded. Errors are logged below.
                                            if line.contains("\"id\":\"wxdc-") {
                                                webxdc_resolve_line(&app_handle, &line);
                                                continue;
                                            }
                                            app_handle.emit("velta-rpc", line).ok();
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
        .register_asynchronous_uri_scheme_protocol("webxdc", move |ctx, request, responder| {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let response = webxdc_serve(app, request).await;
        responder.respond(response);
    });
})
.register_uri_scheme_protocol("blobfile", |ctx, request| {
            let mut response = serve_blob_file(ctx.app_handle(), request);
            // Blob URLs are content-deduplicated by the core (same name =
            // same bytes), so media is immutable: let the WebView cache it.
            // Reopening a chat then decodes images from memory/disk cache
            // instead of re-reading and re-decoding every blob.
            response.headers_mut().insert("Cache-Control", "max-age=31536000, immutable".parse().unwrap());
            response.map(|body| std::borrow::Cow::Owned(body))
        })
        .invoke_handler(tauri::generate_handler![js_log, rpc, set_ui_visible, get_latest_version, fetch_page_title, expand_invite_link, open_in_app_browser, open_webview_browser, get_initial_deeplink, get_sidecar_status, get_accounts_dir, resolve_upload_path, resolve_content_uri, media_base_url, poster_cache_path, read_media_bytes, write_poster, notify_incoming, p2p::p2p_status, p2p::p2p_set_enabled, p2p::p2p_set_name, p2p::p2p_create_invite, p2p::p2p_accept_invite, p2p::p2p_send, p2p::p2p_send_file, p2p::p2p_remove_peer, p2p::p2p_messages, p2p::p2p_retry, p2p::p2p_pair_nearby, p2p::p2p_approve_pair]);

    builder = builder.plugin(tauri_plugin_notification::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|_app, argv, cwd| {
                log(&format!("single-instance args: {argv:?} cwd={cwd}"));
                // The deep-link plugin (with the single-instance feature) forwards
                // the URL to the running instance as a `deep-link://new-url` event.
            }))
            .plugin(tauri_plugin_deep_link::init())
            // Windows self-update: the renderer drives check/download/install
            // through the plugin's JS API; all traffic stays shell-side.
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
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

// ---------------------------------------------------------------------------
// Tests: media range serving + IPC size guard
// ---------------------------------------------------------------------------

#[cfg(test)]
mod media_tests {
    use super::*;
    use std::io::{Read as _, Write as _};

    fn temp_media_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("velta-media-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // Content: byte i = (i % 251) as u8, so any wrong offset or truncated
    // body produces a different payload.
    fn make_media_file(dir: &PathBuf, name: &str, len: usize) -> PathBuf {
        let path = dir.join(name);
        let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &data).unwrap();
        path
    }

    fn start_test_server(accounts: PathBuf) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut server) = stream else { break };
                serve_media_connection(&mut server, &accounts);
            }
        });
        port
    }

    fn exchange(port: u16, request: String) -> Vec<u8> {
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        sock.write_all(request.as_bytes()).unwrap();
        let mut response = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match sock.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => response.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }
        response
    }

    fn head(response: &[u8]) -> String {
        let end = response.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4).unwrap_or(response.len());
        String::from_utf8_lossy(&response[..end]).into_owned()
    }

    fn body(response: &[u8]) -> &[u8] {
        match response.windows(4).position(|w| w == b"\r\n\r\n") {
            Some(i) => &response[i + 4..],
            None => &[],
        }
    }

    fn get(port: u16, token: &str, path: &str, range: Option<&str>) -> Vec<u8> {
        get_with(port, token, path, range, None)
    }

    fn get_with(port: u16, token: &str, path: &str, range: Option<&str>, origin: Option<&str>) -> Vec<u8> {
        let range_line = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
        let origin_line = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
        exchange(
            port,
            format!("GET /{token}/{} HTTP/1.1\r\nHost: x\r\n{range_line}{origin_line}\r\n", path),
        )
    }

    // Regression: the head terminator literal was a raw newline pair, so the
    // server never saw the end of the request head and every request waited
    // for the 10 s read timeout before answering.
    #[test]
    fn request_head_is_parsed_without_waiting_for_the_read_timeout() {
        let dir = temp_media_dir("latency");
        *MEDIA_TOKEN.lock().unwrap() = "testtoken".into();
        let path = make_media_file(&dir, "clip.mp4", 100);
        let port = start_test_server(dir.clone());

        let started = std::time::Instant::now();
        let response = get(port, "testtoken", &path.to_string_lossy(), Some("bytes=0-9"));
        assert!(head(&response).starts_with("HTTP/1.1 206"), "{}", head(&response));
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "took {:?}", started.elapsed());
    }

    #[test]
    fn sandboxed_frames_cannot_read_media_and_the_app_origin_can() {
        let dir = temp_media_dir("origin");
        *MEDIA_TOKEN.lock().unwrap() = "testtoken".into();
        let path = make_media_file(&dir, "clip.mp4", 100);
        let port = start_test_server(dir.clone());
        let p = path.to_string_lossy();

        // Opaque-origin frames (webxdc apps, the HTML viewer) send Origin: null.
        let denied = get_with(port, "testtoken", &p, None, Some("null"));
        assert!(head(&denied).starts_with("HTTP/1.1 404"), "{}", head(&denied));
        assert!(body(&denied).is_empty());

        let allowed = get_with(port, "testtoken", &p, None, Some("http://tauri.localhost"));
        assert!(head(&allowed).starts_with("HTTP/1.1 200"), "{}", head(&allowed));
        assert!(head(&allowed).contains("Access-Control-Allow-Origin: http://tauri.localhost"), "{}", head(&allowed));

        // Plain element loads carry no Origin and get no ACAO header.
        let plain = get(port, "testtoken", &p, None);
        assert!(head(&plain).starts_with("HTTP/1.1 200"), "{}", head(&plain));
        assert!(!head(&plain).contains("Access-Control-Allow-Origin"), "{}", head(&plain));
    }

    #[test]
    fn media_cors_accepts_only_app_origins() {
        assert_eq!(media_cors(None), Ok(None));
        assert_eq!(media_cors(Some("tauri://localhost")), Ok(Some("tauri://localhost".into())));
        assert_eq!(media_cors(Some("http://tauri.localhost")), Ok(Some("http://tauri.localhost".into())));
        assert_eq!(media_cors(Some("null")), Err(()));
        assert_eq!(media_cors(Some("http://webxdc.localhost")), Err(()));
        assert_eq!(media_cors(Some("https://example.com")), Err(()));
    }

    #[test]
    fn parse_range_cases() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-199", 1000), Some((100, 199)));
        assert_eq!(parse_range("bytes=100-", 1000), Some((100, 999)));
        assert_eq!(parse_range("bytes=-200", 1000), Some((800, 999)));
        assert_eq!(parse_range("bytes=999-", 1000), Some((999, 999)));
        // Unsatisfiable or malformed.
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("bytes=500-100", 1000), None);
        assert_eq!(parse_range("bytes=abc", 1000), None);
    }

    #[test]
    fn range_request_serves_the_requested_interval_from_the_right_offset() {
        let dir = temp_media_dir("range");
        *MEDIA_TOKEN.lock().unwrap() = "testtoken".into();
        let path = make_media_file(&dir, "clip.mp4", 1000);
        let port = start_test_server(dir.clone());

        let response = get(port, "testtoken", &path.to_string_lossy(), Some("bytes=100-199"));

        assert!(head(&response).starts_with("HTTP/1.1 206 Partial Content"), "{}", head(&response));
        assert!(head(&response).contains("Content-Range: bytes 100-199/1000"), "{}", head(&response));
        let expected: Vec<u8> = (100..200).map(|i| (i % 251) as u8).collect();
        assert_eq!(body(&response), expected.as_slice());
    }

    #[test]
    fn open_ended_and_suffix_ranges_stay_correct() {
        let dir = temp_media_dir("openrange");
        *MEDIA_TOKEN.lock().unwrap() = "testtoken".into();
        let path = make_media_file(&dir, "clip.mp4", 1000);
        let port = start_test_server(dir.clone());
        let tail: Vec<u8> = (900..1000).map(|i| (i % 251) as u8).collect();

        // bytes=900- → the tail, seeked to 900.
        let response = get(port, "testtoken", &path.to_string_lossy(), Some("bytes=900-"));
        assert!(head(&response).contains("Content-Range: bytes 900-999/1000"), "{}", head(&response));
        assert_eq!(body(&response), tail.as_slice());

        // bytes=-100 → also the last 100 bytes.
        let response = get(port, "testtoken", &path.to_string_lossy(), Some("bytes=-100"));
        assert!(head(&response).contains("Content-Range: bytes 900-999/1000"), "{}", head(&response));
        assert_eq!(body(&response), tail.as_slice());
    }

    #[test]
    fn unsatisfiable_range_gets_416_not_the_whole_file() {
        let dir = temp_media_dir("unsat");
        *MEDIA_TOKEN.lock().unwrap() = "testtoken".into();
        let path = make_media_file(&dir, "clip.mp4", 1000);
        let port = start_test_server(dir.clone());

        let response = get(port, "testtoken", &path.to_string_lossy(), Some("bytes=2000-3000"));
        assert!(head(&response).starts_with("HTTP/1.1 416"), "{}", head(&response));
        assert!(head(&response).contains("Content-Range: bytes */1000"), "{}", head(&response));
        assert!(body(&response).is_empty(), "{:?}", body(&response));
    }

    #[test]
    fn full_get_streams_the_whole_file() {
        let dir = temp_media_dir("full");
        *MEDIA_TOKEN.lock().unwrap() = "testtoken".into();
        let path = make_media_file(&dir, "clip.mp4", 5000);
        let port = start_test_server(dir.clone());

        let response = get(port, "testtoken", &path.to_string_lossy(), None);
        assert!(head(&response).starts_with("HTTP/1.1 200 OK"), "{}", head(&response));
        assert!(head(&response).contains("Content-Length: 5000"), "{}", head(&response));
        assert_eq!(body(&response).len(), 5000);
        let expected: Vec<u8> = (0..5000).map(|i| (i % 251) as u8).collect();
        assert_eq!(body(&response), expected.as_slice());
    }

    #[test]
    fn oversized_media_read_is_refused_before_allocation() {
        let dir = temp_media_dir("big");
        let path = dir.join("big.mp4");
        // Sparse file: size without content, so the test stays fast.
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(MAX_MEDIA_IPC_BYTES + 1).unwrap();
        drop(f);

        let err = checked_media_read(&path).unwrap_err();
        assert!(err.contains("too large"), "{err}");
    }
}
