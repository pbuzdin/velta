//! Velta Rust preview UI. Experimental, see #314.

pub mod core;
pub mod ui;

/// Relay used to create a first account when the accounts dir is empty.
pub const DEFAULT_RELAY: &str = "dcaccount:nine.testrun.org";

#[cfg(target_os = "android")]
// Safety: android_activity looks this symbol up by name; nothing else in the build defines it.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
fn android_main(app: masonry_winit::winit::platform::android::activity::AndroidApp) {
    use masonry_winit::winit::platform::android::EventLoopBuilderExtAndroid;
    let started = std::time::Instant::now();
    let dir = app.internal_data_path().expect("app data dir").join("accounts");
    let core = core::Core::open(dir, DEFAULT_RELAY).expect("open core");
    eprintln!("velta-preview: core open in {} ms", started.elapsed().as_millis());
    let mut event_loop = masonry_winit::app::EventLoop::with_user_event();
    event_loop.with_android_app(app);
    ui::run(core, started, event_loop).expect("run ui");
}
