//! W flag (relays modal): C3 mail-tunnel capability probe from the shell.
//!
//! A C3-capable relay answers `wss://<relay>/dns/<relay>` with a JSON array
//! of IPs. Relays gate browser Origins, so the WebView's own WebSocket (tauri
//! origin) is refused even by capable relays. This probe opens the socket
//! from Rust and sends NO Origin header, so the answer reflects the relay's
//! capability rather than our origin. The PWA keeps its browser probe
//! (ws-relays.js), where "capable from this origin" is what matters.
//!
//! Direct connection (no account proxy), 5 s overall deadline, host strictly
//! validated (bare DNS name: no scheme, port, path or IP literal games).

use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use crate::lufi::{read_frame, read_head, tls, ws_accept_key};

const TIMEOUT: Duration = Duration::from_secs(5);

/// A bare hostname: ASCII letters, digits, `-` and `.`, dot-separated
/// labels of 1..=63 chars not starting/ending with `-`, at least two labels,
/// total <= 253. Rejects schemes, ports, paths, userinfo and IPv6 literals.
pub fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

/// True only for a non-empty JSON array whose entries are all strings.
pub fn capable_reply(text: &str) -> bool {
    matches!(serde_json::from_str::<Vec<String>>(text), Ok(v) if !v.is_empty())
}

fn left(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| "timeout".to_string())
}

fn probe_blocking(host: &str) -> Result<bool, String> {
    let deadline = Instant::now() + TIMEOUT;
    let addrs: Vec<_> = (host, 443).to_socket_addrs().map_err(|e| format!("DNS: {e}"))?.collect();
    let mut tcp = None;
    for a in addrs {
        if let Ok(s) = TcpStream::connect_timeout(&a, left(deadline)?) {
            tcp = Some(s);
            break;
        }
    }
    let tcp = tcp.ok_or("connect failed")?;
    tcp.set_read_timeout(Some(left(deadline)?)).ok();
    tcp.set_write_timeout(Some(left(deadline)?)).ok();
    let mut io = tls(host, tcp)?;
    let key = data_encoding::BASE64.encode(&crate::random_bytes::<16>());
    // Deliberately no Origin header: relays gate browser origins only.
    let req = format!(
        "GET /dns/{host} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: Velta\r\n\r\n"
    );
    io.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    io.flush().ok();
    let head = read_head(&mut io)?;
    if head.lines().next().and_then(|l| l.split_whitespace().nth(1)) != Some("101") {
        return Ok(false);
    }
    let want = ws_accept_key(&key);
    let accepted = head.lines().any(|l| {
        l.split_once(':')
            .map(|(k, v)| k.trim().eq_ignore_ascii_case("sec-websocket-accept") && v.trim() == want)
            .unwrap_or(false)
    });
    if !accepted {
        return Ok(false);
    }
    // First data frame decides (pings/pongs skipped; fragments not expected
    // for a tiny IP list, so an unfinished frame counts as "no").
    loop {
        left(deadline)?;
        let (fin, op, payload) = read_frame(&mut io)?;
        match op {
            0x9 | 0xA => continue,
            0x1 if fin => return Ok(std::str::from_utf8(&payload).map(capable_reply).unwrap_or(false)),
            _ => return Ok(false),
        }
    }
}

/// W flag: whether `host` answers `wss://<host>/dns/<host>` with a non-empty
/// JSON array of strings, probed without a browser Origin. Invalid hosts,
/// errors and the 5 s timeout all yield `false`.
#[tauri::command]
pub async fn probe_c3_relay(host: String) -> bool {
    let host = host.trim().to_ascii_lowercase();
    if !valid_host(&host) {
        return false;
    }
    let job = tauri::async_runtime::spawn_blocking(move || probe_blocking(&host).unwrap_or(false));
    matches!(tokio::time::timeout(TIMEOUT + Duration::from_secs(1), job).await, Ok(Ok(true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_validation() {
        for ok in ["relay.example.org", "a-b.c1.io", "nine.testrun.org"] {
            assert!(valid_host(ok), "{ok}");
        }
        for bad in [
            "", "localhost", "wss://a.b", "a.b:443", "a.b/dns", "user@a.b", "[::1]", "a..b", ".a.b",
            "-a.b", "a-.b", "a.b ", "a.b\r\nX: y", "a_b.c", "ä.de",
        ] {
            assert!(!valid_host(bad), "{bad:?}");
        }
        assert!(!valid_host(&format!("{}.com", "a".repeat(64))));
    }

    #[test]
    fn reply_parsing() {
        assert!(capable_reply(r#"["1.2.3.4"]"#));
        assert!(capable_reply(r#"["1.2.3.4","::1"]"#));
        for bad in ["[]", "[1]", r#"["a",2]"#, "{}", r#""1.2.3.4""#, "<html>", "", "null"] {
            assert!(!capable_reply(bad), "{bad:?}");
        }
    }
}
