//! Thin, synchronous view of the chat core for the UI thread.
//! The core runs on its own tokio runtime in this process (no JSON-RPC hop).

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, Result};
use deltachat::accounts::Accounts;
use deltachat::chat::{self, Chat, ChatId, ChatItem};
use deltachat::chatlist::Chatlist;
use deltachat::contact::{Contact, ContactId};
use deltachat::context::Context;
use deltachat::message::{Message, MsgId};
use deltachat::EventType;
use tokio::runtime::Runtime;
use tokio::sync::RwLock;

pub struct ChatRow {
    pub id: ChatId,
    pub name: String,
    pub summary: String,
    pub time: String,
    pub unread: usize,
}

pub enum Item {
    Day(String),
    Msg { id: MsgId, outgoing: bool, sender: Option<String>, text: String, time: String, quote: Option<String> },
}

pub struct Core {
    rt: Runtime,
    accounts: Arc<RwLock<Accounts>>,
    ctx: Context,
    /// Relay link "Create account" uses (DEFAULT_RELAY or a test override).
    pub default_relay: String,
}

/// What a pasted link did.
#[derive(Debug)]
pub enum LinkDone {
    /// A contact, group or channel invite: open this chat.
    Chat(ChatId),
    /// A relay link created this (first) account.
    AccountCreated,
    /// Anything else that worked; a short note for the status line.
    Note(&'static str),
}

/// What the background listener reports back to the UI.
#[derive(Debug, Clone, Copy)]
pub enum Change {
    Chatlist,
    Chat(ChatId),
}

fn hm(ts: i64) -> String {
    use chrono::{Local, TimeZone};
    Local.timestamp_opt(ts, 0).single().map(|t| t.format("%H:%M").to_string()).unwrap_or_default()
}

fn day(ts: i64) -> String {
    use chrono::{Local, TimeZone};
    Local.timestamp_opt(ts, 0).single().map(|t| t.format("%a, %d %b %Y").to_string()).unwrap_or_default()
}

impl Core {
    /// Opens an accounts dir (the same layout the other Velta clients use), creating it
    /// and a first account if needed. An unconfigured account is set up in the background
    /// on `relay` (a `dcaccount:` relay), so the window can paint at once.
    pub fn open(dir: PathBuf, relay: &str) -> Result<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().worker_threads(2).build()?;
        let (accounts, ctx) = rt.block_on(async {
            let mut accounts = Accounts::new(dir, true).await?;
            if accounts.get_all().is_empty() {
                accounts.add_account().await?;
            }
            let ctx = accounts.get_selected_account().context("no account in this accounts dir")?;
            // No account is created on its own: the user pastes a relay link
            // (dcaccount:/dclogin:) or taps "Create account" (default relay).
            if ctx.is_configured().await? {
                accounts.start_io().await;
                crate::say("io started");
            } else {
                crate::say("no account yet; waiting for a relay link");
            }
            anyhow::Ok((accounts, ctx))
        })?;
        Ok(Core { rt, accounts: Arc::new(RwLock::new(accounts)), ctx, default_relay: relay.to_string() })
    }

    pub fn is_configured(&self) -> bool {
        self.rt.block_on(self.ctx.is_configured()).unwrap_or(false)
    }

    /// This account's invite link (empty until the account is set up).
    pub fn invite(&self) -> String {
        self.rt.block_on(deltachat::securejoin::get_securejoin_qr(&self.ctx, None)).unwrap_or_default()
    }

    pub fn self_addr(&self) -> String {
        self.rt.block_on(self.ctx.get_primary_self_addr()).unwrap_or_default()
    }

    /// Calls `notify` (from a core thread) whenever the visible data may have changed.
    pub fn listen(&self, notify: impl Fn(Change) + Send + 'static) {
        let accounts = self.accounts.clone();
        let account_id = self.ctx.get_id();
        self.rt.spawn(async move {
            let emitter = accounts.read().await.get_event_emitter();
            while let Some(ev) = emitter.recv().await {
                if ev.id != account_id {
                    continue;
                }
                match ev.typ {
                    EventType::IncomingMsg { chat_id, .. }
                    | EventType::MsgsChanged { chat_id, .. }
                    | EventType::MsgDelivered { chat_id, .. }
                    | EventType::MsgRead { chat_id, .. }
                    | EventType::MsgFailed { chat_id, .. } => {
                        notify(Change::Chat(chat_id));
                        notify(Change::Chatlist);
                    }
                    EventType::ConfigureProgress { progress: 1000, .. } => notify(Change::Chatlist),
                    EventType::ChatModified(_) | EventType::ChatlistChanged | EventType::ContactsChanged(_) => {
                        notify(Change::Chatlist)
                    }
                    _ => {}
                }
            }
        });
    }

    pub fn chats(&self) -> Result<Vec<ChatRow>> {
        let ctx = &self.ctx;
        self.rt.block_on(async {
            let list = Chatlist::try_load(ctx, 0, None, None).await?;
            let mut rows = Vec::with_capacity(list.len());
            for i in 0..list.len() {
                let id = list.get_chat_id(i)?;
                let chat = Chat::load_from_db(ctx, id).await?;
                let s = list.get_summary(ctx, i, Some(&chat)).await?;
                let prefix = s.prefix.as_ref().map(|p| format!("{p}: ")).unwrap_or_default();
                rows.push(ChatRow {
                    id,
                    name: chat.get_name().to_string(),
                    summary: format!("{prefix}{}", s.text),
                    time: if s.timestamp > 0 { hm(s.timestamp) } else { String::new() },
                    unread: id.get_fresh_msg_cnt(ctx).await.unwrap_or(0),
                });
            }
            Ok(rows)
        })
    }

    pub fn chat_name(&self, id: ChatId) -> String {
        self.rt.block_on(Chat::load_from_db(&self.ctx, id)).map(|c| c.get_name().to_string()).unwrap_or_default()
    }

    /// The last `limit` items of a chat, oldest first.
    pub fn items(&self, id: ChatId, limit: usize) -> Result<Vec<Item>> {
        let ctx = &self.ctx;
        self.rt.block_on(async {
            let all = chat::get_chat_msgs(ctx, id).await?;
            let tail = &all[all.len().saturating_sub(limit)..];
            let mut out = Vec::with_capacity(tail.len());
            for it in tail {
                match *it {
                    ChatItem::DayMarker { timestamp } => out.push(Item::Day(day(timestamp))),
                    ChatItem::Message { msg_id } => {
                        let m = Message::load_from_db(ctx, msg_id).await?;
                        let from = m.get_from_id();
                        let outgoing = from == ContactId::SELF;
                        let sender = if outgoing || m.is_info() {
                            None
                        } else if let Some(n) = m.get_override_sender_name() {
                            Some(n)
                        } else {
                            Contact::get_by_id(ctx, from).await.ok().map(|c| c.get_display_name().to_string())
                        };
                        let mut text = m.get_text();
                        if let Some(f) = m.get_filename() {
                            text = if text.is_empty() { format!("[{f}]") } else { format!("[{f}]\n{text}") };
                        }
                        out.push(Item::Msg { id: msg_id, outgoing, sender, text, time: hm(m.get_timestamp()), quote: m.quoted_text() });
                    }
                }
            }
            Ok(out)
        })
    }

    pub fn mark_seen(&self, id: ChatId) {
        let _ = self.rt.block_on(chat::marknoticed_chat(&self.ctx, id));
    }

    /// Acts on a pasted link the way Velta does, in the background:
    /// relay link (dcaccount:/dclogin:) creates the account or adds a relay,
    /// contact/group/channel invite starts a chat, socks5 link adds a proxy.
    pub fn use_link(&self, link: &str, done: impl FnOnce(Result<LinkDone>) + Send + 'static) {
        use deltachat::qr::{check_qr, Qr};
        let ctx = self.ctx.clone();
        let link = link.trim().to_string();
        self.rt.spawn(async move {
            let r = async {
                let configured = ctx.is_configured().await?;
                match check_qr(&ctx, &link).await? {
                    Qr::AskVerifyContact { .. } | Qr::AskVerifyGroup { .. } | Qr::AskJoinBroadcast { .. } => {
                        anyhow::ensure!(configured, "create your account first (paste a relay link or tap Create account)");
                        Ok(LinkDone::Chat(deltachat::securejoin::join_securejoin(&ctx, &link).await?))
                    }
                    Qr::Account { .. } | Qr::Login { .. } => {
                        if !configured {
                            ctx.set_config(deltachat::config::Config::Displayname, Some("Velta preview")).await?;
                        }
                        ctx.add_transport_from_qr(&link).await?;
                        if configured {
                            Ok(LinkDone::Note("Relay added."))
                        } else {
                            ctx.start_io().await;
                            Ok(LinkDone::AccountCreated)
                        }
                    }
                    Qr::Proxy { .. } => {
                        deltachat::qr::set_config_from_qr(&ctx, &link).await?;
                        Ok(LinkDone::Note("Proxy added."))
                    }
                    Qr::Backup2 { .. } | Qr::BackupTooNew { .. } => anyhow::bail!("backups can't be restored in the preview yet"),
                    _ => anyhow::bail!("not an invite, relay or proxy link"),
                }
            }
            .await;
            done(r)
        });
    }

    /// Sends `text`, quoting `reply_to` when set (the swipe-to-reply path).
    pub fn send_text(&self, id: ChatId, text: String, reply_to: Option<MsgId>) -> Result<()> {
        self.rt.block_on(async {
            let mut msg = Message::new_text(text);
            if let Some(q) = reply_to {
                let quoted = Message::load_from_db(&self.ctx, q).await?;
                msg.set_quote(&self.ctx, Some(&quoted)).await?;
            }
            chat::send_msg(&self.ctx, id, &mut msg).await?;
            anyhow::Ok(())
        })
    }

    /// One-line text of a message, for the reply banner.
    pub fn msg_text(&self, id: MsgId) -> String {
        self.rt.block_on(async { Message::load_from_db(&self.ctx, id).await.map(|m| m.get_text()).unwrap_or_default() })
    }
}
