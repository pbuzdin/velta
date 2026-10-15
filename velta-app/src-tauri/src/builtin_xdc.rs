//! #138: built-in webxdc apps bundled into the binary.
//!
//! The renderer used to fetch app/builtin/send-direct.xdc from the frontend
//! origin and write it to uploads/ through the fs plugin. On Android that
//! chain handed the core a file that was not a valid .xdc (the WebView asset
//! fetch / IPC byte transfer does not reliably round-trip binary bodies), so
//! the core created an empty webxdc message whose frame 404'd ("not found").
//! The bytes now come from include_bytes! and are written natively, then
//! verified, before any message exists.

const SEND_DIRECT: &[u8] = include_bytes!("../../../app/builtin/send-direct.xdc");

pub fn builtin_bytes(name: &str) -> Option<&'static [u8]> {
    match name {
        "send-direct" => Some(SEND_DIRECT),
        _ => None,
    }
}

/// A usable .xdc: a zip (local header + end-of-central-directory record)
/// whose central directory names index.html.
pub fn is_valid_xdc(bytes: &[u8]) -> bool {
    if bytes.len() < 30 || !bytes.starts_with(b"PK\x03\x04") {
        return false;
    }
    let tail_start = bytes.len().saturating_sub(22 + 65535);
    let Some(eocd) = bytes[tail_start..]
        .windows(4)
        .rposition(|w| w == b"PK\x05\x06")
        .map(|i| i + tail_start)
    else {
        return false;
    };
    if eocd + 22 > bytes.len() {
        return false;
    }
    let cd_off = u32::from_le_bytes([bytes[eocd + 16], bytes[eocd + 17], bytes[eocd + 18], bytes[eocd + 19]]) as usize;
    let mut p = cd_off;
    while p + 46 <= eocd && bytes[p..p + 4] == *b"PK\x01\x02" {
        let n = u16::from_le_bytes([bytes[p + 28], bytes[p + 29]]) as usize;
        let x = u16::from_le_bytes([bytes[p + 30], bytes[p + 31]]) as usize;
        let c = u16::from_le_bytes([bytes[p + 32], bytes[p + 33]]) as usize;
        if p + 46 + n > bytes.len() {
            return false;
        }
        if &bytes[p + 46..p + 46 + n] == b"index.html" {
            return true;
        }
        p += 46 + n + x + c;
    }
    false
}

/// Write the named built-in app to `dest` and verify it on disk.
pub fn write_builtin(name: &str, dest: &std::path::Path) -> Result<(), String> {
    let bytes = builtin_bytes(name).ok_or_else(|| format!("unknown built-in app: {name}"))?;
    if !is_valid_xdc(bytes) {
        return Err(format!("built-in app {name} is corrupt"));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(dest, bytes).map_err(|e| format!("could not write built-in app: {e}"))?;
    let back = std::fs::read(dest).map_err(|e| format!("built-in app not readable: {e}"))?;
    if back != bytes {
        let _ = std::fs::remove_file(dest);
        return Err("built-in app write verification failed".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_send_direct_is_valid() {
        let b = builtin_bytes("send-direct").unwrap();
        assert!(b.len() > 1000);
        assert!(is_valid_xdc(b));
    }

    #[test]
    fn rejects_non_zip_and_unknown() {
        assert!(!is_valid_xdc(b""));
        assert!(!is_valid_xdc(b"<!doctype html><html></html>                     "));
        assert!(builtin_bytes("nope").is_none());
        let dir = std::env::temp_dir().join(format!("velta-bxdc-{}", std::process::id()));
        assert!(write_builtin("nope", &dir.join("x.xdc")).is_err());
        let out = dir.join("s.xdc");
        write_builtin("send-direct", &out).unwrap();
        assert!(is_valid_xdc(&std::fs::read(&out).unwrap()));
        let _ = std::fs::remove_dir_all(dir);
    }
}
