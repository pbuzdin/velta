// Day 11 SQLCipher upgrade/rollback harness (scratch; never in core/).
use anyhow::{Context as _, Result};
use deltachat::chat::{self, ChatId};
use deltachat::config::Config;
use deltachat::contact::Contact;
use deltachat::context::Context;
use deltachat::message::{Message, Viewtype};
use deltachat::stock_str::StockStrings;
use deltachat::Events;
use std::path::PathBuf;

#[allow(deprecated)]
async fn open(db: &PathBuf, pass: &str) -> Result<Context> {
    let ctx = Context::new_closed(db, 1, Events::new(), StockStrings::new(), Default::default()).await?;
    anyhow::ensure!(ctx.open(pass.to_string()).await?, "passphrase rejected");
    Ok(ctx)
}

fn report(db: &PathBuf, pass: &str, tag: &str) -> Result<()> {
    let c = rusqlite::Connection::open(db)?;
    if !pass.is_empty() { c.pragma_update(None, "key", pass)?; }
    let s = |q: &str| -> Result<String> { Ok(c.query_row(q, [], |r| r.get::<_, rusqlite::types::Value>(0)).map(|v| format!("{v:?}"))?) };
    println!("[{tag}] sqlcipher={} sqlite={} integrity={} dbversion={} msgs={} chats={} contacts={} config={} page_size={} journal={}",
        s("PRAGMA cipher_version")?, s("SELECT sqlite_version()")?, s("PRAGMA integrity_check")?,
        s("SELECT value FROM config WHERE keyname='dbversion'")?, s("SELECT COUNT(*) FROM msgs")?,
        s("SELECT COUNT(*) FROM chats")?, s("SELECT COUNT(*) FROM contacts")?, s("SELECT COUNT(*) FROM config")?,
        s("PRAGMA page_size")?, s("PRAGMA journal_mode")?);
    let mut st = c.prepare("SELECT keyname||'='||value FROM config WHERE keyname LIKE 'ui.d11.%' ORDER BY keyname")?;
    let marks: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    println!("[{tag}] marks={marks:?}");
    Ok(())
}

async fn populate(ctx: &Context, stage: &str) -> Result<()> {
    if ctx.get_config(Config::Addr).await?.is_none() {
        ctx.set_config(Config::Addr, Some("alice@example.org")).await?;
        ctx.set_config(Config::Displayname, Some("Alice Velta")).await?;
    }
    for i in 0..50 {
        let c = Contact::create(ctx, &format!("{stage} c{i}"), &format!("{stage}{i}@example.net")).await?;
        let chat = ChatId::create_for_contact(ctx, c).await?;
        let mut d = Message::new(Viewtype::Text);
        d.set_text(format!("draft {stage} {i} — ünïcödé 🦀"));
        chat.set_draft(ctx, Some(&mut d)).await?;
    }
    let g = chat::create_group(ctx, &format!("group {stage}")).await?;
    for i in 0..200 {
        let mut m = Message::new(Viewtype::Text);
        m.set_text(format!("device msg {stage} {i} {}", "x".repeat(i)));
        chat::add_device_msg(ctx, None, Some(&mut m)).await?;
    }
    let _ = g;
    ctx.set_ui_config(&format!("ui.d11.{stage}"), Some("ok")).await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let (cmd, db, pass, stage) = (&a[1], PathBuf::from(&a[2]), a.get(3).cloned().unwrap_or_default(), a.get(4).cloned().unwrap_or("x".into()));
    match cmd.as_str() {
        "write" => { let ctx = open(&db, &pass).await.context("open")?; populate(&ctx, &stage).await?; ctx.stop_io().await; drop(ctx); }
        "read" => { let ctx = open(&db, &pass).await.context("open")?; drop(ctx); }
        _ => anyhow::bail!("cmd"),
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    report(&db, &pass, &stage)
}
