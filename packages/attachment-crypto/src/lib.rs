//! Velta attachment encryption: wrapped per-file keys and seekable chunks.

#![allow(clippy::arithmetic_side_effects, clippy::indexing_slicing)]

use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;

use aes_gcm::aead::{Aead, AeadInPlace, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context as _, Result, bail, ensure};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

const MAGIC: &[u8; 4] = b"VLTA";
const VERSION: u8 = 1;
const HEADER_LEN: usize = 128;
const CHUNK_LEN: usize = 64 * 1024;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const CHUNK_OVERHEAD: u64 = (NONCE_LEN + TAG_LEN) as u64;
const KEY_INFO: &[u8] = b"velta/attachments/v1";

/// A profile-specific attachment master key. Its Debug output is redacted.
#[derive(Clone)]
pub struct AttachmentKey(Arc<Zeroizing<[u8; 32]>>);

impl fmt::Debug for AttachmentKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AttachmentKey([REDACTED])")
    }
}

impl AttachmentKey {
    /// Derives the attachment key from Velta's raw 256-bit SQLCipher DEK.
    /// Other core passphrases retain the legacy plaintext blob behavior.
    pub fn from_db_key(passphrase: &str) -> Result<Option<Self>> {
        let Some(hex) = passphrase
            .strip_prefix("x'")
            .and_then(|value| value.strip_suffix('\''))
        else {
            return Ok(None);
        };
        if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("invalid raw Velta database key");
        }
        let dek = Zeroizing::new(hex::decode(hex)?);
        let hkdf = Hkdf::<Sha256>::new(None, &dek);
        let mut key = Zeroizing::new([0; 32]);
        hkdf.expand(KEY_INFO, key.as_mut())
            .map_err(|_| anyhow::anyhow!("attachment HKDF expansion failed"))?;
        Ok(Some(Self(Arc::new(key))))
    }

    #[cfg(test)]
    fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Arc::new(Zeroizing::new(bytes)))
    }
}

/// Encrypts a plaintext file into a newly created destination file.
pub fn encrypt_file(key: &AttachmentKey, source: &Path, destination: &Path) -> Result<()> {
    let mut input = File::open(source)
        .with_context(|| format!("failed to open plaintext attachment {}", source.display()))?;
    let len = input.metadata()?.len();
    let mut output = File::create_new(destination).with_context(|| {
        format!(
            "failed to create encrypted attachment {}",
            destination.display()
        )
    })?;
    encrypt(key, &mut input, len, &mut output)?;
    output.sync_all()?;
    Ok(())
}

/// Encrypts exactly `plaintext_len` bytes from `input`.
pub fn encrypt<R: Read, W: Write>(
    key: &AttachmentKey,
    input: &mut R,
    plaintext_len: u64,
    output: &mut W,
) -> Result<()> {
    encrypt_dyn(key, input, plaintext_len, output, &mut |bytes| rand::fill(bytes))
}

/// The encrypt loop, not generic: it is compiled (and optimized) in this
/// crate instead of in every caller. `fill` supplies the randomness in a
/// fixed order (file key, file id, wrap nonce, then one nonce per chunk),
/// so tests can pin the exact output bytes.
fn encrypt_dyn(
    key: &AttachmentKey,
    input: &mut dyn Read,
    plaintext_len: u64,
    output: &mut dyn Write,
    fill: &mut dyn FnMut(&mut [u8]),
) -> Result<()> {
    let mut file_key = Zeroizing::new([0u8; 32]);
    fill(file_key.as_mut_slice());
    let mut file_id = [0u8; 16];
    fill(&mut file_id);
    let mut wrap_nonce = [0u8; NONCE_LEN];
    fill(&mut wrap_nonce);
    let wrapper = Aes256Gcm::new_from_slice(key.0.as_slice())
        .map_err(|_| anyhow::anyhow!("invalid attachment master key"))?;
    let mut wrap_aad = Vec::with_capacity(36);
    wrap_aad.extend_from_slice(MAGIC);
    wrap_aad.push(VERSION);
    wrap_aad.push(0);
    wrap_aad.extend_from_slice(&(HEADER_LEN as u16).to_be_bytes());
    wrap_aad.extend_from_slice(&(CHUNK_LEN as u32).to_be_bytes());
    wrap_aad.extend_from_slice(&plaintext_len.to_be_bytes());
    wrap_aad.extend_from_slice(&file_id);
    let wrapped = wrapper
        .encrypt(
            Nonce::from_slice(&wrap_nonce),
            Payload {
                msg: file_key.as_slice(),
                aad: &wrap_aad,
            },
        )
        .map_err(|_| anyhow::anyhow!("attachment key wrapping failed"))?;

    let mut header = [0u8; HEADER_LEN];
    header[..36].copy_from_slice(&wrap_aad);
    header[36..48].copy_from_slice(&wrap_nonce);
    header[48..96].copy_from_slice(&wrapped);
    output.write_all(&header)?;

    let cipher = Aes256Gcm::new_from_slice(file_key.as_slice())
        .map_err(|_| anyhow::anyhow!("invalid attachment file key"))?;
    // One buffer for every chunk, laid out as it goes to disk:
    // nonce | ciphertext (encrypted in place) | tag. One write per chunk.
    let mut chunk = Zeroizing::new(vec![0u8; NONCE_LEN + CHUNK_LEN + TAG_LEN]);
    let mut offset = 0u64;
    let mut index = 0u64;
    loop {
        let remaining = plaintext_len - offset;
        let wanted = usize::try_from(remaining.min(CHUNK_LEN as u64))?;
        let body = NONCE_LEN..NONCE_LEN + wanted;
        input.read_exact(&mut chunk[body.clone()])?;
        let final_flag = u8::from(offset + wanted as u64 == plaintext_len);
        fill(&mut chunk[..NONCE_LEN]);
        let nonce = *Nonce::from_slice(&chunk[..NONCE_LEN]);
        let aad = chunk_aad(&file_id, index, final_flag, plaintext_len, wanted as u32);
        let tag = cipher
            .encrypt_in_place_detached(&nonce, &aad, &mut chunk[body.clone()])
            .map_err(|_| anyhow::anyhow!("attachment encryption failed"))?;
        chunk[body.end..body.end + TAG_LEN].copy_from_slice(&tag);
        output.write_all(&chunk[..body.end + TAG_LEN])?;
        offset += wanted as u64;
        index += 1;
        if final_flag == 1 {
            break;
        }
    }
    let mut extra = [0u8; 1];
    ensure!(
        input.read(&mut extra)? == 0,
        "plaintext attachment grew during encryption"
    );
    Ok(())
}

struct Header {
    chunk_len: u32,
    plaintext_len: u64,
    file_id: [u8; 16],
    /// Built once per open: the key schedule is not redone per read.
    cipher: Aes256Gcm,
    /// nonce | ciphertext | tag of one chunk; after a decrypt, the plaintext
    /// sits in place of the ciphertext. Zeroed on drop.
    buf: Zeroizing<Vec<u8>>,
    /// Chunk whose plaintext `buf` holds. Small or unaligned reads hit it
    /// instead of decrypting the same chunk again.
    cached: Option<u64>,
}

/// A plaintext view over either a legacy file or an encrypted attachment.
/// Encrypted chunks are independently addressable, so Seek and Range reads do
/// not decrypt the prefix and never create plaintext temporary files.
///
/// The byte source is a real file natively; on wasm32 (no std::fs in the
/// browser) it is memfs bytes handed over by the caller — see
/// [`AttachmentReader::from_memfs_bytes`] and core's `open_blob`. All reads
/// and seeks go through [`std::io::Read`]/[`std::io::Seek`], so the impls
/// are source-agnostic.
#[cfg(not(target_arch = "wasm32"))]
type FileReader = File;
#[cfg(target_arch = "wasm32")]
type FileReader = std::io::Cursor<Vec<u8>>;

pub struct AttachmentReader {
    file: FileReader,
    len: u64,
    position: u64,
    /// Where the underlying file cursor is, when known: sequential reads
    /// skip the seek.
    file_pos: Option<u64>,
    encrypted: Option<Header>,
}

impl fmt::Debug for AttachmentReader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AttachmentReader")
            .field("len", &self.len)
            .field("position", &self.position)
            .field("encrypted", &self.encrypted.is_some())
            .finish()
    }
}

impl AttachmentReader {
    /// Opens a blob. VLTA files fail closed when the key is absent or wrong;
    /// all other files are legacy plaintext and pass through unchanged.
    pub fn open(path: &Path, key: Option<&AttachmentKey>) -> Result<Self> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let file = File::open(path)
                .with_context(|| format!("failed to open attachment {}", path.display()))?;
            let physical_len = file.metadata()?.len();
            Self::from_reader(file, physical_len, key)
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = (path, key);
            bail!(
                "std::fs is unavailable on wasm32 — read the blob from the memfs shim and use AttachmentReader::from_memfs_bytes"
            );
        }
    }

    /// wasm32 entry: the caller reads the blob through the tokio wasm
    /// facade's memfs shim and hands the bytes over (the browser has no
    /// std::fs). VLTA headers still fail closed: the wasm build has no
    /// profile key, so an encrypted attachment must never surface its
    /// ciphertext as plaintext.
    #[cfg(target_arch = "wasm32")]
    pub fn from_memfs_bytes(bytes: Vec<u8>, key: Option<&AttachmentKey>) -> Result<Self> {
        let physical_len = bytes.len() as u64;
        Self::from_reader(std::io::Cursor::new(bytes), physical_len, key)
    }

    /// Shared open path over an opaque byte source.
    fn from_reader(
        mut file: FileReader,
        physical_len: u64,
        key: Option<&AttachmentKey>,
    ) -> Result<Self> {
        let mut magic = [0u8; 4];
        let read = file.read(&mut magic)?;
        file.rewind()?;
        if read != MAGIC.len() || &magic != MAGIC {
            return Ok(Self {
                file,
                len: physical_len,
                position: 0,
                file_pos: Some(0),
                encrypted: None,
            });
        }
        let key = key.context("encrypted attachment requires its profile key")?;
        let mut bytes = [0u8; HEADER_LEN];
        file.read_exact(&mut bytes)?;
        ensure!(bytes[4] == VERSION, "unsupported attachment version");
        ensure!(bytes[5] == 0, "unsupported attachment flags");
        ensure!(
            u16::from_be_bytes(bytes[6..8].try_into()?) as usize == HEADER_LEN,
            "unsupported attachment header length"
        );
        ensure!(
            bytes[96..].iter().all(|byte| *byte == 0),
            "invalid attachment reserved bytes"
        );
        let chunk_len = u32::from_be_bytes(bytes[8..12].try_into()?);
        ensure!(
            chunk_len as usize == CHUNK_LEN,
            "unsupported attachment chunk length"
        );
        let plaintext_len = u64::from_be_bytes(bytes[12..20].try_into()?);
        let file_id: [u8; 16] = bytes[20..36].try_into()?;
        let wrap_nonce = &bytes[36..48];
        let wrapped = &bytes[48..96];
        let wrapper = Aes256Gcm::new_from_slice(key.0.as_slice())
            .map_err(|_| anyhow::anyhow!("invalid attachment master key"))?;
        let unwrapped = Zeroizing::new(
            wrapper
                .decrypt(
                    Nonce::from_slice(wrap_nonce),
                    Payload {
                        msg: wrapped,
                        aad: &bytes[..36],
                    },
                )
                .map_err(|_| anyhow::anyhow!("attachment key authentication failed"))?,
        );
        let file_key = Zeroizing::new(<[u8; 32]>::try_from(unwrapped.as_slice())?);
        let chunks = plaintext_len.div_ceil(chunk_len as u64).max(1);
        let expected_len = (HEADER_LEN as u64)
            .checked_add(plaintext_len)
            .and_then(|len| {
                chunks
                    .checked_mul(CHUNK_OVERHEAD)
                    .and_then(|overhead| len.checked_add(overhead))
            })
            .context("attachment length overflow")?;
        ensure!(
            physical_len == expected_len,
            "truncated or oversized attachment"
        );
        let cipher = Aes256Gcm::new_from_slice(file_key.as_slice())
            .map_err(|_| anyhow::anyhow!("invalid attachment file key"))?;
        Ok(Self {
            file,
            len: plaintext_len,
            position: 0,
            file_pos: Some(HEADER_LEN as u64),
            encrypted: Some(Header {
                chunk_len,
                plaintext_len,
                file_id,
                cipher,
                buf: Zeroizing::new(vec![0u8; NONCE_LEN + CHUNK_LEN + TAG_LEN]),
                cached: None,
            }),
        })
    }

    /// Plaintext length, not the on-disk ciphertext length.
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn read_all(mut self) -> Result<Vec<u8>> {
        let mut bytes = Vec::with_capacity(usize::try_from(self.len)?);
        self.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    pub fn read_range(mut self, start: u64, len: usize) -> Result<Vec<u8>> {
        ensure!(start <= self.len, "attachment range starts past EOF");
        ensure!(
            len as u64 <= self.len - start,
            "attachment range extends past EOF"
        );
        self.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; len];
        self.read_exact(&mut bytes)?;
        Ok(bytes)
    }
}

impl AttachmentReader {
    fn seek_file(&mut self, offset: u64) -> io::Result<()> {
        if self.file_pos != Some(offset) {
            self.file_pos = None;
            self.file.seek(SeekFrom::Start(offset))?;
            self.file_pos = Some(offset);
        }
        Ok(())
    }

    /// Decrypts chunk `index` into the header buffer unless it is already
    /// there. Returns the chunk's plaintext length.
    fn load_chunk(&mut self, index: u64) -> io::Result<usize> {
        let len = self.len;
        let header = self.encrypted.as_ref().expect("encrypted reader");
        let chunk_len = header.chunk_len as u64;
        let chunk_start = index * chunk_len;
        let plaintext_len = (len - chunk_start).min(chunk_len) as usize;
        if header.cached == Some(index) {
            return Ok(plaintext_len);
        }
        let disk_offset = HEADER_LEN as u64 + index * (chunk_len + CHUNK_OVERHEAD);
        self.seek_file(disk_offset)?;
        let header = self.encrypted.as_mut().expect("encrypted reader");
        header.cached = None;
        let total = NONCE_LEN + plaintext_len + TAG_LEN;
        if let Err(e) = self.file.read_exact(&mut header.buf[..total]) {
            self.file_pos = None;
            return Err(e);
        }
        self.file_pos = Some(disk_offset + total as u64);
        let final_flag = u8::from(chunk_start + plaintext_len as u64 == len);
        let aad = chunk_aad(
            &header.file_id,
            index,
            final_flag,
            header.plaintext_len,
            plaintext_len as u32,
        );
        let (nonce, rest) = header.buf.split_at_mut(NONCE_LEN);
        let (body, tag) = rest.split_at_mut(plaintext_len);
        let tag = *aes_gcm::Tag::from_slice(&tag[..TAG_LEN]);
        header
            .cipher
            .decrypt_in_place_detached(Nonce::from_slice(nonce), &aad, body, &tag)
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "attachment authentication failed",
                )
            })?;
        header.cached = Some(index);
        Ok(plaintext_len)
    }
}

impl Read for AttachmentReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() || self.position == self.len {
            return Ok(0);
        }
        let Some(header) = &self.encrypted else {
            self.seek_file(self.position)?;
            let read = match self.file.read(output) {
                Ok(read) => read,
                Err(e) => {
                    self.file_pos = None;
                    return Err(e);
                }
            };
            self.position += read as u64;
            self.file_pos = Some(self.position);
            return Ok(read);
        };
        let chunk_len = header.chunk_len as u64;
        let mut total = 0usize;
        while total < output.len() && self.position < self.len {
            let index = self.position / chunk_len;
            let within = (self.position % chunk_len) as usize;
            let plaintext_len = self.load_chunk(index)?;
            let plain = &self.encrypted.as_ref().expect("encrypted reader").buf
                [NONCE_LEN..NONCE_LEN + plaintext_len];
            let wanted = (plaintext_len - within).min(output.len() - total);
            output[total..total + wanted].copy_from_slice(&plain[within..within + wanted]);
            self.position += wanted as u64;
            total += wanted;
        }
        Ok(total)
    }
}

impl Seek for AttachmentReader {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let next = match position {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(offset) => i128::from(self.len) + i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
        };
        if !(0..=i128::from(self.len)).contains(&next) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid attachment seek",
            ));
        }
        self.position = next as u64;
        Ok(self.position)
    }
}

fn chunk_aad(file_id: &[u8; 16], index: u64, final_flag: u8, total: u64, len: u32) -> [u8; 37] {
    let mut aad = [0u8; 37];
    aad[..16].copy_from_slice(file_id);
    aad[16..24].copy_from_slice(&index.to_be_bytes());
    aad[24] = final_flag;
    aad[25..33].copy_from_slice(&total.to_be_bytes());
    aad[33..37].copy_from_slice(&len.to_be_bytes());
    aad
}

/// Returns whether the file has the VLTA encryption magic.
pub fn is_encrypted(path: &Path) -> Result<bool> {
    let mut file = File::open(path)?;
    let mut magic = [0u8; 4];
    Ok(file.read(&mut magic)? == MAGIC.len() && &magic == MAGIC)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> AttachmentKey {
        AttachmentKey::from_bytes([7; 32])
    }

    fn encrypted_bytes(plaintext: &[u8]) -> Vec<u8> {
        let mut encrypted = Vec::new();
        encrypt(
            &key(),
            &mut &plaintext[..],
            plaintext.len() as u64,
            &mut encrypted,
        )
        .unwrap();
        encrypted
    }

    fn roundtrip(plaintext: &[u8]) {
        let encrypted = encrypted_bytes(plaintext);
        assert_ne!(&encrypted[HEADER_LEN..], plaintext);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");
        std::fs::write(&path, encrypted).unwrap();
        let reader = AttachmentReader::open(&path, Some(&key())).unwrap();
        assert_eq!(reader.len(), plaintext.len() as u64);
        assert_eq!(reader.read_all().unwrap(), plaintext);
    }

    #[test]
    fn chunk_boundaries_and_empty_file_roundtrip() {
        for len in [
            0,
            1,
            CHUNK_LEN - 1,
            CHUNK_LEN,
            CHUNK_LEN + 1,
            2 * CHUNK_LEN + 17,
        ] {
            let plaintext: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            roundtrip(&plaintext);
        }
    }

    #[test]
    fn random_access_matches_plaintext() {
        let plaintext: Vec<u8> = (0..2 * CHUNK_LEN + 91).map(|i| (i % 253) as u8).collect();
        let encrypted = encrypted_bytes(&plaintext);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");
        std::fs::write(&path, encrypted).unwrap();
        for (start, len) in [
            (0, 1),
            (CHUNK_LEN as u64 - 2, 8),
            (CHUNK_LEN as u64, 31),
            (2 * CHUNK_LEN as u64, 91),
        ] {
            let reader = AttachmentReader::open(&path, Some(&key())).unwrap();
            assert_eq!(
                reader.read_range(start, len).unwrap(),
                plaintext[start as usize..start as usize + len]
            );
        }
        let mut reader = AttachmentReader::open(&path, Some(&key())).unwrap();
        reader.seek(SeekFrom::End(-3)).unwrap();
        let mut tail = [0; 3];
        reader.read_exact(&mut tail).unwrap();
        assert_eq!(&tail, &plaintext[plaintext.len() - 3..]);
    }

    #[test]
    fn wrong_key_and_tampering_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");
        std::fs::write(&path, encrypted_bytes(b"authenticated attachment")).unwrap();
        assert!(AttachmentReader::open(&path, None).is_err());
        assert!(AttachmentReader::open(&path, Some(&AttachmentKey::from_bytes([8; 32]))).is_err());
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[HEADER_LEN + NONCE_LEN] ^= 1;
        std::fs::write(&path, bytes).unwrap();
        let mut reader = AttachmentReader::open(&path, Some(&key())).unwrap();
        let mut output = Vec::new();
        assert_eq!(
            reader.read_to_end(&mut output).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn legacy_plaintext_still_works_without_a_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");
        std::fs::write(&path, b"legacy").unwrap();
        assert_eq!(
            AttachmentReader::open(&path, None)
                .unwrap()
                .read_all()
                .unwrap(),
            b"legacy"
        );
        let mut reader = AttachmentReader::open(&path, None).unwrap();
        reader.seek(SeekFrom::Start(2)).unwrap();
        let mut tail = Vec::new();
        reader.read_to_end(&mut tail).unwrap();
        assert_eq!(tail, b"gacy");
    }

    #[test]
    fn derives_only_from_raw_velta_dek() {
        assert!(AttachmentKey::from_db_key("").unwrap().is_none());
        assert!(AttachmentKey::from_db_key("password").unwrap().is_none());
        assert!(AttachmentKey::from_db_key("x'00'").is_err());
        let first = AttachmentKey::from_db_key(&format!("x'{}'", "11".repeat(32)))
            .unwrap()
            .unwrap();
        let second = AttachmentKey::from_db_key(&format!("x'{}'", "11".repeat(32)))
            .unwrap()
            .unwrap();
        assert_eq!(first.0.as_slice(), second.0.as_slice());
        assert_eq!(format!("{first:?}"), "AttachmentKey([REDACTED])");
    }

    /// Deterministic byte source for pinning encrypt output.
    struct Counter(u8);
    impl Counter {
        fn fill(&mut self, bytes: &mut [u8]) {
            for b in bytes {
                *b = self.0;
                self.0 = self.0.wrapping_mul(31).wrapping_add(7);
            }
        }
    }

    /// The encrypt loop before #551 (allocating, two writes per chunk),
    /// with the same randomness order. The new loop must match it byte for
    /// byte.
    fn reference_encrypt(key: &AttachmentKey, plaintext: &[u8], fill: &mut dyn FnMut(&mut [u8])) -> Vec<u8> {
        let plaintext_len = plaintext.len() as u64;
        let mut output = Vec::new();
        let mut file_key = [0u8; 32];
        fill(&mut file_key);
        let mut file_id = [0u8; 16];
        fill(&mut file_id);
        let mut wrap_nonce = [0u8; NONCE_LEN];
        fill(&mut wrap_nonce);
        let wrapper = Aes256Gcm::new_from_slice(key.0.as_slice()).unwrap();
        let mut wrap_aad = Vec::new();
        wrap_aad.extend_from_slice(MAGIC);
        wrap_aad.push(VERSION);
        wrap_aad.push(0);
        wrap_aad.extend_from_slice(&(HEADER_LEN as u16).to_be_bytes());
        wrap_aad.extend_from_slice(&(CHUNK_LEN as u32).to_be_bytes());
        wrap_aad.extend_from_slice(&plaintext_len.to_be_bytes());
        wrap_aad.extend_from_slice(&file_id);
        let wrapped = wrapper
            .encrypt(Nonce::from_slice(&wrap_nonce), Payload { msg: &file_key, aad: &wrap_aad })
            .unwrap();
        let mut header = [0u8; HEADER_LEN];
        header[..36].copy_from_slice(&wrap_aad);
        header[36..48].copy_from_slice(&wrap_nonce);
        header[48..96].copy_from_slice(&wrapped);
        output.extend_from_slice(&header);
        let cipher = Aes256Gcm::new_from_slice(&file_key).unwrap();
        let mut input = plaintext;
        let mut offset = 0u64;
        let mut index = 0u64;
        loop {
            let wanted = (plaintext_len - offset).min(CHUNK_LEN as u64) as usize;
            let mut chunk = vec![0u8; wanted];
            input.read_exact(&mut chunk).unwrap();
            let final_flag = u8::from(offset + wanted as u64 == plaintext_len);
            let mut nonce = [0u8; NONCE_LEN];
            fill(&mut nonce);
            let aad = chunk_aad(&file_id, index, final_flag, plaintext_len, wanted as u32);
            let ct = cipher
                .encrypt(Nonce::from_slice(&nonce), Payload { msg: &chunk, aad: &aad })
                .unwrap();
            output.extend_from_slice(&nonce);
            output.extend_from_slice(&ct);
            offset += wanted as u64;
            index += 1;
            if final_flag == 1 {
                break;
            }
        }
        output
    }

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 131 % 251) as u8).collect()
    }

    fn write_blob(dir: &tempfile::TempDir, plaintext: &[u8]) -> std::path::PathBuf {
        let path = dir.path().join("blob");
        std::fs::write(&path, encrypted_bytes(plaintext)).unwrap();
        path
    }

    #[test]
    fn encrypt_output_is_byte_identical_to_the_old_loop() {
        for len in [0, 1, 300, CHUNK_LEN - 1, CHUNK_LEN, CHUNK_LEN + 1, 3 * CHUNK_LEN + 5] {
            let plaintext = pattern(len);
            let mut new = Vec::new();
            let mut rng = Counter(1);
            encrypt_dyn(&key(), &mut &plaintext[..], len as u64, &mut new, &mut |b| rng.fill(b)).unwrap();
            let mut rng = Counter(1);
            let old = reference_encrypt(&key(), &plaintext, &mut |b| rng.fill(b));
            assert_eq!(new, old, "len {len}");
        }
    }

    /// Written by the pre-#551 `encrypt` (master 23bad571) under the key
    /// derived from x'4242..42'; 300 bytes of `i * 7 % 256`.
    const OLD_FIXTURE_300: &[&str] = &[
        "564c54410100008000010000000000000000012c34261c16a02a793a79462747fa75908e5b69f03b38bc5f09d0ce526c",
        "2297b7f33bcf700f0d8d5095a32bd16dbb6202d6e0ed4140669f33774bce99e511c109299661099b7601d9c3ec5b2b9f",
        "0000000000000000000000000000000000000000000000000000000000000000c0003291429b85e5aefec183540e192d",
        "5de664706c483918d70dcf328e7e8f361dd28d342c26f93f474ac536e45efe8884878f58f50940f36ad64732ea55d3f0",
        "ef4131209aa10b5a92e7f3e5523f167881fff5bbfbc7ec629515366a960bf134c9569ae37fc175707611d613183303c5",
        "013d13c743158240f3e41f431ecfeaa4e3edb088798a767bf534fa989f0e5134f9e31c54f5f84b1917691376bd06df11",
        "37707ae15a05e1d00cc07f5072be28b908955f0946f312a186462ef9f9da0a33e75778e830b6809d4a24f6325e496915",
        "c1e3396d653b58873196efbcc650227f9eadcdac39dc0e03d9b802bf7964430453b730828d36713a0ec9b4a93cf6148f",
        "cea8dc6c162d9a4e2565a336d6e9b0cc935bb7a58cd96a28471b1b9f0e156c3e11ae02205ec70ce60602884367dc49f3",
        "6f7145aec5b265085c6f14e566c682b8abb5333d1daf6403",
    ];

    #[test]
    fn opens_a_file_written_by_the_old_encrypt() {
        let bytes = hex::decode(OLD_FIXTURE_300.concat()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old");
        std::fs::write(&path, bytes).unwrap();
        let key = AttachmentKey::from_db_key(&format!("x'{}'", "42".repeat(32))).unwrap().unwrap();
        let expected: Vec<u8> = (0..300u32).map(|i| (i * 7 % 256) as u8).collect();
        assert_eq!(AttachmentReader::open(&path, Some(&key)).unwrap().read_all().unwrap(), expected);
        let mut reader = AttachmentReader::open(&path, Some(&key)).unwrap();
        reader.seek(SeekFrom::Start(123)).unwrap();
        let mut part = [0u8; 50];
        reader.read_exact(&mut part).unwrap();
        assert_eq!(&part[..], &expected[123..173]);
    }

    #[test]
    fn random_offsets_and_unaligned_reads_match_plaintext() {
        let plaintext = pattern(4 * CHUNK_LEN + 777);
        let dir = tempfile::tempdir().unwrap();
        let path = write_blob(&dir, &plaintext);
        let mut reader = AttachmentReader::open(&path, Some(&key())).unwrap();
        let mut rng = Counter(9);
        for _ in 0..300 {
            let mut r = [0u8; 8];
            rng.fill(&mut r);
            let start = (u64::from_le_bytes(r) % plaintext.len() as u64) as usize;
            let want = 1 + (r[0] as usize * 977) % (2 * CHUNK_LEN + 3);
            let end = (start + want).min(plaintext.len());
            reader.seek(SeekFrom::Start(start as u64)).unwrap();
            let mut got = vec![0u8; end - start];
            reader.read_exact(&mut got).unwrap();
            assert_eq!(got, &plaintext[start..end], "range {start}..{end}");
        }
        // Odd buffer sizes that straddle chunk edges, read to the end.
        for bs in [1usize, 7, 1000, 8 * 1024, 96 * 1024, CHUNK_LEN + 1, 192 * 1024] {
            let mut reader = AttachmentReader::open(&path, Some(&key())).unwrap();
            reader.seek(SeekFrom::Start(5)).unwrap();
            let mut out = Vec::new();
            let mut buf = vec![0u8; bs];
            loop {
                let n = reader.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n]);
            }
            assert_eq!(out, &plaintext[5..], "buffer {bs}");
        }
    }

    #[test]
    fn small_buffer_io_copy_round_trips() {
        let plaintext = pattern(3 * CHUNK_LEN + 4321);
        let dir = tempfile::tempdir().unwrap();
        let path = write_blob(&dir, &plaintext);
        let mut reader = AttachmentReader::open(&path, Some(&key())).unwrap();
        let out_path = dir.path().join("plain");
        let mut out = File::create(&out_path).unwrap();
        assert_eq!(io::copy(&mut reader, &mut out).unwrap(), plaintext.len() as u64);
        drop(out);
        assert_eq!(std::fs::read(&out_path).unwrap(), plaintext);
    }

    #[test]
    fn seeks_backward_forward_and_from_the_end() {
        let plaintext = pattern(2 * CHUNK_LEN + 99);
        let dir = tempfile::tempdir().unwrap();
        let path = write_blob(&dir, &plaintext);
        let mut reader = AttachmentReader::open(&path, Some(&key())).unwrap();
        let mut one = [0u8; 10];
        for pos in [CHUNK_LEN as u64 + 3, 2, 2 * CHUNK_LEN as u64 + 80, CHUNK_LEN as u64 - 5, 0] {
            assert_eq!(reader.seek(SeekFrom::Start(pos)).unwrap(), pos);
            reader.read_exact(&mut one).unwrap();
            assert_eq!(one, plaintext[pos as usize..pos as usize + 10]);
        }
        assert_eq!(reader.seek(SeekFrom::Current(-4)).unwrap(), 6);
        reader.read_exact(&mut one).unwrap();
        assert_eq!(one, plaintext[6..16]);
        let end = reader.seek(SeekFrom::End(-10)).unwrap();
        reader.read_exact(&mut one).unwrap();
        assert_eq!(one, plaintext[end as usize..]);
        assert_eq!(reader.read(&mut one).unwrap(), 0, "EOF");
        assert!(reader.seek(SeekFrom::End(1)).is_err());
        // Legacy plaintext seeks the same way.
        let legacy = dir.path().join("legacy");
        std::fs::write(&legacy, &plaintext).unwrap();
        let mut reader = AttachmentReader::open(&legacy, None).unwrap();
        reader.seek(SeekFrom::Start(CHUNK_LEN as u64)).unwrap();
        reader.read_exact(&mut one).unwrap();
        reader.seek(SeekFrom::Start(3)).unwrap();
        reader.read_exact(&mut one).unwrap();
        assert_eq!(one, plaintext[3..13]);
    }

    #[test]
    fn a_tampered_chunk_fails_every_time_and_neighbours_still_read() {
        let plaintext = pattern(3 * CHUNK_LEN);
        let dir = tempfile::tempdir().unwrap();
        let path = write_blob(&dir, &plaintext);
        let mut bytes = std::fs::read(&path).unwrap();
        let second = HEADER_LEN + (CHUNK_LEN + CHUNK_OVERHEAD as usize) + NONCE_LEN + 9;
        bytes[second] ^= 0x80;
        std::fs::write(&path, bytes).unwrap();
        let mut reader = AttachmentReader::open(&path, Some(&key())).unwrap();
        let mut buf = [0u8; 16];
        reader.seek(SeekFrom::Start(CHUNK_LEN as u64 - 8)).unwrap();
        reader.read_exact(&mut buf[..8]).unwrap();
        assert_eq!(buf[..8], plaintext[CHUNK_LEN - 8..CHUNK_LEN], "the first chunk's tail is fine");
        for _ in 0..2 {
            reader.seek(SeekFrom::Start(CHUNK_LEN as u64 + 1)).unwrap();
            assert_eq!(reader.read(&mut buf).unwrap_err().kind(), io::ErrorKind::InvalidData);
        }
        reader.seek(SeekFrom::Start(2 * CHUNK_LEN as u64)).unwrap();
        reader.read_exact(&mut buf).unwrap();
        assert_eq!(buf, plaintext[2 * CHUNK_LEN..2 * CHUNK_LEN + 16]);
    }
}
