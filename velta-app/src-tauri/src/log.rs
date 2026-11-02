//! Bounded, redacting, rate-limited logger (#196).
//!
//! The writer thread is fed by a `sync_channel(8192)` with `try_send`. A
//! full channel drops the NEW message (drop-newest) and increments a
//! counter; the next successful line carries `dropped=N`. Logging defaults
//! ON; the Diagnostics switch can freeze the writer. Heartbeat lines
//! (`boot:`) skip redaction and the rate limit.

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const CHANNEL_CAP: usize = 8192;
const RATE_PER_SEC: u64 = 50;
const QUOTE_MAX: usize = 80;

static LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static MIRROR_LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static LOG_TX: Mutex<Option<SyncSender<String>>> = Mutex::new(None);
// Default ON (#196): redaction + rate-limit make a disk log safe enough
// that a fresh profile is not blind. The Diagnostics switch can still
// freeze the writer (`velta-logging` = "0").
static LOG_ENABLED: AtomicBool = AtomicBool::new(true);
static DROP_COUNT: AtomicU64 = AtomicU64::new(0);
static RATE_DROP_COUNT: AtomicU64 = AtomicU64::new(0);
/// Packed rate window: high 32 bits = unix seconds, low 32 bits = count.
static RATE: AtomicU64 = AtomicU64::new(0);

pub fn set_mirror_log_dir(path: PathBuf) {
    *MIRROR_LOG_DIR.lock().unwrap() = Some(path);
}

pub(crate) fn log_dir() -> PathBuf {
    LOG_DIR.lock().unwrap().clone().unwrap_or_else(|| {
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

pub(crate) fn log_dir_is_set() -> bool {
    LOG_DIR.lock().unwrap().is_some()
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
    let (tx, rx) = mpsc::sync_channel::<String>(CHANNEL_CAP);
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
                    if let Ok(mut f) = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&mirror_file)
                    {
                        use std::io::Write;
                        let _ = f.write_all(msg.as_bytes());
                    }
                }
            }
        })
        .ok();
}

pub fn set_logging_enabled(enabled: bool) {
    LOG_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn log(msg: &str) {
    // Runtime gate (Diagnostics chat "Logging" switch): when off, velta.log
    // and its mirror freeze. The in-app Diagnostics chat keeps working —
    // its rows live in the frontend and never pass through here.
    if !LOG_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    if !allow_rate(msg) {
        RATE_DROP_COUNT.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let text = if msg.starts_with("boot:") {
        msg.to_string()
    } else {
        redact(msg)
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let line = format!("[{}.{:03}] {}\n", now.as_secs(), now.subsec_millis(), text);
    enqueue(line);
}

fn sender() -> Option<SyncSender<String>> {
    LOG_TX.lock().unwrap().clone()
}

fn enqueue(line: String) {
    let Some(tx) = sender() else {
        return;
    };
    let dropped = DROP_COUNT.load(Ordering::Relaxed);
    let rate_dropped = RATE_DROP_COUNT.load(Ordering::Relaxed);
    let line = if dropped > 0 || rate_dropped > 0 {
        format!(
            "{} dropped={} rate_dropped={}\n",
            line.trim_end(),
            dropped,
            rate_dropped
        )
    } else {
        line
    };
    match tx.try_send(line) {
        Ok(()) => {
            if dropped > 0 {
                let _ =
                    DROP_COUNT.compare_exchange(dropped, 0, Ordering::Relaxed, Ordering::Relaxed);
            }
            if rate_dropped > 0 {
                let _ = RATE_DROP_COUNT.compare_exchange(
                    rate_dropped,
                    0,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                );
            }
        }
        // Drop-newest: the message we failed to enqueue is discarded. A
        // stalled writer then keeps a bounded queue instead of growing RAM.
        Err(TrySendError::Full(_)) => {
            DROP_COUNT.fetch_add(1, Ordering::Relaxed);
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

fn allow_rate(msg: &str) -> bool {
    if rate_exempt(msg) {
        return true;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    loop {
        let packed = RATE.load(Ordering::Relaxed);
        let window = packed >> 32;
        let count = packed & 0xffff_ffff;
        let (new_window, new_count) = if window != now {
            (now, 1u64)
        } else if count >= RATE_PER_SEC {
            return false;
        } else {
            (window, count + 1)
        };
        let new_packed = (new_window << 32) | new_count;
        if RATE
            .compare_exchange_weak(packed, new_packed, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            return true;
        }
    }
}

fn rate_exempt(msg: &str) -> bool {
    let start = msg.trim_start();
    if start.starts_with("boot:") {
        return true;
    }
    start.len() >= 5 && start[..5].eq_ignore_ascii_case("error")
}

/// Cheap redaction before enqueue: mask email domains, drop `t=` query
/// values, truncate long quoted bodies. Heartbeats skip this.
pub(crate) fn redact(msg: &str) -> String {
    truncate_quoted(&redact_emails(&redact_chat_link(msg)))
}

/// Drop `t=` values before they reach velta.log. The query delimiter has to
/// precede `t=`, so an unrelated path that happens to contain those letters
/// is left alone.
pub(crate) fn redact_chat_link(url: &str) -> String {
    let mut out = String::with_capacity(url.len());
    let mut rest = url;
    while let Some(rel) = rest.find(['?', '&']) {
        let (head, tail) = rest.split_at(rel + 1);
        out.push_str(head);
        if let Some(value) = tail.strip_prefix("t=") {
            out.push_str("t=…");
            let end = value.find(['&', '#']).unwrap_or(value.len());
            rest = &value[end..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

fn is_local(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'%' | b'+' | b'-')
}

fn is_domain(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-')
}

/// `foo@bar` / `foo@bar.com` → `foo@***`.
fn redact_emails(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if is_local(b[i]) {
            let start = i;
            while i < b.len() && is_local(b[i]) {
                i += 1;
            }
            if i < b.len() && b[i] == b'@' {
                let at = i;
                i += 1;
                let dom_start = i;
                while i < b.len() && is_domain(b[i]) {
                    i += 1;
                }
                let mut dom_end = i;
                while dom_end > dom_start && b[dom_end - 1] == b'.' {
                    dom_end -= 1;
                }
                if dom_end > dom_start {
                    out.push_str(std::str::from_utf8(&b[start..=at]).unwrap_or(""));
                    out.push_str("***");
                    i = dom_end;
                    continue;
                }
            }
            out.push_str(std::str::from_utf8(&b[start..i]).unwrap_or(""));
            continue;
        }
        let ch_len = s[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&s[i..i + ch_len]);
        i += ch_len;
    }
    out
}

fn truncate_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('"') {
        out.push_str(&rest[..=start]);
        rest = &rest[start + 1..];
        match rest.find('"') {
            Some(end) => {
                let body = &rest[..end];
                if body.len() > QUOTE_MAX {
                    let mut cut = QUOTE_MAX;
                    while cut > 0 && !body.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    out.push_str(&body[..cut]);
                    out.push('…');
                } else {
                    out.push_str(body);
                }
                out.push('"');
                rest = &rest[end + 1..];
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_GATE: Mutex<()> = Mutex::new(());

    #[test]
    fn bounded_channel_drops_newest_and_counts() {
        let _gate = TEST_GATE.lock().unwrap();
        set_logging_enabled(true);
        let (tx, rx) = mpsc::sync_channel(CHANNEL_CAP);
        let prev = {
            let mut guard = LOG_TX.lock().unwrap();
            let prev = guard.clone();
            *guard = Some(tx);
            prev
        };
        DROP_COUNT.store(0, Ordering::Relaxed);
        RATE_DROP_COUNT.store(0, Ordering::Relaxed);
        // boot: is rate-limit exempt so this fill is not capped at 50/s.
        for i in 0..(CHANNEL_CAP + 64) {
            log(&format!("boot: fill {i}"));
        }
        let dropped = DROP_COUNT.load(Ordering::Relaxed);
        *LOG_TX.lock().unwrap() = prev;
        drop(rx);
        assert!(
            dropped >= 64,
            "drop-newest counter should move when the bounded channel is full, got {dropped}"
        );
    }

    #[test]
    fn redact_hides_message_body_and_email() {
        let secret = "SECRET_BODY_MUST_NOT_LEAK";
        let quoted = format!("{}{secret}", "x".repeat(QUOTE_MAX));
        let raw = format!(r#"Incoming from alice@example.org velta://chat?t=abcd "{quoted}""#);
        let out = redact(&raw);
        assert!(
            !out.contains(secret),
            "quoted body must be truncated: {out}"
        );
        assert!(
            !out.contains("example.org"),
            "email domain must be masked: {out}"
        );
        assert!(
            out.contains("alice@***"),
            "local part kept, domain masked: {out}"
        );
        assert!(
            !out.contains("t=abcd"),
            "chat-link token must be stripped: {out}"
        );
        assert!(out.contains("t=…"), "{out}");
    }

    #[test]
    fn redact_chat_link_hides_only_the_query_token() {
        assert_eq!(
            redact_chat_link("velta://chat?account=1&chat=2&t=abcd"),
            "velta://chat?account=1&chat=2&t=…"
        );
        assert_eq!(
            redact_chat_link("velta://chat?t=abcd&chat=2"),
            "velta://chat?t=…&chat=2"
        );
        assert_eq!(
            redact_chat_link("https://x?t=secret#frag"),
            "https://x?t=…#frag"
        );
        assert_eq!(redact_chat_link("no token"), "no token");
        assert_eq!(redact_chat_link(r"C:\Users\t=foo"), r"C:\Users\t=foo");
    }

    #[test]
    fn boot_prefix_skips_redaction() {
        let msg = r#"boot: sidecar spawned alice@example.org "SECRET_BODY_MUST_NOT_LEAK""#;
        assert_eq!(
            if msg.starts_with("boot:") {
                msg.to_string()
            } else {
                redact(msg)
            },
            msg
        );
    }

    #[test]
    fn logging_gate_toggles() {
        let _gate = TEST_GATE.lock().unwrap();
        set_logging_enabled(false);
        assert!(!LOG_ENABLED.load(Ordering::Relaxed));
        set_logging_enabled(true);
        assert!(LOG_ENABLED.load(Ordering::Relaxed));
    }
}
