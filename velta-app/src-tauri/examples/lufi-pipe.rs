// Live check for the shell-side Lufi WebSocket client (#138): one frame per
// stdin line → that frame's reply on stdout. Driven by the node round-trip
// script in docs/agents/large-file.md, which does the SJCL encryption with
// app/js/lufi.js exactly as the app does:
//   cargo run --example lufi-pipe -- https://upload.disroot.org [proxy-url]
use std::io::{BufRead, Write};

fn main() {
    let mut args = std::env::args().skip(1);
    let server = args.next().unwrap_or_else(|| "https://upload.disroot.org".into());
    let proxy = args.next();
    let mut ws = velta_app::lufi::Ws::connect(&server, proxy.as_deref()).expect("connect");
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.expect("stdin");
        if line.is_empty() {
            break;
        }
        ws.send_text(&line).expect("send");
        let reply = ws.recv_text().expect("recv");
        writeln!(out, "{reply}").unwrap();
        out.flush().unwrap();
    }
    ws.close();
}
