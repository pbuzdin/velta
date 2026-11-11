//! Velta Rust preview UI. Experimental, see #314.

pub mod core;
pub mod ui;

use std::sync::Mutex;
use std::time::Instant;

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
static LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Startup log: goes to stderr (logcat on Android) and to the strip at the top of the window.
pub fn say(msg: impl AsRef<str>) {
    let ms = START.get_or_init(Instant::now).elapsed().as_millis();
    let line = format!("+{ms} ms  {}", msg.as_ref());
    #[cfg(target_os = "android")]
    log::info!("{line}");
    #[cfg(not(target_os = "android"))]
    eprintln!("velta-preview: {line}");
    if let Ok(mut l) = LINES.lock() {
        l.push(line);
        let n = l.len();
        if n > 8 {
            l.drain(..n - 8);
        }
    }
}

/// The last few log lines, newest last.
pub fn log_text() -> String {
    LINES.lock().map(|l| l.join("\n")).unwrap_or_default()
}

/// Relay used to create a first account when the accounts dir is empty.
pub const DEFAULT_RELAY: &str = "dcaccount:nine.testrun.org";

/// First-run relay override: `VELTA_RELAY` env (desktop), or `relay.txt` in
/// the accounts dir / the app's files dir (Android; pushed there with
/// `adb push` + `run-as`). Lets test devices use a private relay without
/// hardcoding its hostname in the repo.
pub fn relay_for(accounts_dir: &std::path::Path) -> String {
    if let Ok(r) = std::env::var("VELTA_RELAY")
        && !r.trim().is_empty()
    {
        return normalize_relay(&r);
    }
    for dir in [accounts_dir.to_path_buf(), accounts_dir.parent().map(|p| p.to_path_buf()).unwrap_or_default()] {
        let Ok(s) = std::fs::read_to_string(dir.join("relay.txt")) else {
            continue;
        };
        if !s.trim().is_empty() {
            return normalize_relay(&s);
        }
    }
    DEFAULT_RELAY.to_string()
}

/// Bare hostnames become `dcaccount:<host>`; anything with a scheme passes through.
fn normalize_relay(s: &str) -> String {
    let s = s.trim();
    if s.contains(':') {
        s.to_string()
    } else {
        format!("dcaccount:{s}")
    }
}

/// A `relay` string extra on the launch intent (`am start --es relay …`) —
/// the highest-priority override, and the only one that works on a
/// non-debuggable test APK.
#[cfg(target_os = "android")]
fn relay_from_intent() -> Option<String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.ok()?;
    let mut env = vm.attach_current_thread().ok()?;
    let inner = || -> jni::errors::Result<Option<String>> {
        let Some(&ptr) = ACTIVITY.get() else { return Ok(None) };
        let activity = unsafe { jni::objects::JObject::from_raw(ptr as jni::sys::jobject) };
        let intent = env
            .call_method(&activity, "getIntent", "()Landroid/content/Intent;", &[])?
            .l()?;
        let key = env.new_string("relay")?;
        let extra = env
            .call_method(&intent, "getStringExtra", "(Ljava/lang/String;)Ljava/lang/String;", &[(&key).into()])?
            .l()?;
        if extra.is_null() {
            return Ok(None);
        }
        let extra = jni::objects::JString::from(extra);
        let s: String = env.get_string(&extra)?.into();
        Ok(Some(s))
    }();
    if let Err(_e) = &inner
        && env.exception_check().unwrap_or(false)
    {
        env.exception_clear().ok();
    }
    inner.ok().flatten().filter(|s| !s.trim().is_empty())
}

/// The NativeActivity jobject (ndk_context only hands out the Application).
#[cfg(target_os = "android")]
static ACTIVITY: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

#[cfg(target_os = "android")]
// Safety: android_activity looks this symbol up by name; nothing else in the build defines it.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
fn android_main(app: masonry_winit::winit::platform::android::activity::AndroidApp) {
    use masonry_winit::winit::platform::android::EventLoopBuilderExtAndroid;
    // stderr goes nowhere on Android; send our log lines and panics to logcat (tag velta-preview).
    android_logger::init_once(android_logger::Config::default().with_tag("velta-preview").with_max_level(log::LevelFilter::Info));
    std::panic::set_hook(Box::new(|p| log::error!("panic: {p}")));
    let started = *START.get_or_init(Instant::now);
    say("android_main");
    let dir = app.internal_data_path().expect("app data dir").join("accounts");
    say(format!("opening accounts at {}", dir.display()));
    let relay = relay_from_intent().unwrap_or_else(|| relay_for(&dir));
    log::info!("first-run relay: {relay}");
    let core = match core::Core::open(dir, &relay) {
        Ok(c) => c,
        Err(e) => {
            say(format!("core open failed: {e:#}"));
            panic!("core open failed: {e:#}");
        }
    };
    say("core open");
    let mut event_loop = masonry_winit::app::EventLoop::with_user_event();
    let _ = ACTIVITY.set(app.activity_as_ptr() as usize);
    let _ = APP.set(app.clone());
    event_loop.with_android_app(app);
    if let Err(e) = ui::run(core, started, event_loop) {
        log::error!("ui exited: {e:#}");
    }
}

#[cfg(target_os = "android")]
static APP: std::sync::OnceLock<masonry_winit::winit::platform::android::activity::AndroidApp> = std::sync::OnceLock::new();

/// Soft-keyboard text. GameActivity's keyboard edits a GameTextInput buffer and
/// reports it as `TextEvent`, which winit 0.30 drops ("Unknown android_activity
/// input event"), so the composer never saw typed text. The UI reads the buffer
/// itself and mirrors it into the TextArea. `None` off the GameActivity build.
pub fn ime_text() -> Option<String> {
    #[cfg(all(target_os = "android", feature = "game-activity"))]
    {
        APP.get().map(|a| a.text_input_state().text)
    }
    #[cfg(not(all(target_os = "android", feature = "game-activity")))]
    None
}

/// Empty the keyboard buffer (after Send, and when a chat opens).
pub fn clear_ime_text() {
    #[cfg(all(target_os = "android", feature = "game-activity"))]
    if let Some(a) = APP.get() {
        a.set_text_input_state(Default::default());
    }
}

static IME_POLL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static IME_THREAD: std::sync::OnceLock<std::thread::Thread> = std::sync::OnceLock::new();

/// The keyboard-inset poller runs only while a chat (the only screen with a
/// composer) is open and the app is in the foreground; otherwise it parks.
pub fn set_ime_polling(on: bool) {
    IME_POLL.store(on, std::sync::atomic::Ordering::Relaxed);
    if on && let Some(t) = IME_THREAD.get() {
        t.unpark();
    }
}

/// Called by the poller thread: parks until polling is on. Returns true if it
/// had to wait, so the caller re-reads the inset from scratch.
pub fn ime_poll_wait() -> bool {
    let _ = IME_THREAD.set(std::thread::current());
    let mut waited = false;
    while !IME_POLL.load(std::sync::atomic::Ordering::Relaxed) {
        std::thread::park();
        waited = true;
    }
    waited
}

/// The visible height under the window the on-screen keyboard covers, in
/// logical pixels. GameActivity ignores `adjustResize`, so the UI has to pad
/// the composer by this itself. 0.0 when the keyboard is closed or on query
/// failure. Desktop callers get 0.0.
pub fn ime_bottom() -> f64 {
    #[cfg(target_os = "android")]
    {
        ime_bottom_android().unwrap_or(0.0)
    }
    #[cfg(not(target_os = "android"))]
    0.0
}

/// JNI query; `java.lang.NoSuchMethodError` and friends must never escape —
/// a pending exception left on the thread crashes the whole app.
#[cfg(target_os = "android")]
fn ime_bottom_android() -> jni::errors::Result<f64> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }?;
    let mut env = vm.attach_current_thread()?;
    let inner = || -> jni::errors::Result<f64> {
        let Some(&ptr) = ACTIVITY.get() else { return Ok(0.0) };
        let activity = unsafe { jni::objects::JObject::from_raw(ptr as jni::sys::jobject) };
        let window = env
            .call_method(&activity, "getWindow", "()Landroid/view/Window;", &[])?
            .l()?;
        let decor = env
            .call_method(&window, "getDecorView", "()Landroid/view/View;", &[])?
            .l()?;
        let insets = env
            .call_method(&decor, "getRootWindowInsets", "()Landroid/view/WindowInsets;", &[])?
            .l()?;
        let sdk = env.get_static_field("android/os/Build$VERSION", "SDK_INT", "I")?.i()?;
        let bottom = if sdk >= 30 {
            let kind = env
                .call_static_method("android/view/WindowInsets$Type", "ime", "()I", &[])?
                .i()?;
            // Insets lives in android.graphics, not android.view.
            let ime = env
                .call_method(&insets, "getInsets", "(I)Landroid/graphics/Insets;", &[kind.into()])?
                .l()?;
            env.get_field(&ime, "bottom", "I")?.i()?
        } else {
            env.call_method(&insets, "getSystemWindowInsetBottom", "()I", &[])?.i()?
        };
        let resources = env
            .call_method(&activity, "getResources", "()Landroid/content/res/Resources;", &[])?
            .l()?;
        let metrics = env
            .call_method(&resources, "getDisplayMetrics", "()Landroid/util/DisplayMetrics;", &[])?
            .l()?;
        let d = env.get_field(&metrics, "density", "F")?.f()? as f64;
        if d <= 0.0 {
            return Ok(0.0);
        }
        Ok(bottom as f64 / d)
    }();
    if inner.is_err() && env.exception_check()? {
        env.exception_clear()?;
    }
    inner
}

/// Sends the app to the background, like Back on a home screen does.
pub fn to_background() {
    #[cfg(target_os = "android")]
    {
        let res = (|| -> jni::errors::Result<()> {
            let ctx = ndk_context::android_context();
            let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }?;
            let mut env = vm.attach_current_thread()?;
            let Some(&ptr) = ACTIVITY.get() else { return Ok(()) };
            let activity = unsafe { jni::objects::JObject::from_raw(ptr as jni::sys::jobject) };
            let r = env.call_method(&activity, "moveTaskToBack", "(Z)Z", &[true.into()]);
            if env.exception_check()? {
                let ex = env.exception_occurred()?;
                env.exception_clear()?;
                let msg = env.call_method(&ex, "toString", "()Ljava/lang/String;", &[])?.l()?;
                let msg: String = env.get_string(&msg.into())?.into();
                say(format!("moveTaskToBack: {msg}"));
            }
            r.map(|_| ())
        })();
        if let Err(e) = res {
            say(format!("moveTaskToBack failed: {e}"));
        }
    }
}
