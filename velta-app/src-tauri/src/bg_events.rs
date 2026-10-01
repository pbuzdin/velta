//! Background event poller plumbing (Android; #21 / #22 / #25).
//!
//! The Rust background poller and the WebView both long-poll the core's
//! single event queue (`get_next_event_batch`). A parked request cannot be
//! cancelled in the core: whoever's request is parked receives the next
//! batch. So a "bg-" round-trip whose caller gave up (timeout, cancelled
//! task) must never keep a stale registration, and an event batch that
//! reaches Rust with nobody waiting for it must be handed to the WebView
//! instead of being dropped silently.
//!
//! Platform-neutral on purpose, so the logic is unit-tested on desktop.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

pub type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>;

/// Request-id prefix of the background poller's `get_next_event_batch`
/// calls (a sub-prefix of the generic "bg-" round-trips).
pub const EVENT_BATCH_ID_PREFIX: &str = "bg-ev-";

/// JSON-RPC notification method the WebView's rpc-core dispatches exactly
/// like the result of its own event poll (see `_onLine` in rpc-core.js).
pub const FORWARDED_EVENTS_METHOD: &str = "velta_core_events";

pub fn is_event_batch_id(id: &str) -> bool {
    id.starts_with(EVENT_BATCH_ID_PREFIX)
}

/// Registration of one in-flight "bg-" round-trip. Dropping it — normal
/// completion, timeout or a cancelled future — removes the entry, so a
/// response that arrives later is recognised as orphaned (see [`deliver`])
/// instead of being "delivered" into a dead receiver and lost.
pub struct PendingGuard {
    map: PendingMap,
    id: String,
}

impl PendingGuard {
    pub fn register(map: &PendingMap, id: String) -> (Self, oneshot::Receiver<String>) {
        let (tx, rx) = oneshot::channel();
        map.lock().unwrap().insert(id.clone(), tx);
        (PendingGuard { map: map.clone(), id }, rx)
    }
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.map.lock() {
            map.remove(&self.id);
        }
    }
}

/// Hands a "bg-" response line to its waiting caller. Returns the line back
/// when nobody is waiting any more (never registered, gave up, or dropped
/// its receiver in between), so the caller can salvage it.
pub fn deliver(map: &PendingMap, id: &str, line: String) -> Option<String> {
    let sender = map.lock().unwrap().remove(id);
    match sender {
        Some(sender) => sender.send(line).err(),
        None => Some(line),
    }
}

/// Wraps an event batch as a JSON-RPC notification for the WebView.
/// `None` for anything that is not a non-empty batch.
pub fn forwarded_events_from_result(result: &serde_json::Value) -> Option<String> {
    let batch = result.as_array().filter(|b| !b.is_empty())?;
    Some(
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": FORWARDED_EVENTS_METHOD,
            "params": [batch],
        })
        .to_string(),
    )
}

/// Same, from a raw `get_next_event_batch` response line (an error
/// response or garbage yields `None`).
pub fn forwarded_events_line(response_line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(response_line).ok()?;
    if value.get("error").is_some() {
        return None;
    }
    forwarded_events_from_result(value.get("result")?)
}

/// The background poller must sleep only while the page can drain events
/// itself. Android Home often leaves the page flag true and freezes JS;
/// the activity flag covers that.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn background_poller_paused(js_visible: bool, activity_foreground: bool) -> bool {
    js_visible && activity_foreground
}

/// IncomingMsg hits in a JSON-RPC response line (a get_next_event_batch
/// result, or a single event). Empty when the line is not an event batch.
/// The page's poll and the Rust poller share one core queue; a response
/// that belongs to the frozen WebView still has to be notified.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn incoming_hits(response_line: &str) -> Vec<(u32, u32, u32)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(response_line) else {
        return Vec::new();
    };
    if value.get("error").is_some() {
        return Vec::new();
    }
    let Some(result) = value.get("result") else {
        return Vec::new();
    };
    let mut hits = Vec::new();
    let mut push = |ev: &serde_json::Value| {
        if ev.pointer("/event/kind").and_then(|k| k.as_str()) != Some("IncomingMsg") {
            return;
        }
        let msg_id = ev.pointer("/event/msgId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        if msg_id == 0 {
            return;
        }
        hits.push((
            ev.get("contextId").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            ev.pointer("/event/chatId").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            msg_id,
        ));
    };
    if let Some(arr) = result.as_array() {
        for ev in arr {
            push(ev);
        }
    } else {
        push(result);
    }
    hits
}

/// Routing of one background event-batch response while the UI is
/// visible: the WebView gets the events (as a notification, emitted by the
/// response forwarder itself so it stays ordered before any later response
/// to the WebView's own poll), and the Rust poller gets an empty batch so it
/// notifies nothing. Hidden UI: the poller gets the batch unchanged.
/// Returns (line to emit to the WebView, line to deliver to the poller).
pub fn route_event_batch(id: &str, response_line: String, ui_visible: bool) -> (Option<String>, String) {
    if !ui_visible {
        return (None, response_line);
    }
    match forwarded_events_line(&response_line) {
        Some(fwd) => (
            Some(fwd),
            serde_json::json!({"jsonrpc": "2.0", "id": id, "result": []}).to_string(),
        ),
        None => (None, response_line),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map() -> PendingMap {
        Arc::new(Mutex::new(HashMap::new()))
    }

    const BATCH: &str = r#"{"jsonrpc":"2.0","id":"bg-ev-3","result":[{"contextId":1,"event":{"kind":"IncomingMsg","chatId":10,"msgId":20}},{"contextId":1,"event":{"kind":"MsgsNoticed","chatId":10}}]}"#;

    #[test]
    fn live_response_reaches_its_caller() {
        let pending = map();
        let (guard, mut rx) = PendingGuard::register(&pending, "bg-1".into());
        assert_eq!(deliver(&pending, "bg-1", "line".into()), None);
        assert_eq!(rx.try_recv().unwrap(), "line");
        drop(guard);
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn a_timed_out_caller_leaves_no_entry_and_its_late_response_is_returned() {
        let pending = map();
        let (guard, rx) = PendingGuard::register(&pending, "bg-ev-3".into());
        // tokio::time::timeout drops the receiver future and then the guard.
        drop(rx);
        drop(guard);
        assert!(pending.lock().unwrap().is_empty(), "the timed-out request must be cleared");
        assert_eq!(deliver(&pending, "bg-ev-3", BATCH.into()).as_deref(), Some(BATCH));
    }

    #[test]
    fn a_receiver_dropped_between_lookup_and_send_still_returns_the_line() {
        let pending = map();
        let (guard, rx) = PendingGuard::register(&pending, "bg-ev-4".into());
        drop(rx); // caller gone, guard not yet dropped
        assert_eq!(deliver(&pending, "bg-ev-4", BATCH.into()).as_deref(), Some(BATCH));
        drop(guard);
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn orphaned_batch_is_forwarded_as_a_notification_in_order() {
        let fwd = forwarded_events_line(BATCH).expect("batch forwarded");
        let v: serde_json::Value = serde_json::from_str(&fwd).unwrap();
        assert_eq!(v["method"], FORWARDED_EVENTS_METHOD);
        assert!(v.get("id").is_none(), "a notification, not a response");
        let kinds: Vec<&str> = v["params"][0]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["event"]["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["IncomingMsg", "MsgsNoticed"]);
    }

    #[test]
    fn errors_empty_batches_and_garbage_are_not_forwarded() {
        assert_eq!(forwarded_events_line(r#"{"jsonrpc":"2.0","id":"bg-ev-1","error":{"code":-1,"message":"x"}}"#), None);
        assert_eq!(forwarded_events_line(r#"{"jsonrpc":"2.0","id":"bg-ev-1","result":[]}"#), None);
        assert_eq!(forwarded_events_line(r#"{"jsonrpc":"2.0","id":"bg-ev-1","result":null}"#), None);
        assert_eq!(forwarded_events_line("not json"), None);
    }

    #[test]
    fn visible_ui_takes_the_batch_and_the_poller_gets_nothing_to_notify() {
        let (fwd, to_poller) = route_event_batch("bg-ev-3", BATCH.into(), true);
        let fwd: serde_json::Value = serde_json::from_str(&fwd.expect("forwarded")).unwrap();
        assert_eq!(fwd["params"][0].as_array().unwrap().len(), 2);
        let to_poller: serde_json::Value = serde_json::from_str(&to_poller).unwrap();
        assert_eq!(to_poller["id"], "bg-ev-3");
        assert_eq!(to_poller["result"], serde_json::json!([]));
    }

    #[test]
    fn hidden_ui_leaves_the_batch_to_the_poller() {
        assert_eq!(route_event_batch("bg-ev-3", BATCH.into(), false), (None, BATCH.to_string()));
        let err = r#"{"jsonrpc":"2.0","id":"bg-ev-1","error":{"code":-1,"message":"x"}}"#;
        assert_eq!(route_event_batch("bg-ev-1", err.into(), true), (None, err.to_string()));
    }

    #[test]
    fn the_poller_pauses_only_while_the_page_and_the_activity_are_up() {
        assert!(background_poller_paused(true, true));
        assert!(!background_poller_paused(true, false));
        assert!(!background_poller_paused(false, true));
        assert!(!background_poller_paused(false, false));
    }

    #[test]
    fn incoming_hits_reads_a_batch_and_ignores_everything_else() {
        assert_eq!(incoming_hits(BATCH), vec![(1, 10, 20)]);
        let numeric = BATCH.replacen("\"bg-ev-3\"", "7", 1);
        assert_eq!(incoming_hits(&numeric), vec![(1, 10, 20)]);
        assert!(incoming_hits(r#"{"jsonrpc":"2.0","id":1,"result":{"id":5}}"#).is_empty());
        assert!(incoming_hits(r#"{"jsonrpc":"2.0","id":1,"error":{"message":"x"}}"#).is_empty());
        assert!(incoming_hits("not json").is_empty());
    }

    #[test]
    fn event_batch_ids_are_recognised() {
        assert!(is_event_batch_id("bg-ev-12"));
        assert!(!is_event_batch_id("bg-12"));
        assert!(!is_event_batch_id("wxdc-1"));
    }
}
