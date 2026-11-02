//! Android side of the SOCKS5 proxy keeper (proxy.rs): the in-process core
//! (the accounts manager the Android shell embeds).

use deltachat::config::Config;

type Accounts = std::sync::Arc<tokio::sync::RwLock<deltachat_jsonrpc::api::Accounts>>;

fn accounts() -> Option<Accounts> {
    crate::ANDROID_ACCOUNTS.lock().unwrap().clone()
}

/// None until the core is up.
pub async fn account_ids() -> Option<Vec<u32>> {
    Some(accounts()?.read().await.get_all())
}

/// (proxy_url, proxy_enabled) of one account.
pub async fn proxy_config(id: u32) -> Option<(String, bool)> {
    let ctx = accounts()?.read().await.get_account(id)?;
    let url = ctx.get_config(Config::ProxyUrl).await.ok().flatten().unwrap_or_default();
    let enabled = ctx.get_config_bool(Config::ProxyEnabled).await.unwrap_or(false);
    Some((url, enabled))
}

pub async fn set_config(id: u32, key: &str, value: Option<&str>) -> Result<(), String> {
    let ctx = accounts().ok_or("core not running")?.read().await.get_account(id).ok_or("no such account")?;
    let key: Config = key.parse().map_err(|_| format!("unknown key {key}"))?;
    ctx.set_config(key, value).await.map_err(|e| e.to_string())
}

pub async fn restart_io(id: u32) {
    let Some(a) = accounts() else { return };
    let ctx = a.read().await.get_account(id);
    if let Some(ctx) = ctx {
        ctx.restart_io_if_running().await;
    }
}

/// Tells the core the network changed; false when it is not up yet.
pub async fn maybe_network() -> bool {
    let Some(a) = accounts() else { return false };
    // Never hold the account manager lock across the interrupts: they can
    // wait out an IO restart, and a queued writer would then block every
    // UI RPC (chat switching hung behind it).
    let contexts: Vec<_> = {
        let accounts = a.read().await;
        accounts.get_all().into_iter().filter_map(|id| accounts.get_account(id)).collect()
    };
    for ctx in contexts {
        ctx.maybe_network().await;
    }
    true
}

/// Resume diagnostic: one line per account with its connectivity, or a
/// line saying the account manager lock is held (a stuck start_io/stop_io
/// writer blocks every UI RPC). Read-only; bounded at 5 s.
pub async fn log_resume_state() {
    let Some(a) = accounts() else {
        crate::log("resume: core not running");
        return;
    };
    let t = std::time::Instant::now();
    let contexts: Vec<_> = match tokio::time::timeout(std::time::Duration::from_secs(5), a.read()).await {
        Ok(accounts) => accounts.get_all().into_iter().filter_map(|id| accounts.get_account(id).map(|c| (id, c))).collect(),
        Err(_) => {
            crate::log("resume: account lock busy >5s (IO start/stop stuck?)");
            return;
        }
    };
    crate::log(&format!("resume: account lock in {} ms", t.elapsed().as_millis()));
    for (id, ctx) in contexts {
        crate::log(&format!("resume: account {id} connectivity {:?}", ctx.get_connectivity()));
    }
}
