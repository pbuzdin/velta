fn main() {
    tauri_build::build();
    // `cargo test` on Windows: tauri-build embeds its Common-Controls v6
    // manifest into the *bin* target only. Without it, test binaries bind the
    // ancient comctl32 v5 from System32, wry's TaskDialogIndirect import is
    // missing, and every test process dies at load with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). Adding the SxS dependency via
    // linker arg also embeds it for every target (lib unit tests included).
    //
    // Target-scoped, not #[cfg(windows)]: in a build script cfg() refers to
    // the HOST, and cross-compiling FROM Windows TO Android must not emit
    // this MSVC-only flag (clang rejects it as an input file — the Android
    // CI link failure). CARGO_CFG_TARGET_OS is the target's OS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg=/manifestdependency:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' publicKeyToken='6595b64144ccf1df' language='*' processorArchitecture='*'");
    }
}
