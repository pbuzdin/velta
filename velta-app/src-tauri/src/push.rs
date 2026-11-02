//! UnifiedPush settings commands and Android JNI glue (#140 / #205).

/// #140/#204: UnifiedPush state for Settings → Push notifications, as the
/// JSON string UnifiedPushBridge.status builds (distributors with app labels,
/// saved distributor, explicit Off, last push / endpoint time in ms,
/// registration ok|failed|none + registrationError). The settings UI reads
/// only this object.
#[cfg(target_os = "android")]
#[tauri::command]
pub fn push_status() -> Result<String, String> {
    crate::with_android_class(
        &crate::APP_UNIFIEDPUSH_CLASS,
        "UnifiedPushBridge",
        |env, context, class_ref| {
            let out = env
                .call_static_method(
                    class_ref,
                    "status",
                    "(Landroid/content/Context;)Ljava/lang/String;",
                    &[(&context).into()],
                )
                .map_err(|e| e.to_string())?;
            let jstr = jni::objects::JString::from(out.l().map_err(|e| e.to_string())?);
            let s = env
                .get_string(&jstr)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into_owned();
            Ok(s)
        },
    )
}

/// #140: use this distributor now (saveDistributor + register).
#[cfg(target_os = "android")]
#[tauri::command]
pub fn push_select(package: String) -> Result<(), String> {
    crate::with_android_class(
        &crate::APP_UNIFIEDPUSH_CLASS,
        "UnifiedPushBridge",
        |env, context, class_ref| {
            let jpkg = env.new_string(&package).map_err(|e| e.to_string())?;
            env.call_static_method(
                class_ref,
                "select",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[(&context).into(), (&jpkg).into()],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        },
    )
}

/// #140: explicit Off (unregister + removeDistributor, persisted so the
/// start-up auto-register does not override it).
#[cfg(target_os = "android")]
#[tauri::command]
pub fn push_off() -> Result<(), String> {
    crate::with_android_class(
        &crate::APP_UNIFIEDPUSH_CLASS,
        "UnifiedPushBridge",
        |env, context, class_ref| {
            env.call_static_method(
                class_ref,
                "off",
                "(Landroid/content/Context;)V",
                &[(&context).into()],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        },
    )
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn push_status() -> Result<String, String> {
    Err("push settings are only on Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn push_select(package: String) -> Result<(), String> {
    let _ = package;
    Err("push settings are only on Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn push_off() -> Result<(), String> {
    Err("push settings are only on Android".into())
}

#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "android")]
use std::sync::Mutex;
#[cfg(target_os = "android")]
use tauri::Emitter;

#[cfg(target_os = "android")]
pub(crate) static PENDING_PUSH_TOKEN: Mutex<Option<String>> = Mutex::new(None);
#[cfg(target_os = "android")]
pub(crate) static PUSH_ENDPOINT_SET: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "android")]
pub(crate) static LAST_PUSH_SECS: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "android")]
fn push_wakeup_impl() {
    tauri::async_runtime::spawn(async move {
        let _ = crate::background_fetch_once().await;
    });
}

// onNewEndpoint: the serialized "webpush:<endpoint>|<pubkey>|<auth>" token.
// Applied to the accounts manager immediately when the core is ready — the
// core then registers it with the relay automatically (IMAP METADATA
// /private/devicetoken, core push.rs + imap.rs register_token) — otherwise
// parked in PENDING_PUSH_TOKEN and applied at the end of init_android_core.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_UnifiedPushService_pushEndpointReceived(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    token: jni::objects::JString,
) {
    let Ok(jtoken) = env.get_string(&token) else {
        return;
    };
    let token: String = jtoken.to_string_lossy().into_owned();
    PUSH_ENDPOINT_SET.store(true, Ordering::SeqCst);
    // Log the scheme only — the endpoint URL is a capability URL.
    crate::log(&format!(
        "push endpoint received ({})",
        token.split(':').next().unwrap_or("?")
    ));
    let accounts = crate::ANDROID_ACCOUNTS.lock().unwrap().clone();
    match accounts {
        Some(accounts) => {
            if let Err(e) = accounts.blocking_read().set_push_device_token(&token) {
                crate::log(&format!("push endpoint apply failed: {e}"));
            } else {
                crate::log("push endpoint applied to the accounts manager");
                crate::log("boot: push registered");
                if let Some(app) = crate::APP_HANDLE.lock().unwrap().clone() {
                    let _ = app.emit("velta-push", serde_json::json!({"stage": "endpoint"}));
                }
            }
        }
        None => {
            *PENDING_PUSH_TOKEN.lock().unwrap() = Some(token);
            crate::log("push endpoint parked until the core is ready");
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_UnifiedPushService_pushWakeup(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
) {
    LAST_PUSH_SECS.store(crate::unix_secs(), Ordering::SeqCst);
    push_wakeup_impl();
}

// onUnregistered (distributor removed, user picked Off): the reconnect
// nudge is needed again.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_org_velta_UnifiedPushService_pushUnregistered(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
) {
    PUSH_ENDPOINT_SET.store(false, Ordering::SeqCst);
    LAST_PUSH_SECS.store(0, Ordering::SeqCst);
}
