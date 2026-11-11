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
    let core = match core::Core::open(dir, DEFAULT_RELAY) {
        Ok(c) => c,
        Err(e) => {
            say(format!("core open failed: {e:#}"));
            panic!("core open failed: {e:#}");
        }
    };
    say("core open");
    let mut event_loop = masonry_winit::app::EventLoop::with_user_event();
    let _ = ACTIVITY.set(app.activity_as_ptr() as usize);
    event_loop.with_android_app(app);
    if let Err(e) = ui::run(core, started, event_loop) {
        log::error!("ui exited: {e:#}");
    }
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
