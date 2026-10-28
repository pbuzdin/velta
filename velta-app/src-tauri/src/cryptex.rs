//! Cryptex (drop.gluek.info-style) large-file provider: plain HTTPS through
//! the account proxy, like lufi.rs. The renderer never talks to the server
//! itself (no CORS for app origins; proxy must apply).
//!
//! Flow: create (multipart, one file, password, retention) -> chat link
//! `https://<server>/<id>#<password>` -> receiver: open -> download (token)
//! -> GET /api/download/<token>. The API key is optional (private-mode
//! servers) and only ever comes from the caller; nothing is hardcoded.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub const MAX_FILE: u64 = 1024 * 1024 * 1024; // 1 GB per file

pub struct Progress {
    sent: AtomicU64,
    total: AtomicU64,
    cancel: AtomicBool,
}

fn uploads() -> &'static Mutex<HashMap<u64, Arc<Progress>>> {
    static U: OnceLock<Mutex<HashMap<u64, Arc<Progress>>>> = OnceLock::new();
    U.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `https://host[/path]` without a trailing slash; https only.
pub fn base_url(server: &str) -> Result<String, String> {
    let s = server.trim().trim_end_matches('/');
    let rest = s.strip_prefix("https://").ok_or("the Cryptex server must use https://")?;
    if rest.is_empty() || rest.contains(['?', '#', ' ', '@']) {
        return Err("invalid Cryptex server URL".into());
    }
    Ok(s.to_string())
}

/// Cryptex ids look like `abc-defg-hij` (lowercase letters and dashes).
pub fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn retention_ok(r: &str) -> bool {
    let (n, unit) = r.split_at(r.len().saturating_sub(1));
    let Ok(n) = n.parse::<u64>() else { return false };
    let mins = match unit { "m" => n, "h" => n * 60, "d" => n * 1440, _ => return false };
    n > 0 && mins <= 7 * 1440
}

fn agent(proxy: Option<&str>, timeout: Duration) -> Result<ureq::Agent, String> {
    let mut b = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(20)).timeout_read(timeout).timeout_write(timeout);
    if let Some(p) = crate::link_preview_proxy(proxy).map_err(|_| "unsupported proxy for large-file uploads".to_string())? {
        b = b.proxy(ureq::Proxy::new(&p).map_err(|_| "unsupported proxy for large-file uploads".to_string())?);
    }
    Ok(b.build())
}

fn with_key(req: ureq::Request, key: Option<&str>) -> ureq::Request {
    match key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => req.set("X-API-Key", k),
        None => req,
    }
}

/// Reads the reply body as JSON; a non-2xx reply becomes Err with the
/// server's `detail` (FastAPI style) when present.
fn json_reply(res: Result<ureq::Response, ureq::Error>) -> Result<serde_json::Value, String> {
    let (ok, resp) = match res {
        Ok(r) => (true, r),
        Err(ureq::Error::Status(code, r)) => {
            let mut body = Vec::new();
            let _ = r.into_reader().take(64 * 1024).read_to_end(&mut body);
            let detail = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
                .unwrap_or_else(|| format!("HTTP {code}"));
            return Err(detail);
        }
        Err(e) => return Err(format!("server not reachable: {e}")),
    };
    let _ = ok;
    let mut body = Vec::new();
    resp.into_reader().take(256 * 1024).read_to_end(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|_| "unexpected reply from the Cryptex server".to_string())
}

/// Multipart body parts around the file bytes (password and retention as
/// fields, one `file`).
pub fn multipart_parts(boundary: &str, name: &str, password: &str, retention: &str, autodestroy: bool) -> (Vec<u8>, Vec<u8>) {
    let safe_name: String = name.chars().map(|c| if c == '"' || c == '\r' || c == '\n' { '_' } else { c }).collect();
    let mut head = String::new();
    for (k, v) in [("password", password), ("retention", retention), ("autodestroy", if autodestroy { "true" } else { "false" })] {
        head.push_str(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n"));
    }
    head.push_str(&format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    ));
    (head.into_bytes(), format!("\r\n--{boundary}--\r\n").into_bytes())
}

struct CountingReader<R> {
    inner: R,
    prog: Arc<Progress>,
}
impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.prog.cancel.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"));
        }
        let n = self.inner.read(buf)?;
        self.prog.sent.fetch_add(n as u64, Ordering::SeqCst);
        Ok(n)
    }
}

#[allow(clippy::too_many_arguments)]
pub fn create_blocking(
    server: &str, key: Option<&str>, path: &std::path::Path, name: &str, password: &str,
    retention: &str, autodestroy: bool, proxy: Option<&str>, prog: Arc<Progress>,
) -> Result<serde_json::Value, String> {
    let base = base_url(server)?;
    if !retention_ok(retention) {
        return Err("retention must be 1m…7d".into());
    }
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_FILE {
        return Err("too large for Cryptex (max 1 GB)".into());
    }
    let boundary = format!("velta{}", hex(&crate::random_bytes::<12>()));
    let (head, tail) = multipart_parts(&boundary, name, password, retention, autodestroy);
    let total = head.len() as u64 + size + tail.len() as u64;
    prog.total.store(total, Ordering::SeqCst);
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let body = CountingReader { inner: std::io::Cursor::new(head).chain(file).chain(std::io::Cursor::new(tail)), prog: prog.clone() };
    let req = with_key(agent(proxy, Duration::from_secs(120))?.post(&format!("{base}/api/create")), key)
        .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
        .set("Content-Length", &total.to_string());
    let res = req.send(body);
    if prog.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    json_reply(res)
}

pub fn open_blocking(server: &str, key: Option<&str>, id: &str, password: &str, proxy: Option<&str>) -> Result<serde_json::Value, String> {
    let base = base_url(server)?;
    if !id_ok(id) {
        return Err("invalid Cryptex id".into());
    }
    json_reply(with_key(agent(proxy, Duration::from_secs(30))?.post(&format!("{base}/api/open")), key)
        .set("Content-Type", "application/json").send_string(&serde_json::json!({ "id": id, "password": password }).to_string()))
}

pub fn destroy_blocking(server: &str, key: Option<&str>, id: &str, password: &str, proxy: Option<&str>) -> Result<serde_json::Value, String> {
    let base = base_url(server)?;
    if !id_ok(id) {
        return Err("invalid Cryptex id".into());
    }
    json_reply(with_key(agent(proxy, Duration::from_secs(30))?.post(&format!("{base}/api/destroy")), key)
        .set("Content-Type", "application/json").send_string(&serde_json::json!({ "id": id, "password": password }).to_string()))
}

/// Presigned token -> file bytes into `out`. The server's own `url` field
/// is ignored: it has been seen pointing at http://…/api/api/download/…
/// (broken); the token on our known base is what works.
pub fn fetch_blocking(
    server: &str, key: Option<&str>, id: &str, password: &str, filename: &str,
    proxy: Option<&str>, out: &mut dyn Write,
) -> Result<u64, String> {
    let base = base_url(server)?;
    if !id_ok(id) {
        return Err("invalid Cryptex id".into());
    }
    let a = agent(proxy, Duration::from_secs(120))?;
    let tok = json_reply(with_key(a.post(&format!("{base}/api/download")), key)
        .set("Content-Type", "application/json").send_string(&serde_json::json!({ "cryptex_id": id, "filename": filename, "password": password }).to_string()))?;
    let token = tok.get("token").and_then(|t| t.as_str()).ok_or("no download token")?;
    if !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad download token".into());
    }
    let resp = a.get(&format!("{base}/api/download/{token}")).call().map_err(|e| format!("download failed: {e}"))?;
    let n = std::io::copy(&mut resp.into_reader().take(MAX_FILE + 1), out).map_err(|e| e.to_string())?;
    if n > MAX_FILE {
        return Err("download larger than 1 GB".into());
    }
    Ok(n)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A strong per-upload password: 24 random bytes, URL-safe (it rides in the
/// link fragment).
pub fn new_password() -> String {
    const A: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    crate::random_bytes::<24>().iter().map(|b| A[*b as usize % A.len()] as char).collect()
}

/// Saved-file name: no path separators or control characters.
pub fn safe_filename(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let s = s.trim().trim_start_matches('.').to_string();
    if s.is_empty() { "file".into() } else { s.chars().take(120).collect() }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cryptex_new_password() -> String {
    new_password()
}

/// Upload a file registered by lufi_open_file. `upload` is a caller-chosen
/// id for cryptex_progress / cryptex_cancel.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cryptex_create(
    server: String, key: Option<String>, handle: u64, upload: u64, password: String,
    retention: String, autodestroy: bool, proxy: Option<String>,
) -> Result<serde_json::Value, String> {
    let (path, _) = crate::lufi::registered_file(handle).ok_or("file is no longer open")?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let prog = Arc::new(Progress { sent: AtomicU64::new(0), total: AtomicU64::new(0), cancel: AtomicBool::new(false) });
    uploads().lock().unwrap().insert(upload, prog.clone());
    let r = blocking(move || create_blocking(&server, key.as_deref(), &path, &name, &password, &retention, autodestroy, proxy.as_deref(), prog)).await;
    uploads().lock().unwrap().remove(&upload);
    r
}

#[tauri::command]
pub fn cryptex_progress(upload: u64) -> (u64, u64) {
    uploads().lock().unwrap().get(&upload).map(|p| (p.sent.load(Ordering::SeqCst), p.total.load(Ordering::SeqCst))).unwrap_or((0, 0))
}

#[tauri::command]
pub fn cryptex_cancel(upload: u64) {
    if let Some(p) = uploads().lock().unwrap().get(&upload) {
        p.cancel.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn cryptex_open(server: String, key: Option<String>, id: String, password: String, proxy: Option<String>) -> Result<serde_json::Value, String> {
    blocking(move || open_blocking(&server, key.as_deref(), &id, &password, proxy.as_deref())).await
}

#[tauri::command]
pub async fn cryptex_destroy(server: String, key: Option<String>, id: String, password: String, proxy: Option<String>) -> Result<serde_json::Value, String> {
    blocking(move || destroy_blocking(&server, key.as_deref(), &id, &password, proxy.as_deref())).await
}

/// Download one file. Android: `dest` is the content:// URI from the save
/// dialog. Desktop: `dest` is ignored and the file lands in the user's
/// Downloads folder under a sanitized, non-clobbering name (no arbitrary
/// write path from the renderer). Returns the saved location.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cryptex_fetch(
    app: tauri::AppHandle, server: String, key: Option<String>, id: String, password: String,
    filename: String, dest: Option<String>, proxy: Option<String>,
) -> Result<String, String> {
    use tauri::Manager;
    #[cfg(target_os = "android")]
    {
        let uri = dest.filter(|d| d.starts_with("content://")).ok_or("pick where to save the file")?;
        let tmp = app.path().app_cache_dir().map_err(|e| e.to_string())?.join(format!("cryptex-{}", hex(&crate::random_bytes::<8>())));
        return blocking(move || {
            let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            let r = fetch_blocking(&server, key.as_deref(), &id, &password, &filename, proxy.as_deref(), &mut f)
                .and_then(|_| { drop(f); crate::copy_path_to_content_uri(&tmp, &uri) });
            let _ = std::fs::remove_file(&tmp);
            r.map(|_| uri)
        })
        .await;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = dest;
        let dir = app.path().download_dir().map_err(|e| e.to_string())?;
        blocking(move || {
            let name = safe_filename(&filename);
            let mut target = dir.join(&name);
            let mut i = 1;
            while target.exists() {
                let (stem, ext) = match name.rsplit_once('.') { Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")), _ => (name.clone(), String::new()) };
                target = dir.join(format!("{stem} ({i}){ext}"));
                i += 1;
            }
            let part = target.with_extension("part");
            let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            match fetch_blocking(&server, key.as_deref(), &id, &password, &filename, proxy.as_deref(), &mut f) {
                Ok(_) => { drop(f); std::fs::rename(&part, &target).map_err(|e| e.to_string())?; Ok(target.to_string_lossy().into_owned()) }
                Err(e) => { drop(f); let _ = std::fs::remove_file(&part); Err(e) }
            }
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_ids_retention() {
        assert_eq!(base_url("https://drop.gluek.info/").unwrap(), "https://drop.gluek.info");
        assert!(base_url("http://drop.gluek.info").is_err());
        assert!(base_url("https://a@b").is_err());
        assert!(id_ok("abc-defg-hij"));
        assert!(!id_ok("../x") && !id_ok(""));
        for ok in ["30m", "24h", "7d", "1d"] { assert!(retention_ok(ok), "{ok}"); }
        for bad in ["8d", "0d", "169h", "7w", "d", ""] { assert!(!retention_ok(bad), "{bad}"); }
    }

    #[test]
    fn multipart_shape_and_names() {
        let (h, t) = multipart_parts("B", "a\"b.txt", "pw", "7d", false);
        let h = String::from_utf8(h).unwrap();
        assert!(h.contains("name=\"password\"\r\n\r\npw\r\n"));
        assert!(h.contains("name=\"retention\"\r\n\r\n7d\r\n"));
        assert!(h.contains("filename=\"a_b.txt\""));
        assert_eq!(String::from_utf8(t).unwrap(), "\r\n--B--\r\n");
        assert_eq!(safe_filename("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_filename(""), "file");
        let p = new_password();
        assert_eq!(p.len(), 24);
        assert!(p.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    /// Live round trip: CRYPTEX_KEY_FILE=/path cargo test --lib cryptex -- --ignored
    /// (reads the key from that file at test time; never printed).
    #[test]
    #[ignore]
    fn live_round_trip() {
        let key = std::env::var("CRYPTEX_KEY_FILE").ok().and_then(|f| std::fs::read_to_string(f).ok()).map(|k| k.trim().to_string());
        let server = "https://drop.gluek.info";
        let dir = std::env::temp_dir().join("velta-cryptex-live");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("velta-live.bin");
        let data: Vec<u8> = crate::random_bytes::<64>().iter().cycle().take(4096).copied().collect();
        std::fs::write(&path, &data).unwrap();
        let pw = new_password();
        let prog = Arc::new(Progress { sent: AtomicU64::new(0), total: AtomicU64::new(0), cancel: AtomicBool::new(false) });
        let c = create_blocking(server, key.as_deref(), &path, "velta-live.bin", &pw, "30m", false, None, prog.clone()).unwrap();
        let id = c["id"].as_str().unwrap().to_string();
        assert_eq!(prog.sent.load(Ordering::SeqCst), prog.total.load(Ordering::SeqCst));
        // Receiver side: no API key.
        let o = open_blocking(server, None, &id, &pw, None).unwrap();
        assert_eq!(o["files"][0]["filename"], "velta-live.bin");
        let mut out = Vec::new();
        let fetched = fetch_blocking(server, None, &id, &pw, "velta-live.bin", None, &mut out);
        let destroyed = destroy_blocking(server, key.as_deref(), &id, &pw, None);
        assert_eq!(fetched.unwrap(), 4096);
        assert_eq!(out, data);
        destroyed.unwrap();
        assert!(open_blocking(server, None, &id, &pw, None).is_err(), "destroyed");
    }
}
