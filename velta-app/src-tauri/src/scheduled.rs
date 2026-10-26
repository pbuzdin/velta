//! Scheduled messages: Tauri commands over `scheduled.json` (pure rules in
//! scheduled_store.rs) plus the Android send path that runs without the
//! WebView. docs/scheduled-messages.md.
//!
//! Desktop: the page's runner (app/js/scheduled.js) sends through
//! rpc-core's sendMessage; this file only stores the document.
//! Android: the shell owns sending (alarm receiver and page both end up in
//! `run_due`), serialized by one async mutex, each item claimed in the file
//! before its send_msg — so the alarm and the page can never both send it.

use crate::scheduled_store as store;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

static FILE_LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id(now: i64) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("s{now:x}{:x}{n:x}", std::process::id())
}

// Android: AppData resolves to the app's filesDir root — the same place
// ScheduledAlarm.kt reads (like notify-prefs.json). Desktop: local data dir.
fn path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    #[cfg(target_os = "android")]
    {
        app.path().resolve(store::FILE, tauri::path::BaseDirectory::AppData).ok()
    }
    #[cfg(not(target_os = "android"))]
    {
        app.path().app_local_data_dir().ok().map(|d| d.join(store::FILE))
    }
}

fn read(p: &PathBuf) -> Value {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .map(store::normalize)
        .unwrap_or_else(store::empty)
}

fn write(p: &PathBuf, doc: &Value) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Write + rename: a crash mid-write never leaves a half document.
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, doc.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

/// One op under the file lock; returns (doc, result).
pub fn op(app: &tauri::AppHandle, op: &Value) -> Result<(Value, Value), String> {
    let p = path(app).ok_or("no app data dir")?;
    let out = {
        let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut doc = read(&p);
        let now = now_ms();
        let result = store::apply(&mut doc, op, now, || new_id(now));
        if op["op"].as_str() != Some("list") {
            write(&p, &doc)?;
        }
        (doc, result)
    };
    if op["op"].as_str() != Some("list") {
        rearm();
    }
    Ok(out)
}

#[tauri::command]
pub fn scheduled_op(app: tauri::AppHandle, op: Value) -> Result<Value, String> {
    let (doc, result) = self::op(&app, &op)?;
    Ok(json!({"doc": doc, "result": result}))
}

/// Re-arm the single Android alarm for the next due item (ScheduledAlarm.kt
/// reads scheduled.json itself, so boot re-registration needs no Rust).
#[cfg(target_os = "android")]
pub fn rearm() {
    let r = crate::with_android_class(&crate::APP_SCHEDULED_CLASS, "ScheduledAlarm", |env, context, class_ref| {
        env.call_static_method(class_ref, "rearm", "(Landroid/content/Context;)V", &[(&context).into()])
            .map_err(|e| e.to_string())?;
        Ok(())
    });
    if let Err(e) = r {
        crate::log(&format!("scheduled: rearm failed: {e}"));
    }
}

#[cfg(not(target_os = "android"))]
pub fn rearm() {}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn scheduled_exact_status() -> Result<Value, String> {
    crate::with_android_class(&crate::APP_SCHEDULED_CLASS, "ScheduledAlarm", |env, context, class_ref| {
        let v = env
            .call_static_method(class_ref, "canExact", "(Landroid/content/Context;)Z", &[(&context).into()])
            .and_then(|v| v.z())
            .map_err(|e| e.to_string())?;
        Ok(json!({"exact": v}))
    })
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn scheduled_exact_status() -> Result<Value, String> {
    Err("exact alarms are only on Android".into())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn scheduled_exact_request() -> Result<(), String> {
    crate::with_android_class(&crate::APP_SCHEDULED_CLASS, "ScheduledAlarm", |env, context, class_ref| {
        env.call_static_method(class_ref, "requestExact", "(Landroid/content/Context;)V", &[(&context).into()])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn scheduled_exact_request() -> Result<(), String> {
    Err("exact alarms are only on Android".into())
}

/// Android: send every due item through the in-process core's send_msg
/// (the same JSON-RPC call rpc-core.js sendMessage makes). Returns how
/// many went out.
#[cfg(target_os = "android")]
pub async fn run_due(app: tauri::AppHandle, wake: bool) -> Result<usize, String> {
    use tauri::{Emitter, Manager};
    static RUN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _run = RUN.lock().await;
    let tx = crate::ANDROID_RPC_TX.lock().unwrap().clone().ok_or("core rpc channel not ready")?;
    let state = app.state::<crate::RpcState>();
    let (doc, _) = op(&app, &json!({"op": "recover"}))?;
    let mut sent = 0;
    for it in store::due(&doc, now_ms(), wake) {
        let id = it["id"].as_str().unwrap_or_default().to_string();
        let (_, won) = op(&app, &json!({"op": "claim", "id": id}))?;
        if won != json!(true) {
            continue;
        }
        match crate::bg_rpc(&tx, &state, "send_msg", store::send_params(&it)).await {
            Ok(_) => {
                op(&app, &json!({"op": "done", "id": id}))?;
                sent += 1;
            }
            Err(e) => {
                crate::log(&format!("scheduled: send {id} failed: {e}"));
                op(&app, &json!({"op": "fail", "id": id, "error": e, "uncertain": store::is_uncertain_error(&e)}))?;
            }
        }
    }
    crate::log(&format!("scheduled: run_due wake={wake} sent={sent}"));
    let _ = app.emit("velta-scheduled-changed", ());
    Ok(sent)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn scheduled_run_due(app: tauri::AppHandle, wake: bool) -> Result<usize, String> {
    run_due(app, wake).await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn scheduled_run_due(wake: bool) -> Result<usize, String> {
    let _ = wake;
    Err("the page sends scheduled messages on this platform".into())
}

/// Alarm receiver entry (ScheduledAlarmReceiver.kt). false = the core is not
/// up in this process (cold start by the alarm): Kotlin then posts a
/// "open Velta to send" notification instead.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_ScheduledAlarmReceiver_scheduledWakeup(
    _env: jni::JNIEnv,
    _this: jni::objects::JObject,
) -> jni::sys::jboolean {
    let Some(app) = crate::APP_HANDLE.lock().unwrap().clone() else {
        println!("scheduled wakeup: core not initialized");
        return 0;
    };
    if crate::ANDROID_RPC_TX.lock().unwrap().is_none() {
        println!("scheduled wakeup: rpc channel not ready");
        return 0;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_due(app, true).await {
            crate::log(&format!("scheduled wakeup: {e}"));
        }
    });
    1
}
