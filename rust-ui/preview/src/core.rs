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
    Msg { id: MsgId, outgoing: bool, sender: Option<String>, text: String, time: String },
}

pub struct Core {
    rt: Runtime,
    accounts: Arc<RwLock<Accounts>>,
    ctx: Context,
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
    /// Opens an existing accounts dir (the same layout the other Velta clients use)
    /// and starts IO for every account.
    pub fn open(dir: PathBuf) -> Result<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().worker_threads(2).build()?;
        let (accounts, ctx) = rt.block_on(async {
            let mut accounts = Accounts::new(dir, true).await?;
            let ctx = accounts.get_selected_account().context("no account in this accounts dir")?;
            accounts.start_io().await;
            anyhow::Ok((accounts, ctx))
        })?;
        Ok(Core { rt, accounts: Arc::new(RwLock::new(accounts)), ctx })
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
                        out.push(Item::Msg { id: msg_id, outgoing, sender, text, time: hm(m.get_timestamp()) });
                    }
                }
            }
            Ok(out)
        })
    }

    pub fn mark_seen(&self, id: ChatId) {
        let _ = self.rt.block_on(chat::marknoticed_chat(&self.ctx, id));
    }

    pub fn send_text(&self, id: ChatId, text: String) -> Result<()> {
        self.rt.block_on(chat::send_text_msg(&self.ctx, id, text))?;
        Ok(())
    }
}
