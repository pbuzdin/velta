//! Scheduled messages ("Send later") — `scheduled.json` in the app's private
//! data dir. Mirrors `app/js/scheduled.js` (applyOp / dueItems / nextWake)
//! so the page and the Android alarm path share one document and one set of
//! rules. Pure functions over `serde_json::Value`, unit-tested on any host.
//! docs/scheduled-messages.md.

use serde_json::{json, Value};

pub const FILE: &str = "scheduled.json";
pub const TEXT_MAX: usize = 64 * 1024;
pub const STALE_SENDING_MS: i64 = 2 * 60 * 1000;
const BACKOFF_MS: [i64; 4] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

pub fn empty() -> Value {
    json!({"version": 1, "items": []})
}

pub fn backoff_ms(attempts: i64) -> i64 {
    BACKOFF_MS[(attempts.clamp(1, BACKOFF_MS.len() as i64) - 1) as usize]
}

pub fn normalize(doc: Value) -> Value {
    match doc.get("items").and_then(Value::as_array) {
        Some(items) => {
            let items: Vec<Value> = items.iter().filter(|it| it["id"].is_string()).cloned().collect();
            json!({"version": 1, "items": items})
        }
        None => empty(),
    }
}

fn items_mut(doc: &mut Value) -> &mut Vec<Value> {
    if !doc["items"].is_array() {
        doc["items"] = json!([]);
    }
    doc["items"].as_array_mut().unwrap()
}

fn items(doc: &Value) -> &[Value] {
    doc["items"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn status(it: &Value) -> &str {
    it["status"].as_str().unwrap_or("")
}

fn uncertain(it: &Value) -> bool {
    it["uncertain"].as_bool().unwrap_or(false)
}

fn i(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().map(|f| f.round() as i64))
}

fn valid_text(t: &str) -> bool {
    !t.trim().is_empty() && t.encode_utf16().count() <= TEXT_MAX
}

/// Apply one op (see scheduled.js applyOp); returns the op result.
/// `new_id` is injected so tests are deterministic.
pub fn apply(doc: &mut Value, op: &Value, now: i64, new_id: impl FnOnce() -> String) -> Value {
    let id = op["id"].as_str().unwrap_or("").to_string();
    let find = |doc: &mut Value| -> Option<usize> { items_mut(doc).iter().position(|it| it["id"].as_str() == Some(id.as_str())) };
    match op["op"].as_str().unwrap_or("") {
        "list" => json!(true),
        "add" => {
            let src = &op["item"];
            let text = src["text"].as_str().unwrap_or("");
            let (Some(due), Some(acc), Some(chat)) = (i(&src["dueAt"]), i(&src["accountId"]), i(&src["chatId"])) else {
                return json!({"error": "bad item"});
            };
            if !valid_text(text) || due <= 0 {
                return json!({"error": "empty or too long"});
            }
            let nid = new_id();
            items_mut(doc).push(json!({
                "id": nid, "accountId": acc, "chatId": chat, "text": text,
                "quoteId": i(&src["quoteId"]), "dueAt": due, "createdAt": now,
                "status": "pending", "error": null, "attempts": 0, "retryAt": null,
                "claimedAt": null, "uncertain": false,
            }));
            json!({"id": nid})
        }
        "update" => {
            let Some(ix) = find(doc) else { return json!(false) };
            let it = &mut items_mut(doc)[ix];
            if status(it) == "sending" {
                return json!(false);
            }
            if let Some(t) = op["text"].as_str() {
                if !valid_text(t) {
                    return json!(false);
                }
                it["text"] = json!(t);
            }
            if !op["dueAt"].is_null() {
                match i(&op["dueAt"]) {
                    Some(d) if d > 0 => it["dueAt"] = json!(d),
                    _ => return json!(false),
                }
            }
            it["status"] = json!("pending");
            it["error"] = Value::Null;
            it["retryAt"] = Value::Null;
            it["uncertain"] = json!(false);
            json!(true)
        }
        "remove" => {
            let Some(ix) = find(doc) else { return json!(false) };
            if status(&items(doc)[ix]) == "sending" {
                return json!(false);
            }
            items_mut(doc).remove(ix);
            json!(true)
        }
        "claim" => {
            let Some(ix) = find(doc) else { return json!(false) };
            let it = &mut items_mut(doc)[ix];
            if status(it) == "sending" || uncertain(it) {
                return json!(false);
            }
            it["status"] = json!("sending");
            it["claimedAt"] = json!(now);
            json!(true)
        }
        "done" => {
            let Some(ix) = find(doc) else { return json!(false) };
            items_mut(doc).remove(ix);
            json!(true)
        }
        "fail" => {
            let Some(ix) = find(doc) else { return json!(false) };
            let unc = op["uncertain"].as_bool().unwrap_or(false);
            let err: String = op["error"].as_str().unwrap_or("Send failed").chars().take(300).collect();
            let it = &mut items_mut(doc)[ix];
            let attempts = it["attempts"].as_i64().unwrap_or(0) + 1;
            it["attempts"] = json!(attempts);
            it["status"] = json!("error");
            it["error"] = json!(err);
            it["claimedAt"] = Value::Null;
            it["uncertain"] = json!(unc);
            it["retryAt"] = if unc { Value::Null } else { json!(now + backoff_ms(attempts)) };
            json!(true)
        }
        "recover" => {
            let mut n = 0;
            for it in items_mut(doc).iter_mut() {
                let claimed = it["claimedAt"].as_i64().unwrap_or(0);
                if status(it) == "sending" && now - claimed >= STALE_SENDING_MS {
                    it["status"] = json!("error");
                    it["error"] = json!("Interrupted while sending — check the chat before sending again");
                    it["uncertain"] = json!(true);
                    it["retryAt"] = Value::Null;
                    it["claimedAt"] = Value::Null;
                    n += 1;
                }
            }
            json!(n)
        }
        _ => json!(false),
    }
}

/// Due items, oldest first (see scheduled.js dueItems).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn due(doc: &Value, now: i64, wake: bool) -> Vec<Value> {
    let mut v: Vec<Value> = items(doc)
        .iter()
        .filter(|it| {
            let due_at = it["dueAt"].as_i64().unwrap_or(i64::MAX);
            due_at <= now
                && match status(it) {
                    "pending" => true,
                    "error" => !uncertain(it) && (wake || it["retryAt"].as_i64().unwrap_or(0) <= now),
                    _ => false,
                }
        })
        .cloned()
        .collect();
    v.sort_by_key(|it| (it["dueAt"].as_i64().unwrap_or(0), it["createdAt"].as_i64().unwrap_or(0)));
    v
}

/// Next wakeup instant (UTC ms), if any.
/// Reference for ScheduledAlarm.kt nextWake (Kotlin arms the alarm itself).
#[allow(dead_code)]
pub fn next_wake(doc: &Value) -> Option<i64> {
    items(doc)
        .iter()
        .filter_map(|it| {
            let d = it["dueAt"].as_i64()?;
            match status(it) {
                "pending" => Some(d),
                "error" if !uncertain(it) => Some(d.max(it["retryAt"].as_i64().unwrap_or(d))),
                _ => None,
            }
        })
        .min()
}

/// send_msg params exactly as rpc-core.js sendMessage builds them for text.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn send_params(it: &Value) -> Value {
    let q = it["quoteId"].clone();
    json!([it["accountId"], it["chatId"], {"text": it["text"], "quotedMessageId": q, "quoted_message_id": q}])
}

/// Errors where the core may already have queued the message.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn is_uncertain_error(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    ["timed out", "timeout", "dropped", "closed", "restart", "not running", "disconnect"].iter().any(|k| e.contains(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add(doc: &mut Value, id: &str, due: i64) {
        let r = apply(doc, &json!({"op": "add", "item": {"accountId": 1, "chatId": 10, "text": "hi", "dueAt": due}}), 0, || id.to_string());
        assert_eq!(r["id"], id);
    }

    #[test]
    fn claim_is_exclusive_and_done_removes() {
        let mut d = empty();
        add(&mut d, "a", 100);
        assert_eq!(due(&d, 100, false).len(), 1);
        assert_eq!(apply(&mut d, &json!({"op": "claim", "id": "a"}), 100, String::new), json!(true));
        assert_eq!(apply(&mut d, &json!({"op": "claim", "id": "a"}), 100, String::new), json!(false));
        assert!(due(&d, 200, true).is_empty());
        assert_eq!(apply(&mut d, &json!({"op": "update", "id": "a", "text": "x"}), 100, String::new), json!(false));
        assert_eq!(apply(&mut d, &json!({"op": "done", "id": "a"}), 100, String::new), json!(true));
        assert!(items(&d).is_empty());
    }

    #[test]
    fn fail_backoff_and_uncertain() {
        let mut d = empty();
        add(&mut d, "a", 100);
        apply(&mut d, &json!({"op": "claim", "id": "a"}), 100, String::new);
        apply(&mut d, &json!({"op": "fail", "id": "a", "error": "x"}), 100, String::new);
        assert!(due(&d, 101, false).is_empty());
        assert_eq!(due(&d, 101, true).len(), 1);
        assert_eq!(next_wake(&d), Some(100 + 60_000));
        apply(&mut d, &json!({"op": "claim", "id": "a"}), 200, String::new);
        assert_eq!(apply(&mut d, &json!({"op": "recover"}), 200 + STALE_SENDING_MS, String::new), json!(1));
        assert!(due(&d, i64::MAX - 1, true).is_empty());
        assert_eq!(next_wake(&d), None);
        assert_eq!(apply(&mut d, &json!({"op": "claim", "id": "a"}), 0, String::new), json!(false));
        apply(&mut d, &json!({"op": "update", "id": "a", "dueAt": 5}), 0, String::new);
        assert_eq!(due(&d, 5, false).len(), 1);
    }

    #[test]
    fn send_params_match_rpc_core() {
        let mut d = empty();
        add(&mut d, "a", 1);
        let p = send_params(&items(&d)[0]);
        assert_eq!(p, json!([1, 10, {"text": "hi", "quotedMessageId": null, "quoted_message_id": null}]));
        assert!(is_uncertain_error("bg rpc timed out"));
        assert!(!is_uncertain_error("bg rpc error: chat not found"));
    }
}
