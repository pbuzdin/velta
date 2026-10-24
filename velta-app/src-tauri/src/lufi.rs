//! "Large file" (#138): the shell side of the Lufi client (app/js/lufi.js).
//!
//! The renderer does chunking + SJCL encryption (wire-compatible with the
//! Lufi web page); this module only moves bytes:
//! - reads slices of a user-picked file (registered handle, never an
//!   arbitrary path from the renderer);
//! - `/about/config` and the JSON delete route over ureq;
//! - a minimal blocking WebSocket client (RFC 6455, client side only) for
//!   `/upload`: one text frame out, one text frame back per slice.
//!
//! Network goes through the account proxy exactly like fetch_link_preview
//! (`link_preview_proxy`): SOCKS5 (remote DNS) or HTTP CONNECT, and FAILS
//! CLOSED — an unusable proxy is an Err, never a silent direct connection.
//! No new crates: rustls/webpki-roots/socks are what ureq already links.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub const SLICE: u64 = 750_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const IO_TIMEOUT: Duration = Duration::from_secs(180);
/// Server replies are small JSON; refuse anything absurd.
const MAX_REPLY: usize = 4 * 1024 * 1024;

pub(crate) trait Stream: Read + Write + Send {}
impl<T: Read + Write + Send> Stream for T {}

pub struct Ws {
    io: Box<dyn Stream>,
}

static NEXT: OnceLock<Mutex<u64>> = OnceLock::new();
static FILES: OnceLock<Mutex<HashMap<u64, (PathBuf, u64)>>> = OnceLock::new();
static SOCKETS: OnceLock<Mutex<HashMap<u64, Arc<Mutex<Ws>>>>> = OnceLock::new();

fn next_id() -> u64 {
    let mut n = NEXT.get_or_init(|| Mutex::new(0)).lock().unwrap();
    *n += 1;
    *n
}
fn files() -> &'static Mutex<HashMap<u64, (PathBuf, u64)>> {
    FILES.get_or_init(|| Mutex::new(HashMap::new()))
}
fn sockets() -> &'static Mutex<HashMap<u64, Arc<Mutex<Ws>>>> {
    SOCKETS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `https://host[:port][/path]` → (host, port, path-without-trailing-slash).
pub fn parse_server(server: &str) -> Result<(String, u16, String), String> {
    let rest = server
        .trim()
        .strip_prefix("https://")
        .ok_or_else(|| "the Lufi server must use https://".to_string())?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].trim_end_matches('/')),
        None => (rest, ""),
    };
    if authority.contains('@') || path.contains(['?', '#', ' ']) {
        return Err("invalid Lufi server URL".into());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().map_err(|_| "invalid port".to_string())?),
        None => (authority, 443),
    };
    let ok = |c: char| c.is_ascii_alphanumeric() || c == '.' || c == '-';
    if host.is_empty() || !host.chars().all(ok) {
        return Err("invalid Lufi server host".into());
    }
    Ok((host.to_ascii_lowercase(), port, path.to_string()))
}

fn ident_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// TCP to host:port, through the proxy when one is set (fail closed).
fn tcp_connect(host: &str, port: u16, proxy: Option<&str>) -> Result<TcpStream, String> {
    let proxy = crate::link_preview_proxy(proxy).map_err(|_| "unsupported proxy for large-file uploads".to_string())?;
    let tcp = match proxy {
        None => {
            let addrs: Vec<_> = (host, port).to_socket_addrs().map_err(|e| format!("DNS: {e}"))?.collect();
            let mut last = String::from("no address");
            let mut got = None;
            for a in addrs {
                match TcpStream::connect_timeout(&a, CONNECT_TIMEOUT) {
                    Ok(s) => { got = Some(s); break; }
                    Err(e) => last = e.to_string(),
                }
            }
            got.ok_or_else(|| format!("connect failed: {last}"))?
        }
        Some(p) => {
            let (scheme, rest) = p.split_once("://").unwrap_or(("", ""));
            let (creds, hostport) = match rest.rsplit_once('@') {
                Some((c, h)) => (Some(c), h),
                None => (None, rest),
            };
            let hostport = hostport.trim_end_matches('/');
            match scheme {
                "socks5" => {
                    let s = match creds.and_then(|c| c.split_once(':')) {
                        Some((u, pw)) => socks::Socks5Stream::connect_with_password(hostport, (host, port), u, pw),
                        None => socks::Socks5Stream::connect(hostport, (host, port)),
                    }
                    .map_err(|e| format!("proxy connect failed: {e}"))?;
                    s.into_inner()
                }
                "http" => {
                    let addr = hostport
                        .to_socket_addrs()
                        .map_err(|e| format!("proxy DNS: {e}"))?
                        .next()
                        .ok_or("proxy has no address")?;
                    let mut s = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| format!("proxy connect failed: {e}"))?;
                    s.set_read_timeout(Some(CONNECT_TIMEOUT)).ok();
                    let mut req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
                    if let Some(c) = creds {
                        req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", data_encoding::BASE64.encode(c.as_bytes())));
                    }
                    req.push_str("\r\n");
                    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
                    let head = read_head(&mut s)?;
                    let status = head.split_whitespace().nth(1).unwrap_or("");
                    if status != "200" {
                        return Err(format!("proxy refused CONNECT ({status})"));
                    }
                    s
                }
                _ => return Err("unsupported proxy for large-file uploads".into()),
            }
        }
    };
    tcp.set_read_timeout(Some(IO_TIMEOUT)).ok();
    tcp.set_write_timeout(Some(IO_TIMEOUT)).ok();
    tcp.set_nodelay(true).ok();
    Ok(tcp)
}

/// Read an HTTP response head (up to the blank line), byte by byte so no
/// frame data after it is swallowed.
pub(crate) fn read_head(s: &mut impl Read) -> Result<String, String> {
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if buf.len() > 16 * 1024 {
            return Err("response head too large".into());
        }
        let n = s.read(&mut b).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed".into());
        }
        buf.push(b[0]);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

pub(crate) fn tls(host: &str, tcp: TcpStream) -> Result<Box<dyn Stream>, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
    let conn = rustls::ClientConnection::new(Arc::new(cfg), name).map_err(|e| e.to_string())?;
    Ok(Box::new(rustls::StreamOwned::new(conn, tcp)))
}

pub fn ws_accept_key(key: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(key.as_bytes());
    h.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    data_encoding::BASE64.encode(&h.finalize())
}

/// Client frame: FIN + opcode, masked payload.
pub fn encode_frame(opcode: u8, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 14);
    out.push(0x80 | opcode);
    let n = payload.len();
    if n < 126 {
        out.push(0x80 | n as u8);
    } else if n <= 0xffff {
        out.push(0x80 | 126);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(n as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    out
}

/// One frame from the server: (fin, opcode, payload). Server frames are
/// unmasked, but a masked one is decoded anyway.
pub fn read_frame(s: &mut impl Read) -> Result<(bool, u8, Vec<u8>), String> {
    let mut h = [0u8; 2];
    s.read_exact(&mut h).map_err(|e| e.to_string())?;
    let fin = h[0] & 0x80 != 0;
    let op = h[0] & 0x0f;
    let masked = h[1] & 0x80 != 0;
    let mut len = (h[1] & 0x7f) as u64;
    if len == 126 {
        let mut b = [0u8; 2];
        s.read_exact(&mut b).map_err(|e| e.to_string())?;
        len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
        let mut b = [0u8; 8];
        s.read_exact(&mut b).map_err(|e| e.to_string())?;
        len = u64::from_be_bytes(b);
    }
    if len as usize > MAX_REPLY {
        return Err("reply too large".into());
    }
    let mut mask = [0u8; 4];
    if masked {
        s.read_exact(&mut mask).map_err(|e| e.to_string())?;
    }
    let mut p = vec![0u8; len as usize];
    s.read_exact(&mut p).map_err(|e| e.to_string())?;
    if masked {
        for (i, b) in p.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
    }
    Ok((fin, op, p))
}

impl Ws {
    pub fn connect(server: &str, proxy: Option<&str>) -> Result<Ws, String> {
        let (host, port, path) = parse_server(server)?;
        let tcp = tcp_connect(&host, port, proxy)?;
        let mut io = tls(&host, tcp)?;
        let key = data_encoding::BASE64.encode(&crate::random_bytes::<16>());
        let host_hdr = if port == 443 { host.clone() } else { format!("{host}:{port}") };
        let req = format!(
            "GET {path}/upload HTTP/1.1\r\nHost: {host_hdr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://{host_hdr}\r\nUser-Agent: Velta\r\n\r\n"
        );
        io.write_all(req.as_bytes()).map_err(|e| format!("TLS/handshake: {e}"))?;
        io.flush().ok();
        let head = read_head(&mut io)?;
        let first = head.lines().next().unwrap_or("");
        if first.split_whitespace().nth(1) != Some("101") {
            return Err(format!("WebSocket upgrade refused: {first}"));
        }
        let want = ws_accept_key(&key);
        let ok = head.lines().any(|l| {
            l.split_once(':')
                .map(|(k, v)| k.trim().eq_ignore_ascii_case("sec-websocket-accept") && v.trim() == want)
                .unwrap_or(false)
        });
        if !ok {
            return Err("WebSocket handshake: bad accept key".into());
        }
        Ok(Ws { io })
    }

    pub fn send_text(&mut self, text: &str) -> Result<(), String> {
        let f = encode_frame(0x1, text.as_bytes(), crate::random_bytes());
        self.io.write_all(&f).map_err(|e| format!("send: {e}"))?;
        self.io.flush().map_err(|e| format!("send: {e}"))
    }

    /// Next complete text message (pings answered, fragments joined).
    pub fn recv_text(&mut self) -> Result<String, String> {
        let mut msg = Vec::new();
        loop {
            let (fin, op, p) = read_frame(&mut self.io)?;
            match op {
                0x9 => {
                    let f = encode_frame(0xA, &p, crate::random_bytes());
                    self.io.write_all(&f).map_err(|e| e.to_string())?;
                    continue;
                }
                0xA => continue,
                0x8 => return Err("server closed the connection".into()),
                0x0..=0x2 => {
                    msg.extend_from_slice(&p);
                    if msg.len() > MAX_REPLY {
                        return Err("reply too large".into());
                    }
                    if fin {
                        return String::from_utf8(msg).map_err(|_| "reply is not UTF-8".to_string());
                    }
                }
                _ => return Err("unexpected WebSocket frame".into()),
            }
        }
    }

    pub fn close(&mut self) {
        let f = encode_frame(0x8, &1000u16.to_be_bytes(), crate::random_bytes());
        let _ = self.io.write_all(&f);
        let _ = self.io.flush();
    }
}

fn agent(proxy: Option<&str>) -> Result<ureq::Agent, String> {
    let mut b = ureq::AgentBuilder::new().timeout(Duration::from_secs(20));
    if let Some(p) = crate::link_preview_proxy(proxy).map_err(|_| "unsupported proxy for large-file uploads".to_string())? {
        b = b.proxy(ureq::Proxy::new(&p).map_err(|_| "unsupported proxy for large-file uploads".to_string())?);
    }
    Ok(b.build())
}

fn base_url(server: &str) -> Result<String, String> {
    let (host, port, path) = parse_server(server)?;
    Ok(if port == 443 { format!("https://{host}{path}") } else { format!("https://{host}:{port}{path}") })
}

// ---------- blocking cores (unit/live-testable without Tauri) ----------

pub fn config_blocking(server: &str, proxy: Option<&str>) -> Result<serde_json::Value, String> {
    let url = format!("{}/about/config", base_url(server)?);
    let resp = agent(proxy)?.get(&url).call().map_err(|e| format!("server not reachable: {e}"))?;
    let mut body = Vec::new();
    resp.into_reader().take(256 * 1024).read_to_end(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|_| "this server does not look like Lufi (no /about/config)".to_string())
}

pub fn delete_blocking(server: &str, short: &str, token: &str, proxy: Option<&str>) -> Result<serde_json::Value, String> {
    if !ident_ok(short) || !ident_ok(token) {
        return Err("invalid file id".into());
    }
    let url = format!("{}/d/{short}/{token}?_format=json", base_url(server)?);
    let resp = match agent(proxy)?.post(&url).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("server not reachable: {e}")),
    };
    let mut body = Vec::new();
    resp.into_reader().take(64 * 1024).read_to_end(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|_| "unexpected reply from the Lufi server".to_string())
}

pub fn read_slice_blocking(path: &std::path::Path, index: u64) -> Result<String, String> {
    use std::io::{Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(index * SLICE)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(SLICE as usize);
    f.take(SLICE).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(data_encoding::BASE64.encode(&buf))
}

// ---------- Tauri commands ----------

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Register a user-picked file (dialog result / resolve_content_uri copy)
/// for slice reads. Returns {handle, size, name}.
#[tauri::command]
pub async fn lufi_open_file(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    let p = PathBuf::from(&path);
    // V-07/#65: only user-picked files (or Velta's own copies) — see picked.rs.
    crate::picked::check(&app, &p)?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    let id = next_id();
    files().lock().unwrap().insert(id, (p.clone(), meta.len()));
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    Ok(serde_json::json!({ "handle": id, "size": meta.len(), "name": name }))
}

/// Base64 of slice `index` (750 000 bytes) of a registered file.
#[tauri::command]
pub async fn lufi_read_slice(handle: u64, index: u64) -> Result<String, String> {
    let (path, size) = files().lock().unwrap().get(&handle).cloned().ok_or("unknown file handle")?;
    if index * SLICE >= size.max(1) {
        return Err("slice out of range".into());
    }
    blocking(move || read_slice_blocking(&path, index)).await
}

#[tauri::command]
pub fn lufi_close_file(handle: u64) {
    files().lock().unwrap().remove(&handle);
}

#[tauri::command]
pub async fn lufi_config(server: String, proxy: Option<String>) -> Result<serde_json::Value, String> {
    blocking(move || config_blocking(&server, proxy.as_deref())).await
}

#[tauri::command]
pub async fn lufi_ws_open(server: String, proxy: Option<String>) -> Result<u64, String> {
    let ws = blocking(move || Ws::connect(&server, proxy.as_deref())).await?;
    let id = next_id();
    sockets().lock().unwrap().insert(id, Arc::new(Mutex::new(ws)));
    Ok(id)
}

/// Send one text frame and wait for the server's reply frame.
#[tauri::command]
pub async fn lufi_ws_send(id: u64, text: String) -> Result<String, String> {
    let ws = sockets().lock().unwrap().get(&id).cloned().ok_or("upload connection closed")?;
    blocking(move || {
        let mut ws = ws.lock().unwrap();
        ws.send_text(&text)?;
        ws.recv_text()
    })
    .await
}

#[tauri::command]
pub async fn lufi_ws_close(id: u64) -> Result<(), String> {
    let ws = sockets().lock().unwrap().remove(&id);
    if let Some(ws) = ws {
        // A send in flight holds the lock until its read times out; closing
        // the map entry is enough to make the next send fail.
        if let Ok(mut w) = ws.try_lock() {
            w.close();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn lufi_delete(server: String, short: String, token: String, proxy: Option<String>) -> Result<serde_json::Value, String> {
    blocking(move || delete_blocking(&server, &short, &token, proxy.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls() {
        assert_eq!(parse_server("https://upload.disroot.org").unwrap(), ("upload.disroot.org".into(), 443, "".into()));
        assert_eq!(parse_server("https://Host.example:8443/lufi/").unwrap(), ("host.example".into(), 8443, "/lufi".into()));
        assert!(parse_server("http://upload.disroot.org").is_err());
        assert!(parse_server("https://u:p@host").is_err());
        assert!(parse_server("https://host/a?x=1").is_err());
        assert!(parse_server("https://ho st").is_err());
    }

    #[test]
    fn accept_key_rfc6455_example() {
        assert_eq!(ws_accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn frames_roundtrip_all_length_forms() {
        for n in [0usize, 5, 125, 126, 65535, 65536, 1_000_000] {
            let payload: Vec<u8> = (0..n).map(|i| (i % 251) as u8).collect();
            let f = encode_frame(0x1, &payload, [1, 2, 3, 4]);
            let (fin, op, p) = read_frame(&mut &f[..]).unwrap();
            assert!(fin);
            assert_eq!(op, 1);
            assert_eq!(p, payload);
        }
    }

    #[test]
    fn proxy_fails_closed() {
        // Shadowsocks / https proxies can't be spoken: Err, never direct.
        assert!(tcp_connect("example.org", 443, Some("ss://abc@1.2.3.4:8388")).is_err());
        assert!(tcp_connect("example.org", 443, Some("https://proxy:1")).is_err());
        assert!(agent(Some("garbage")).is_err());
        // A dead SOCKS proxy is a transport error, not a fallback.
        assert!(tcp_connect("example.org", 443, Some("socks5://127.0.0.1:9")).is_err());
    }

    #[test]
    fn delete_rejects_bad_ids() {
        assert!(delete_blocking("https://upload.disroot.org", "../x", "t", None).is_err());
        assert!(delete_blocking("https://upload.disroot.org", "abc", "", None).is_err());
    }

    #[test]
    fn slices_are_base64_of_750k_windows() {
        let dir = std::env::temp_dir().join(format!("lufi-slice-{}", std::process::id()));
        let data: Vec<u8> = (0..1_600_000u32).map(|i| (i % 256) as u8).collect();
        std::fs::write(&dir, &data).unwrap();
        let s2 = data_encoding::BASE64.decode(read_slice_blocking(&dir, 2).unwrap().as_bytes()).unwrap();
        assert_eq!(s2, &data[1_500_000..]);
        let s0 = data_encoding::BASE64.decode(read_slice_blocking(&dir, 0).unwrap().as_bytes()).unwrap();
        assert_eq!(s0.len(), 750_000);
        std::fs::remove_file(&dir).ok();
    }

    /// Live: config, a real 1-slice upload (8 opaque bytes, not a file —
    /// the server stores ciphertext blindly), then the JSON delete route.
    /// `cargo test --lib lufi -- --ignored`. The full SJCL round trip
    /// through this client: examples/lufi-pipe.rs + docs/agents/large-file.md.
    #[test]
    #[ignore]
    fn live_disroot_upload_and_delete() {
        let server = "https://upload.disroot.org";
        let cfg = config_blocking(server, None).unwrap();
        assert!(cfg.get("max_delay").is_some());
        let mut ws = Ws::connect(server, None).unwrap();
        ws.send_text(r#"{"total":1,"part":0,"size":8,"name":"velta-live-test.bin","type":"","delay":1,"del_at_first_view":false,"zipped":false,"id":null,"i":0}XXMOJOXX"\"x\""#).unwrap();
        let reply: serde_json::Value = serde_json::from_str(&ws.recv_text().unwrap()).unwrap();
        ws.close();
        assert_eq!(reply["success"], true, "{reply}");
        let short = reply["short"].as_str().unwrap();
        let token = reply["token"].as_str().unwrap();
        let del = delete_blocking(server, short, token, None).unwrap();
        assert_eq!(del["success"], true, "{del}");
    }
}
