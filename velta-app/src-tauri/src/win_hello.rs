//! Windows Hello custody for the database key (#178).
//!
//! An RSA-2048 key in the Microsoft Passport key storage provider wraps the
//! DEK. Decrypt is the private operation, so Windows Hello (PIN, face, or
//! fingerprint) must succeed before the plaintext comes back. The signature
//! API is not used: RSA-PSS signatures are not a stable key.
//!
//! ponytail: one NGC key for the whole install. Per-profile Hello keys only
//! if profiles ever stop sharing one DEK.

use std::ffi::c_void;

const KEY_NAME: &str = "chat.velta.dbkey";
const PROVIDER: &str = "Microsoft Passport Key Storage Provider";
const NCRYPT_PAD_PKCS1: u32 = 2;
const NCRYPT_SILENT: u32 = 0x40;
const NCRYPT_OVERWRITE: u32 = 0x80;
const NCRYPT_ALLOW_DECRYPT: u32 = 1;
const NCRYPT_ALLOW_SIGNING: u32 = 2;
const NCRYPT_ALLOW_KEY_IMPORT: u32 = 8;
const NGC_CACHE_AUTH_MANDATORY: u32 = 1;

fn w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn fail(st: i32, what: &str) -> Result<(), String> {
    if st >= 0 {
        return Ok(());
    }
    let code = st as u32;
    if code == 0x8009_0036 || code == 0x8007_04C7 {
        return Err("cancelled".to_string());
    }
    // No Hello enrollment, or the Passport provider refused the key.
    if matches!(
        code,
        0x8009_000D | 0x8009_0016 | 0x8009_0029 | 0x8009_0030 | 0x8009_0035
    ) {
        return Err("hello-unavailable".to_string());
    }
    Err(format!("hello-failed: {what} {code:#x}"))
}

struct Nc(isize);
impl Drop for Nc {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { NCryptFreeObject(self.0) };
        }
    }
}

#[link(name = "ncrypt")]
extern "system" {
    fn NCryptOpenStorageProvider(out: *mut isize, name: *const u16, flags: u32) -> i32;
    fn NCryptOpenKey(prov: isize, out: *mut isize, name: *const u16, spec: u32, flags: u32) -> i32;
    fn NCryptCreatePersistedKey(
        prov: isize,
        out: *mut isize,
        alg: *const u16,
        name: *const u16,
        spec: u32,
        flags: u32,
    ) -> i32;
    fn NCryptFinalizeKey(key: isize, flags: u32) -> i32;
    fn NCryptDeleteKey(key: isize, flags: u32) -> i32;
    fn NCryptFreeObject(obj: isize) -> i32;
    fn NCryptFreeBuffer(p: *mut c_void) -> i32;
    fn NCryptSetProperty(obj: isize, name: *const u16, input: *const u8, len: u32, flags: u32) -> i32;
    fn NCryptGetProperty(
        obj: isize,
        name: *const u16,
        output: *mut u8,
        len: u32,
        written: *mut u32,
        flags: u32,
    ) -> i32;
    fn NCryptEncrypt(
        key: isize,
        input: *const u8,
        input_len: u32,
        padding: *const c_void,
        output: *mut u8,
        output_len: u32,
        written: *mut u32,
        flags: u32,
    ) -> i32;
    fn NCryptDecrypt(
        key: isize,
        input: *const u8,
        input_len: u32,
        padding: *const c_void,
        output: *mut u8,
        output_len: u32,
        written: *mut u32,
        flags: u32,
    ) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: isize, access: u32, token: *mut isize) -> i32;
    fn GetTokenInformation(token: isize, class: u32, info: *mut u8, len: u32, ret: *mut u32) -> i32;
    fn ConvertSidToStringSidW(sid: isize, out: *mut *mut u16) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> isize;
    fn CloseHandle(handle: isize) -> i32;
    fn LocalFree(p: isize) -> isize;
    fn LoadLibraryW(name: *const u16) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *mut c_void;
    fn FreeLibrary(module: isize) -> i32;
}

fn set_dword(obj: isize, name: &str, val: u32) -> i32 {
    let n = w(name);
    let b = val.to_le_bytes();
    unsafe { NCryptSetProperty(obj, n.as_ptr(), b.as_ptr(), 4, 0) }
}

fn get_dword(obj: isize, name: &str) -> Result<u32, i32> {
    let n = w(name);
    let mut val = 0u32;
    let mut got = 0u32;
    let st = unsafe {
        NCryptGetProperty(obj, n.as_ptr(), &mut val as *mut u32 as *mut u8, 4, &mut got, 0)
    };
    if st < 0 { Err(st) } else { Ok(val) }
}

fn set_hwnd(obj: isize, hwnd: isize) -> i32 {
    if hwnd == 0 {
        return 0;
    }
    let n = w("HWND Handle");
    let b = hwnd.to_ne_bytes();
    unsafe { NCryptSetProperty(obj, n.as_ptr(), b.as_ptr(), b.len() as u32, 0) }
}

fn user_sid() -> Option<Vec<u16>> {
    unsafe {
        let mut token = 0isize;
        if OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) == 0 {
            return None;
        }
        let mut need = 0u32;
        GetTokenInformation(token, 1, std::ptr::null_mut(), 0, &mut need);
        if need == 0 {
            CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; need as usize];
        let ok = GetTokenInformation(token, 1, buf.as_mut_ptr(), need, &mut need) != 0;
        CloseHandle(token);
        if !ok || buf.len() < std::mem::size_of::<isize>() {
            return None;
        }
        let sid = isize::from_ne_bytes(buf[..std::mem::size_of::<isize>()].try_into().ok()?);
        let mut out = std::ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut out) == 0 || out.is_null() {
            return None;
        }
        let mut len = 0usize;
        while len < 200 && *out.add(len) != 0 {
            len += 1;
        }
        let mut s = std::slice::from_raw_parts(out, len).to_vec();
        LocalFree(out as isize);
        s.push(0);
        Some(s)
    }
}

/// True when this user already has a Windows Hello decryption key.
pub fn available() -> bool {
    let sid = match user_sid() {
        Some(s) => s,
        None => return false,
    };
    unsafe {
        let lib = LoadLibraryW(w("cryptngc.dll").as_ptr());
        if lib == 0 {
            return false;
        }
        let proc = GetProcAddress(lib, b"NgcGetDefaultDecryptionKeyName\0".as_ptr());
        if proc.is_null() {
            FreeLibrary(lib);
            return false;
        }
        let f: unsafe extern "system" fn(*const u16, u32, u32, *mut *mut u16) -> i32 =
            std::mem::transmute(proc);
        let mut name = std::ptr::null_mut();
        let st = f(sid.as_ptr(), 0, 0, &mut name);
        let ok = st >= 0 && !name.is_null();
        if !name.is_null() {
            NCryptFreeBuffer(name as *mut c_void);
        }
        FreeLibrary(lib);
        ok
    }
}

fn provider() -> Result<Nc, String> {
    let mut h = 0isize;
    fail(
        unsafe { NCryptOpenStorageProvider(&mut h, w(PROVIDER).as_ptr(), 0) },
        "provider",
    )?;
    Ok(Nc(h))
}

fn open_key(prov: isize, silent: bool) -> Result<Nc, String> {
    let mut h = 0isize;
    let flags = if silent { NCRYPT_SILENT } else { 0 };
    fail(
        unsafe { NCryptOpenKey(prov, &mut h, w(KEY_NAME).as_ptr(), 0, flags) },
        "open",
    )?;
    Ok(Nc(h))
}

/// The persisted key must require Hello on every use and must not be an
/// importable software stand-in.
fn require_auth_bound(key: isize) -> Result<(), String> {
    let usage = get_dword(key, "Key Usage").map_err(|st| fail(st, "usage").unwrap_err())?;
    if usage & NCRYPT_ALLOW_KEY_IMPORT != 0 || usage & NCRYPT_ALLOW_DECRYPT == 0 {
        return Err("hello-failed: key not bound to Windows Hello".to_string());
    }
    let cache = get_dword(key, "NgcCacheType")
        .or_else(|_| get_dword(key, "NgcCacheTypeProperty"))
        .map_err(|st| fail(st, "cache").unwrap_err())?;
    if cache != NGC_CACHE_AUTH_MANDATORY {
        return Err("hello-failed: key not bound to Windows Hello".to_string());
    }
    Ok(())
}

fn create_key(prov: isize) -> Result<Nc, String> {
    let mut h = 0isize;
    fail(
        unsafe {
            NCryptCreatePersistedKey(
                prov,
                &mut h,
                w("RSA").as_ptr(),
                w(KEY_NAME).as_ptr(),
                0,
                NCRYPT_OVERWRITE,
            )
        },
        "create",
    )?;
    let key = Nc(h);
    fail(set_dword(key.0, "Length", 2048), "length")?;
    fail(
        set_dword(key.0, "Key Usage", NCRYPT_ALLOW_DECRYPT | NCRYPT_ALLOW_SIGNING),
        "usage",
    )?;
    let cache = set_dword(key.0, "NgcCacheType", NGC_CACHE_AUTH_MANDATORY);
    if cache < 0 {
        fail(set_dword(key.0, "NgcCacheTypeProperty", NGC_CACHE_AUTH_MANDATORY), "cache")?;
    }
    fail(unsafe { NCryptFinalizeKey(key.0, 0) }, "finalize")?;
    Ok(key)
}

fn crypt(key: isize, input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    let mut need = 0u32;
    let call = |out: *mut u8, len: u32, written: *mut u32| unsafe {
        if encrypt {
            NCryptEncrypt(key, input.as_ptr(), input.len() as u32, std::ptr::null(), out, len, written, NCRYPT_PAD_PKCS1)
        } else {
            NCryptDecrypt(key, input.as_ptr(), input.len() as u32, std::ptr::null(), out, len, written, NCRYPT_PAD_PKCS1)
        }
    };
    fail(call(std::ptr::null_mut(), 0, &mut need), "size")?;
    if need == 0 || need > 512 {
        return Err("hello-failed: bad ciphertext size".to_string());
    }
    let mut buf = vec![0u8; need as usize];
    let mut got = 0u32;
    fail(call(buf.as_mut_ptr(), need, &mut got), if encrypt { "encrypt" } else { "decrypt" })?;
    buf.truncate(got as usize);
    Ok(buf)
}

/// Create the Hello key and wrap `dek` (32 bytes). Encrypt does not prompt.
pub fn seal(dek: &[u8]) -> Result<Vec<u8>, String> {
    if dek.len() != 32 {
        return Err("bad dek".to_string());
    }
    if !available() {
        return Err("hello-unavailable".to_string());
    }
    let prov = provider()?;
    if let Err(e) = create_key(prov.0) {
        delete();
        return Err(e);
    }
    // Public encrypt does not prompt. Silent open falls back to a normal
    // open when the provider refuses a silent handle.
    let key = match open_key(prov.0, true).or_else(|_| open_key(prov.0, false)) {
        Ok(k) => k,
        Err(e) => {
            delete();
            return Err(e);
        }
    };
    if let Err(e) = require_auth_bound(key.0) {
        drop(key);
        delete();
        return Err(e);
    }
    match crypt(key.0, dek, true) {
        Ok(ct) => Ok(ct),
        Err(e) => {
            drop(key);
            delete();
            Err(e)
        }
    }
}

/// Unwrap. Prompts Windows Hello. `hwnd` parents the dialog; 0 lets Windows choose.
pub fn open(ct: &[u8], hwnd: isize) -> Result<Vec<u8>, String> {
    let prov = provider()?;
    let key = open_key(prov.0, false)?;
    require_auth_bound(key.0)?;
    let _ = set_hwnd(key.0, hwnd);
    let _ = set_dword(key.0, "PinCacheIsGestureRequired", 1);
    let plain = crypt(key.0, ct, false)?;
    if plain.len() != 32 {
        return Err("corrupt".to_string());
    }
    Ok(plain)
}

pub fn delete() {
    let Ok(prov) = provider() else { return };
    let mut h = 0isize;
    let st = unsafe { NCryptOpenKey(prov.0, &mut h, w(KEY_NAME).as_ptr(), 0, NCRYPT_SILENT) };
    if st < 0 || h == 0 {
        return;
    }
    // Delete frees the handle.
    unsafe { NCryptDeleteKey(h, 0) };
}
