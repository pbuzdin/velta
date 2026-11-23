//! #454 follow-up: STORE zips of a picked folder, built and read in Rust.
//!
//! [`FolderZip::plan`] walks the folder once and works out the exact archive
//! size before a byte is read, so the transfer can announce it up front.
//! [`FolderZip::reader`] then streams the archive straight from the files on
//! disk: memory stays at one read buffer however big the folder is. CRCs go
//! in a data descriptor after each entry (general-purpose flag bit 3), so
//! every file is read exactly once.
//!
//! Zip64 records are written only when a size, an offset or the entry count
//! needs them, so small archives stay plain zips any tool opens.
//!
//! [`extract`] is the receiving half: it reads the central directory, checks
//! every path stays under the destination and every CRC matches, and copies
//! entry by entry with a fixed buffer. STORE entries only (Velta's own zips,
//! including the older renderer-built ones).

use anyhow::{bail, Context, Result};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

const LOCAL_SIG: u32 = 0x0403_4b50;
const DESC_SIG: u32 = 0x0807_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD64_SIG: u32 = 0x0606_4b50;
const LOC64_SIG: u32 = 0x0706_4b50;
/// Bit 3 (sizes/CRC in a data descriptor) + bit 11 (UTF-8 names).
const FLAGS_FILE: u16 = 0x0808;
const FLAGS_DIR: u16 = 0x0800;
const U32_MAX: u64 = 0xFFFF_FFFF;
/// Same walk limits as `list_folder_files`.
const MAX_DEPTH: usize = 12;
const MAX_ENTRIES: usize = 200_000;
const BUF: usize = 256 * 1024;

/// Where an entry's bytes come from: a file on disk, or (Android) a
/// `content://` document read through a ContentResolver file descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Src {
    Path(PathBuf),
    Uri(String),
}

impl Src {
    fn open(&self) -> std::io::Result<File> {
        match self {
            Src::Path(p) => File::open(p),
            #[cfg(target_os = "android")]
            Src::Uri(u) => crate::saf::open_read(u),
            #[cfg(not(target_os = "android"))]
            Src::Uri(_) => Err(std::io::Error::other("content URIs are Android-only")),
        }
    }
}

/// One file or folder of a listing built elsewhere (an Android SAF tree).
#[derive(Debug, Clone)]
pub struct Listed {
    /// Forward-slash path relative to the picked folder, without a trailing `/`.
    pub rel: String,
    pub dir: bool,
    pub size: u64,
    pub mtime: std::time::SystemTime,
    /// None for folders.
    pub src: Option<Src>,
}

#[derive(Debug, Clone)]
struct Entry {
    /// Forward-slash path inside the archive; directories end in `/`.
    name: String,
    /// Source of the bytes (None for directories).
    src: Option<Src>,
    size: u64,
    time: u16,
    date: u16,
    offset: u64,
}

impl Entry {
    fn is_dir(&self) -> bool {
        self.src.is_none()
    }
    /// Sizes do not fit the 32-bit fields.
    fn big(&self) -> bool {
        self.size >= U32_MAX
    }
    fn local_len(&self) -> u64 {
        30 + self.name.len() as u64 + if self.big() { 20 } else { 0 }
    }
    fn desc_len(&self) -> u64 {
        if self.is_dir() {
            0
        } else if self.big() {
            24
        } else {
            16
        }
    }
    fn central_extra(&self) -> Vec<u8> {
        let mut x = Vec::new();
        if self.big() {
            x.extend_from_slice(&self.size.to_le_bytes());
            x.extend_from_slice(&self.size.to_le_bytes());
        }
        if self.offset >= U32_MAX {
            x.extend_from_slice(&self.offset.to_le_bytes());
        }
        if x.is_empty() {
            return x;
        }
        let mut out = Vec::with_capacity(4 + x.len());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&(x.len() as u16).to_le_bytes());
        out.extend_from_slice(&x);
        out
    }
    fn central_len(&self) -> u64 {
        46 + self.name.len() as u64 + self.central_extra().len() as u64
    }
    fn local_header(&self) -> Vec<u8> {
        let mut h = Vec::with_capacity(self.local_len() as usize);
        put32(&mut h, LOCAL_SIG);
        put16(&mut h, if self.big() { 45 } else { 20 });
        put16(&mut h, if self.is_dir() { FLAGS_DIR } else { FLAGS_FILE });
        put16(&mut h, 0); // STORE
        put16(&mut h, self.time);
        put16(&mut h, self.date);
        put32(&mut h, 0); // CRC lives in the data descriptor
        let s = if self.big() { U32_MAX as u32 } else { self.size as u32 };
        put32(&mut h, s);
        put32(&mut h, s);
        put16(&mut h, self.name.len() as u16);
        put16(&mut h, if self.big() { 20 } else { 0 });
        h.extend_from_slice(self.name.as_bytes());
        if self.big() {
            put16(&mut h, 1);
            put16(&mut h, 16);
            h.extend_from_slice(&self.size.to_le_bytes());
            h.extend_from_slice(&self.size.to_le_bytes());
        }
        h
    }
    fn descriptor(&self, crc: u32) -> Vec<u8> {
        let mut d = Vec::with_capacity(24);
        put32(&mut d, DESC_SIG);
        put32(&mut d, crc);
        if self.big() {
            d.extend_from_slice(&self.size.to_le_bytes());
            d.extend_from_slice(&self.size.to_le_bytes());
        } else {
            put32(&mut d, self.size as u32);
            put32(&mut d, self.size as u32);
        }
        d
    }
    fn central(&self, crc: u32) -> Vec<u8> {
        let extra = self.central_extra();
        let zip64 = !extra.is_empty();
        let mut h = Vec::with_capacity(46 + self.name.len() + extra.len());
        put32(&mut h, CENTRAL_SIG);
        put16(&mut h, 0x0300 | if zip64 { 45 } else { 20 }); // made by: Unix
        put16(&mut h, if zip64 { 45 } else { 20 });
        put16(&mut h, if self.is_dir() { FLAGS_DIR } else { FLAGS_FILE });
        put16(&mut h, 0);
        put16(&mut h, self.time);
        put16(&mut h, self.date);
        put32(&mut h, crc);
        let s = if self.big() { U32_MAX as u32 } else { self.size as u32 };
        put32(&mut h, s);
        put32(&mut h, s);
        put16(&mut h, self.name.len() as u16);
        put16(&mut h, extra.len() as u16);
        put16(&mut h, 0); // comment
        put16(&mut h, 0); // disk
        put16(&mut h, 0); // internal attrs
        let mode: u32 = if self.is_dir() { 0o040755 } else { 0o100644 };
        put32(&mut h, (mode << 16) | if self.is_dir() { 0x10 } else { 0 });
        put32(&mut h, if self.offset >= U32_MAX { U32_MAX as u32 } else { self.offset as u32 });
        h.extend_from_slice(self.name.as_bytes());
        h.extend_from_slice(&extra);
        h
    }
}

fn put16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}

/// MS-DOS time and date (UTC; zip has no zone field). Clamped to 1980..2107.
fn dos_time(t: std::time::SystemTime) -> (u16, u16) {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(315_532_800)
        .clamp(315_532_800, 4_354_819_198);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    let time = ((rem / 3600) << 11) | (((rem % 3600) / 60) << 5) | ((rem % 60) / 2);
    let date = ((y - 1980) << 9) | (m << 5) | d;
    (time as u16, date as u16)
}

/// Hidden names (dot-files, like `list_folder_files`) are skipped.
fn hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

/// A folder laid out as a STORE zip, with its exact size known up front.
#[derive(Debug, Clone)]
pub struct FolderZip {
    entries: Vec<Entry>,
    central_offset: u64,
    central_len: u64,
    total: u64,
}

impl FolderZip {
    /// Walks `root` (no symlinks, no hidden files, depth ≤ 12). Empty
    /// folders are kept as directory entries.
    pub fn plan(root: &Path) -> Result<FolderZip> {
        let root = std::fs::canonicalize(root).context("folder missing")?;
        if !root.is_dir() {
            bail!("not a folder");
        }
        let mut entries = Vec::new();
        for e in walkdir::WalkDir::new(&root)
            .min_depth(1)
            .max_depth(MAX_DEPTH)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|e| !hidden(e.file_name()))
        {
            let e = e.context("reading the folder")?;
            let ft = e.file_type();
            if !ft.is_file() && !ft.is_dir() {
                continue; // symlinks, sockets, devices
            }
            let rel = e.path().strip_prefix(&root)?;
            let mut name = rel
                .components()
                .map(|c| match c {
                    Component::Normal(s) => Ok(s.to_string_lossy().into_owned()),
                    _ => bail!("odd path in the folder"),
                })
                .collect::<Result<Vec<_>>>()?
                .join("/");
            if name.len() > u16::MAX as usize - 1 {
                bail!("path too long: {name}");
            }
            let meta = e.metadata()?;
            let (time, date) = dos_time(meta.modified().unwrap_or_else(|_| std::time::SystemTime::now()));
            if ft.is_dir() {
                name.push('/');
                entries.push(Entry { name, src: None, size: 0, time, date, offset: 0 });
            } else {
                entries.push(Entry { name, src: Some(Src::Path(e.path().to_path_buf())), size: meta.len(), time, date, offset: 0 });
            }
            if entries.len() > MAX_ENTRIES {
                bail!("the folder has more than {MAX_ENTRIES} entries");
            }
        }
        Self::layout(entries)
    }

    /// Lays out a listing made elsewhere (Android: a SAF tree walked in
    /// Kotlin). Hidden segments and unsafe paths are dropped, like the walk.
    pub fn from_listing(list: Vec<Listed>) -> Result<FolderZip> {
        let mut entries = Vec::with_capacity(list.len());
        for l in list {
            let Some(rel) = safe_rel(&l.rel) else { continue };
            let mut name = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
            if name.len() > u16::MAX as usize - 1 {
                bail!("path too long: {name}");
            }
            let (time, date) = dos_time(l.mtime);
            if l.dir {
                name.push('/');
                entries.push(Entry { name, src: None, size: 0, time, date, offset: 0 });
            } else {
                let src = l.src.context("a file without a source")?;
                entries.push(Entry { name, src: Some(src), size: l.size, time, date, offset: 0 });
            }
            if entries.len() > MAX_ENTRIES {
                bail!("the folder has more than {MAX_ENTRIES} entries");
            }
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Self::layout(entries)
    }

    fn layout(mut entries: Vec<Entry>) -> Result<FolderZip> {
        if !entries.iter().any(|e| !e.is_dir()) {
            bail!("the folder is empty (hidden files are skipped)");
        }
        let mut off = 0u64;
        for e in entries.iter_mut() {
            e.offset = off;
            off += e.local_len() + e.size + e.desc_len();
        }
        let central_offset = off;
        let central_len: u64 = entries.iter().map(|e| e.central_len()).sum();
        let mut z = FolderZip { entries, central_offset, central_len, total: 0 };
        z.total = central_offset + central_len + z.tail_len();
        Ok(z)
    }

    fn zip64_tail(&self) -> bool {
        self.entries.len() >= 0xFFFF || self.central_offset >= U32_MAX || self.central_len >= U32_MAX
    }

    fn tail_len(&self) -> u64 {
        22 + if self.zip64_tail() { 56 + 20 } else { 0 }
    }

    fn tail(&self) -> Vec<u8> {
        let n = self.entries.len() as u64;
        let mut t = Vec::with_capacity(self.tail_len() as usize);
        if self.zip64_tail() {
            let eocd64_at = self.central_offset + self.central_len;
            put32(&mut t, EOCD64_SIG);
            t.extend_from_slice(&44u64.to_le_bytes());
            put16(&mut t, 0x0300 | 45);
            put16(&mut t, 45);
            put32(&mut t, 0);
            put32(&mut t, 0);
            t.extend_from_slice(&n.to_le_bytes());
            t.extend_from_slice(&n.to_le_bytes());
            t.extend_from_slice(&self.central_len.to_le_bytes());
            t.extend_from_slice(&self.central_offset.to_le_bytes());
            put32(&mut t, LOC64_SIG);
            put32(&mut t, 0);
            t.extend_from_slice(&eocd64_at.to_le_bytes());
            put32(&mut t, 1);
        }
        put32(&mut t, EOCD_SIG);
        put16(&mut t, 0);
        put16(&mut t, 0);
        let n16 = n.min(0xFFFF) as u16;
        put16(&mut t, n16);
        put16(&mut t, n16);
        put32(&mut t, self.central_len.min(U32_MAX) as u32);
        put32(&mut t, self.central_offset.min(U32_MAX) as u32);
        put16(&mut t, 0);
        t
    }

    /// Exact archive length in bytes.
    pub fn len(&self) -> u64 {
        self.total
    }

    /// Number of entries (files and folders).
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    /// The archive as a byte stream read from the files on disk.
    pub fn reader(&self) -> ZipReader {
        ZipReader { zip: self.clone(), next: 0, crcs: Vec::with_capacity(self.entries.len()), out: Vec::new(), pos: 0, cur: None, state: Stage::Entries }
    }
}

enum Stage {
    Entries,
    Central,
    Done,
}

struct Current {
    file: File,
    left: u64,
    crc: crc32fast::Hasher,
}

/// Streams a [`FolderZip`]. A file that changed size since [`FolderZip::plan`]
/// fails the read (the receiver's size check then drops the partial).
pub struct ZipReader {
    zip: FolderZip,
    next: usize,
    crcs: Vec<u32>,
    out: Vec<u8>,
    pos: usize,
    cur: Option<Current>,
    state: Stage,
}

impl ZipReader {
    /// Refills `out` with the next header/descriptor/central bytes, or opens
    /// the next file. Returns false at the end of the archive.
    fn advance(&mut self) -> std::io::Result<bool> {
        self.out.clear();
        self.pos = 0;
        match self.state {
            Stage::Entries => {
                if self.next == self.zip.entries.len() {
                    self.state = Stage::Central;
                    let mut c = Vec::with_capacity(self.zip.central_len as usize + 100);
                    for (e, crc) in self.zip.entries.iter().zip(&self.crcs) {
                        c.extend_from_slice(&e.central(*crc));
                    }
                    c.extend_from_slice(&self.zip.tail());
                    self.out = c;
                    return Ok(true);
                }
                let e = &self.zip.entries[self.next];
                self.out = e.local_header();
                match &e.src {
                    None => {
                        self.crcs.push(0);
                        self.next += 1;
                    }
                    Some(p) => {
                        let file = p.open()?;
                        self.cur = Some(Current { file, left: e.size, crc: crc32fast::Hasher::new() });
                    }
                }
                Ok(true)
            }
            Stage::Central => {
                self.state = Stage::Done;
                Ok(false)
            }
            Stage::Done => Ok(false),
        }
    }
}

impl Read for ZipReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.pos < self.out.len() {
                let n = (self.out.len() - self.pos).min(buf.len());
                buf[..n].copy_from_slice(&self.out[self.pos..self.pos + n]);
                self.pos += n;
                return Ok(n);
            }
            if let Some(cur) = self.cur.as_mut() {
                if cur.left > 0 {
                    let want = (cur.left.min(buf.len() as u64)) as usize;
                    let n = cur.file.read(&mut buf[..want])?;
                    if n == 0 {
                        return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "a file shrank while sending the folder"));
                    }
                    cur.crc.update(&buf[..n]);
                    cur.left -= n as u64;
                    return Ok(n);
                }
                let mut probe = [0u8; 1];
                if cur.file.read(&mut probe)? != 0 {
                    return Err(std::io::Error::other("a file grew while sending the folder"));
                }
                let cur = self.cur.take().unwrap();
                let crc = cur.crc.finalize();
                self.crcs.push(crc);
                let e = &self.zip.entries[self.next];
                self.out = e.descriptor(crc);
                self.pos = 0;
                self.next += 1;
                continue;
            }
            if !self.advance()? {
                return Ok(0);
            }
        }
    }
}

/// One file or folder found in an archive's central directory.
#[derive(Debug, Clone)]
pub struct ZipEntry {
    pub name: String,
    pub size: u64,
    pub crc: u32,
    offset: u64,
}

impl ZipEntry {
    pub fn is_dir(&self) -> bool {
        self.name.ends_with('/')
    }
}

fn le16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}
fn le64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

/// Reads the central directory. Refuses anything but STORE entries.
pub fn list<R: Read + Seek>(r: &mut R) -> Result<Vec<ZipEntry>> {
    let len = r.seek(SeekFrom::End(0))?;
    let tail_len = len.min(22 + 0xFFFF + 20);
    r.seek(SeekFrom::Start(len - tail_len))?;
    let mut tail = vec![0u8; tail_len as usize];
    r.read_exact(&mut tail)?;
    let at = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|&i| le32(&tail, i) == EOCD_SIG)
        .context("not a zip (no end record)")?;
    let mut count = le16(&tail, at + 10) as u64;
    let mut cd_len = le32(&tail, at + 12) as u64;
    let mut cd_off = le32(&tail, at + 16) as u64;
    if at >= 20 && le32(&tail, at - 20) == LOC64_SIG {
        let e64 = le64(&tail, at - 20 + 8);
        r.seek(SeekFrom::Start(e64))?;
        let mut h = [0u8; 56];
        r.read_exact(&mut h)?;
        if le32(&h, 0) != EOCD64_SIG {
            bail!("bad zip64 end record");
        }
        count = le64(&h, 32);
        cd_len = le64(&h, 40);
        cd_off = le64(&h, 48);
    }
    if cd_off.checked_add(cd_len).is_none_or(|end| end > len) || count > MAX_ENTRIES as u64 || cd_len > 64 << 20 {
        bail!("corrupt zip directory");
    }
    r.seek(SeekFrom::Start(cd_off))?;
    let mut cd = vec![0u8; cd_len as usize];
    r.read_exact(&mut cd)?;
    let mut out = Vec::with_capacity(count as usize);
    let mut p = 0usize;
    for _ in 0..count {
        if p + 46 > cd.len() || le32(&cd, p) != CENTRAL_SIG {
            bail!("corrupt zip directory");
        }
        let method = le16(&cd, p + 10);
        let crc = le32(&cd, p + 16);
        let mut csize = le32(&cd, p + 20) as u64;
        let mut size = le32(&cd, p + 24) as u64;
        let nlen = le16(&cd, p + 28) as usize;
        let xlen = le16(&cd, p + 30) as usize;
        let clen = le16(&cd, p + 32) as usize;
        let mut offset = le32(&cd, p + 42) as u64;
        let end = p + 46 + nlen + xlen + clen;
        if end > cd.len() {
            bail!("corrupt zip directory");
        }
        let name = String::from_utf8_lossy(&cd[p + 46..p + 46 + nlen]).into_owned();
        // Zip64 extra: only the fields whose 32-bit slot is saturated, in order.
        let mut x = p + 46 + nlen;
        let xend = x + xlen;
        while x + 4 <= xend {
            let (id, l) = (le16(&cd, x), le16(&cd, x + 2) as usize);
            if x + 4 + l > xend {
                break;
            }
            if id == 1 {
                let mut q = x + 4;
                for f in [&mut size, &mut csize, &mut offset] {
                    if *f == U32_MAX && q + 8 <= x + 4 + l {
                        *f = le64(&cd, q);
                        q += 8;
                    }
                }
            }
            x += 4 + l;
        }
        if method != 0 || csize != size {
            bail!("{name}: compressed zip entries are not supported");
        }
        out.push(ZipEntry { name, size, crc, offset });
        p = end;
    }
    Ok(out)
}

/// A safe relative path for an archive entry name: no `..`, no absolute or
/// drive paths, no hidden segments. None means skip the entry.
pub fn safe_rel(name: &str) -> Option<PathBuf> {
    let segs: Vec<&str> = name
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if segs.is_empty() || segs.iter().any(|s| *s == ".." || s.starts_with('.') || s.contains(':')) {
        return None;
    }
    Some(segs.iter().collect())
}

/// Where [`extract_to`] writes: folders and files by safe relative path.
pub trait Dest {
    fn mkdir(&mut self, rel: &Path) -> Result<()>;
    fn create(&mut self, rel: &Path) -> Result<Box<dyn Write>>;
    /// Best effort: drop a file whose bytes failed the check.
    fn remove(&mut self, rel: &Path);
}

/// A plain directory on disk.
pub struct DirDest(pub PathBuf);

impl Dest for DirDest {
    fn mkdir(&mut self, rel: &Path) -> Result<()> {
        let p = self.0.join(rel);
        if !p.starts_with(&self.0) {
            bail!("entry escaped the destination");
        }
        std::fs::create_dir_all(p)?;
        Ok(())
    }
    fn create(&mut self, rel: &Path) -> Result<Box<dyn Write>> {
        let p = self.0.join(rel);
        if !p.starts_with(&self.0) {
            bail!("entry escaped the destination");
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(Box::new(File::create(p)?))
    }
    fn remove(&mut self, rel: &Path) {
        let _ = std::fs::remove_file(self.0.join(rel));
    }
}

/// Extracts every entry of `r` under `root` (created if missing), checking
/// each CRC. Returns the number of files written. Memory stays at one
/// buffer; a bad entry stops the extraction and removes that file.
pub fn extract<R: Read + Seek>(r: &mut R, root: &Path, progress: impl FnMut(u64, u64)) -> Result<usize> {
    std::fs::create_dir_all(root)?;
    extract_to(r, &mut DirDest(root.to_path_buf()), progress)
}

/// [`extract`] into any [`Dest`] (Android: a SAF folder the user picked).
pub fn extract_to<R: Read + Seek>(r: &mut R, dest: &mut dyn Dest, mut progress: impl FnMut(u64, u64)) -> Result<usize> {
    let entries = list(r)?;
    let total: u64 = entries.iter().map(|e| e.size).sum();
    let mut done = 0u64;
    let mut wrote = 0usize;
    let mut buf = vec![0u8; BUF];
    for e in entries {
        let Some(rel) = safe_rel(&e.name) else { continue };
        if e.is_dir() {
            dest.mkdir(&rel)?;
            continue;
        }
        r.seek(SeekFrom::Start(e.offset))?;
        let mut h = [0u8; 30];
        r.read_exact(&mut h)?;
        if le32(&h, 0) != LOCAL_SIG {
            bail!("{}: bad local header", e.name);
        }
        let skip = le16(&h, 26) as i64 + le16(&h, 28) as i64;
        r.seek(SeekFrom::Current(skip))?;
        let res: Result<()> = (|| {
            let mut out = std::io::BufWriter::with_capacity(BUF, dest.create(&rel)?);
            let mut left = e.size;
            let mut crc = crc32fast::Hasher::new();
            while left > 0 {
                let n = r.read(&mut buf[..left.min(BUF as u64) as usize])?;
                if n == 0 {
                    bail!("{}: archive is truncated", e.name);
                }
                crc.update(&buf[..n]);
                out.write_all(&buf[..n])?;
                left -= n as u64;
                done += n as u64;
                progress(done, total);
            }
            out.flush()?;
            if crc.finalize() != e.crc {
                bail!("{}: checksum mismatch", e.name);
            }
            Ok(())
        })();
        if let Err(err) = res {
            dest.remove(&rel);
            return Err(err);
        }
        wrote += 1;
    }
    Ok(wrote)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join("a/b/c/d/e/f")).unwrap();
        std::fs::create_dir_all(r.join("empty")).unwrap();
        std::fs::create_dir_all(r.join(".git")).unwrap();
        std::fs::write(r.join(".git/HEAD"), "x").unwrap();
        std::fs::write(r.join(".hidden"), "x").unwrap();
        std::fs::write(r.join("top.txt"), "hello").unwrap();
        std::fs::write(r.join("a/b/c/d/e/f/deep.bin"), vec![7u8; 300_001]).unwrap();
        std::fs::write(r.join("a/Привет мир ✓.txt"), "юникод").unwrap();
        std::fs::write(r.join("a/zero"), "").unwrap();
        d
    }

    fn zip_bytes(z: &FolderZip) -> Vec<u8> {
        let mut v = Vec::new();
        z.reader().read_to_end(&mut v).unwrap();
        v
    }

    #[test]
    fn planned_size_is_exact_and_round_trips() {
        let src = tree();
        let z = FolderZip::plan(src.path()).unwrap();
        let bytes = zip_bytes(&z);
        assert_eq!(bytes.len() as u64, z.len(), "announced size == streamed size");
        let names: Vec<String> = list(&mut std::io::Cursor::new(&bytes)).unwrap().into_iter().map(|e| e.name).collect();
        assert!(names.contains(&"empty/".to_string()), "empty folders survive: {names:?}");
        assert!(!names.iter().any(|n| n.contains(".git") || n.contains(".hidden")), "hidden files skipped");
        let out = tempfile::tempdir().unwrap();
        let n = extract(&mut std::io::Cursor::new(&bytes), &out.path().join("x"), |_, _| {}).unwrap();
        assert_eq!(n, 4);
        let x = out.path().join("x");
        assert_eq!(std::fs::read(x.join("top.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(x.join("a/b/c/d/e/f/deep.bin")).unwrap(), vec![7u8; 300_001]);
        assert_eq!(std::fs::read_to_string(x.join("a/Привет мир ✓.txt")).unwrap(), "юникод");
        assert_eq!(std::fs::read(x.join("a/zero")).unwrap().len(), 0);
        assert!(x.join("empty").is_dir());
    }

    #[test]
    fn other_tools_read_it() {
        // Python's zipfile is a strict reader (CRC, central directory,
        // descriptors); skip quietly where python3 is missing.
        let src = tree();
        let z = FolderZip::plan(src.path()).unwrap();
        let out = tempfile::tempdir().unwrap();
        let path = out.path().join("t.zip");
        std::fs::write(&path, zip_bytes(&z)).unwrap();
        let Ok(o) = std::process::Command::new("python3")
            .args(["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(len(z.namelist()))"])
            .arg(&path)
            .output()
        else {
            return;
        };
        assert!(o.status.success(), "python zipfile: {}", String::from_utf8_lossy(&o.stderr));
        assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), z.entry_count().to_string());
    }

    #[test]
    fn crc_mismatch_and_path_escape_are_refused() {
        let src = tree();
        let z = FolderZip::plan(src.path()).unwrap();
        let mut bytes = zip_bytes(&z);
        // Flip a byte inside deep.bin's data (it is all 7s).
        let at = bytes.windows(16).position(|w| w.iter().all(|&b| b == 7)).unwrap();
        bytes[at + 8] ^= 1;
        let out = tempfile::tempdir().unwrap();
        let err = extract(&mut std::io::Cursor::new(&bytes), out.path(), |_, _| {}).unwrap_err();
        assert!(format!("{err}").contains("checksum"), "{err}");
        assert!(safe_rel("../x").is_none());
        assert!(safe_rel("a/../../x").is_none());
        assert!(safe_rel("C:/Windows/x").is_none());
        assert!(safe_rel("/etc/passwd").map(|p| p == Path::new("etc/passwd")).unwrap(), "absolute becomes relative");
        assert!(safe_rel("a/.ssh/k").is_none());
    }

    #[test]
    fn a_listing_lays_out_like_the_walk() {
        let src = tree();
        let walked = FolderZip::plan(src.path()).unwrap();
        let mut list = Vec::new();
        for e in &walked.entries {
            let rel = e.name.trim_end_matches('/').to_string();
            list.push(Listed {
                rel,
                dir: e.is_dir(),
                size: e.size,
                mtime: std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000),
                src: e.src.clone(),
            });
        }
        list.push(Listed { rel: "../escape".into(), dir: false, size: 1, mtime: std::time::UNIX_EPOCH, src: Some(Src::Path("/etc/hostname".into())) });
        list.reverse();
        let z = FolderZip::from_listing(list).unwrap();
        assert_eq!(z.entry_count(), walked.entry_count(), "the escape is dropped");
        let bytes = zip_bytes(&z);
        assert_eq!(bytes.len() as u64, z.len());
        let out = tempfile::tempdir().unwrap();
        assert_eq!(extract(&mut std::io::Cursor::new(&bytes), out.path(), |_, _| {}).unwrap(), 4);
        assert_eq!(std::fs::read(out.path().join("a/b/c/d/e/f/deep.bin")).unwrap(), vec![7u8; 300_001]);
    }

    #[test]
    fn a_file_that_changes_while_sending_fails_the_stream() {
        let src = tree();
        let z = FolderZip::plan(src.path()).unwrap();
        std::fs::write(src.path().join("top.txt"), "hello, longer now").unwrap();
        let mut v = Vec::new();
        assert!(z.reader().read_to_end(&mut v).is_err());
    }

    #[test]
    fn zip64_layout_for_sizes_over_4_gib() {
        // Sparse file: 4 GiB + 10 without writing it. Plan + list only; the
        // data itself is streamed lazily, so read the head and the tail.
        let src = tempfile::tempdir().unwrap();
        let f = File::create(src.path().join("big.bin")).unwrap();
        f.set_len(U32_MAX + 11).unwrap();
        std::fs::write(src.path().join("z_after.txt"), "tail").unwrap();
        let z = FolderZip::plan(src.path()).unwrap();
        assert!(z.zip64_tail(), "central directory starts past 4 GiB");
        assert_eq!(z.len(), z.central_offset + z.central_len + 22 + 76);
        // The tail can be produced without the data: check the directory parses.
        let mut central = Vec::new();
        for e in &z.entries {
            central.extend_from_slice(&e.central(0));
        }
        central.extend_from_slice(&z.tail());
        // Fake a stream that has zeros up to the central directory.
        struct Sparse {
            pos: u64,
            start: u64,
            tail: Vec<u8>,
        }
        impl Read for Sparse {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                let end = self.start + self.tail.len() as u64;
                if self.pos >= end {
                    return Ok(0);
                }
                let n = (b.len() as u64).min(end - self.pos) as usize;
                for (i, x) in b[..n].iter_mut().enumerate() {
                    let p = self.pos + i as u64;
                    *x = if p >= self.start { self.tail[(p - self.start) as usize] } else { 0 };
                }
                self.pos += n as u64;
                Ok(n)
            }
        }
        impl Seek for Sparse {
            fn seek(&mut self, s: SeekFrom) -> std::io::Result<u64> {
                let end = self.start + self.tail.len() as u64;
                self.pos = match s {
                    SeekFrom::Start(x) => x,
                    SeekFrom::End(x) => (end as i64 + x) as u64,
                    SeekFrom::Current(x) => (self.pos as i64 + x) as u64,
                };
                Ok(self.pos)
            }
        }
        let mut s = Sparse { pos: 0, start: z.central_offset, tail: central };
        let got = list(&mut s).unwrap();
        let big = got.iter().find(|e| e.name == "big.bin").unwrap();
        assert_eq!(big.size, U32_MAX + 11);
        let after = got.iter().find(|e| e.name == "z_after.txt").unwrap();
        assert!(after.offset > U32_MAX, "offset beyond 4 GiB comes from the zip64 extra");
    }
}
