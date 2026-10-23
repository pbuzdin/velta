// picked.rs — V-07/#65: which arbitrary (outside app data) paths the
// renderer may hand to the file-reading commands.
//
// The renderer is not trusted to say "the user picked this". Rust-side
// evidence only:
//   1. the dialog plugin's open/save commands add every path they return to
//      the fs plugin's runtime scope (tauri-plugin-dialog commands.rs), so a
//      dialog pick shows up as `fs_scope().is_allowed(path)`;
//   2. files the OS handed to Velta ("Open with" / "Send to", argv and
//      RunEvent::Opened) are recorded here by `record` in queue_opened;
//   3. anything inside Velta's own app-data / temp-backup dirs (copies made
//      by resolve_content_uri for Android content URIs, uploads/, built-in
//      xdc files, prep_backup output) is ours already.
// allow_picked_path, lufi_open_file and prep_backup accept only these.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static OPENED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

fn normalize(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Record a file path the OS opened Velta with (not a URL).
pub fn record(path: &Path) {
    let mut g = OPENED.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashSet::new).insert(normalize(path));
}

fn was_opened(path: &Path) -> bool {
    let g = OPENED.lock().unwrap_or_else(|e| e.into_inner());
    g.as_ref().is_some_and(|s| s.contains(&normalize(path)))
}

/// True when `path` resolves to somewhere under one of `bases`. Both sides
/// are canonicalized when they exist, so `..` and symlinks cannot escape.
pub fn is_within(path: &Path, bases: &[PathBuf]) -> bool {
    let p = normalize(path);
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    bases.iter().any(|b| {
        let b = normalize(b);
        !b.as_os_str().is_empty() && p.starts_with(&b)
    })
}

/// Turn an opened-with argument (`file:///…` or a plain path) into a path,
/// or None for links and anything that is not an existing file.
pub fn opened_file_path(url: &str) -> Option<PathBuf> {
    let p = if let Some(rest) = url.strip_prefix("file://") {
        let rest = crate::percent_decode(rest);
        // file:///C:/x on Windows
        let rest = if rest.len() > 2 && rest.as_bytes()[0] == b'/' && rest.as_bytes()[2] == b':' {
            rest[1..].to_string()
        } else {
            rest
        };
        PathBuf::from(rest)
    } else if url.contains("://") || url.starts_with("data:") || url.starts_with("content:") {
        return None;
    } else {
        PathBuf::from(url)
    };
    p.is_file().then_some(p)
}

/// The V-07 gate. Err when the renderer names a path with no Rust-side
/// evidence of a user pick.
pub fn check<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &Path) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    if path.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    let mut bases = vec![std::env::temp_dir().join("velta-backup")];
    if let Ok(d) = app.path().app_local_data_dir() {
        bases.push(d);
    }
    if let Ok(d) = app.path().app_cache_dir() {
        bases.push(d);
    }
    if is_within(path, &bases) || was_opened(path) {
        return Ok(());
    }
    if let Some(scope) = app.try_fs_scope() {
        if scope.is_allowed(path) {
            return Ok(());
        }
    }
    Err("path was not picked by the user".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_rejects_escape_and_outside() {
        let base = std::env::temp_dir().join("velta-picked-test");
        std::fs::create_dir_all(base.join("uploads")).unwrap();
        std::fs::write(base.join("uploads/a.txt"), b"x").unwrap();
        let bases = vec![base.clone()];
        assert!(is_within(&base.join("uploads/a.txt"), &bases));
        assert!(!is_within(&base.join("../etc/passwd"), &bases));
        assert!(!is_within(Path::new("/etc/passwd"), &bases));
        assert!(!is_within(&base.join("uploads/../../x"), &bases));
        assert!(!is_within(Path::new("/x"), &[PathBuf::new()]));
    }

    #[test]
    fn opened_paths_only_for_files() {
        let f = std::env::temp_dir().join("velta-picked-open.txt");
        std::fs::write(&f, b"x").unwrap();
        assert_eq!(opened_file_path(f.to_str().unwrap()), Some(f.clone()));
        assert_eq!(opened_file_path("velta://invite"), None);
        assert_eq!(opened_file_path("https://i.delta.chat/#x"), None);
        assert_eq!(opened_file_path("content://x/y"), None);
        record(&f);
        assert!(was_opened(&f));
        assert!(!was_opened(Path::new("/etc/hostname")));
    }
}
