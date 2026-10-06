// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Velta contributors. Velta-original (clean-room, see
// docs/research/wasm-patches/velta-tokio-wasm-requirements.md).

//! A process-wide, in-memory filesystem with a `tokio::fs`-shaped API.
//!
//! Paths are normalised to absolute form (relative paths are taken relative
//! to `/`; `.` and `..` are resolved lexically). Contents live only as long
//! as the wasm instance: there is no persistence layer here.

use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::io::{self, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};

// ---------------------------------------------------------------- store ---

#[derive(Debug)]
struct FileData {
    bytes: Vec<u8>,
    modified: SystemTime,
}

type FileRef = Arc<Mutex<FileData>>;

#[derive(Clone)]
enum Node {
    Dir { modified: SystemTime },
    File(FileRef),
}

/// Map from normalised absolute path to node. A BTreeMap keeps directory
/// listings and subtree walks ordered and cheap (subtrees are contiguous).
struct Store {
    nodes: BTreeMap<PathBuf, Node>,
}

fn store() -> MutexGuard<'static, Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            let mut nodes = BTreeMap::new();
            nodes.insert(PathBuf::from("/"), Node::Dir { modified: now() });
            Mutex::new(Store { nodes })
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Wall-clock time without `SystemTime::now()` (which panics on this target).
fn now() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs_f64(js_sys::Date::now() / 1000.0)
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for comp in path.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => out = PathBuf::from("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
        }
    }
    out
}

fn err(kind: io::ErrorKind, what: &str, path: &Path) -> io::Error {
    io::Error::new(kind, format!("{what}: {}", path.display()))
}

fn not_found(path: &Path) -> io::Error {
    err(io::ErrorKind::NotFound, "no such file or directory", path)
}

/// Iterates the strict descendants of `dir` (BTreeMap order puts them right
/// after `dir` itself, all sharing its prefix).
fn descendants<'a>(
    nodes: &'a BTreeMap<PathBuf, Node>,
    dir: &'a Path,
) -> impl Iterator<Item = &'a PathBuf> + 'a {
    nodes
        .range::<Path, _>((std::ops::Bound::Excluded(dir), std::ops::Bound::Unbounded))
        .map(|(k, _)| k)
        .take_while(move |k| k.starts_with(dir))
}

impl Store {
    fn get(&self, p: &Path) -> Option<&Node> {
        self.nodes.get(p)
    }

    fn require_parent_dir(&self, p: &Path) -> io::Result<()> {
        match p.parent() {
            None => Ok(()),
            Some(parent) => match self.get(parent) {
                Some(Node::Dir { .. }) => Ok(()),
                Some(Node::File(_)) => Err(err(
                    io::ErrorKind::NotADirectory,
                    "parent is not a directory",
                    p,
                )),
                None => Err(not_found(parent)),
            },
        }
    }

    fn file(&self, p: &Path) -> io::Result<FileRef> {
        match self.get(p) {
            Some(Node::File(f)) => Ok(f.clone()),
            Some(Node::Dir { .. }) => Err(err(io::ErrorKind::IsADirectory, "is a directory", p)),
            None => Err(not_found(p)),
        }
    }

    fn touch_parent(&mut self, p: &Path) {
        if let Some(parent) = p.parent() {
            if let Some(Node::Dir { modified }) = self.nodes.get_mut(parent) {
                *modified = now();
            }
        }
    }

    /// Opens or creates a file according to `opts`.
    fn open(&mut self, p: &Path, opts: &OpenOptions) -> io::Result<FileRef> {
        match self.get(p) {
            Some(Node::Dir { .. }) => Err(err(io::ErrorKind::IsADirectory, "is a directory", p)),
            Some(Node::File(f)) => {
                if opts.create_new {
                    return Err(err(io::ErrorKind::AlreadyExists, "file exists", p));
                }
                let f = f.clone();
                if opts.truncate {
                    let mut d = f.lock().unwrap();
                    d.bytes.clear();
                    d.modified = now();
                }
                Ok(f)
            }
            None => {
                if !(opts.create || opts.create_new) {
                    return Err(not_found(p));
                }
                self.require_parent_dir(p)?;
                let f = Arc::new(Mutex::new(FileData {
                    bytes: Vec::new(),
                    modified: now(),
                }));
                self.nodes.insert(p.to_path_buf(), Node::File(f.clone()));
                self.touch_parent(p);
                Ok(f)
            }
        }
    }

    fn write_all(&mut self, p: &Path, data: &[u8]) -> io::Result<()> {
        let opts = OpenOptions {
            write: true,
            create: true,
            truncate: true,
            ..OpenOptions::default()
        };
        let f = self.open(p, &opts)?;
        let mut d = f.lock().unwrap();
        d.bytes.clear();
        d.bytes.extend_from_slice(data);
        d.modified = now();
        Ok(())
    }

    fn create_dir(&mut self, p: &Path) -> io::Result<()> {
        if self.get(p).is_some() {
            return Err(err(io::ErrorKind::AlreadyExists, "already exists", p));
        }
        self.require_parent_dir(p)?;
        self.nodes
            .insert(p.to_path_buf(), Node::Dir { modified: now() });
        self.touch_parent(p);
        Ok(())
    }

    fn create_dir_all(&mut self, p: &Path) -> io::Result<()> {
        let mut missing = Vec::new();
        let mut cur = Some(p);
        while let Some(c) = cur {
            match self.get(c) {
                Some(Node::Dir { .. }) => break,
                Some(Node::File(_)) => {
                    return Err(err(io::ErrorKind::NotADirectory, "not a directory", c))
                }
                None => missing.push(c.to_path_buf()),
            }
            cur = c.parent();
        }
        for dir in missing.into_iter().rev() {
            self.nodes
                .insert(dir.clone(), Node::Dir { modified: now() });
            self.touch_parent(&dir);
        }
        Ok(())
    }

    fn remove_file(&mut self, p: &Path) -> io::Result<()> {
        match self.get(p) {
            Some(Node::File(_)) => {
                self.nodes.remove(p);
                self.touch_parent(p);
                Ok(())
            }
            Some(Node::Dir { .. }) => Err(err(io::ErrorKind::IsADirectory, "is a directory", p)),
            None => Err(not_found(p)),
        }
    }

    fn remove_dir(&mut self, p: &Path, recursive: bool) -> io::Result<()> {
        match self.get(p) {
            Some(Node::Dir { .. }) => {}
            Some(Node::File(_)) => {
                return Err(err(io::ErrorKind::NotADirectory, "not a directory", p))
            }
            None => return Err(not_found(p)),
        }
        if p == Path::new("/") {
            return Err(err(
                io::ErrorKind::PermissionDenied,
                "refusing to remove",
                p,
            ));
        }
        let children: Vec<PathBuf> = descendants(&self.nodes, p).cloned().collect();
        if !children.is_empty() && !recursive {
            return Err(err(
                io::ErrorKind::DirectoryNotEmpty,
                "directory not empty",
                p,
            ));
        }
        for c in children {
            self.nodes.remove(&c);
        }
        self.nodes.remove(p);
        self.touch_parent(p);
        Ok(())
    }

    fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        let node = self.get(from).cloned().ok_or_else(|| not_found(from))?;
        if from == to {
            return Ok(());
        }
        self.require_parent_dir(to)?;
        match (&node, self.get(to)) {
            (Node::File(_), Some(Node::Dir { .. })) => {
                return Err(err(
                    io::ErrorKind::IsADirectory,
                    "target is a directory",
                    to,
                ))
            }
            (Node::Dir { .. }, Some(Node::File(_))) => {
                return Err(err(
                    io::ErrorKind::NotADirectory,
                    "target is not a directory",
                    to,
                ))
            }
            (Node::Dir { .. }, Some(Node::Dir { .. })) => {
                if descendants(&self.nodes, to).next().is_some() {
                    return Err(err(
                        io::ErrorKind::DirectoryNotEmpty,
                        "target directory not empty",
                        to,
                    ));
                }
            }
            _ => {}
        }
        if let Node::Dir { .. } = node {
            if to.starts_with(from) {
                return Err(err(
                    io::ErrorKind::InvalidInput,
                    "cannot move a directory into itself",
                    to,
                ));
            }
            let moved: Vec<(PathBuf, Node)> = descendants(&self.nodes, from)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .map(|k| {
                    let n = self.nodes.remove(&k).expect("listed");
                    (to.join(k.strip_prefix(from).expect("descendant")), n)
                })
                .collect();
            self.nodes.extend(moved);
        }
        self.nodes.remove(from);
        self.nodes.insert(to.to_path_buf(), node);
        self.touch_parent(from);
        self.touch_parent(to);
        Ok(())
    }

    fn metadata(&self, p: &Path) -> io::Result<Metadata> {
        match self.get(p) {
            Some(Node::Dir { modified }) => Ok(Metadata {
                dir: true,
                len: 0,
                modified: *modified,
            }),
            Some(Node::File(f)) => {
                let d = f.lock().unwrap();
                Ok(Metadata {
                    dir: false,
                    len: d.bytes.len() as u64,
                    modified: d.modified,
                })
            }
            None => Err(not_found(p)),
        }
    }

    fn list(&self, p: &Path) -> io::Result<VecDeque<DirEntry>> {
        match self.get(p) {
            Some(Node::Dir { .. }) => {}
            Some(Node::File(_)) => {
                return Err(err(io::ErrorKind::NotADirectory, "not a directory", p))
            }
            None => return Err(not_found(p)),
        }
        Ok(descendants(&self.nodes, p)
            .filter(|k| k.parent() == Some(p))
            .map(|k| DirEntry { path: k.clone() })
            .collect())
    }
}

// ------------------------------------------------------- metadata types ---

/// File or directory, as reported by [`Metadata::file_type`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileType {
    dir: bool,
}

impl FileType {
    pub fn is_dir(&self) -> bool {
        self.dir
    }
    pub fn is_file(&self) -> bool {
        !self.dir
    }
    pub fn is_symlink(&self) -> bool {
        false
    }
}

/// Snapshot of a node's attributes.
#[derive(Clone, Debug)]
pub struct Metadata {
    dir: bool,
    len: u64,
    modified: SystemTime,
}

impl Metadata {
    pub fn is_dir(&self) -> bool {
        self.dir
    }
    pub fn is_file(&self) -> bool {
        !self.dir
    }
    pub fn is_symlink(&self) -> bool {
        false
    }
    pub fn len(&self) -> u64 {
        self.len
    }
    pub fn file_type(&self) -> FileType {
        FileType { dir: self.dir }
    }
    pub fn modified(&self) -> io::Result<SystemTime> {
        Ok(self.modified)
    }
    /// Access times are not tracked; reports the modification time.
    pub fn accessed(&self) -> io::Result<SystemTime> {
        Ok(self.modified)
    }
    /// Creation times are not tracked; reports the modification time.
    pub fn created(&self) -> io::Result<SystemTime> {
        Ok(self.modified)
    }
}

// ------------------------------------------------------- free functions ---

macro_rules! with_store {
    (|$s:ident| $body:expr) => {{
        let mut guard = store();
        let $s: &mut Store = &mut guard;
        $body
    }};
}

pub fn sync_read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    let p = normalize(path.as_ref());
    let f = with_store!(|s| s.file(&p))?;
    let bytes = f.lock().unwrap().bytes.clone();
    Ok(bytes)
}

/// Writes a whole file, **creating missing parent directories** (contract of
/// the wrapper's JS file side channel, e.g. `fs_write("/t/x/hello.bin")`).
/// The async [`write`] keeps std semantics and needs an existing parent.
pub fn sync_write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let p = normalize(path.as_ref());
    with_store!(|s| {
        if let Some(parent) = p.parent() {
            s.create_dir_all(parent)?;
        }
        s.write_all(&p, contents.as_ref())
    })
}

fn write_strict(path: &Path, contents: &[u8]) -> io::Result<()> {
    let p = normalize(path);
    with_store!(|s| s.write_all(&p, contents))
}

/// Removes a file, or a directory tree.
pub fn sync_remove(path: impl AsRef<Path>) -> io::Result<()> {
    let p = normalize(path.as_ref());
    with_store!(|s| match s.get(&p) {
        Some(Node::Dir { .. }) => s.remove_dir(&p, true),
        _ => s.remove_file(&p),
    })
}

pub fn sync_exists(path: impl AsRef<Path>) -> bool {
    let p = normalize(path.as_ref());
    with_store!(|s| s.get(&p).is_some())
}

pub fn sync_is_dir(path: impl AsRef<Path>) -> bool {
    let p = normalize(path.as_ref());
    with_store!(|s| matches!(s.get(&p), Some(Node::Dir { .. })))
}

pub fn sync_is_file(path: impl AsRef<Path>) -> bool {
    let p = normalize(path.as_ref());
    with_store!(|s| matches!(s.get(&p), Some(Node::File(_))))
}

pub fn sync_create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    let p = normalize(path.as_ref());
    with_store!(|s| s.create_dir_all(&p))
}

pub fn sync_metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
    let p = normalize(path.as_ref());
    with_store!(|s| s.metadata(&p))
}

pub async fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    sync_read(path)
}

pub async fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
    let bytes = sync_read(path)?;
    String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

pub async fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    write_strict(path.as_ref(), contents.as_ref())
}

pub async fn remove_file(path: impl AsRef<Path>) -> io::Result<()> {
    let p = normalize(path.as_ref());
    with_store!(|s| s.remove_file(&p))
}

pub async fn remove_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let p = normalize(path.as_ref());
    with_store!(|s| s.remove_dir(&p, false))
}

pub async fn remove_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    let p = normalize(path.as_ref());
    with_store!(|s| s.remove_dir(&p, true))
}

pub async fn rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
    let (a, b) = (normalize(from.as_ref()), normalize(to.as_ref()));
    with_store!(|s| s.rename(&a, &b))
}

pub async fn copy(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
    let data = sync_read(from)?;
    let n = data.len() as u64;
    write_strict(to.as_ref(), &data)?;
    Ok(n)
}

pub async fn create_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let p = normalize(path.as_ref());
    with_store!(|s| s.create_dir(&p))
}

pub async fn create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    sync_create_dir_all(path)
}

pub async fn metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
    sync_metadata(path)
}

/// There are no symlinks, so this equals [`metadata`].
pub async fn symlink_metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
    sync_metadata(path)
}

pub async fn try_exists(path: impl AsRef<Path>) -> io::Result<bool> {
    Ok(sync_exists(path))
}

/// Absolute, lexically normalised path; fails if nothing is there.
pub async fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    let p = normalize(path.as_ref());
    if sync_exists(&p) {
        Ok(p)
    } else {
        Err(not_found(&p))
    }
}

pub async fn read_dir(path: impl AsRef<Path>) -> io::Result<ReadDir> {
    let p = normalize(path.as_ref());
    let entries = with_store!(|s| s.list(&p))?;
    Ok(ReadDir { entries })
}

// ------------------------------------------------------------- read_dir ---

/// Directory listing, taken as a snapshot when [`read_dir`] was called.
#[derive(Debug)]
pub struct ReadDir {
    entries: VecDeque<DirEntry>,
}

impl ReadDir {
    pub async fn next_entry(&mut self) -> io::Result<Option<DirEntry>> {
        Ok(self.entries.pop_front())
    }
    pub fn poll_next_entry(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<Option<DirEntry>>> {
        Poll::Ready(Ok(self.entries.pop_front()))
    }
}

#[derive(Debug, Clone)]
pub struct DirEntry {
    path: PathBuf,
}

impl DirEntry {
    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }
    pub fn file_name(&self) -> OsString {
        self.path
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_default()
    }
    pub async fn metadata(&self) -> io::Result<Metadata> {
        sync_metadata(&self.path)
    }
    pub async fn file_type(&self) -> io::Result<FileType> {
        Ok(sync_metadata(&self.path)?.file_type())
    }
}

// --------------------------------------------------------- OpenOptions ---

#[derive(Clone, Debug, Default)]
pub struct OpenOptions {
    read: bool,
    write: bool,
    append: bool,
    truncate: bool,
    create: bool,
    create_new: bool,
}

impl OpenOptions {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn read(&mut self, v: bool) -> &mut Self {
        self.read = v;
        self
    }
    pub fn write(&mut self, v: bool) -> &mut Self {
        self.write = v;
        self
    }
    pub fn append(&mut self, v: bool) -> &mut Self {
        self.append = v;
        self
    }
    pub fn truncate(&mut self, v: bool) -> &mut Self {
        self.truncate = v;
        self
    }
    pub fn create(&mut self, v: bool) -> &mut Self {
        self.create = v;
        self
    }
    pub fn create_new(&mut self, v: bool) -> &mut Self {
        self.create_new = v;
        self
    }
    pub async fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
        let p = normalize(path.as_ref());
        let read_only =
            !(self.write || self.append || self.truncate || self.create || self.create_new);
        if read_only && sync_is_dir(&p) {
            // Like unix: a directory can be opened read-only (core does this to
            // fsync a parent after rename). Reads/writes on it fail.
            return Ok(File {
                data: Arc::new(Mutex::new(FileData {
                    bytes: Vec::new(),
                    modified: now(),
                })),
                pos: 0,
                readable: false,
                writable: false,
                append: false,
                seek_to: None,
                dir: Some(p),
            });
        }
        let data = with_store!(|s| s.open(&p, self))?;
        Ok(File {
            dir: None,
            data,
            pos: 0,
            readable: self.read,
            writable: self.write || self.append,
            append: self.append,
            seek_to: None,
        })
    }
}

// ----------------------------------------------------------------- File ---

/// Handle to an in-memory file. Keeps the contents alive even if the path
/// is removed meanwhile (unix-like).
#[derive(Debug)]
pub struct File {
    data: FileRef,
    pos: u64,
    readable: bool,
    writable: bool,
    append: bool,
    seek_to: Option<io::Result<u64>>,
    /// Set when this handle refers to a directory.
    dir: Option<PathBuf>,
}

impl File {
    pub async fn open(path: impl AsRef<Path>) -> io::Result<File> {
        OpenOptions::new().read(true).open(path).await
    }
    pub async fn create(path: impl AsRef<Path>) -> io::Result<File> {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .await
    }
    pub async fn create_new(path: impl AsRef<Path>) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)
            .await
    }
    pub fn options() -> OpenOptions {
        OpenOptions::new()
    }
    pub async fn metadata(&self) -> io::Result<Metadata> {
        if let Some(dir) = &self.dir {
            return sync_metadata(dir);
        }
        let d = self.data.lock().unwrap();
        Ok(Metadata {
            dir: false,
            len: d.bytes.len() as u64,
            modified: d.modified,
        })
    }
    pub async fn set_len(&self, size: u64) -> io::Result<()> {
        if !self.writable {
            return Err(self.access_error(true));
        }
        let mut d = self.data.lock().unwrap();
        d.bytes.resize(
            usize::try_from(size).map_err(|_| io::ErrorKind::InvalidInput)?,
            0,
        );
        d.modified = now();
        Ok(())
    }
    pub async fn sync_all(&self) -> io::Result<()> {
        Ok(())
    }
    pub async fn sync_data(&self) -> io::Result<()> {
        Ok(())
    }
    pub async fn try_clone(&self) -> io::Result<File> {
        Ok(File {
            data: self.data.clone(),
            pos: self.pos,
            readable: self.readable,
            writable: self.writable,
            append: self.append,
            seek_to: None,
            dir: self.dir.clone(),
        })
    }

    fn access_error(&self, writing: bool) -> io::Error {
        if let Some(dir) = &self.dir {
            err(io::ErrorKind::IsADirectory, "is a directory", dir)
        } else if writing {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "file not opened for writing",
            )
        } else {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "file not opened for reading",
            )
        }
    }
}

impl AsyncRead for File {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.readable {
            return Poll::Ready(Err(self.access_error(false)));
        }
        let n = {
            let d = self.data.lock().unwrap();
            let start = usize::try_from(self.pos)
                .unwrap_or(usize::MAX)
                .min(d.bytes.len());
            let n = buf.remaining().min(d.bytes.len() - start);
            buf.put_slice(&d.bytes[start..start + n]);
            n
        };
        self.pos += n as u64;
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for File {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        src: &[u8],
    ) -> Poll<io::Result<usize>> {
        if !self.writable {
            return Poll::Ready(Err(self.access_error(true)));
        }
        let end = {
            let mut d = self.data.lock().unwrap();
            let start = if self.append {
                d.bytes.len()
            } else {
                usize::try_from(self.pos).unwrap_or(usize::MAX)
            };
            let end = start
                .checked_add(src.len())
                .ok_or(io::ErrorKind::InvalidInput)?;
            if d.bytes.len() < end {
                d.bytes.resize(end, 0);
            }
            d.bytes[start..end].copy_from_slice(src);
            d.modified = now();
            end
        };
        self.pos = end as u64;
        Poll::Ready(Ok(src.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for File {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        let len = self.data.lock().unwrap().bytes.len() as i128;
        let target = match position {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(off) => len + off as i128,
            SeekFrom::Current(off) => self.pos as i128 + off as i128,
        };
        self.seek_to = Some(if target < 0 || target > u64::MAX as i128 {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid seek position",
            ))
        } else {
            Ok(target as u64)
        });
        Ok(())
    }
    fn poll_complete(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        match self.seek_to.take() {
            Some(Ok(p)) => {
                self.pos = p;
                Poll::Ready(Ok(p))
            }
            Some(Err(e)) => Poll::Ready(Err(e)),
            None => Poll::Ready(Ok(self.pos)),
        }
    }
}

// ------------------------------------------------------------- links ---

/// No symlinks exist here, so every path is "not a link".
pub async fn read_link(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    let p = normalize(path.as_ref());
    if sync_exists(&p) {
        Err(err(io::ErrorKind::InvalidInput, "not a symbolic link", &p))
    } else {
        Err(not_found(&p))
    }
}

/// Second name for an existing file; both names share the same contents.
pub async fn hard_link(original: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
    let (src, dst) = (normalize(original.as_ref()), normalize(link.as_ref()));
    with_store!(|s| {
        let f = s.file(&src)?;
        if s.get(&dst).is_some() {
            return Err(err(io::ErrorKind::AlreadyExists, "already exists", &dst));
        }
        s.require_parent_dir(&dst)?;
        s.nodes.insert(dst.clone(), Node::File(f));
        s.touch_parent(&dst);
        Ok(())
    })
}

// ------------------------------------------------- more sync helpers ---

/// Synchronous [`copy`] (same contract as `std::fs::copy`).
pub fn sync_copy(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
    let data = sync_read(from)?;
    let n = data.len() as u64;
    write_strict(to.as_ref(), &data)?;
    Ok(n)
}

/// Synchronous [`rename`] (same contract as `std::fs::rename`).
pub fn sync_rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
    let (a, b) = (normalize(from.as_ref()), normalize(to.as_ref()));
    with_store!(|s| s.rename(&a, &b))
}

/// Core consumes listings as a `Stream` (tokio needs `ReadDirStream` for that).
impl futures_core::Stream for ReadDir {
    type Item = io::Result<DirEntry>;
    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Ready(self.entries.pop_front().map(Ok))
    }
}
