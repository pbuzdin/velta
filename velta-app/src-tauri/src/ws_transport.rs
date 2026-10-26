//! WebSocket transport (Android and Windows): a local SOCKS5 server on
//! 127.0.0.1 that carries each CONNECT through a Velta WebSocket proxy —
//! the same byte tunnel the PWA uses (tools/deploy-ws-proxy.sh):
//!
//! * `wss://<proxy>/dns/<host>` answers one text frame, a JSON array of IPs;
//! * `wss://<proxy>/tcp/<ip>/<port>` is a raw binary byte stream.
//!
//! The core reaches its relays through that SOCKS5 port via `proxy_url`,
//! exactly like the DNS tunnel (tunnel.rs), whose proxy keeper writes the
//! URL into every profile. Only one of the two is active at a time: turning
//! one on turns the other off (and if both were ever saved as active, the
//! DNS tunnel wins). A proxy the user set up themselves is never replaced.
//!
//! Invite auth: a proxy deployed with invites (the default) wants a signed
//! token from `deploy-ws-proxy.sh invite` on every handshake. It is stored
//! with the saved proxy and sent as `Sec-WebSocket-Protocol: velta.v1,
//! tok.<token>` (the PWA can only send subprotocols, so both use that, and
//! it never lands in access logs like a query string would). The app does
//! not verify tokens (it has no key); it checks their shape only. A 401 at
//! the handshake surfaces as "invite refused".
//!
//! Device caps: an invite minted with `--uses N` admits N devices. Next to
//! the token the app offers `dev.<id>`, a random id kept per proxy URL in
//! the store's `devices` map (stable across restarts, reconnects and a
//! delete + re-add, different for each proxy). A full invite answers 403
//! with `X-Velta-Refusal: device-limit`.
//!
//! Nothing is logged about credentials, tokens, hosts beyond the proxy's own name,
//! or payload bytes.

#![cfg_attr(not(any(target_os = "android", windows)), allow(dead_code))]

use serde_json::Value;

/// Saved proxies (`ws_transport.json` in the app data dir).
pub const FILE: &str = "ws_transport.json";
/// Every proxy URL this module writes starts with this (see tunnel.rs).
pub const OURS: &str = "socks5://velta-ws:";
pub const LABEL_MAX: usize = 64;
pub const URL_MAX: usize = 512;
pub const MAX_PROXIES: usize = 20;
pub const TOKEN_MAX: usize = 1024;
pub const SUBPROTOCOL: &str = "velta.v1";

/// Shape check (mirrors validWsToken in ws-transport.js):
/// base64url payload "." base64url 32-byte HMAC.
pub fn valid_token(t: &str) -> bool {
    let b64 = |s: &str| s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
    t.len() <= TOKEN_MAX && t.split_once('.').is_some_and(|(p, sig)| p.len() >= 4 && b64(p) && sig.len() == 43 && b64(sig))
}

/// Device id shape (mirrors validWsDevice in ws-relays.js and the bridge).
pub fn valid_device(d: &str) -> bool {
    (16..=64).contains(&d.len()) && d.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// The handshake's extra header line ("" without a token). The device id
/// rides along only with a token: proxies without invites never see it.
pub fn auth_header(token: Option<&str>, device: Option<&str>) -> String {
    match token.filter(|t| valid_token(t)) {
        Some(t) => match device.filter(|d| valid_device(d)) {
            Some(d) => format!("Sec-WebSocket-Protocol: {SUBPROTOCOL}, tok.{t}, dev.{d}\r\n"),
            None => format!("Sec-WebSocket-Protocol: {SUBPROTOCOL}, tok.{t}\r\n"),
        },
        None => String::new(),
    }
}

pub const DEVICE_LIMIT: &str = "invite device limit (403): this invite has reached its device limit";

/// Error text for a refused upgrade (`head`: status line and headers);
/// 401 means the invite, 403 + X-Velta-Refusal: device-limit a full one.
pub fn refusal_text(head: &str) -> String {
    let status_line = head.lines().next().unwrap_or("");
    let code = status_line.split_whitespace().nth(1);
    if code == Some("401") {
        return "invite refused (401): invalid, expired or revoked".into();
    }
    let limit = head.lines().any(|l| l.split_once(':').is_some_and(|(k, v)| k.trim().eq_ignore_ascii_case("x-velta-refusal") && v.trim() == "device-limit"));
    if code == Some("403") && limit {
        return DEVICE_LIMIT.into();
    }
    format!("proxy refused the WebSocket: {}", status_line.chars().take(60).collect::<String>())
}

/// A parsed WebSocket proxy base URL.
#[derive(Debug, Clone, PartialEq)]
pub struct ProxyUrl {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    /// "" or "/base" (no trailing slash).
    pub base: String,
}

fn valid_dns_name(h: &str) -> bool {
    h.len() <= 253
        && h.contains('.')
        && h.split('.').all(|l| {
            !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn is_loopback_name(h: &str) -> bool {
    h == "localhost" || h.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Strict: `wss://host[:port][/path]`, no credentials, query or fragment.
/// Plain `ws://` only for a loopback proxy (local testing). A bare host
/// means `wss://host`.
pub fn parse_proxy_url(raw: &str) -> Result<ProxyUrl, String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > URL_MAX {
        return Err("Enter the proxy address".into());
    }
    if s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The address contains spaces".into());
    }
    let lower = s.to_ascii_lowercase();
    let (tls, rest) = if let Some(r) = lower.strip_prefix("wss://") {
        (true, r)
    } else if let Some(r) = lower.strip_prefix("ws://") {
        (false, r)
    } else if lower.contains("://") {
        return Err("Only wss:// addresses are supported".into());
    } else {
        (true, lower.as_str())
    };
    if rest.contains(['?', '#', '@', '\\']) {
        return Err("The address must not contain credentials, ? or #".into());
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].trim_end_matches('/')),
        None => (rest, ""),
    };
    if !path.is_empty() && !path.bytes().all(|b| b.is_ascii_alphanumeric() || b"/-._~".contains(&b)) || path.contains("//") || path.contains("/../") || path.ends_with("/..") {
        return Err("Bad path in the address".into());
    }
    let (host, port) = if let Some(r) = authority.strip_prefix('[') {
        let (h, p) = r.split_once(']').ok_or("Bad address")?;
        (h.to_string(), p)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), if p.is_empty() { ":" } else { &authority[h.len()..] }),
            None => (authority.to_string(), ""),
        }
    };
    let port = match port {
        "" => if tls { 443 } else { 80 },
        p => p.strip_prefix(':').and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0).ok_or("Bad port")?,
    };
    let host = host.trim_end_matches('.').to_string();
    let ip_ok = host.parse::<std::net::IpAddr>().is_ok();
    if !(ip_ok || valid_dns_name(&host) || host == "localhost") {
        return Err("Bad host name".into());
    }
    if !tls && !is_loopback_name(&host) {
        return Err("Only wss:// addresses are supported".into());
    }
    Ok(ProxyUrl { tls, host, port, base: path.to_string() })
}

impl ProxyUrl {
    /// Canonical form, as stored and shown.
    pub fn to_url(&self) -> String {
        let scheme = if self.tls { "wss" } else { "ws" };
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        let default = if self.tls { 443 } else { 80 };
        let port = if self.port == default { String::new() } else { format!(":{}", self.port) };
        format!("{scheme}://{host}{port}{}", self.base)
    }
    pub fn host_header(&self) -> String {
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        if self.port == if self.tls { 443 } else { 80 } { host } else { format!("{host}:{}", self.port) }
    }
    pub fn dns_path(&self, host: &str) -> String {
        format!("{}/dns/{}", self.base, host.trim_end_matches('.').to_ascii_lowercase())
    }
    pub fn tcp_path(&self, ip: std::net::IpAddr, port: u16) -> String {
        // The bridge takes the bare address (no brackets for IPv6).
        format!("{}/tcp/{ip}/{port}", self.base)
    }
}

/// What a SOCKS5 CONNECT asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Ip(std::net::IpAddr, u16),
    Name(String, u16),
}

/// SOCKS5 parse errors carry the reply code to send.
pub mod socks {
    use super::Target;
    pub const REP_GENERAL: u8 = 1;
    pub const REP_HOST_UNREACHABLE: u8 = 4;
    pub const REP_CMD_UNSUPPORTED: u8 = 7;
    pub const REP_ATYP_UNSUPPORTED: u8 = 8;

    /// Greeting: VER NMETHODS METHODS…; true when user/pass (0x02) is offered.
    pub fn greeting_offers_userpass(b: &[u8]) -> Result<bool, &'static str> {
        if b.len() < 2 || b[0] != 5 {
            return Err("not SOCKS5");
        }
        let n = b[1] as usize;
        if n == 0 || b.len() != 2 + n {
            return Err("bad greeting");
        }
        Ok(b[2..].contains(&2))
    }

    /// RFC 1929: VER(1) ULEN USER PLEN PASS → (user, pass).
    pub fn parse_userpass(b: &[u8]) -> Result<(&[u8], &[u8]), &'static str> {
        if b.len() < 3 || b[0] != 1 {
            return Err("bad auth");
        }
        let ul = b[1] as usize;
        let u = b.get(2..2 + ul).ok_or("bad auth")?;
        let pl = *b.get(2 + ul).ok_or("bad auth")? as usize;
        let p = b.get(3 + ul..3 + ul + pl).ok_or("bad auth")?;
        if b.len() != 3 + ul + pl {
            return Err("bad auth");
        }
        Ok((u, p))
    }

    /// Request: VER CMD RSV ATYP ADDR PORT. Err is the reply code.
    pub fn parse_request(b: &[u8]) -> Result<Target, u8> {
        if b.len() < 4 || b[0] != 5 || b[2] != 0 {
            return Err(REP_GENERAL);
        }
        if b[1] != 1 {
            return Err(REP_CMD_UNSUPPORTED);
        }
        let port_at = |i: usize| -> Result<u16, u8> {
            if b.len() != i + 2 {
                return Err(REP_GENERAL);
            }
            Ok(u16::from_be_bytes([b[i], b[i + 1]]))
        };
        match b[3] {
            1 => {
                let a: [u8; 4] = b.get(4..8).ok_or(REP_GENERAL)?.try_into().unwrap();
                Ok(Target::Ip(std::net::Ipv4Addr::from(a).into(), port_at(8)?))
            }
            4 => {
                let a: [u8; 16] = b.get(4..20).ok_or(REP_GENERAL)?.try_into().unwrap();
                Ok(Target::Ip(std::net::Ipv6Addr::from(a).into(), port_at(20)?))
            }
            3 => {
                let n = *b.get(4).ok_or(REP_GENERAL)? as usize;
                let name = b.get(5..5 + n).ok_or(REP_GENERAL)?;
                let name = std::str::from_utf8(name).map_err(|_| REP_GENERAL)?.trim_end_matches('.').to_ascii_lowercase();
                let port = port_at(5 + n)?;
                if let Ok(ip) = name.parse::<std::net::IpAddr>() {
                    return Ok(Target::Ip(ip, port));
                }
                if !super::valid_dns_name(&name) {
                    return Err(REP_HOST_UNREACHABLE);
                }
                Ok(Target::Name(name, port))
            }
            _ => Err(REP_ATYP_UNSUPPORTED),
        }
    }

    /// Length of a complete request in `b`, or None while more is needed.
    pub fn request_len(b: &[u8]) -> Option<usize> {
        let base = match *b.get(3)? {
            1 => 4 + 4,
            4 => 4 + 16,
            3 => 5 + *b.get(4)? as usize,
            _ => return Some(b.len()),
        };
        (b.len() >= base + 2).then_some(base + 2)
    }

    /// Reply with a zero bound address.
    pub fn reply(code: u8) -> [u8; 10] {
        [5, code, 0, 1, 0, 0, 0, 0, 0, 0]
    }
}

/// RFC 6455 accept key.
pub fn ws_accept_key(key: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(key.as_bytes());
    h.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    data_encoding::BASE64.encode(&h.finalize())
}

/// Masked client frame header + payload.
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

/// The `/dns/` answer: a JSON array of IP strings (bad entries skipped).
pub fn parse_dns_answer(text: &str) -> Result<Vec<std::net::IpAddr>, String> {
    let v: Value = serde_json::from_str(text).map_err(|_| "bad DNS answer".to_string())?;
    let arr = v.as_array().ok_or("bad DNS answer")?;
    Ok(arr.iter().filter_map(|x| x.as_str()?.parse().ok()).take(16).collect())
}

/// The saved proxies: {"active": id|null, "proxies": [{id,label,url,added}],
/// "pass": "…", "listen": "127.0.0.1:port"}. Pure, unit-tested.
pub mod store {
    use serde_json::{json, Value};

    pub fn empty() -> Value {
        json!({"active": null, "proxies": []})
    }
    pub fn proxies(st: &Value) -> &[Value] {
        st["proxies"].as_array().map_or(&[], |a| a.as_slice())
    }
    pub fn find<'a>(st: &'a Value, id: &str) -> Option<&'a Value> {
        proxies(st).iter().find(|p| p["id"].as_str() == Some(id))
    }
    pub fn active_id(st: &Value) -> Option<&str> {
        let id = st["active"].as_str()?;
        find(st, id).map(|_| id)
    }
    pub fn clean_label(l: &str) -> String {
        l.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(super::LABEL_MAX).collect()
    }
    /// Adds (or finds, same canonical URL) a proxy. Returns (id, existing).
    /// A token given for an existing proxy replaces its saved one (a new invite).
    pub fn add(st: &mut Value, url: &str, label: &str, token: Option<&str>, id: String, now: u64) -> Result<(String, bool), String> {
        let canon = super::parse_proxy_url(url)?.to_url();
        let token = token.map(str::trim).filter(|t| !t.is_empty());
        if token.is_some_and(|t| !super::valid_token(t)) {
            return Err("The invite is damaged".into());
        }
        if let Some(p) = st["proxies"].as_array_mut().and_then(|a| a.iter_mut().find(|p| p["url"].as_str() == Some(&canon))) {
            if let Some(t) = token {
                p["token"] = Value::from(t);
            }
            return Ok((p["id"].as_str().unwrap_or_default().to_string(), true));
        }
        if proxies(st).len() >= super::MAX_PROXIES {
            return Err("Too many saved proxies".into());
        }
        if !st["proxies"].is_array() {
            st["proxies"] = json!([]);
        }
        let mut p = json!({"id": id, "label": clean_label(label), "url": canon, "added": now});
        if let Some(t) = token {
            p["token"] = Value::from(t);
        }
        st["proxies"].as_array_mut().unwrap().push(p);
        Ok((id, false))
    }
    pub fn select(st: &mut Value, id: Option<&str>) -> Result<(), String> {
        if let Some(id) = id {
            find(st, id).ok_or("No such proxy")?;
        }
        st["active"] = id.map_or(Value::Null, Value::from);
        Ok(())
    }
    /// Returns whether the deleted one was active.
    pub fn delete(st: &mut Value, id: &str) -> Result<bool, String> {
        let arr = st["proxies"].as_array_mut().ok_or("No such proxy")?;
        let before = arr.len();
        arr.retain(|p| p["id"].as_str() != Some(id));
        if arr.len() == before {
            return Err("No such proxy".into());
        }
        let was = st["active"].as_str() == Some(id);
        if was {
            st["active"] = Value::Null;
        }
        Ok(was)
    }
    /// This install's device id for a proxy URL (canonical form), created
    /// with `fresh` on first use. Kept outside the proxy entries so that a
    /// delete + re-add of the same proxy does not count as a new device.
    pub fn device(st: &mut Value, url: &str, fresh: impl FnOnce() -> String) -> Result<String, String> {
        let canon = super::parse_proxy_url(url)?.to_url();
        if !st["devices"].is_object() {
            st["devices"] = json!({});
        }
        if let Some(d) = st["devices"][&canon].as_str().filter(|d| super::valid_device(d)) {
            return Ok(d.to_string());
        }
        let d = fresh();
        st["devices"][&canon] = Value::from(d.clone());
        Ok(d)
    }
    /// The saved invite token of a proxy, if any.
    pub fn token<'a>(st: &'a Value, id: &str) -> Option<&'a str> {
        find(st, id)?["token"].as_str().filter(|t| super::valid_token(t))
    }
    /// For the page: never the SOCKS password or port. Tokens are included:
    /// the page needs them for Share and Test.
    pub fn public_list(st: &Value) -> Value {
        json!({"active": active_id(st), "proxies": proxies(st)})
    }
}

#[cfg(any(target_os = "android", windows, test))]
mod imp {
    use super::*;
    use std::net::{IpAddr, SocketAddr};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_util::sync::CancellationToken;

    pub const MAX_CONNS: usize = 64;
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
    const DNS_CACHE: Duration = Duration::from_secs(300);
    const MAX_FRAME: u64 = 1 << 20;

    pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
    impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

    fn tls_config() -> Arc<rustls::ClientConfig> {
        static CFG: std::sync::OnceLock<Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
        CFG.get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let mut cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("rustls protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
            Arc::new(cfg)
        })
        .clone()
    }

    /// Opens a WebSocket to `path` on the proxy (TLS for wss) and completes
    /// the upgrade. Times out after CONNECT_TIMEOUT.
    pub async fn ws_connect(p: &ProxyUrl, path: &str, token: Option<&str>, device: Option<&str>) -> Result<Box<dyn Io>, String> {
        tokio::time::timeout(CONNECT_TIMEOUT, async {
            let tcp = TcpStream::connect((p.host.as_str(), p.port)).await.map_err(|e| format!("can't reach the proxy: {}", e.kind()))?;
            let _ = tcp.set_nodelay(true);
            let mut io: Box<dyn Io> = if p.tls {
                let name = rustls::pki_types::ServerName::try_from(p.host.clone()).map_err(|e| e.to_string())?;
                let s = tokio_rustls::TlsConnector::from(tls_config()).connect(name, tcp).await.map_err(|e| format!("TLS: {e}"))?;
                Box::new(s)
            } else {
                Box::new(tcp)
            };
            let key = data_encoding::BASE64.encode(&crate::random_bytes::<16>());
            let host = p.host_header();
            let auth = auth_header(token, device);
            let req = format!(
                "GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n{auth}User-Agent: Velta\r\n\r\n"
            );
            io.write_all(req.as_bytes()).await.map_err(|e| format!("handshake: {}", e.kind()))?;
            io.flush().await.ok();
            let mut head = Vec::new();
            let mut b = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if head.len() > 8192 || io.read(&mut b).await.map_err(|e| e.to_string())? == 0 {
                    return Err("proxy closed the handshake".to_string());
                }
                head.push(b[0]);
            }
            let head = String::from_utf8_lossy(&head);
            let first = head.lines().next().unwrap_or("");
            if first.split_whitespace().nth(1) != Some("101") {
                return Err(refusal_text(&head));
            }
            let want = ws_accept_key(&key);
            let ok = head.lines().any(|l| l.split_once(':').is_some_and(|(k, v)| k.trim().eq_ignore_ascii_case("sec-websocket-accept") && v.trim() == want));
            if !ok {
                return Err("WebSocket handshake: bad accept key".into());
            }
            Ok(io)
        })
        .await
        .map_err(|_| "proxy timed out".to_string())?
    }

    /// One frame: (fin, opcode, payload).
    pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<(bool, u8, Vec<u8>)> {
        let mut h = [0u8; 2];
        r.read_exact(&mut h).await?;
        let mut len = (h[1] & 0x7f) as u64;
        if len == 126 {
            len = r.read_u16().await? as u64;
        } else if len == 127 {
            len = r.read_u64().await?;
        }
        if len > MAX_FRAME {
            return Err(std::io::Error::other("frame too large"));
        }
        let mut mask = [0u8; 4];
        if h[1] & 0x80 != 0 {
            r.read_exact(&mut mask).await?;
        }
        let mut p = vec![0u8; len as usize];
        r.read_exact(&mut p).await?;
        if h[1] & 0x80 != 0 {
            p.iter_mut().enumerate().for_each(|(i, b)| *b ^= mask[i % 4]);
        }
        Ok((h[0] & 0x80 != 0, h[0] & 0x0f, p))
    }

    /// `/dns/<host>` on the proxy → IPs.
    pub async fn resolve(p: &ProxyUrl, host: &str, token: Option<&str>, device: Option<&str>) -> Result<Vec<IpAddr>, String> {
        let mut ws = ws_connect(p, &p.dns_path(host), token, device).await?;
        let mut msg = Vec::new();
        let r = tokio::time::timeout(CONNECT_TIMEOUT, async {
            loop {
                let (fin, op, data) = read_frame(&mut ws).await.map_err(|e| e.to_string())?;
                match op {
                    0x0..=0x2 => {
                        msg.extend_from_slice(&data);
                        if fin {
                            return Ok::<_, String>(());
                        }
                    }
                    0x8 => return Err("proxy closed without an answer".into()),
                    _ => {}
                }
            }
        })
        .await;
        r.map_err(|_| "DNS answer timed out".to_string())??;
        let _ = ws.write_all(&encode_frame(0x8, &1000u16.to_be_bytes(), crate::random_bytes())).await;
        parse_dns_answer(&String::from_utf8_lossy(&msg))
    }

    /// Pipes a SOCKS client socket and a `/tcp/` WebSocket until either
    /// side closes or `stop` fires.
    async fn pipe(client: TcpStream, ws: Box<dyn Io>, stop: CancellationToken) {
        let (mut cr, mut cw) = client.into_split();
        let (mut wr, ww) = tokio::io::split(ws);
        let ww = Arc::new(tokio::sync::Mutex::new(ww));
        let ww2 = ww.clone();
        let up = async move {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                let n = cr.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    let _ = ww2.lock().await.write_all(&encode_frame(0x8, &1000u16.to_be_bytes(), crate::random_bytes())).await;
                    return;
                }
                if ww2.lock().await.write_all(&encode_frame(0x2, &buf[..n], crate::random_bytes())).await.is_err() {
                    return;
                }
            }
        };
        let down = async move {
            loop {
                let Ok((_, op, data)) = read_frame(&mut wr).await else { return };
                match op {
                    0x0..=0x2 => {
                        if cw.write_all(&data).await.is_err() {
                            return;
                        }
                    }
                    0x9 => {
                        let _ = ww.lock().await.write_all(&encode_frame(0xA, &data, crate::random_bytes())).await;
                    }
                    0x8 => return,
                    _ => {}
                }
            }
        };
        tokio::select! {
            _ = up => {}
            _ = down => {}
            _ = stop.cancelled() => {}
        }
    }

    pub struct Server {
        pub addr: SocketAddr,
        stop: CancellationToken,
    }

    impl Server {
        pub fn stop(&self) {
            self.stop.cancel();
        }
    }

    struct Ctx {
        proxy: ProxyUrl,
        token: Option<String>,
        device: Option<String>,
        user: String,
        pass: String,
        cache: Mutex<std::collections::HashMap<String, (std::time::Instant, Vec<IpAddr>)>>,
        sem: Arc<tokio::sync::Semaphore>,
    }

    fn ct_eq(a: &[u8], b: &[u8]) -> bool {
        a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }

    async fn read_some(s: &mut TcpStream, buf: &mut Vec<u8>, done: impl Fn(&[u8]) -> Option<usize>) -> Result<Vec<u8>, ()> {
        loop {
            if let Some(n) = done(buf) {
                return Ok(buf.drain(..n).collect());
            }
            if buf.len() > 600 {
                return Err(());
            }
            let mut b = [0u8; 512];
            let n = s.read(&mut b).await.map_err(|_| ())?;
            if n == 0 {
                return Err(());
            }
            buf.extend_from_slice(&b[..n]);
        }
    }

    async fn handle(ctx: Arc<Ctx>, mut s: TcpStream, stop: CancellationToken) -> Result<(), ()> {
        let _ = s.set_nodelay(true);
        let mut buf = Vec::new();
        let g = read_some(&mut s, &mut buf, |b| (b.len() >= 2 && b.len() >= 2 + b[1] as usize).then(|| 2 + b[1] as usize)).await?;
        if !socks::greeting_offers_userpass(&g).map_err(|_| ())? {
            let _ = s.write_all(&[5, 0xff]).await;
            return Err(());
        }
        s.write_all(&[5, 2]).await.map_err(|_| ())?;
        let a = read_some(&mut s, &mut buf, |b| {
            let ul = *b.get(1)? as usize;
            let pl = *b.get(2 + ul)? as usize;
            (b.len() >= 3 + ul + pl).then_some(3 + ul + pl)
        })
        .await?;
        let (u, p) = socks::parse_userpass(&a).map_err(|_| ())?;
        if !(ct_eq(u, ctx.user.as_bytes()) & ct_eq(p, ctx.pass.as_bytes())) {
            let _ = s.write_all(&[1, 1]).await;
            return Err(());
        }
        s.write_all(&[1, 0]).await.map_err(|_| ())?;
        let req = read_some(&mut s, &mut buf, socks::request_len).await?;
        let target = match socks::parse_request(&req) {
            Ok(t) => t,
            Err(code) => {
                let _ = s.write_all(&socks::reply(code)).await;
                return Err(());
            }
        };
        let (ips, port) = match target {
            Target::Ip(ip, port) => (vec![ip], port),
            Target::Name(name, port) => {
                let cached = ctx.cache.lock().unwrap().get(&name).filter(|(t, _)| t.elapsed() < DNS_CACHE).map(|(_, v)| v.clone());
                let ips = match cached {
                    Some(v) => v,
                    None => match resolve(&ctx.proxy, &name, ctx.token.as_deref(), ctx.device.as_deref()).await {
                        Ok(v) if !v.is_empty() => {
                            ctx.cache.lock().unwrap().insert(name, (std::time::Instant::now(), v.clone()));
                            v
                        }
                        _ => vec![],
                    },
                };
                (ips, port)
            }
        };
        let mut ws = None;
        for ip in ips.iter().take(4) {
            if let Ok(w) = ws_connect(&ctx.proxy, &ctx.proxy.tcp_path(*ip, port), ctx.token.as_deref(), ctx.device.as_deref()).await {
                ws = Some(w);
                break;
            }
        }
        let Some(ws) = ws else {
            let _ = s.write_all(&socks::reply(socks::REP_HOST_UNREACHABLE)).await;
            return Err(());
        };
        s.write_all(&socks::reply(0)).await.map_err(|_| ())?;
        // Bytes the client sent after the request (none for IMAP/SMTP) go first.
        let mut ww = ws;
        if !buf.is_empty() {
            ww.write_all(&encode_frame(0x2, &buf, crate::random_bytes())).await.map_err(|_| ())?;
        }
        pipe(s, ww, stop).await;
        Ok(())
    }

    /// Starts the SOCKS5 server on `listen` ("127.0.0.1:0" for a random port).
    pub async fn start(proxy: ProxyUrl, token: Option<String>, device: Option<String>, user: String, pass: String, listen: &str) -> Result<Server, String> {
        let l = match TcpListener::bind(listen).await {
            Ok(l) => l,
            Err(_) => TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?,
        };
        let addr = l.local_addr().map_err(|e| e.to_string())?;
        if !addr.ip().is_loopback() {
            return Err("listen address must be loopback".into());
        }
        let stop = CancellationToken::new();
        let ctx = Arc::new(Ctx { proxy, token, device, user, pass, cache: Mutex::new(Default::default()), sem: Arc::new(tokio::sync::Semaphore::new(MAX_CONNS)) });
        let st = stop.clone();
        let fut = async move {
            loop {
                let accepted = tokio::select! {
                    _ = st.cancelled() => return,
                    a = l.accept() => a,
                };
                let Ok((s, _)) = accepted else {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                };
                let Ok(permit) = ctx.sem.clone().try_acquire_owned() else {
                    drop(s); // over the limit: the core retries later
                    continue;
                };
                let (ctx, st) = (ctx.clone(), st.clone());
                spawn(async move {
                    let _ = handle(ctx, s, st).await;
                    drop(permit);
                });
            }
        };
        spawn(fut);
        Ok(Server { addr, stop })
    }

    #[cfg(not(test))]
    fn spawn(f: impl std::future::Future<Output = ()> + Send + 'static) {
        tauri::async_runtime::spawn(f);
    }
    #[cfg(test)]
    fn spawn(f: impl std::future::Future<Output = ()> + Send + 'static) {
        tokio::spawn(f);
    }
}

#[cfg(test)]
pub use imp::{resolve, start};

/// The app side: saved list, the running server, the proxy keeper hook.
#[cfg(any(target_os = "android", windows))]
mod app {
    use super::*;
    use std::sync::Mutex;

    static SERVER: Mutex<Option<imp::Server>> = Mutex::new(None);
    /// Serializes start/stop/select. Never held while calling into tunnel.rs.
    static OP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn log(msg: &str) {
        crate::log(&format!("ws transport: {msg}"));
    }
    fn path(app: &crate::Host) -> Option<std::path::PathBuf> {
        app.data_dir().map(|d| d.join(FILE))
    }
    pub fn load(app: &crate::Host) -> Value {
        path(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(Value::is_object)
            .unwrap_or_else(store::empty)
    }
    fn save(app: &crate::Host, st: &Value) -> Result<(), String> {
        let p = path(app).ok_or("no app data dir")?;
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, st.to_string()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
    }
    fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
    }
    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
    /// 128 random bits, base64url (22 chars).
    fn new_device() -> String {
        data_encoding::BASE64URL_NOPAD.encode(&crate::random_bytes::<16>())
    }
    /// The device id for `url`, saving a new one (for the Test button).
    pub async fn device_for(app: &crate::Host, url: &str) -> Result<String, String> {
        let _g = OP.lock().await;
        let mut st = load(app);
        let had = st["devices"].clone();
        let d = store::device(&mut st, url, new_device)?;
        if st["devices"] != had {
            save(app, &st)?;
        }
        Ok(d)
    }

    fn stop_server() {
        if let Some(s) = SERVER.lock().unwrap().take() {
            s.stop();
        }
    }

    /// Starts the active proxy's server and points the profiles at it.
    async fn start_active(app: &crate::Host, st: &mut Value) -> Result<(), String> {
        stop_server();
        let Some(id) = store::active_id(st).map(str::to_string) else {
            crate::tunnel::set_ws_proxy(None);
            return Ok(());
        };
        let url = store::find(st, &id).and_then(|p| p["url"].as_str()).unwrap_or_default().to_string();
        let url = url.as_str();
        let proxy = parse_proxy_url(url)?;
        let token = store::token(st, &id).map(str::to_string);
        let device = store::device(st, url, new_device)?;
        // Port and password belong to the list: switching proxies keeps
        // the profiles' proxy_url unchanged.
        if st["pass"].as_str().is_none_or(|p| p.len() < 16) {
            st["pass"] = Value::from(hex(&crate::random_bytes::<16>()));
        }
        let pass = st["pass"].as_str().unwrap_or_default().to_string();
        let listen = st["listen"].as_str().unwrap_or("127.0.0.1:0").to_string();
        let server = imp::start(proxy.clone(), token, Some(device), "velta-ws".into(), pass.clone(), &listen).await?;
        let addr = server.addr;
        st["listen"] = Value::from(addr.to_string());
        save(app, st)?;
        *SERVER.lock().unwrap() = Some(server);
        log(&format!("started on {addr} via {}", proxy.host));
        crate::tunnel::set_ws_proxy(Some(format!("{OURS}{pass}@{addr}")));
        Ok(())
    }

    /// Health check every minute: the local server must accept connections;
    /// one that died in the background is restarted (audit item 5).
    fn start_keeper(app: crate::Host) {
        static KEEPER: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        KEEPER.get_or_init(|| {
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    health(&app).await;
                }
            });
        });
    }

    async fn health(app: &crate::Host) {
        let addr = SERVER.lock().unwrap().as_ref().map(|s| s.addr);
        let Some(addr) = addr else { return };
        let alive = tokio::time::timeout(std::time::Duration::from_secs(2), tokio::net::TcpStream::connect(addr))
            .await
            .is_ok_and(|r| r.is_ok());
        if alive {
            return;
        }
        log(&format!("local server not answering on {addr}; restarting it"));
        let _g = OP.lock().await;
        let mut st = load(app);
        if store::active_id(&st).is_some() {
            if let Err(e) = start_active(app, &mut st).await {
                log(&format!("restart failed: {e}"));
            }
        }
    }

    pub async fn boot(app: &crate::Host) {
        start_keeper(app.clone());
        let _g = OP.lock().await;
        let mut st = load(app);
        if store::active_id(&st).is_none() {
            return;
        }
        if crate::tunnel::dns_tunnel_active(app) {
            // Both saved as active (older build): the DNS tunnel wins.
            let _ = store::select(&mut st, None);
            let _ = save(app, &st);
            log("DNS tunnel is in use; WebSocket transport left off");
            return;
        }
        if let Err(e) = start_active(app, &mut st).await {
            log(&format!("start failed: {e}"));
        }
    }

    /// The DNS tunnel just started: turn this off (one at a time).
    pub fn deactivate_for_tunnel(app: &crate::Host) {
        let mut st = load(app);
        if store::active_id(&st).is_some() || SERVER.lock().unwrap().is_some() {
            let _ = store::select(&mut st, None);
            let _ = save(app, &st);
            stop_server();
            crate::tunnel::set_ws_proxy(None);
            log("turned off: the DNS tunnel is in use now");
        }
    }

    pub async fn add(app: &crate::Host, url: &str, label: &str, token: Option<&str>, activate: bool) -> Result<Value, String> {
        if activate {
            crate::tunnel::deactivate_for_ws(app);
        }
        let _g = OP.lock().await;
        let mut st = load(app);
        let id = hex(&crate::random_bytes::<6>());
        let (id, existing) = store::add(&mut st, url, label, token, id, now())?;
        if activate {
            store::select(&mut st, Some(&id))?;
        }
        save(app, &st)?;
        // A new invite for the proxy in use takes effect right away.
        if activate || (existing && token.is_some() && store::active_id(&st) == Some(id.as_str())) {
            start_active(app, &mut st).await?;
        }
        Ok(serde_json::json!({"id": id, "existing": existing}))
    }

    pub async fn select(app: &crate::Host, id: Option<&str>) -> Result<(), String> {
        if id.is_some() {
            crate::tunnel::deactivate_for_ws(app);
        }
        let _g = OP.lock().await;
        let mut st = load(app);
        store::select(&mut st, id)?;
        save(app, &st)?;
        start_active(app, &mut st).await
    }

    pub async fn delete(app: &crate::Host, id: &str) -> Result<(), String> {
        let _g = OP.lock().await;
        let mut st = load(app);
        let was = store::delete(&mut st, id)?;
        save(app, &st)?;
        if was {
            start_active(app, &mut st).await?;
        }
        Ok(())
    }

    pub fn status(app: &crate::Host) -> Value {
        let st = load(app);
        let mut v = store::public_list(&st);
        v["supported"] = Value::from(true);
        v["running"] = Value::from(SERVER.lock().unwrap().is_some());
        v["dns_tunnel_active"] = Value::from(crate::tunnel::dns_tunnel_active(app));
        v
    }
}

#[cfg(any(target_os = "android", windows))]
pub use app::deactivate_for_tunnel;

#[cfg(any(target_os = "android", windows))]
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn boot(app: &crate::Host) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { app::boot(&app).await });
}
#[cfg(not(any(target_os = "android", windows)))]
pub fn boot(_app: &crate::Host) {}

/// boot, awaited: the server listens (and the profiles' proxy is set) when
/// this returns, so IO can start behind it.
#[cfg(any(target_os = "android", windows))]
#[cfg_attr(windows, allow(dead_code))]
pub async fn boot_now(app: &crate::Host) {
    app::boot(app).await;
}
#[cfg(not(any(target_os = "android", windows)))]
#[allow(dead_code)]
pub async fn boot_now(_app: &crate::Host) {}

#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub fn ws_transport_status(app: tauri::AppHandle) -> Value {
    app::status(&crate::Host::from_app(&app))
}
#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub async fn ws_transport_add(app: tauri::AppHandle, url: String, label: Option<String>, token: Option<String>, activate: Option<bool>) -> Result<Value, String> {
    app::add(&crate::Host::from_app(&app), &url, label.as_deref().unwrap_or(""), token.as_deref(), activate.unwrap_or(false)).await
}
#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub async fn ws_transport_select(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    app::select(&crate::Host::from_app(&app), id.as_deref()).await
}
#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub async fn ws_transport_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    app::delete(&crate::Host::from_app(&app), &id).await
}
/// Test button: asks the proxy's /dns/ for `host` (the account's IMAP host).
#[cfg(any(target_os = "android", windows))]
#[tauri::command]
pub async fn ws_transport_test(app: tauri::AppHandle, url: String, host: String, token: Option<String>) -> Result<Value, String> {
    let p = parse_proxy_url(&url)?;
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if !valid_dns_name(&host) {
        return Err("Bad host name".into());
    }
    let t0 = std::time::Instant::now();
    // Same device id as the transport itself, so a Test of a capped invite
    // takes the slot this install will use anyway.
    let device = match token.as_deref() {
        Some(_) => Some(app::device_for(&crate::Host::from_app(&app), &url).await?),
        None => None,
    };
    let ips = imp::resolve(&p, &host, token.as_deref(), device.as_deref()).await?;
    Ok(serde_json::json!({"ips": ips.len(), "ms": t0.elapsed().as_millis() as u64}))
}

#[cfg(not(any(target_os = "android", windows)))]
const UNSUPPORTED: &str = "The WebSocket transport is available in the Android and Windows apps";

#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn ws_transport_status() -> Value {
    serde_json::json!({"supported": false, "platform": std::env::consts::OS, "active": null, "proxies": []})
}
#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn ws_transport_add(url: String, label: Option<String>, token: Option<String>, activate: Option<bool>) -> Result<Value, String> {
    let _ = (url, label, token, activate);
    Err(UNSUPPORTED.into())
}
#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn ws_transport_select(id: Option<String>) -> Result<(), String> {
    let _ = id;
    Err(UNSUPPORTED.into())
}
#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn ws_transport_delete(id: String) -> Result<(), String> {
    let _ = id;
    Err(UNSUPPORTED.into())
}
#[cfg(not(any(target_os = "android", windows)))]
#[tauri::command]
pub fn ws_transport_test(url: String, host: String, token: Option<String>) -> Result<Value, String> {
    let _ = (url, host, token);
    Err(UNSUPPORTED.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    #[test]
    fn proxy_urls() {
        let p = parse_proxy_url("wss://proxy.example.org").unwrap();
        assert_eq!((p.tls, p.host.as_str(), p.port, p.base.as_str()), (true, "proxy.example.org", 443, ""));
        assert_eq!(p.to_url(), "wss://proxy.example.org");
        assert_eq!(parse_proxy_url("Proxy.Example.org/").unwrap().to_url(), "wss://proxy.example.org");
        let p = parse_proxy_url("wss://proxy.example.org:8443/ws/").unwrap();
        assert_eq!(p.to_url(), "wss://proxy.example.org:8443/ws");
        assert_eq!(p.dns_path("IMAP.Example.org."), "/ws/dns/imap.example.org");
        assert_eq!(p.tcp_path("192.0.2.7".parse().unwrap(), 993), "/ws/tcp/192.0.2.7/993");
        assert_eq!(p.tcp_path("2001:db8::1".parse().unwrap(), 465), "/ws/tcp/2001:db8::1/465");
        assert_eq!(p.host_header(), "proxy.example.org:8443");
        assert_eq!(parse_proxy_url("ws://127.0.0.1:8153").unwrap().to_url(), "ws://127.0.0.1:8153");
        assert_eq!(parse_proxy_url("wss://[2001:db8::2]:444").unwrap().to_url(), "wss://[2001:db8::2]:444");
        for bad in ["", "ws://proxy.example.org", "https://proxy.example.org", "wss://u:p@proxy.example.org", "wss://proxy.example.org/?x=1",
            "wss://proxy.example.org/#a", "wss://proxy.example.org:0", "wss://proxy.example.org:99999", "wss://bad_host.example.org",
            "wss://proxy.example.org/a/../b", "wss://pro xy.example.org", "wss://nodot", "wss://proxy.example.org:", "wss://-a.example.org"] {
            assert!(parse_proxy_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn socks_parsing() {
        assert_eq!(socks::greeting_offers_userpass(&[5, 2, 0, 2]), Ok(true));
        assert_eq!(socks::greeting_offers_userpass(&[5, 1, 0]), Ok(false));
        assert!(socks::greeting_offers_userpass(&[4, 1, 0]).is_err());
        assert!(socks::greeting_offers_userpass(&[5, 0]).is_err());
        assert_eq!(socks::parse_userpass(&[1, 1, b'u', 2, b'p', b'w']).unwrap(), (&b"u"[..], &b"pw"[..]));
        assert!(socks::parse_userpass(&[1, 5, b'u']).is_err());
        assert!(socks::parse_userpass(&[1, 1, b'u', 1, b'p', 9]).is_err());
        let v4 = [5, 1, 0, 1, 192, 0, 2, 1, 0x03, 0xe1];
        assert_eq!(socks::request_len(&v4), Some(10));
        assert_eq!(socks::request_len(&v4[..9]), None);
        assert_eq!(socks::parse_request(&v4), Ok(Target::Ip("192.0.2.1".parse().unwrap(), 993)));
        let mut name = vec![5, 1, 0, 3, 16];
        name.extend_from_slice(b"Imap.Example.org");
        name.extend_from_slice(&465u16.to_be_bytes());
        assert_eq!(socks::request_len(&name), Some(name.len()));
        assert_eq!(socks::parse_request(&name), Ok(Target::Name("imap.example.org".into(), 465)));
        let mut v6 = vec![5, 1, 0, 4];
        v6.extend_from_slice(&"2001:db8::1".parse::<std::net::Ipv6Addr>().unwrap().octets());
        v6.extend_from_slice(&[0, 25]);
        assert_eq!(socks::parse_request(&v6), Ok(Target::Ip("2001:db8::1".parse().unwrap(), 25)));
        assert_eq!(socks::parse_request(&[5, 2, 0, 1, 1, 2, 3, 4, 0, 1]), Err(socks::REP_CMD_UNSUPPORTED));
        assert_eq!(socks::parse_request(&[5, 1, 0, 9, 0, 0]), Err(socks::REP_ATYP_UNSUPPORTED));
        assert_eq!(socks::parse_request(&[5, 1, 0, 3, 3, b'a', b'/', b'b', 0, 1]), Err(socks::REP_HOST_UNREACHABLE));
        assert_eq!(socks::parse_request(&[5, 1, 0, 1, 1, 2, 3, 4, 0]), Err(socks::REP_GENERAL));
    }

    #[test]
    fn frames_and_dns_answer() {
        assert_eq!(ws_accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        let f = encode_frame(2, &[1, 2, 3], [9, 9, 9, 9]);
        assert_eq!(f, vec![0x82, 0x83, 9, 9, 9, 9, 1 ^ 9, 2 ^ 9, 3 ^ 9]);
        assert_eq!(encode_frame(2, &[0; 300], [0; 4])[1], 0x80 | 126);
        assert_eq!(encode_frame(2, &vec![0; 70000], [0; 4])[1], 0x80 | 127);
        let ips = parse_dns_answer(r#"["192.0.2.1","2001:db8::1","junk",5]"#).unwrap();
        assert_eq!(ips, vec!["192.0.2.1".parse::<IpAddr>().unwrap(), "2001:db8::1".parse().unwrap()]);
        assert!(parse_dns_answer("{}").is_err());
    }

    const TOK: &str = "eyJ2IjoxLCJpIjoiYWFhIn0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn tokens() {
        assert!(valid_token(TOK));
        for bad in ["", "abc", "eyJ2.short", "eyJ2IjoxfQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "eyJ 2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "a.b.c"] {
            assert!(!valid_token(bad), "{bad}");
        }
        assert!(!valid_token(&format!("{}.{}", "a".repeat(1000), "A".repeat(43))));
        assert_eq!(auth_header(Some(TOK), None), format!("Sec-WebSocket-Protocol: velta.v1, tok.{TOK}\r\n"));
        let dev = "AAAAAAAAAAAAAAAAAAAAAA";
        assert_eq!(auth_header(Some(TOK), Some(dev)), format!("Sec-WebSocket-Protocol: velta.v1, tok.{TOK}, dev.{dev}\r\n"));
        assert_eq!(auth_header(Some(TOK), Some("bad\r\nX: 1aaaaaaaaaaaa")), format!("Sec-WebSocket-Protocol: velta.v1, tok.{TOK}\r\n"));
        assert_eq!(auth_header(Some("x\r\nEvil: 1"), Some(dev)), "");
        assert_eq!(auth_header(None, Some(dev)), "", "no device id without an invite");
        assert!(!valid_device("short") && !valid_device(&"a".repeat(65)) && valid_device(dev));
        assert_eq!(refusal_text("HTTP/1.1 403 Forbidden\r\nX-Velta-Refusal: device-limit\r\n\r\n"), DEVICE_LIMIT);
        assert!(refusal_text("HTTP/1.1 403 Forbidden\r\nServer: nginx\r\n\r\n").starts_with("proxy refused"));
        assert!(refusal_text("HTTP/1.1 401 Unauthorized").starts_with("invite refused (401)"));
        assert!(refusal_text("HTTP/1.1 403 Forbidden").contains("403"));

        let mut st = store::empty();
        assert!(store::add(&mut st, "proxy.example.org", "", Some("junk"), "a1".into(), 1).is_err());
        store::add(&mut st, "proxy.example.org", "", None, "a1".into(), 1).unwrap();
        assert_eq!(store::token(&st, "a1"), None);
        // Re-adding the same proxy with an invite stores it (new link from the owner).
        assert_eq!(store::add(&mut st, "wss://proxy.example.org", "", Some(TOK), "a2".into(), 2).unwrap(), ("a1".into(), true));
        assert_eq!(store::token(&st, "a1"), Some(TOK));
        // Without a token, a re-add keeps the saved one.
        store::add(&mut st, "proxy.example.org", "", None, "a3".into(), 3).unwrap();
        assert_eq!(store::token(&st, "a1"), Some(TOK));
        assert!(store::public_list(&st).to_string().contains(TOK));
        // Device ids: one per canonical proxy URL, stable, survive a delete.
        let d1 = store::device(&mut st, "proxy.example.org", || "d".repeat(22)).unwrap();
        assert_eq!(store::device(&mut st, "wss://proxy.example.org/", || unreachable!()).unwrap(), d1);
        store::delete(&mut st, "a1").unwrap();
        assert_eq!(store::device(&mut st, "proxy.example.org", || unreachable!()).unwrap(), d1);
        assert_eq!(store::device(&mut st, "other.example.org", || "e".repeat(22)).unwrap(), "e".repeat(22));
        assert!(!store::public_list(&st).to_string().contains(&d1));
    }

    #[test]
    fn store_logic() {
        let mut st = store::empty();
        let (a, ex) = store::add(&mut st, "proxy.example.org", " Home\n ", None, "a1".into(), 1).unwrap();
        assert!(!ex);
        assert_eq!(store::add(&mut st, "wss://PROXY.example.org/", "x", None, "a2".into(), 2).unwrap(), (a.clone(), true));
        assert!(store::add(&mut st, "http://x.example.org", "", None, "a3".into(), 3).is_err());
        assert_eq!(store::find(&st, "a1").unwrap()["label"], "Home");
        store::select(&mut st, Some("a1")).unwrap();
        assert!(store::select(&mut st, Some("zz")).is_err());
        st["pass"] = "secret".into();
        let pubv = store::public_list(&st).to_string();
        assert!(!pubv.contains("secret"));
        assert_eq!(store::active_id(&st), Some("a1"));
        assert!(store::delete(&mut st, "a1").unwrap());
        assert_eq!(store::active_id(&st), None);
        assert!(store::delete(&mut st, "a1").is_err());
    }

    /// Runs the bridge from tools/deploy-ws-proxy.sh on 127.0.0.1 (needs
    /// python3 + websockets) and pipes an echo server through the SOCKS5
    /// port. Skipped when python3/websockets are missing.
    #[tokio::test]
    async fn socks_through_local_bridge() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let Some(bridge) = local_bridge::start() else {
            eprintln!("skipped: python3 + websockets not available");
            return;
        };
        // Echo server on loopback.
        let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let mut b = [0u8; 4096];
                    while let Ok(n) = s.read(&mut b).await {
                        if n == 0 || s.write_all(&b[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        let bridge = bridge.with_echo_port(echo_port);
        let proxy = parse_proxy_url(&format!("ws://127.0.0.1:{}", bridge.port)).unwrap();
        // /dns/ answer for the allowlisted name.
        let ips = resolve(&proxy, "localhost.example.org", None, None).await.unwrap();
        assert_eq!(ips, vec!["127.0.0.1".parse::<IpAddr>().unwrap()]);
        let server = start(proxy, None, None, "velta-ws".into(), "pw".into(), "127.0.0.1:0").await.unwrap();

        // Wrong password is refused.
        let mut s = tokio::net::TcpStream::connect(server.addr).await.unwrap();
        s.write_all(&[5, 1, 2]).await.unwrap();
        let mut r = [0u8; 2];
        s.read_exact(&mut r).await.unwrap();
        assert_eq!(r, [5, 2]);
        s.write_all(&[1, 8, b'v', b'e', b'l', b't', b'a', b'-', b'w', b's', 2, b'n', b'o']).await.unwrap();
        s.read_exact(&mut r).await.unwrap();
        assert_eq!(r, [1, 1]);

        // By name (resolved through /dns/) and by IP.
        for by_name in [true, false] {
            let mut s = tokio::net::TcpStream::connect(server.addr).await.unwrap();
            s.write_all(&[5, 1, 2]).await.unwrap();
            s.read_exact(&mut r).await.unwrap();
            s.write_all(&[1, 8, b'v', b'e', b'l', b't', b'a', b'-', b'w', b's', 2, b'p', b'w']).await.unwrap();
            s.read_exact(&mut r).await.unwrap();
            assert_eq!(r, [1, 0]);
            let mut req = vec![5, 1, 0];
            if by_name {
                let n = b"localhost.example.org";
                req.push(3);
                req.push(n.len() as u8);
                req.extend_from_slice(n);
            } else {
                req.extend_from_slice(&[1, 127, 0, 0, 1]);
            }
            req.extend_from_slice(&echo_port.to_be_bytes());
            s.write_all(&req).await.unwrap();
            let mut rep = [0u8; 10];
            s.read_exact(&mut rep).await.unwrap();
            assert_eq!(rep[1], 0, "CONNECT refused");
            let payload: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
            let (mut rd, mut wr) = s.into_split();
            let p2 = payload.clone();
            let w = tokio::spawn(async move { wr.write_all(&p2).await.unwrap(); wr });
            let mut got = vec![0u8; payload.len()];
            tokio::time::timeout(std::time::Duration::from_secs(20), rd.read_exact(&mut got)).await.unwrap().unwrap();
            assert_eq!(got, payload);
            drop(w.await.unwrap());
        }
        // A port the bridge does not allow: the bridge closes the WebSocket
        // right after the upgrade, so the client sees a refusal or an EOF.
        let mut s = tokio::net::TcpStream::connect(server.addr).await.unwrap();
        s.write_all(&[5, 1, 2]).await.unwrap();
        s.read_exact(&mut r).await.unwrap();
        s.write_all(&[1, 8, b'v', b'e', b'l', b't', b'a', b'-', b'w', b's', 2, b'p', b'w']).await.unwrap();
        s.read_exact(&mut r).await.unwrap();
        s.write_all(&[5, 1, 0, 1, 127, 0, 0, 1, 0, 9]).await.unwrap();
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).await.unwrap();
        if rep[1] == 0 {
            let mut b = [0u8; 1];
            let n = tokio::time::timeout(std::time::Duration::from_secs(5), s.read(&mut b)).await.unwrap().unwrap_or(0);
            assert_eq!(n, 0, "disallowed port must not carry data");
        }
        server.stop();
    }

    /// Invite auth end to end with the real bridge (AUTH=1): valid, missing,
    /// bad signature, expired and revoked tokens, plus a CONNECT that carries
    /// the token. Skipped when python3/websockets are missing.
    #[tokio::test]
    async fn invite_auth_through_local_bridge() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let Some(bridge) = local_bridge::start() else {
            eprintln!("skipped: python3 + websockets not available");
            return;
        };
        let dir = std::env::temp_dir().join(format!("velta-wsauth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (secret, revoked) = (dir.join("secret"), dir.join("revoked"));
        std::fs::write(&secret, "ef".repeat(32)).unwrap();
        std::fs::write(&revoked, "").unwrap();
        let (secret_s, revoked_s) = (secret.to_str().unwrap(), revoked.to_str().unwrap());
        const MINT: &str = "import importlib.util,sys,time\nspec=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)\nk=b.load_secret(sys.argv[2]) if sys.argv[2]!='-' else b'0'*64\nprint(b.mint(k,sys.argv[3],'',float(sys.argv[4])))";
        let valid = bridge.py(MINT, &[secret_s, "id1", "0"]);
        let other = bridge.py(MINT, &[secret_s, "id2", &(now_secs() + 3600).to_string()]);
        let expired = bridge.py(MINT, &[secret_s, "id3", "1000"]);
        let forged = bridge.py(MINT, &["-", "id1", "0"]);
        assert!(valid_token(&valid) && valid_token(&forged) && valid_token(&expired));

        let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let mut b = [0u8; 1024];
                    while let Ok(n) = s.read(&mut b).await {
                        if n == 0 || s.write_all(&b[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        let port_s = echo_port.to_string();
        let bridge = bridge.with_env(echo_port, &[("AUTH", "1"), ("SECRET_FILE", secret_s), ("REVOKED_FILE", revoked_s), ("ALLOW_PORTS", &port_s)]);
        let proxy = parse_proxy_url(&format!("ws://127.0.0.1:{}", bridge.port)).unwrap();
        let host = "localhost.example.org";
        assert_eq!(resolve(&proxy, host, Some(&valid), None).await.unwrap(), vec!["127.0.0.1".parse::<IpAddr>().unwrap()]);
        for (why, tok) in [("missing", None), ("forged", Some(forged.as_str())), ("expired", Some(expired.as_str()))] {
            let e = resolve(&proxy, host, tok, None).await.unwrap_err();
            assert!(e.starts_with("invite refused (401)"), "{why}: {e}");
        }
        // A /tcp/ tunnel without the token is refused before any dial.
        let e = imp::ws_connect(&proxy, &proxy.tcp_path("127.0.0.1".parse().unwrap(), echo_port), None, None).await.err().unwrap();
        assert!(e.starts_with("invite refused"), "{e}");

        // SOCKS CONNECT through the bridge with the token.
        let server = start(proxy.clone(), Some(valid.clone()), None, "velta-ws".into(), "pw".into(), "127.0.0.1:0").await.unwrap();
        let mut s = tokio::net::TcpStream::connect(server.addr).await.unwrap();
        let mut r = [0u8; 2];
        s.write_all(&[5, 1, 2]).await.unwrap();
        s.read_exact(&mut r).await.unwrap();
        s.write_all(&[1, 8, b'v', b'e', b'l', b't', b'a', b'-', b'w', b's', 2, b'p', b'w']).await.unwrap();
        s.read_exact(&mut r).await.unwrap();
        let mut req = vec![5, 1, 0, 1, 127, 0, 0, 1];
        req.extend_from_slice(&echo_port.to_be_bytes());
        s.write_all(&req).await.unwrap();
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).await.unwrap();
        assert_eq!(rep[1], 0, "CONNECT refused");
        s.write_all(b"ping").await.unwrap();
        let mut got = [0u8; 4];
        tokio::time::timeout(std::time::Duration::from_secs(10), s.read_exact(&mut got)).await.unwrap().unwrap();
        assert_eq!(&got, b"ping");
        server.stop();

        // Revocation: the bridge re-reads the list within ~2 s.
        std::fs::write(&revoked, "id1\n").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2600)).await;
        let e = resolve(&proxy, host, Some(&valid), None).await.unwrap_err();
        assert!(e.starts_with("invite refused"), "revoked: {e}");
        assert!(resolve(&proxy, host, Some(&other), None).await.is_ok(), "other invites keep working");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `--uses 1` end to end with the real bridge: the first device takes the
    /// slot and reconnects freely (also after a bridge restart), a second
    /// one gets the device-limit refusal, an app without a device id 401.
    #[tokio::test]
    async fn invite_device_cap_through_local_bridge() {
        let Some(b1) = local_bridge::start() else {
            eprintln!("skipped: python3 + websockets not available");
            return;
        };
        let dir = std::env::temp_dir().join(format!("velta-wscap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("state")).unwrap();
        let secret = dir.join("secret");
        std::fs::write(&secret, "ef".repeat(32)).unwrap();
        let (secret_s, state_s) = (secret.to_str().unwrap().to_string(), dir.join("state").to_str().unwrap().to_string());
        const MINT: &str = "import importlib.util,sys\nspec=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)\nprint(b.mint(b.load_secret(sys.argv[2]),'cap1','',0,1))";
        let tok = b1.py(MINT, &[&secret_s]);
        let env = [("AUTH", "1"), ("SECRET_FILE", secret_s.as_str()), ("STATE_DIRECTORY", state_s.as_str())];
        let host = "localhost.example.org";
        let (a, c) = ("A".repeat(22), "C".repeat(22));
        let b1 = b1.with_env(1, &env);
        let proxy = parse_proxy_url(&format!("ws://127.0.0.1:{}", b1.port)).unwrap();
        for _ in 0..3 {
            resolve(&proxy, host, Some(&tok), Some(&a)).await.unwrap();
        }
        assert_eq!(resolve(&proxy, host, Some(&tok), Some(&c)).await.unwrap_err(), DEVICE_LIMIT);
        let e = resolve(&proxy, host, Some(&tok), None).await.unwrap_err();
        assert!(e.starts_with("invite refused (401)"), "{e}");
        drop(b1);
        let b2 = local_bridge::start().unwrap().with_env(1, &env);
        let proxy = parse_proxy_url(&format!("ws://127.0.0.1:{}", b2.port)).unwrap();
        resolve(&proxy, host, Some(&tok), Some(&a)).await.expect("known device after restart");
        assert_eq!(resolve(&proxy, host, Some(&tok), Some(&c)).await.unwrap_err(), DEVICE_LIMIT);
        drop(b2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn now_secs() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
    }

    /// The bridge script extracted from tools/deploy-ws-proxy.sh, with its
    /// "never private addresses" check relaxed to loopback for this test.
    mod local_bridge {
        pub struct Bridge {
            script: std::path::PathBuf,
            pub port: u16,
            child: Option<std::process::Child>,
        }
        impl Drop for Bridge {
            fn drop(&mut self) {
                if let Some(c) = self.child.as_mut() {
                    let _ = c.kill();
                }
                let _ = std::fs::remove_file(&self.script);
            }
        }
        pub fn start() -> Option<Bridge> {
            let ok = std::process::Command::new("python3").args(["-c", "import websockets"]).output().ok()?.status.success();
            if !ok {
                return None;
            }
            let sh = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/deploy-ws-proxy.sh")).ok()?;
            let start = sh.find("cat > \"$LIB/bridge.py\" <<'PY'\n")?;
            let body = &sh[start..];
            let body = &body[body.find('\n')? + 1..];
            let body = &body[..body.find("\nPY\n")?];
            let body = body.replace("return a.is_global and not a.is_multicast", "return a.is_loopback");
            let body = body.replace("loop.getaddrinfo(host,", "loop.getaddrinfo(\"127.0.0.1\" if host == \"localhost.example.org\" else host,");
            assert!(body.contains("is_loopback") && body.contains("127.0.0.1"), "bridge script changed; update the test");
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let script = std::env::temp_dir().join(format!("velta-ws-bridge-{}-{n}.py", std::process::id()));
            std::fs::write(&script, body).ok()?;
            Some(Bridge { script, port: 0, child: None })
        }
        impl Bridge {
            pub fn with_echo_port(self, echo: u16) -> Bridge {
                self.with_env(echo, &[])
            }
            /// Runs `python3 -c <code> <bridge.py> args…` (mint helpers).
            pub fn py(&self, code: &str, args: &[&str]) -> String {
                let o = std::process::Command::new("python3").arg("-c").arg(code).arg(&self.script).args(args).output().unwrap();
                assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
                String::from_utf8(o.stdout).unwrap().trim().to_string()
            }
            pub fn with_env(mut self, echo: u16, env: &[(&str, &str)]) -> Bridge {
                let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
                let child = std::process::Command::new("python3")
                    .envs(env.iter().copied())
                    .arg(&self.script)
                    .env("ALLOW_HOSTS", "localhost.example.org")
                    .env("ALLOW_PORTS", echo.to_string())
                    .env("LISTEN_PORT", port.to_string())
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap();
                self.child = Some(child);
                self.port = port;
                for _ in 0..100 {
                    if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                self
            }
        }
    }
}
