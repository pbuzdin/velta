//! Velta Loop command bridge (#332).
//!
//! A second JNI channel beside the core session. No listening port: Kotlin
//! calls `sendLoopLine`, events call `RpcShim.onLoopLine`. The engine binds
//! its LAN socket only after `start_loop` — the pref gate lives in Kotlin.
//!
//! ponytail: file send and unpair copy or delete on a blocking thread.
//! Add/remove member and file retry stay in the engine.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::runtime::Runtime;
use tokio::sync::{mpsc, Notify};

use crate::p2p::{P2p, Sink};

static LOOP_SERVING: AtomicBool = AtomicBool::new(false);
static LOOP_LOCK: Mutex<()> = Mutex::new(());
static LOOP_WORKER: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static LOOP_IN: Mutex<Option<mpsc::UnboundedSender<String>>> = Mutex::new(None);
static LOOP_STOP: std::sync::RwLock<Option<Arc<Notify>>> = std::sync::RwLock::new(None);

struct LoopGuard;

impl Drop for LoopGuard {
    fn drop(&mut self) {
        LOOP_SERVING.store(false, Ordering::SeqCst);
        if let Ok(mut live) = LOOP_IN.lock() {
            *live = None;
        }
        crate::jni_on_loop_exit();
    }
}

pub fn start_loop(dir: String) -> i32 {
    let _guard = LOOP_LOCK.lock().expect("loop start");
    if LOOP_SERVING.load(Ordering::SeqCst) {
        return 1;
    }
    if let Some(prev) = LOOP_WORKER.lock().expect("loop worker").take() {
        let _ = prev.join();
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let stop = Arc::new(Notify::new());
    *LOOP_STOP.write().expect("loop stop") = Some(stop.clone());
    *LOOP_IN.lock().expect("loop in") = Some(tx);
    LOOP_SERVING.store(true, Ordering::SeqCst);
    match std::thread::Builder::new()
        .name("velta-loop".into())
        .spawn(move || worker(dir, rx, stop))
    {
        Ok(handle) => {
            *LOOP_WORKER.lock().expect("loop worker") = Some(handle);
            1
        }
        Err(e) => {
            crate::log(&format!("loop thread: {e}"));
            LOOP_SERVING.store(false, Ordering::SeqCst);
            *LOOP_IN.lock().expect("loop in") = None;
            -1
        }
    }
}

pub fn stop_loop() -> i32 {
    let _guard = LOOP_LOCK.lock().expect("loop stop");
    LOOP_SERVING.store(false, Ordering::SeqCst);
    if let Some(stop) = LOOP_STOP.write().expect("loop stop").take() {
        stop.notify_one();
    }
    if let Ok(mut live) = LOOP_IN.lock() {
        *live = None;
    }
    if let Some(handle) = LOOP_WORKER.lock().expect("loop worker").take() {
        let _ = handle.join();
    }
    0
}

pub fn send_loop_line(line: String) -> i32 {
    if !LOOP_SERVING.load(Ordering::SeqCst) {
        return -1;
    }
    let tx = match LOOP_IN.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return -1,
    };
    match tx {
        Some(tx) if tx.send(line).is_ok() => 0,
        _ => -1,
    }
}

fn worker(dir: String, mut incoming: mpsc::UnboundedReceiver<String>, stop: Arc<Notify>) {
    let _guard = LoopGuard;
    let rt = match Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            crate::log(&format!("loop runtime: {e}"));
            fail_queued(&mut incoming, &e.to_string());
            return;
        }
    };
    rt.block_on(async move {
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let accounts = PathBuf::from(&dir);
        let engine = match P2p::start(
            accounts.join("p2p"),
            accounts.join("p2p-blobs"),
            Sink::Events(ev_tx),
        )
        .await
        {
            Ok(engine) => engine,
            Err(e) => {
                crate::log(&format!("loop start failed: {e:#}"));
                fail_queued(&mut incoming, &e.to_string());
                return;
            }
        };
        loop {
            tokio::select! {
                biased;
                _ = stop.notified() => break,
                ev = ev_rx.recv() => match ev {
                    Some(value) => {
                        let line = json!({
                            "jsonrpc": "2.0",
                            "method": "p2p-event",
                            "params": value,
                        })
                        .to_string();
                        crate::jni_on_loop_line(&line);
                    }
                    None => break,
                },
                cmd = incoming.recv() => match cmd {
                    Some(line) => {
                        let engine = engine.clone();
                        tokio::spawn(async move {
                            if let Some(resp) = dispatch(&engine, &line).await {
                                crate::jni_on_loop_line(&resp);
                            }
                        });
                    }
                    None => break,
                },
            }
        }
        engine.close().await;
    });
}

fn fail_queued(incoming: &mut mpsc::UnboundedReceiver<String>, msg: &str) {
    while let Ok(line) = incoming.try_recv() {
        if let Some(resp) = error_for_line(&line, msg) {
            crate::jni_on_loop_line(&resp);
        }
    }
}

async fn dispatch(engine: &Arc<P2p>, line: &str) -> Option<String> {
    let obj: Value = serde_json::from_str(line).ok()?;
    let id = obj.get("id")?.clone();
    let method = obj.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = obj.get("params").cloned().unwrap_or(Value::Array(vec![]));
    let result = call(engine, method, &params).await;
    Some(match result {
        Ok(value) => ok_line(&id, value),
        Err(e) => error_line(&id, &e.to_string()),
    })
}

async fn call(engine: &Arc<P2p>, method: &str, params: &Value) -> Result<Value> {
    match method {
        "p2p_status" => Ok(engine.status()),
        "p2p_create_invite" => engine.create_invite().await.map(Value::String),
        "p2p_accept_invite" => engine.accept_invite(&arg(params, 0)).await,
        "p2p_pair_nearby" => engine.pair_nearby(&arg(params, 0)).await,
        "p2p_approve_pair" => engine
            .approve_pair(&arg(params, 0), bool_at(params, 1))
            .map(|_| Value::Null),
        "p2p_send" => engine.send(
            &arg(params, 0),
            &arg(params, 1),
            opt_str(params, 2).as_deref(),
            opt_str(params, 3).as_deref(),
        ),
        "p2p_messages" => engine
            .messages(&arg(params, 0), limit_at(params, 1))
            .map(Value::Array),
        "p2p_typing_peer" => engine
            .typing_peer(&arg(params, 0), bool_at(params, 1))
            .map(Value::Bool),
        "p2p_typing_group" => engine
            .typing_group(&arg(params, 0), bool_at(params, 1))
            .map(|n| Value::from(n as u64)),
        "p2p_group_create" => {
            let ids = str_list(params, 1);
            engine.group_create(&arg(params, 0), &ids)
        }
        "p2p_group_send" => engine.group_send(
            &arg(params, 0),
            &arg(params, 1),
            opt_str(params, 2).as_deref(),
            opt_str(params, 3).as_deref(),
        ),
        "p2p_group_messages" => engine
            .group_messages(&arg(params, 0), limit_at(params, 1))
            .map(Value::Array),
        "p2p_set_name" => engine.set_name(arg(params, 0)).map(|_| Value::Null),
        "p2p_peer_groups" => engine.peer_group_impact(&arg(params, 0)),
        "p2p_remove_peer" => {
            let engine = engine.clone();
            let peer = arg(params, 0);
            tokio::task::spawn_blocking(move || engine.remove_peer(&peer))
                .await
                .map_err(|e| anyhow!("{e}"))??;
            Ok(Value::Null)
        }
        "p2p_send_file" => {
            let engine = engine.clone();
            let peer = arg(params, 0);
            let src = arg(params, 1);
            let name = arg(params, 2);
            let caption = arg(params, 3);
            let (id, path) = tokio::task::spawn_blocking(move || {
                engine.send_file(&peer, &src, &name, &caption)
            })
            .await
            .map_err(|e| anyhow!("{e}"))??;
            Ok(json!({ "id": id, "path": path.to_string_lossy() }))
        }
        "p2p_group_send_file" => {
            let engine = engine.clone();
            let gid = arg(params, 0);
            let src = arg(params, 1);
            let name = arg(params, 2);
            let caption = arg(params, 3);
            let value = tokio::task::spawn_blocking(move || {
                engine.group_send_file(&gid, &src, &name, &caption)
            })
            .await
            .map_err(|e| anyhow!("{e}"))??;
            Ok(value)
        }
        "p2p_group_rename" => engine.group_rename(&arg(params, 0), &arg(params, 1)),
        "p2p_group_leave" => engine.group_leave(&arg(params, 0)),
        "p2p_group_disband" => engine.group_disband(&arg(params, 0)),
        "p2p_group_delete" => engine.group_delete(&arg(params, 0)).map(|_| Value::Null),
        _ => Err(anyhow!("unknown method")),
    }
}

fn arg(params: &Value, i: usize) -> String {
    params.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn opt_str(params: &Value, i: usize) -> Option<String> {
    params
        .get(i)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn bool_at(params: &Value, i: usize) -> bool {
    params.get(i).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn limit_at(params: &Value, i: usize) -> usize {
    params.get(i).and_then(|v| v.as_u64()).unwrap_or(200) as usize
}

fn str_list(params: &Value, i: usize) -> Vec<String> {
    params
        .get(i)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

fn ok_line(id: &Value, result: Value) -> String {
    json!({"jsonrpc":"2.0","id": id, "result": result}).to_string()
}

fn error_line(id: &Value, msg: &str) -> String {
    json!({"jsonrpc":"2.0","id": id, "error": {"code": -1, "message": msg}}).to_string()
}

fn error_for_line(line: &str, msg: &str) -> Option<String> {
    let obj: Value = serde_json::from_str(line).ok()?;
    Some(error_line(obj.get("id")?, msg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_line_carries_the_id_and_message() {
        let line = error_line(&json!(4), "unknown method");
        let parsed: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["id"], 4);
        assert_eq!(parsed["error"]["message"], "unknown method");
    }
}
