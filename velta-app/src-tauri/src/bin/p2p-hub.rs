//! Headless Local chat hub for debugging device pairing.
//!
//! Runs the exact same engine as the app (`velta_app::p2p`), prints an invite
//! QR, and logs every event. Control it by writing lines to a command file
//! (useful when run without a console):
//!
//!   `send <peer-id-prefix> <text>`   send a message to a paired peer
//!   `invite`                         print a fresh invite ticket
//!   `status`                         print the status snapshot
//!
//! Local groups (ids/gids may be abbreviated to a unique prefix; use `_` for
//! a space in a group name):
//!   `groups`                         list groups
//!   `gcreate <name> <peer>...`       create a group with 1-3 paired peers
//!   `gsend <gid> <text>`             message a group
//!   `gmsgs <gid>`                    print the group log
//!   `gadd <gid> <peer>`              add a paired peer (creator)
//!   `gremove <gid> <member>`         remove a member (creator)
//!   `grename <gid> <name>`           rename (creator)
//!   `gdisband <gid>`                 close the group (creator)
//!   `gleave <gid>`                   leave the group
//!   `gdelete <gid>`                  forget a finished group (local data)
//!
//! The command file path and the ticket are printed at startup.

use anyhow::Result;
use velta_app::p2p::{P2p, Sink};

#[tokio::main]
async fn main() -> Result<()> {
    let dir = std::env::temp_dir().join("velta-p2p-hub");
    std::fs::create_dir_all(&dir)?;
    let cmd_file = dir.join("hub-cmd.txt");
    let _ = std::fs::remove_file(&cmd_file);

    let (tx, rx) = std::sync::mpsc::channel();
    let p2p = P2p::start(dir.clone(), dir.join("blobs"), Sink::Test(tx)).await?;
    p2p.set_name("Velta Hub".into())?;

    // Event printer.
    std::thread::spawn(move || {
        for ev in rx {
            println!("[EVENT] {ev}");
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
    });

    let ticket = p2p.create_invite().await?;

    println!("HUB DIR      : {}", dir.display());
    println!("CMD FILE     : {}  (one command per line)", cmd_file.display());
    println!("NODE ID      : {}", p2p.node_id());
    println!("TICKET       : {ticket}  ({} chars)", ticket.len());

    // ASCII QR of the ticket for terminals. EC level L + alphanumeric mode
    // (compact binary ticket) keep the grid small enough for screen scanning.
    let code = qrcode::QrCode::with_error_correction_level(ticket.as_bytes(), qrcode::EcLevel::L)?;
    let image = code
        .render::<qrcode::render::unicode::Dense1x2>()
        .dark_color(qrcode::render::unicode::Dense1x2::Light)
        .light_color(qrcode::render::unicode::Dense1x2::Dark)
        .quiet_zone(true)
        .build();
    println!("{image}");

    // Browser-scannable QR: big, clean, easy to point a phone at. The
    // legacy QR exists for app builds that only parse v1 JSON tickets.
    let legacy = legacy_ticket(&ticket, "Velta Hub");
    let html = format!(
        "<!doctype html><html><head><meta charset=utf-8><title>Velta Hub</title></head>         <body style=\"background:#111;color:#eee;font-family:sans-serif;text-align:center\">         <h2>Velta Hub — scan to pair</h2>         <div style=\"display:flex;justify-content:center;gap:40px;flex-wrap:wrap\">         <div><p>new build</p><div id=q style=\"background:#fff;padding:24px\"></div></div>         <div><p>1.3.0 APK (v1 ticket)</p><div id=q2 style=\"background:#fff;padding:24px\"></div></div>         </div>         <p style=\"word-break:break-all;opacity:.6;max-width:700px;margin:12px auto\">{ticket}</p>         <p style=\"word-break:break-all;opacity:.35;max-width:700px;margin:12px auto\">{legacy}</p>         <script src=\"https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js\"></script>         <script>         new QRCode(document.getElementById('q'), {{ text: '{ticket}', width: 420, height: 420, correctLevel: QRCode.CorrectLevel.L }});         new QRCode(document.getElementById('q2'), {{ text: '{legacy}', width: 420, height: 420, correctLevel: QRCode.CorrectLevel.L }});         </script></body></html>"
    );
    let qr_path = dir.join("hub-qr.html");
    std::fs::write(&qr_path, html)?;
    println!("QR HTML      : {}", qr_path.display());

    // Status + control-file loop.
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let Ok(cmd) = std::fs::read_to_string(&cmd_file) else {
            continue;
        };
        let _ = std::fs::remove_file(&cmd_file);
        for line in cmd.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if line == "status" {
                println!("[STATUS] {}", p2p.status());
            } else if let Some(rest) = line.strip_prefix("pair ") {
                match resolve_peer(&p2p, rest.trim()) {
                    Some(id) => match p2p.pair_nearby(&id).await {
                        Ok(peer) => println!("[PAIRED] {} ({})", peer["id"], peer["name"]),
                        Err(e) => println!("[PAIR-ERR] {e:#}"),
                    },
                    None => println!("[PAIR-ERR] no nearby device matching '{}'", rest.trim()),
                }
            } else if line == "invite" {
                let invite = p2p.create_invite().await?;
                println!("[INVITE] {invite}");
            } else if let Some(rest) = line.strip_prefix("send ") {
                let mut parts = rest.splitn(2, ' ');
                let prefix = parts.next().unwrap_or("");
                let text = parts.next().unwrap_or("");
                match resolve_peer(&p2p, prefix) {
                    Some(id) => match p2p.send(&id, text, None, None) {
                        Ok(msg_id) => println!("[SENT] {msg_id} -> {id}: {text}"),
                        Err(e) => println!("[SEND-ERR] {e:#}"),
                    },
                    None => println!("[SEND-ERR] no peer matching prefix '{prefix}'"),
                }
            } else if line == "groups" {
                for g in p2p.groups() {
                    println!("[GROUP] {g}");
                }
            } else if let Some(rest) = line.strip_prefix("gcreate ") {
                let mut parts = rest.split_whitespace();
                let name = parts.next().unwrap_or("").replace('_', " ");
                let members: Vec<String> = parts.filter_map(|p| resolve_peer(&p2p, p)).collect();
                match p2p.group_create(&name, &members) {
                    Ok(g) => println!("[GROUP-CREATED] {g}"),
                    Err(e) => println!("[GROUP-ERR] {e:#}"),
                }
            } else if let Some(rest) = line.strip_prefix("gsend ") {
                let mut parts = rest.splitn(2, ' ');
                let prefix = parts.next().unwrap_or("");
                let text = parts.next().unwrap_or("");
                match resolve_group(&p2p, prefix) {
                    Some(gid) => match p2p.group_send(&gid, text, None, None) {
                        Ok(sent) => println!("[GROUP-SENT] {sent} -> {gid}: {text}"),
                        Err(e) => println!("[GROUP-ERR] {e:#}"),
                    },
                    None => println!("[GROUP-ERR] no group matching '{prefix}'"),
                }
            } else if let Some(prefix) = line.strip_prefix("gmsgs ") {
                match resolve_group(&p2p, prefix.trim()) {
                    Some(gid) => match p2p.group_messages(&gid, 50) {
                        Ok(rows) => rows.iter().for_each(|r| println!("[GROUP-MSG] {r}")),
                        Err(e) => println!("[GROUP-ERR] {e:#}"),
                    },
                    None => println!("[GROUP-ERR] no group matching '{}'", prefix.trim()),
                }
            } else if let Some(rest) = line.strip_prefix("gadd ") {
                let mut parts = rest.split_whitespace();
                let (gp, pp) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                match (resolve_group(&p2p, gp), resolve_peer(&p2p, pp)) {
                    (Some(gid), Some(peer)) => match p2p.group_add(&gid, &peer) {
                        Ok(g) => println!("[GROUP-UPDATED] {g}"),
                        Err(e) => println!("[GROUP-ERR] {e:#}"),
                    },
                    _ => println!("[GROUP-ERR] usage: gadd <gid> <peer>"),
                }
            } else if let Some(rest) = line.strip_prefix("gremove ") {
                let mut parts = rest.split_whitespace();
                let (gp, mp) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                match resolve_group(&p2p, gp).and_then(|gid| resolve_member(&p2p, &gid, mp).map(|m| (gid, m))) {
                    Some((gid, member)) => match p2p.group_remove(&gid, &member) {
                        Ok(g) => println!("[GROUP-UPDATED] {g}"),
                        Err(e) => println!("[GROUP-ERR] {e:#}"),
                    },
                    None => println!("[GROUP-ERR] usage: gremove <gid> <member>"),
                }
            } else if let Some(rest) = line.strip_prefix("grename ") {
                let mut parts = rest.splitn(2, ' ');
                let (gp, name) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                match resolve_group(&p2p, gp) {
                    Some(gid) => match p2p.group_rename(&gid, name) {
                        Ok(g) => println!("[GROUP-UPDATED] {g}"),
                        Err(e) => println!("[GROUP-ERR] {e:#}"),
                    },
                    None => println!("[GROUP-ERR] no group matching '{gp}'"),
                }
            } else if let Some(prefix) = line.strip_prefix("gdisband ") {
                match resolve_group(&p2p, prefix.trim()) {
                    Some(gid) => match p2p.group_disband(&gid) {
                        Ok(g) => println!("[GROUP-UPDATED] {g}"),
                        Err(e) => println!("[GROUP-ERR] {e:#}"),
                    },
                    None => println!("[GROUP-ERR] no group matching '{}'", prefix.trim()),
                }
            } else if let Some(prefix) = line.strip_prefix("gdelete ") {
                match resolve_group(&p2p, prefix.trim()) {
                    Some(gid) => match p2p.group_delete(&gid) {
                        Ok(()) => println!("[GROUP-DELETED] {gid}"),
                        Err(e) => println!("[GROUP-ERR] {e:#}"),
                    },
                    None => println!("[GROUP-ERR] no group matching '{}'", prefix.trim()),
                }
            } else if let Some(prefix) = line.strip_prefix("gleave ") {
                match resolve_group(&p2p, prefix.trim()) {
                    Some(gid) => match p2p.group_leave(&gid) {
                        Ok(g) => println!("[GROUP-UPDATED] {g}"),
                        Err(e) => println!("[GROUP-ERR] {e:#}"),
                    },
                    None => println!("[GROUP-ERR] no group matching '{}'", prefix.trim()),
                }
            } else {
                println!("[CMD?] {line}");
            }
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
    }
}

/// Convert a compact ticket back to the legacy v1 JSON form, for pairing
/// with app builds that predate the compact format (e.g. the 1.3.0 APK).
fn legacy_ticket(ticket: &str, name: &str) -> String {
    let Ok(bytes) = data_encoding::BASE32_NOPAD.decode(
        ticket.trim().strip_prefix("VELTAP2P1:").unwrap_or("").to_ascii_uppercase().as_bytes(),
    ) else {
        return ticket.to_string();
    };
    if bytes.first() != Some(&2) || bytes.len() < 46 {
        return ticket.to_string();
    }
    let node_id = data_encoding::HEXLOWER.encode(&bytes[1..33]);
    let token = data_encoding::HEXLOWER.encode(&bytes[33..45]);
    let mut addrs = Vec::new();
    let mut pos = 46;
    let n = bytes[45] as usize;
    for _ in 0..n {
        if pos + 1 > bytes.len() { break; }
        let (len, ip) = match bytes[pos] {
            4 => (4usize, {
                let mut o = [0u8; 4];
                o.copy_from_slice(&bytes[pos+1..pos+5]);
                std::net::Ipv4Addr::from(o).to_string()
            }),
            6 => (16usize, {
                let mut o = [0u8; 16];
                o.copy_from_slice(&bytes[pos+1..pos+17]);
                std::net::Ipv6Addr::from(o).to_string()
            }),
            _ => break,
        };
        if pos + 1 + len + 2 > bytes.len() { break; }
        let port = u16::from_be_bytes([bytes[pos+1+len], bytes[pos+2+len]]);
        addrs.push(format!("{ip}:{port}"));
        pos += 1 + len + 2;
    }
    let json = serde_json::json!({
        "v": 1, "node_id": node_id, "addrs": addrs, "token": token, "name": name
    });
    format!(
        "VELTAP2P1:{}",
        data_encoding::BASE64URL_NOPAD.encode(&serde_json::to_vec(&json).unwrap_or_default())
    )
}

fn resolve_peer(p2p: &P2p, prefix: &str) -> Option<String> {
    let status = p2p.status();
    let peers = status["peers"].as_array()?;
    peers
        .iter()
        .filter_map(|p| p["id"].as_str())
        .find(|id| id.starts_with(prefix))
        .map(|s| s.to_string())
}

fn resolve_group(p2p: &P2p, prefix: &str) -> Option<String> {
    p2p.groups()
        .iter()
        .filter_map(|g| g["gid"].as_str())
        .find(|gid| !prefix.is_empty() && gid.starts_with(prefix))
        .map(|s| s.to_string())
}

/// A member of `gid` (paired or introduced) by node-id prefix.
fn resolve_member(p2p: &P2p, gid: &str, prefix: &str) -> Option<String> {
    let groups = p2p.groups();
    let group = groups.iter().find(|g| g["gid"] == gid)?;
    group["members"]
        .as_array()?
        .iter()
        .filter_map(|m| m["id"].as_str())
        .find(|id| !prefix.is_empty() && id.starts_with(prefix))
        .map(|s| s.to_string())
}
