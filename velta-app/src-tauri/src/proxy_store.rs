//! Saved SOCKS5 proxies (`proxies.json` in the app's local data dir).
//!
//! Pure functions over the JSON document so the list logic is unit-tested
//! on any host (mirrors tunnel_store.rs).
//!
//! ```json
//! {"version": 1, "active": "p1", "next": 2,
//!  "last_written": "socks5://user:pass@proxy.example:1080",
//!  "proxies": [{"id": "p1", "label": "", "host": "proxy.example", "port": 1080,
//!               "user": "", "pass": "", "added": 1700000000}]}
//! ```
//!
//! `last_written` is the proxy_url the keeper last wrote into the profiles:
//! it is what tells a keeper-owned proxy_url apart from one the user set
//! themselves (a SOCKS5 proxy URL carries no marker of its own, unlike the
//! archived DNS tunnel's `socks5://velta-tunnel:` local listener).
//! Credentials are stored plain, in the app's private data dir, which only
//! the app can read — same model as the tunnel's keys before.

use serde_json::{json, Value};

pub const FILE: &str = "proxies.json";
pub const LABEL_MAX: usize = 64;
pub const HOST_MAX: usize = 253;
pub const CRED_MAX: usize = 128;
pub const MAX_PROXIES: usize = 50;

pub fn empty() -> Value {
    json!({"version": 1, "active": null, "next": 1, "last_written": null, "proxies": []})
}

pub fn proxies(s: &Value) -> &[Value] {
    s["proxies"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn proxies_mut(s: &mut Value) -> &mut Vec<Value> {
    if !s["proxies"].is_array() {
        s["proxies"] = json!([]);
    }
    s["proxies"].as_array_mut().unwrap()
}

pub fn find<'a>(s: &'a Value, id: &str) -> Option<&'a Value> {
    proxies(s).iter().find(|p| p["id"].as_str() == Some(id))
}

fn find_mut<'a>(s: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    proxies_mut(s).iter_mut().find(|p| p["id"].as_str() == Some(id))
}

/// Normalized server address: lowercase hostname without a trailing dot,
/// or an IP in its canonical form. IPv6 is stored bare (no brackets).
pub fn norm_host(h: &str) -> Option<String> {
    let h = h.trim().trim_end_matches('.');
    if h.is_empty() || h.chars().count() > HOST_MAX {
        return None;
    }
    if let Ok(v4) = h.parse::<std::net::Ipv4Addr>() {
        return Some(v4.to_string());
    }
    let bare = h.strip_prefix('[').and_then(|x| x.strip_suffix(']')).unwrap_or(h);
    if let Ok(v6) = bare.parse::<std::net::Ipv6Addr>() {
        return Some(v6.to_string());
    }
    if bare.contains(':') {
        return None; // a colon that is not part of an IPv6 address
    }
    let lower = bare.to_ascii_lowercase();
    // Four dot-separated numbers that are not a valid IPv4 address are a
    // typo, not a hostname ("10.0.0.999").
    let numeric = lower.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    if numeric && lower.matches('.').count() >= 3 {
        return None;
    }
    let label_ok = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    };
    if lower.split('.').all(label_ok) {
        Some(lower)
    } else {
        None
    }
}

pub fn valid_port(p: u64) -> bool {
    (1..=65535).contains(&p)
}

/// RFC 3986 userinfo: anything but unreserved is percent-encoded, so a
/// password with '@' or ':' cannot corrupt the URL.
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The proxy_url the core gets for an entry: socks5://[user[:pass]@]host:port.
pub fn url_of(p: &Value) -> Option<String> {
    let host = p["host"].as_str()?;
    let port = p["port"].as_u64().filter(|n| valid_port(*n))?;
    let host = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    let user = p["user"].as_str().unwrap_or("");
    let pass = p["pass"].as_str().unwrap_or("");
    let auth = if user.is_empty() {
        String::new()
    } else {
        format!("{}:{}@", pct(user), pct(pass))
    };
    Some(format!("socks5://{auth}{host}:{port}"))
}

/// The active proxy's URL, if one is selected.
pub fn active_url(s: &Value) -> Option<String> {
    active_id(s).and_then(|id| find(s, id)).and_then(url_of)
}

/// The saved proxy with the same server and username, if any.
pub fn find_duplicate<'a>(s: &'a Value, host: &str, port: u64, user: &str) -> Option<&'a Value> {
    let host = norm_host(host)?;
    proxies(s).iter().find(|p| {
        p["host"].as_str() == Some(host.as_str()) && p["port"].as_u64() == Some(port) && p["user"].as_str().unwrap_or("") == user
    })
}

/// Display label: no control/bidi characters, at most LABEL_MAX characters.
pub fn clean_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| !c.is_control() && !matches!(*c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .collect::<String>()
        .trim()
        .chars()
        .take(LABEL_MAX)
        .collect()
}

/// Adds a proxy. Returns (id, false) for a new entry, or (existing id,
/// true) when the same host+port+user is already saved (nothing changes).
pub fn add(s: &mut Value, host: &str, port: u64, user: &str, pass: &str, label: &str, now: u64) -> Result<(String, bool), String> {
    let host = norm_host(host).ok_or("The proxy server address is not valid")?;
    if !valid_port(port) {
        return Err("The port is not valid".into());
    }
    if user.chars().count() > CRED_MAX || pass.chars().count() > CRED_MAX {
        return Err("The username or password is too long".into());
    }
    // RFC 1929 allows an empty password; a password without a username is
    // meaningless and almost always a malformed link.
    if user.is_empty() && !pass.is_empty() {
        return Err("A password without a username is not valid".into());
    }
    if let Some(d) = find_duplicate(s, &host, port, user) {
        return Ok((d["id"].as_str().unwrap_or_default().to_string(), true));
    }
    if proxies(s).len() >= MAX_PROXIES {
        return Err(format!("Too many saved proxies (max {MAX_PROXIES})"));
    }
    let mut n = s["next"].as_u64().unwrap_or(1).max(1);
    while find(s, &format!("p{n}")).is_some() {
        n += 1;
    }
    let id = format!("p{n}");
    s["next"] = Value::from(n + 1);
    proxies_mut(s).push(json!({
        "id": id.clone(), "label": clean_label(label), "host": host, "port": port,
        "user": user, "pass": pass, "added": now,
    }));
    Ok((id, false))
}

pub fn active_id(s: &Value) -> Option<&str> {
    s["active"].as_str().filter(|id| find(s, id).is_some())
}

pub fn select(s: &mut Value, id: Option<&str>) -> Result<(), String> {
    match id {
        Some(id) if find(s, id).is_none() => Err("No such proxy".into()),
        Some(id) => {
            s["active"] = Value::from(id);
            Ok(())
        }
        None => {
            s["active"] = Value::Null;
            Ok(())
        }
    }
}

pub fn rename(s: &mut Value, id: &str, label: &str) -> Result<(), String> {
    let label = clean_label(label);
    let p = find_mut(s, id).ok_or("No such proxy")?;
    p["label"] = Value::from(label);
    Ok(())
}

/// Removes a proxy. Returns true when it was the active one (now none is).
pub fn delete(s: &mut Value, id: &str) -> Result<bool, String> {
    let list = proxies_mut(s);
    let before = list.len();
    list.retain(|p| p["id"].as_str() != Some(id));
    if list.len() == before {
        return Err("No such proxy".into());
    }
    let was_active = s["active"].as_str() == Some(id);
    if was_active {
        s["active"] = Value::Null;
    }
    Ok(was_active)
}

/// The list for the page: everything but the passwords.
pub fn public_list(s: &Value) -> Value {
    let active = active_id(s);
    let list: Vec<Value> = proxies(s)
        .iter()
        .map(|p| {
            json!({
                "id": p["id"], "label": p["label"], "host": p["host"], "port": p["port"],
                "user": p["user"], "has_pass": p["pass"].as_str().is_some_and(|x| !x.is_empty()),
                "added": p["added"],
                "active": active.is_some() && p["id"].as_str() == active,
            })
        })
        .collect();
    json!({"active": active, "proxies": list})
}

/// What a share link carries: the server, credentials and label.
pub fn link(s: &Value, id: &str) -> Option<Value> {
    let p = find(s, id)?;
    Some(json!({"host": p["host"], "port": p["port"], "user": p["user"], "pass": p["pass"], "label": p["label"]}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_one(s: &mut Value) -> (String, bool) {
        add(s, "Proxy.Example.org.", 1080, "u", "p", "Home", 7).unwrap()
    }

    #[test]
    fn host_normalization() {
        assert_eq!(norm_host(" Proxy.Example.org. ").as_deref(), Some("proxy.example.org"));
        assert_eq!(norm_host("192.168.1.10").as_deref(), Some("192.168.1.10"));
        assert_eq!(norm_host("127.0.0.1").as_deref(), Some("127.0.0.1"));
        assert_eq!(norm_host("[2001:DB8::1]").as_deref(), Some("2001:db8::1"));
        assert_eq!(norm_host("nas").as_deref(), Some("nas"));
        for bad in ["", "10.0.0.999", "-bad.example", "bad-.example", "bad..example", "exa mple.org", "host:1080", &"a".repeat(254)] {
            assert!(norm_host(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn proxy_url_shapes() {
        let mut s = empty();
        let (id, _) = add(&mut s, "proxy.example", 1080, "", "", "", 1).unwrap();
        assert_eq!(url_of(find(&s, &id).unwrap()).as_deref(), Some("socks5://proxy.example:1080"));
        let (id2, _) = add(&mut s, "192.168.1.10", 9050, "me", "p@ss:w/rd", "", 2).unwrap();
        assert_eq!(url_of(find(&s, &id2).unwrap()).as_deref(), Some("socks5://me:p%40ss%3Aw%2Frd@192.168.1.10:9050"));
        let (id3, _) = add(&mut s, "::1", 1080, "", "", "", 3).unwrap();
        assert_eq!(url_of(find(&s, &id3).unwrap()).as_deref(), Some("socks5://[::1]:1080"));
    }

    #[test]
    fn add_dedupes_on_host_port_user() {
        let mut s = empty();
        assert_eq!(add_one(&mut s), ("p1".into(), false));
        // Trailing dot and case: still the same proxy.
        assert_eq!(add(&mut s, "proxy.example.ORG", 1080, "u", "other-pass", "", 2), Ok(("p1".into(), true)));
        // Another password or another user: another proxy.
        assert_eq!(add(&mut s, "proxy.example.org", 1080, "other", "p", "", 3), Ok(("p2".into(), false)));
        assert_eq!(add(&mut s, "proxy.example.org", 1081, "u", "p", "", 4), Ok(("p3".into(), false)));
        assert_eq!(proxies(&s).len(), 3);
    }

    #[test]
    fn add_validates() {
        let mut s = empty();
        assert!(add(&mut s, "not a host", 1080, "", "", "", 1).is_err());
        assert!(add(&mut s, "ok.example", 0, "", "", "", 1).is_err());
        assert!(add(&mut s, "ok.example", 70000, "", "", "", 1).is_err());
        assert!(add(&mut s, "ok.example", 1080, "", "pass-without-user", "", 1).is_err());
        assert!(add(&mut s, "ok.example", 1080, &"u".repeat(200), "", "", 1).is_err());
    }

    #[test]
    fn select_rename_delete() {
        let mut s = empty();
        add_one(&mut s);
        add(&mut s, "other.example", 1080, "", "", "B", 2).unwrap();
        assert!(select(&mut s, Some("nope")).is_err());
        select(&mut s, Some("p2")).unwrap();
        assert_eq!(active_id(&s), Some("p2"));
        assert_eq!(active_url(&s).as_deref(), Some("socks5://other.example:1080"));
        rename(&mut s, "p2", "  Work\u{202e}\n ").unwrap();
        assert_eq!(find(&s, "p2").unwrap()["label"], "Work");
        assert!(rename(&mut s, "p9", "x").is_err());
        assert_eq!(delete(&mut s, "p1"), Ok(false));
        assert_eq!(delete(&mut s, "p2"), Ok(true));
        assert_eq!(active_id(&s), None);
        assert!(delete(&mut s, "p2").is_err());
        // Ids are never reused after a delete.
        assert_eq!(add(&mut s, "c.example", 1080, "", "", "", 3).unwrap().0, "p3");
        select(&mut s, None).unwrap();
        assert_eq!(active_id(&s), None);
    }

    #[test]
    fn public_list_hides_passwords() {
        let mut s = empty();
        add_one(&mut s);
        select(&mut s, Some("p1")).unwrap();
        let p = public_list(&s);
        assert_eq!(p["active"], "p1");
        assert_eq!(p["proxies"][0]["active"], true);
        assert_eq!(p["proxies"][0]["has_pass"], true);
        assert!(p["proxies"][0].get("pass").is_none());
        assert!(!p.to_string().contains("\"p\""));
        assert_eq!(link(&s, "p1").unwrap()["pass"], "p");
    }

    #[test]
    fn label_is_capped() {
        assert_eq!(clean_label(&"x".repeat(100)).chars().count(), LABEL_MAX);
    }
}
