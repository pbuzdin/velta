//! Velta attachment encryption: wrapped per-file keys and seekable chunks.

#![allow(clippy::arithmetic_side_effects, clippy::indexing_slicing)]

use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context as _, Result, bail, ensure};
use hkdf::Hkdf;
use rand::RngCore;
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
    let file_key = Zeroizing::new(rand::random::<[u8; 32]>());
    let file_id = rand::random::<[u8; 16]>();
    let wrap_nonce = rand::random::<[u8; NONCE_LEN]>();
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
    let mut offset = 0u64;
    let mut index = 0u64;
    loop {
        let remaining = plaintext_len - offset;
        let wanted = usize::try_from(remaining.min(CHUNK_LEN as u64))?;
        let mut plaintext = vec![0u8; wanted];
        input.read_exact(&mut plaintext)?;
        let final_flag = u8::from(offset + wanted as u64 == plaintext_len);
        let nonce = rand::random::<[u8; NONCE_LEN]>();
        let aad = chunk_aad(&file_id, index, final_flag, plaintext_len, wanted as u32);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| anyhow::anyhow!("attachment encryption failed"))?;
        output.write_all(&nonce)?;
        output.write_all(&ciphertext)?;
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

#[derive(Debug)]
struct Header {
    chunk_len: u32,
    plaintext_len: u64,
    file_id: [u8; 16],
    file_key: Zeroizing<[u8; 32]>,
}

/// A plaintext view over either a legacy file or an encrypted attachment.
/// Encrypted chunks are independently addressable, so Seek and Range reads do
/// not decrypt the prefix and never create plaintext temporary files.
pub struct AttachmentReader {
    file: File,
    len: u64,
    position: u64,
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
        let mut file = File::open(path)
            .with_context(|| format!("failed to open attachment {}", path.display()))?;
        let physical_len = file.metadata()?.len();
        let mut magic = [0u8; 4];
        let read = file.read(&mut magic)?;
        file.rewind()?;
        if read != MAGIC.len() || &magic != MAGIC {
            return Ok(Self {
                file,
                len: physical_len,
                position: 0,
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
        ensure!(bytes[96..].iter().all(|byte| *byte == 0), "invalid attachment reserved bytes");
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
        ensure!(physical_len == expected_len, "truncated or oversized attachment");
        Ok(Self {
            file,
            len: plaintext_len,
            position: 0,
            encrypted: Some(Header {
                chunk_len,
                plaintext_len,
                file_id,
                file_key,
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

impl Read for AttachmentReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() || self.position == self.len {
            return Ok(0);
        }
        let Some(header) = &self.encrypted else {
            self.file.seek(SeekFrom::Start(self.position))?;
            let read = self.file.read(output)?;
            self.position += read as u64;
            return Ok(read);
        };
        let cipher = Aes256Gcm::new_from_slice(header.file_key.as_slice())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid file key"))?;
        let mut total = 0usize;
        while total < output.len() && self.position < self.len {
            let index = self.position / header.chunk_len as u64;
            let within = self.position % header.chunk_len as u64;
            let chunk_start = index * header.chunk_len as u64;
            let plaintext_len = (self.len - chunk_start).min(header.chunk_len as u64) as usize;
            let final_flag = u8::from(chunk_start + plaintext_len as u64 == self.len);
            let disk_offset =
                HEADER_LEN as u64 + index * (header.chunk_len as u64 + CHUNK_OVERHEAD);
            self.file.seek(SeekFrom::Start(disk_offset))?;
            let mut nonce = [0u8; NONCE_LEN];
            self.file.read_exact(&mut nonce)?;
            let mut ciphertext = vec![0u8; plaintext_len + TAG_LEN];
            self.file.read_exact(&mut ciphertext)?;
            let aad = chunk_aad(
                &header.file_id,
                index,
                final_flag,
                header.plaintext_len,
                plaintext_len as u32,
            );
            let plaintext = cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "attachment authentication failed")
                })?;
            let wanted = (plaintext_len - within as usize).min(output.len() - total);
            output[total..total + wanted]
                .copy_from_slice(&plaintext[within as usize..within as usize + wanted]);
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
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid attachment seek"));
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
        encrypt(&key(), &mut &plaintext[..], plaintext.len() as u64, &mut encrypted).unwrap();
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
        for len in [0, 1, CHUNK_LEN - 1, CHUNK_LEN, CHUNK_LEN + 1, 2 * CHUNK_LEN + 17] {
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
        assert_eq!(reader.read_to_end(&mut output).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn legacy_plaintext_still_works_without_a_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");
        std::fs::write(&path, b"legacy").unwrap();
        assert_eq!(AttachmentReader::open(&path, None).unwrap().read_all().unwrap(), b"legacy");
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
}
