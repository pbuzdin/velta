// Manual visual check for the Windows conversation toast (run from
// src-tauri: cargo run --example win-toast). Uses the installed app's AUMID,
// so the app must have been installed via the NSIS installer at least once.
fn main() {
    let avatar = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/icons/icon-192.png");
    tauri_winrt_notification::Toast::new("org.velta")
        .title("Chat RU")
        .text1("InChat [ARCANE]")
        .text2("Sample incoming message text for the conversation toast layout")
        .icon(avatar, tauri_winrt_notification::IconCrop::Circular, "sender avatar")
        .show()
        .expect("failed to show toast");
    println!("toast shown");
}
