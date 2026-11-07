//! Windows Hello custody for the database key (#178).
//!
//! The DEK is AES-256-GCM wrapped under a Hello-derived key: a fixed
//! challenge is signed by the Velta KeyCredentialManager credential and
//! `SHA-256("velta-hello-kek-v1" || signature)` is the wrapping key. The
//! signature IS the Windows Hello gesture (PIN, face, or fingerprint), so
//! every unwrap prompts first. RSA-PKCS1 signatures are deterministic, so
//! the same challenge always re-derives the same wrapping key.
//!
//! NCrypt was measured and rejected (Win11 26300, 2026-11-07):
//! NCryptCreatePersistedKey on the Microsoft Passport Key Storage Provider
//! returns NTE_INVALID_PARAMETER (0x80090027) for every third-party key
//! name — creation is fenced to OS components — and the user's default NGC
//! decryption key opens but refuses third-party decrypt (NTE_BAD_KEYSET,
//! even with a parent HWND). KeyCredentialManager is the documented
//! third-party surface. It has no delete API: "clear" drops the wrap and
//! leaves the dormant credential behind.
//!
//! ponytail: one Hello credential for the whole install. Per-profile keys
//! only if profiles ever stop sharing one DEK.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use windows::core::HSTRING;
use windows::Security::Credentials::*;
use windows::Security::Cryptography::CryptographicBuffer;

const CREDENTIAL_NAME: &str = "chat.velta.dbkey";
/// What the credential signs. Content is arbitrary but must never change:
/// the wrap only opens with the signature of exactly these bytes.
const CHALLENGE: &[u8] = b"chat.velta app-lock hello-unlock v1";
const KEK_DOMAIN: &[u8] = b"velta-hello-kek-v1";
/// Binds the wrap header (magic + format version) into the AEAD tag.
const WRAP_AAD: &[u8] = b"VLTHW\x01";

fn kek(sig: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(KEK_DOMAIN);
    h.update(sig);
    h.finalize().into()
}

/// Map a KeyCredentialStatus onto the tokens the UI matches on
/// ("cancelled", "hello-unavailable", "hello-failed: …").
fn status_err(what: &str, st: KeyCredentialStatus) -> String {
    match st.0 {
        3 => "cancelled".to_string(),          // UserCanceled
        2 => "hello-unavailable".to_string(),  // NotFound
        _ => format!("hello-failed: {what} {:#x}", st.0),
    }
}

/// The credential, opening on first use. Creation shows the Hello
/// enrollment/creation panel once; later calls return it silently and only
/// the sign prompts.
fn open_credential() -> Result<KeyCredential, String> {
    let name = HSTRING::from(CREDENTIAL_NAME);
    let opened = KeyCredentialManager::OpenAsync(&name)
        .and_then(|op| op.get())
        .map_err(|e| format!("hello-failed: open {e}"))?;
    let st = opened
        .Status()
        .map_err(|e| format!("hello-failed: open status {e}"))?;
    if st.0 == KeyCredentialStatus::Success.0 {
        return opened
            .Credential()
            .map_err(|e| format!("hello-failed: credential {e}"));
    }
    // NotFound = first use (or Hello was reset and the credential is gone).
    if st.0 == KeyCredentialStatus::NotFound.0 {
        let created = KeyCredentialManager::RequestCreateAsync(&name, KeyCredentialCreationOption::FailIfExists)
            .and_then(|op| op.get())
            .map_err(|e| format!("hello-failed: create {e}"))?;
        let cst = created
            .Status()
            .map_err(|e| format!("hello-failed: create status {e}"))?;
        if cst.0 != KeyCredentialStatus::Success.0 {
            return Err(status_err("create", cst));
        }
        return created
            .Credential()
            .map_err(|e| format!("hello-failed: credential {e}"));
    }
    Err(status_err("open", st))
}

/// Sign the fixed challenge — this is the Windows Hello prompt.
fn sign_challenge(cred: &KeyCredential) -> Result<Vec<u8>, String> {
    let buf = CryptographicBuffer::CreateFromByteArray(CHALLENGE)
        .map_err(|e| format!("hello-failed: buffer {e}"))?;
    let signed = cred
        .RequestSignAsync(&buf)
        .and_then(|op| op.get())
        .map_err(|e| format!("hello-failed: sign {e}"))?;
    let st = signed
        .Status()
        .map_err(|e| format!("hello-failed: sign status {e}"))?;
    if st.0 != KeyCredentialStatus::Success.0 {
        return Err(status_err("sign", st));
    }
    let b64 = CryptographicBuffer::EncodeToBase64String(&signed.Result().map_err(|e| format!("hello-failed: sig {e}"))?)
        .map_err(|e| format!("hello-failed: encode {e}"))?;
    data_encoding::BASE64
        .decode(b64.to_string_lossy().as_bytes())
        .map_err(|_| "hello-failed: sig encoding".to_string())
}

/// Device-level Hello support. Unlike the old NGC probe this does not
/// require an existing Hello key: with only `IsSupportedAsync` true, the
/// first enable still walks the user through Hello enrollment.
pub fn available() -> bool {
    match KeyCredentialManager::IsSupportedAsync() {
        Ok(op) => op.get().unwrap_or(false),
        Err(_) => false,
    }
}

/// Wrap `dek` (32 bytes) under the Hello credential. Prompts once: the sign
/// gesture, preceded by the creation panel on first ever use. Returns the
/// 60-byte `nonce || ciphertext` body for the wrap file. The round-trip is
/// verified locally (unlock re-signs deterministically; no second prompt).
pub fn seal(dek: &[u8]) -> Result<Vec<u8>, String> {
    if dek.len() != 32 {
        return Err("bad dek".to_string());
    }
    let cred = open_credential()?;
    let key = kek(&sign_challenge(&cred)?);
    let cipher = Aes256Gcm::new((&key).into());
    let nonce_bytes = crate::random_bytes::<12>();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, Payload { msg: dek, aad: WRAP_AAD })
        .map_err(|_| "hello-failed: encrypt".to_string())?;
    if cipher
        .decrypt(nonce, Payload { msg: &ct, aad: WRAP_AAD })
        .map_err(|_| "hello-failed: wrap verify".to_string())?
        != dek
    {
        return Err("hello-failed: wrap verify".to_string());
    }
    let mut out = Vec::with_capacity(60);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Unwrap. Signs the challenge — the Windows Hello prompt — and derives the
/// same wrapping key. `wrap` is the `nonce || ct` body from the wrap file.
pub fn open(wrap: &[u8]) -> Result<Vec<u8>, String> {
    if wrap.len() != 60 {
        return Err("corrupt".to_string());
    }
    let cred = open_credential()?;
    let key = kek(&sign_challenge(&cred)?);
    let plain = Aes256Gcm::new((&key).into())
        .decrypt(
            Nonce::from_slice(&wrap[..12]),
            Payload { msg: &wrap[12..], aad: WRAP_AAD },
        )
        .map_err(|_| "corrupt".to_string())?;
    if plain.len() != 32 {
        return Err("corrupt".to_string());
    }
    Ok(plain)
}
