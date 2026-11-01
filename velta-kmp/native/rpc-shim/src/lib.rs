//! In-process deltachat core for the Velta KMP Android client (issue #192 P1b).
//!
//! Mirrors `deltachat-rpc-server/src/main.rs` (Accounts + CommandApi +
//! yerpc RpcSession) but serves **JSON Lines on a 127.0.0.1 TCP port**
//! instead of stdio, so the Kotlin client needs no exec'd sidecar binary —
//! the same in-process architecture the Tauri Android shell uses
//! (`init_android_core`), minus the Tauri event plumbing.

use std::path::PathBuf;
use std::sync::Arc;

use deltachat_jsonrpc::api::{Accounts, CommandApi};
use futures_util::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use yerpc::{RpcClient, RpcSession};

/// One yerpc session per connection: read request lines, dispatch them as
/// independent tasks, and forward responses/events back as JSON Lines.
async fn serve_connection(state: CommandApi, stream: tokio::net::TcpStream) -> anyhow::Result<()> {
    let (client, mut out_receiver) = RpcClient::new();
    let session = RpcSession::new(client.clone(), state);
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    loop {
        tokio::select! {
            incoming = lines.next_line() => match incoming? {
                Some(line) => {
                    let session = session.clone();
                    tokio::spawn(async move {
                        session.handle_incoming(&line).await;
                    });
                }
                None => break,
            },
            outgoing = out_receiver.next() => match outgoing {
                Some(message) => {
                    let line = serde_json::to_string(&message)?;
                    writer.write_all(line.as_bytes()).await?;
                    writer.write_all(b"\n").await?;
                }
                None => break,
            },
        }
    }
    Ok(())
}

/// Bind a loopback port synchronously (the port must be known before the
/// JNI call returns), then serve the core from a dedicated thread with its
/// own tokio runtime. Returns the port, or a distinct negative code:
/// -2 bind failed, -3 Accounts::new failed.
fn start_core(accounts_dir: String) -> anyhow::Result<i32> {
    let std_listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("velta-rpc-shim: bind failed: {e:#}");
            return Ok(-2);
        }
    };
    let port = std_listener.local_addr()?.port() as i32;

    std::thread::Builder::new()
        .name("velta-rpc-shim".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            rt.block_on(async move {
                let accounts = match Accounts::new(PathBuf::from(&accounts_dir), true).await {
                    Ok(accounts) => Arc::new(RwLock::new(accounts)),
                    Err(e) => {
                        eprintln!("velta-rpc-shim: Accounts::new failed: {e:#}");
                        return;
                    }
                };
                let state = CommandApi::from_arc(accounts.clone()).await;
                let listener = match TcpListener::from_std(std_listener) {
                    Ok(listener) => listener,
                    Err(e) => {
                        eprintln!("velta-rpc-shim: listener handoff failed: {e}");
                        return;
                    }
                };
                eprintln!("velta-rpc-shim: serving core on 127.0.0.1:{port}");
                loop {
                    let (stream, _peer) = match listener.accept().await {
                        Ok(accepted) => accepted,
                        Err(e) => {
                            eprintln!("velta-rpc-shim: accept failed: {e}");
                            continue;
                        }
                    };
                    let state = state.clone();
                    tokio::spawn(async move {
                        if let Err(e) = serve_connection(state, stream).await {
                            eprintln!("velta-rpc-shim: connection ended: {e:#}");
                        }
                    });
                }
            });
        })?;

    Ok(port)
}

/// JNI entry: `org.velta.kmp.core.RpcShim.startCore(accountsDir) -> port`.
/// Returns -1 on failure (the Kotlin side surfaces that as a connect error).
#[no_mangle]
pub extern "system" fn Java_org_velta_kmp_core_RpcShim_startCore<'local>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
    accounts_dir: jni::objects::JString<'local>,
) -> i32 {
    let dir: String = match env.get_string(&accounts_dir) {
        Ok(s) => s.into(),
        Err(_) => return -1,
    };
    match start_core(dir) {
        Ok(port) => port,
        Err(e) => {
            eprintln!("velta-rpc-shim: start failed: {e:#}");
            -1
        }
    }
}
