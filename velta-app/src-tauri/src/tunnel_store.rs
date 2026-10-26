//! Saved DNS tunnels (`tunnels.json` in the app's local data dir).
//!
//! Pure functions over the JSON document so the list logic and the upgrade
//! from the old single-tunnel `tunnel.json` are unit-tested on any host.
//!
//! ```json
//! {"version": 1, "active": "t1", "next": 2,
//!  "listen": "127.0.0.1:41234", "user": "…", "pass": "…",
//!  "tunnels": [{"id": "t1", "label": "", "zone": "…", "key": "…",
//!               "resolvers": [], "canaries": [], "mode": "auto", "added": 1700000000}]}
//! ```
//!
//! The local SOCKS5 port and its credentials belong to the store, not to a
//! tunnel: switching tunnels keeps them, so every account's proxy_url stays
//! valid. Keys are stored exactly as before (plain, in the app's private
//! data dir, which only the app can read).

use serde_json::{json, Value};

pub const FILE: &str = "tunnels.json";
pub const LEGACY_FILE: &str = "tunnel.json";
pub const LABEL_MAX: usize = 64;

/// Per-tunnel fields copied from a parsed link / the legacy config.
const TUNNEL_FIELDS: [&str; 5] = ["zone", "key", "resolvers", "canaries", "mode"];
/// Store-wide fields (the local proxy) taken from the legacy config.
const PROXY_FIELDS: [&str; 3] = ["listen", "user", "pass"];

pub fn empty() -> Value {
    json!({"version": 1, "active": null, "next": 1, "tunnels": []})
}

/// Builds the store from the old single-tunnel config: one saved tunnel, active.
pub fn migrate(legacy: &Value, label: &str, now: u64) -> Value {
    let mut s = empty();
    for k in PROXY_FIELDS {
        if let Some(v) = legacy.get(k).filter(|v| !v.is_null()) {
            s[k] = v.clone();
        }
    }
    if legacy["zone"].as_str().is_some_and(|z| !z.is_empty()) && legacy["key"].as_str().is_some_and(|k| !k.is_empty()) {
        let (id, _) = add(&mut s, legacy, label, now);
        s["active"] = Value::from(id);
    }
    s
}

/// Same key whatever base64 flavour or padding the link used.
pub fn key_norm(k: &str) -> String {
    k.trim().trim_end_matches('=').replace('-', "+").replace('_', "/")
}

pub fn tunnels(s: &Value) -> &[Value] {
    s["tunnels"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn tunnels_mut(s: &mut Value) -> &mut Vec<Value> {
    if !s["tunnels"].is_array() {
        s["tunnels"] = json!([]);
    }
    s["tunnels"].as_array_mut().unwrap()
}

pub fn find<'a>(s: &'a Value, id: &str) -> Option<&'a Value> {
    tunnels(s).iter().find(|t| t["id"].as_str() == Some(id))
}

fn find_mut<'a>(s: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    tunnels_mut(s).iter_mut().find(|t| t["id"].as_str() == Some(id))
}

/// The saved tunnel with the same server zone and key, if any.
pub fn find_duplicate<'a>(s: &'a Value, zone: &str, key: &str) -> Option<&'a Value> {
    let zone = zone.trim().trim_end_matches('.').to_ascii_lowercase();
    let key = key_norm(key);
    tunnels(s).iter().find(|t| {
        t["zone"].as_str().map(|z| z.trim_end_matches('.').to_ascii_lowercase()) == Some(zone.clone())
            && t["key"].as_str().map(key_norm) == Some(key.clone())
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

/// Adds a tunnel from a parsed link config. Returns (id, false) for a new
/// entry, or (existing id, true) when the same zone+key is already saved
/// (nothing changes then).
pub fn add(s: &mut Value, cfg: &Value, label: &str, now: u64) -> (String, bool) {
    if let Some(d) = find_duplicate(s, cfg["zone"].as_str().unwrap_or(""), cfg["key"].as_str().unwrap_or("")) {
        return (d["id"].as_str().unwrap_or_default().to_string(), true);
    }
    let n = s["next"].as_u64().unwrap_or(1).max(1);
    let mut n = n;
    while find(s, &format!("t{n}")).is_some() {
        n += 1;
    }
    let id = format!("t{n}");
    s["next"] = Value::from(n + 1);
    let mut t = json!({"id": id, "label": clean_label(label), "added": now});
    for k in TUNNEL_FIELDS {
        t[k] = cfg.get(k).cloned().unwrap_or(Value::Null);
    }
    if !t["resolvers"].is_array() {
        t["resolvers"] = json!([]);
    }
    if !t["canaries"].is_array() {
        t["canaries"] = json!([]);
    }
    if !t["mode"].is_string() {
        t["mode"] = Value::from("auto");
    }
    tunnels_mut(s).push(t);
    // The first SOCKS credentials win: later tunnels reuse the same proxy.
    for k in ["user", "pass"] {
        if s[k].as_str().is_none_or(str::is_empty) {
            if let Some(v) = cfg.get(k).filter(|v| v.is_string()) {
                s[k] = v.clone();
            }
        }
    }
    (id, false)
}

pub fn active_id(s: &Value) -> Option<&str> {
    s["active"].as_str().filter(|id| find(s, id).is_some())
}

pub fn select(s: &mut Value, id: Option<&str>) -> Result<(), String> {
    match id {
        Some(id) if find(s, id).is_none() => Err("No such tunnel".into()),
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
    let t = find_mut(s, id).ok_or("No such tunnel")?;
    t["label"] = Value::from(label);
    Ok(())
}

pub fn set_mode(s: &mut Value, id: &str, mode: &str) -> Result<(), String> {
    let t = find_mut(s, id).ok_or("No such tunnel")?;
    t["mode"] = Value::from(mode);
    Ok(())
}

/// Removes a tunnel. Returns true when it was the active one (now none is).
pub fn delete(s: &mut Value, id: &str) -> Result<bool, String> {
    let list = tunnels_mut(s);
    let before = list.len();
    list.retain(|t| t["id"].as_str() != Some(id));
    if list.len() == before {
        return Err("No such tunnel".into());
    }
    let was_active = s["active"].as_str() == Some(id);
    if was_active {
        s["active"] = Value::Null;
    }
    Ok(was_active)
}

/// The config the library starts with: the tunnel plus the shared proxy.
pub fn run_config(s: &Value, id: &str) -> Option<Value> {
    let t = find(s, id)?;
    let mut cfg = json!({});
    for k in TUNNEL_FIELDS {
        cfg[k] = t[k].clone();
    }
    for k in PROXY_FIELDS {
        if let Some(v) = s.get(k).filter(|v| v.is_string()) {
            cfg[k] = v.clone();
        }
    }
    if cfg["canaries"].as_array().is_some_and(Vec::is_empty) {
        cfg.as_object_mut().unwrap().remove("canaries");
    }
    Some(cfg)
}

/// The list for the page: everything but the keys.
pub fn public_list(s: &Value) -> Value {
    let active = active_id(s);
    let list: Vec<Value> = tunnels(s)
        .iter()
        .map(|t| {
            json!({
                "id": t["id"], "label": t["label"], "zone": t["zone"],
                "resolvers": t["resolvers"], "canaries": t["canaries"],
                "mode": t["mode"], "added": t["added"],
                "active": active.is_some() && t["id"].as_str() == active,
            })
        })
        .collect();
    json!({"active": active, "tunnels": list})
}

/// What a share link carries: only the values the original link did.
pub fn link(s: &Value, id: &str) -> Option<Value> {
    let t = find(s, id)?;
    Some(json!({"zone": t["zone"], "key": t["key"], "resolvers": t["resolvers"], "canaries": t["canaries"], "label": t["label"]}))
}

#[cfg(test)]
mod tests {
    use super::*;

    const K1: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const K2: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=";

    fn cfg(zone: &str, key: &str) -> Value {
        json!({"zone": zone, "key": key, "resolvers": ["192.0.2.1"], "canaries": [], "user": "u", "pass": "p"})
    }

    #[test]
    fn migrates_legacy_single_tunnel() {
        let legacy = json!({"zone": "t.example.org", "key": K1, "resolvers": ["192.0.2.1:53"], "mode": "always",
            "listen": "127.0.0.1:41234", "user": "velta-tunnel", "pass": "secret"});
        let s = migrate(&legacy, "Home", 7);
        assert_eq!(tunnels(&s).len(), 1);
        assert_eq!(active_id(&s), Some("t1"));
        assert_eq!(s["listen"], "127.0.0.1:41234");
        let run = run_config(&s, "t1").unwrap();
        assert_eq!(run["zone"], "t.example.org");
        assert_eq!(run["key"], K1);
        assert_eq!(run["mode"], "always");
        assert_eq!(run["listen"], "127.0.0.1:41234");
        assert_eq!(run["user"], "velta-tunnel");
        assert_eq!(run["pass"], "secret");
        assert_eq!(find(&s, "t1").unwrap()["label"], "Home");
        assert_eq!(find(&s, "t1").unwrap()["added"], 7);
    }

    #[test]
    fn migrate_of_garbage_is_empty() {
        let s = migrate(&json!({"listen": "127.0.0.1:1"}), "", 0);
        assert!(tunnels(&s).is_empty());
        assert_eq!(active_id(&s), None);
    }

    #[test]
    fn add_dedupes_on_zone_and_key() {
        let mut s = empty();
        assert_eq!(add(&mut s, &cfg("a.example.org", K1), "A", 1), ("t1".into(), false));
        assert_eq!(add(&mut s, &cfg("b.example.org", K1), "B", 2), ("t2".into(), false));
        // URL-safe, unpadded, different case and trailing dot: still the same tunnel.
        let same = cfg("A.example.org.", K1.trim_end_matches('='));
        assert_eq!(add(&mut s, &same, "", 3), ("t1".into(), true));
        assert_eq!(add(&mut s, &cfg("a.example.org", K2), "", 4), ("t3".into(), false));
        assert_eq!(tunnels(&s).len(), 3);
        // Credentials come from the first link only.
        assert_eq!(s["user"], "u");
    }

    #[test]
    fn select_rename_mode_delete() {
        let mut s = empty();
        add(&mut s, &cfg("a.example.org", K1), "A", 1);
        add(&mut s, &cfg("b.example.org", K2), "B", 2);
        assert!(select(&mut s, Some("nope")).is_err());
        select(&mut s, Some("t2")).unwrap();
        assert_eq!(active_id(&s), Some("t2"));
        rename(&mut s, "t2", "  Work\u{202e}\n ").unwrap();
        assert_eq!(find(&s, "t2").unwrap()["label"], "Work");
        assert!(rename(&mut s, "t9", "x").is_err());
        set_mode(&mut s, "t2", "off").unwrap();
        assert_eq!(run_config(&s, "t2").unwrap()["mode"], "off");
        assert_eq!(delete(&mut s, "t1"), Ok(false));
        assert_eq!(active_id(&s), Some("t2"));
        assert_eq!(delete(&mut s, "t2"), Ok(true));
        assert_eq!(active_id(&s), None);
        assert!(delete(&mut s, "t2").is_err());
        // Ids are never reused after a delete.
        assert_eq!(add(&mut s, &cfg("c.example.org", K1), "", 3).0, "t3");
        select(&mut s, None).unwrap();
        assert_eq!(active_id(&s), None);
    }

    #[test]
    fn public_list_hides_keys() {
        let mut s = empty();
        add(&mut s, &cfg("a.example.org", K1), "A", 1);
        select(&mut s, Some("t1")).unwrap();
        let p = public_list(&s);
        assert_eq!(p["active"], "t1");
        assert_eq!(p["tunnels"][0]["active"], true);
        assert!(p["tunnels"][0].get("key").is_none());
        assert!(!p.to_string().contains(K1));
        assert_eq!(link(&s, "t1").unwrap()["key"], K1);
    }

    #[test]
    fn label_is_capped() {
        assert_eq!(clean_label(&"x".repeat(100)).chars().count(), LABEL_MAX);
    }
}
