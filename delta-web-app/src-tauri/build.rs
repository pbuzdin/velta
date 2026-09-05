fn main() {
    tauri_build::build();
    // `cargo test` on Windows: tauri-build embeds its Common-Controls v6
    // manifest into the *bin* target only. Without it, test binaries bind the
    // ancient comctl32 v5 from System32, wry's TaskDialogIndirect import is
    // missing, and every test process dies at load with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). Adding the SxS dependency via
    // linker arg also embeds it for every target (lib unit tests included).
    println!("cargo:rustc-link-arg=/manifestdependency:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' publicKeyToken='6595b64144ccf1df' language='*' processorArchitecture='*'");
}
