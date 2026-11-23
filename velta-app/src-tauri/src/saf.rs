//! #454 Android storage for Loop (local chat): the folder picker, SAF tree
//! listings and reads for streamed sends (`content://` too), extraction into
//! a picked tree, and the foreground service that keeps long transfers alive
//! with a progress notification and Cancel. Kotlin side: LoopFiles.kt and
//! LoopTransferService.kt.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::os::fd::FromRawFd;
use std::path::Path;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{anyhow, bail, Result};
use serde_json::Value;

use crate::loopzip::{Dest, Listed, Src};
use crate::{with_android_class, APP_LOOP_FILES_CLASS, APP_LOOP_SERVICE_CLASS};

/// Tree URIs the user picked through [`pick_tree`] in this process: the only
/// trees the commands will list or write into (the pick is the consent).
static PICKED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub fn check_picked(tree: &str) -> Result<(), String> {
    let ok = PICKED.lock().unwrap().as_ref().is_some_and(|s| s.contains(tree));
    if ok { Ok(()) } else { Err("folder was not picked by the user".into()) }
}

fn files<R>(
    f: impl FnOnce(&mut jni::JNIEnv<'_>, &jni::objects::JObject<'_>, &jni::objects::GlobalRef) -> Result<R, String>,
) -> Result<R, String> {
    with_android_class(&APP_LOOP_FILES_CLASS, "LoopFiles", f)
}

fn jstr(env: &mut jni::JNIEnv<'_>, v: jni::objects::JValueOwned<'_>) -> Result<String, String> {
    let o = v.l().map_err(|e| e.to_string())?;
    if o.is_null() {
        return Ok(String::new());
    }
    let s: String = env.get_string(&jni::objects::JString::from(o)).map_err(|e| e.to_string())?.into();
    Ok(s)
}

fn call_str(method: &str, args: &[&str]) -> Result<String, String> {
    files(|env, context, class| {
        let mut owned = Vec::new();
        for a in args {
            owned.push(env.new_string(a).map_err(|e| e.to_string())?);
        }
        let mut jargs: Vec<jni::objects::JValue> = vec![context.into()];
        let mut sig = String::from("(Landroid/content/Context;");
        for s in &owned {
            jargs.push(s.into());
            sig.push_str("Ljava/lang/String;");
        }
        sig.push_str(")Ljava/lang/String;");
        let v = env.call_static_method(class, method, &sig, &jargs).map_err(|e| format!("{method}: {e}"))?;
        jstr(env, v)
    })
}

/// Opens the system folder picker and waits for the answer. `None` when
/// the user backed out.
pub fn pick_tree() -> Result<Option<String>, String> {
    let shown = files(|env, _ctx, class| {
        env.call_static_method(class, "pickTree", "()Z", &[])
            .and_then(|v| v.z())
            .map_err(|e| e.to_string())
    })?;
    if !shown {
        return Err("the folder picker needs the app in front".into());
    }
    let start = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(150));
        let r = files(|env, _ctx, class| {
            let v = env.call_static_method(class, "takeResult", "()Ljava/lang/String;", &[]).map_err(|e| e.to_string())?;
            jstr(env, v)
        })?;
        match r.as_str() {
            "" if start.elapsed() < Duration::from_secs(30 * 60) => continue,
            "" | "-" => return Ok(None),
            uri => {
                PICKED.lock().unwrap().get_or_insert_with(HashSet::new).insert(uri.to_string());
                return Ok(Some(uri.to_string()));
            }
        }
    }
}

/// Root folder name and the entries of a picked tree, ready for
/// `FolderZip::from_listing`.
pub fn list_tree(tree: &str) -> Result<(String, Vec<Listed>)> {
    let json = call_str("listTree", &[tree]).map_err(|e| anyhow!(e))?;
    if json.is_empty() {
        bail!("could not read that folder");
    }
    let v: Value = serde_json::from_str(&json)?;
    let name = v["name"].as_str().unwrap_or("folder").to_string();
    let mut out = Vec::new();
    for e in v["entries"].as_array().into_iter().flatten() {
        let dir = e["dir"].as_bool().unwrap_or(false);
        let uri = e["uri"].as_str().unwrap_or_default();
        out.push(Listed {
            rel: e["rel"].as_str().unwrap_or_default().to_string(),
            dir,
            size: e["size"].as_u64().unwrap_or(0),
            mtime: SystemTime::UNIX_EPOCH + Duration::from_millis(e["mtime"].as_u64().unwrap_or(0)),
            src: (!dir && !uri.is_empty()).then(|| Src::Uri(uri.to_string())),
        });
    }
    Ok((name, out))
}

/// Display name and size of one `content://` file.
pub fn describe(uri: &str) -> Result<(String, u64)> {
    let json = call_str("describe", &[uri]).map_err(|e| anyhow!(e))?;
    if json.is_empty() {
        bail!("could not read that file");
    }
    let v: Value = serde_json::from_str(&json)?;
    let size = v["size"].as_i64().unwrap_or(-1);
    if size < 0 {
        bail!("that file does not report its size");
    }
    Ok((v["name"].as_str().unwrap_or("file").to_string(), size as u64))
}

/// A readable `File` for a `content://` URI (the fd is detached on the
/// Kotlin side, so this File owns and closes it).
pub fn open_read(uri: &str) -> std::io::Result<File> {
    let fd = files(|env, context, class| {
        let u = env.new_string(uri).map_err(|e| e.to_string())?;
        env.call_static_method(class, "openRead", "(Landroid/content/Context;Ljava/lang/String;)I", &[context.into(), (&u).into()])
            .and_then(|v| v.i())
            .map_err(|e| e.to_string())
    })
    .map_err(std::io::Error::other)?;
    if fd < 0 {
        return Err(std::io::Error::other("could not open that file"));
    }
    // SAFETY: a fresh fd detached from its ParcelFileDescriptor; nothing else owns it.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn rel_str(base: &str, rel: &Path) -> Result<String> {
    let mut s = base.to_string();
    for c in rel.components() {
        match c {
            std::path::Component::Normal(p) => {
                s.push('/');
                s.push_str(&p.to_string_lossy());
            }
            _ => bail!("entry escaped the destination"),
        }
    }
    Ok(s)
}

/// A picked SAF tree as an extraction destination; everything lands under
/// `<tree>/<base>/`.
pub struct TreeDest {
    tree: String,
    base: String,
    made: HashMap<String, String>,
}

impl TreeDest {
    pub fn new(tree: &str, base: &str) -> Self {
        TreeDest { tree: tree.into(), base: base.into(), made: HashMap::new() }
    }
}

impl Drop for TreeDest {
    fn drop(&mut self) {
        let _ = files(|env, _ctx, class| env.call_static_method(class, "endExtract", "()V", &[]).map(|_| ()).map_err(|e| e.to_string()));
    }
}

impl Dest for TreeDest {
    fn mkdir(&mut self, rel: &Path) -> Result<()> {
        let r = rel_str(&self.base, rel)?;
        let ok = files(|env, context, class| {
            let t = env.new_string(&self.tree).map_err(|e| e.to_string())?;
            let p = env.new_string(&r).map_err(|e| e.to_string())?;
            env.call_static_method(
                class,
                "mkdirs",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Z",
                &[context.into(), (&t).into(), (&p).into()],
            )
            .and_then(|v| v.z())
            .map_err(|e| e.to_string())
        })
        .map_err(|e| anyhow!(e))?;
        if !ok {
            bail!("could not create a folder there");
        }
        Ok(())
    }

    fn create(&mut self, rel: &Path) -> Result<Box<dyn std::io::Write>> {
        let r = rel_str(&self.base, rel)?;
        let out = call_str("createFile", &[&self.tree, &r]).map_err(|e| anyhow!(e))?;
        let (fd, doc) = out.split_once('|').ok_or_else(|| anyhow!("could not create a file there"))?;
        let fd: i32 = fd.parse()?;
        self.made.insert(r, doc.to_string());
        // SAFETY: as in open_read.
        let f = unsafe { File::from_raw_fd(fd) };
        Ok(Box::new(std::io::BufWriter::with_capacity(256 * 1024, f)))
    }

    fn remove(&mut self, rel: &Path) {
        let Ok(r) = rel_str(&self.base, rel) else { return };
        if let Some(doc) = self.made.remove(&r) {
            let _ = call_str("remove", &[&doc]);
        }
    }
}

// ---- Foreground service for long transfers --------------------------------

/// Transfers smaller than this never raise the service.
const FGS_MIN_BYTES: u64 = 4 * 1024 * 1024;
/// An entry with no progress for this long is forgotten (a dropped receive
/// has no terminal event).
const STALE: Duration = Duration::from_secs(60);

type Key = (String, String, String); // peer, id, dir

struct Track {
    got: u64,
    size: u64,
    seen: Instant,
}

static TRACKER: OnceLock<Mutex<mpsc::Sender<Value>>> = OnceLock::new();
static ACTIVE: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// Called for every engine event on Android (p2p.rs Sink::Tauri). Cheap: the
/// bookkeeping and the JNI calls run on one worker thread.
pub fn observe(v: &Value) {
    let interesting = matches!(v["kind"].as_str(), Some("file-progress") | Some("message"));
    if !interesting {
        return;
    }
    let tx = TRACKER.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new().name("loop-fgs".into()).spawn(move || run_tracker(rx)).ok();
        Mutex::new(tx)
    });
    let _ = tx.lock().unwrap().send(v.clone());
}

fn run_tracker(rx: mpsc::Receiver<Value>) {
    let mut map: HashMap<Key, Track> = HashMap::new();
    let mut shown = false;
    let mut pushed = Instant::now().checked_sub(Duration::from_secs(10)).unwrap_or_else(Instant::now);
    loop {
        let ev = match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(v) => Some(v),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        if let Some(v) = ev {
            let peer = v["peerId"].as_str().unwrap_or_default().to_string();
            let id = v["id"].as_str().unwrap_or_default().to_string();
            match v["kind"].as_str() {
                Some("message") => {
                    map.remove(&(peer, id, "recv".into()));
                }
                _ => {
                    let key = (peer, id, v["dir"].as_str().unwrap_or_default().to_string());
                    if v["done"].as_bool() == Some(true) || v["failed"].as_bool() == Some(true) {
                        map.remove(&key);
                    } else {
                        let size = v["size"].as_u64().unwrap_or(0);
                        if size >= FGS_MIN_BYTES || map.contains_key(&key) {
                            let t = map.entry(key).or_insert(Track { got: 0, size, seen: Instant::now() });
                            t.got = v["got"].as_u64().unwrap_or(t.got);
                            t.size = size.max(t.size);
                            t.seen = Instant::now();
                        }
                    }
                }
            }
        }
        map.retain(|_, t| t.seen.elapsed() < STALE);
        *ACTIVE.lock().unwrap() = map.keys().map(|(p, i, _)| (p.clone(), i.clone())).collect();
        if map.is_empty() {
            if shown {
                shown = !service_update(0, 0, 0);
            }
            continue;
        }
        if !shown || pushed.elapsed() >= Duration::from_secs(1) {
            let got: u64 = map.values().map(|t| t.got).sum();
            let size: u64 = map.values().map(|t| t.size).sum();
            shown = service_update(map.len() as i32, got as i64, size as i64) || shown;
            pushed = Instant::now();
        }
    }
}

/// LoopTransferService.update; count 0 stops the service. true on success.
fn service_update(count: i32, got: i64, size: i64) -> bool {
    with_android_class(&APP_LOOP_SERVICE_CLASS, "LoopTransferService", |env, context, class| {
        env.call_static_method(
            class,
            "update",
            "(Landroid/content/Context;IJJ)V",
            &[context.into(), jni::objects::JValue::Int(count), jni::objects::JValue::Long(got), jni::objects::JValue::Long(size)],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .map_err(|e| {
        crate::log(&format!("loop transfer service: {e}"));
    })
    .is_ok()
}

/// The notification's Cancel: stops every tracked Loop transfer.
#[no_mangle]
pub extern "system" fn Java_org_velta_LoopTransferService_cancelAll(_env: jni::JNIEnv, _class: jni::objects::JClass) {
    let pairs = std::mem::take(&mut *ACTIVE.lock().unwrap());
    let app = crate::APP_HANDLE.lock().unwrap().clone();
    if let Some(app) = app {
        std::thread::spawn(move || crate::p2p::cancel_many(&app, &pairs));
    }
}
