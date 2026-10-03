#!/usr/bin/env python3
"""apply-core-patches.py — re-apply Velta's vendored-core patches after a core upgrade.

Velta carries local patches inside the vendored `core/` tree (documented in
VENDORISSUES.MD entries 7 and 10; every patched block carries a
"Velta patch" marker comment). Re-vendoring upstream replaces the whole
`core/` tree and wipes them; this script re-inserts them.

Idempotent: each patch checks for its own marker first and skips if already
applied. Anchors are upstream context lines; if an anchor can no longer be
found the upstream shape changed — port the patch by hand (the intent lives
in VENDORISSUES.MD), then update this script.

Usage:
  python tools/apply-core-patches.py verify   # report only, exit 1 if anything is missing
  python tools/apply-core-patches.py apply    # insert what's missing (default)

Run from the repo root (velta/).
"""
import sys, os, io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Each op: file, id, applied (marker proving the patch is in), anchor (exact
# upstream text), text (block to insert), where ("after"|"before" the anchor),
# occ (1-based occurrence of the anchor, for deliberately ambiguous anchors).
PATCHES = [
    # ---- VENDORISSUES #7: animated WebP must not be recoded to static JPEG ----
    dict(
        id="#7 call site (blob.rs: skip recode for animated webp)",
        file="core/src/blob.rs",
        applied="if is_animated_webp(&mut file)",
        anchor="// reference. Ok, just rewind it.\n            file.rewind()?;\n",
        where="after",
        text="""            // Velta patch (re-apply on core upgrades, see VENDORISSUES.MD):
            // animated WebP must not be recoded — the `image` crate decodes
            // only the first frame, so the recode below would silently turn
            // an animated, transparent webp into a static JPEG.
            if is_animated_webp(&mut file).unwrap_or(false) {
                return Ok(name);
            }
            file.rewind()?;
""",
    ),
    dict(
        id="#7 helper (blob.rs: is_animated_webp)",
        file="core/src/blob.rs",
        applied="fn is_animated_webp(",
        anchor="/// Returns image file size and Exif.\n",
        where="before",
        text="""/// Velta patch (re-apply on core upgrades, see VENDORISSUES.MD): detects an
/// animated WebP from its container header. WebP is a RIFF container; each
/// animation frame lives in an "ANMF" chunk, which only animated files carry
/// (always near the start, right after the VP8X/ANIM chunks). The `image`
/// crate decodes only the first frame, so recoding an animated webp would
/// silently strip the animation — upstream tracks this in the TODO inside
/// `check_or_recode_to_size`. Animated webps are sent byte-exact instead.
fn is_animated_webp(file: &mut std::fs::File) -> std::io::Result<bool> {
    use std::io::Read;
    file.rewind()?;
    let mut head = Vec::new();
    std::io::Read::take(&mut *file, 4096).read_to_end(&mut head)?;
    file.rewind()?;
    Ok(head.len() > 12
        && head.get(0..4) == Some(b"RIFF".as_slice())
        && head.get(8..12) == Some(b"WEBP".as_slice())
        && head.windows(4).any(|w| w == b"ANMF"))
}

""",
    ),
    # ---- VENDORISSUES #10: expose the SMTP loop's bound transport ----
    dict(
        id="#10 Smtp struct field (smtp.rs)",
        file="core/src/smtp.rs",
        applied="pub(crate) sending_transport: std::sync::Arc<std::sync::atomic::AtomicU32>,",
        anchor="    pub(crate) connectivity: ConnectivityStore,\n",
        where="after",
        text="""
    /// Velta patch (#79, re-apply on core upgrades): the transport the SMTP
    /// loop is currently bound to, shared so the connectivity HTML (which
    /// only sees `SmtpConnectionState`) can report failover. 0 = not
    /// connected. Written on connect/disconnect, read by
    /// `get_connectivity_html`.
    pub(crate) sending_transport: std::sync::Arc<std::sync::atomic::AtomicU32>,
""",
    ),
    dict(
        id="#10 disconnect clears the handle (smtp.rs)",
        file="core/src/smtp.rs",
        applied="self.sending_transport.store(0, std::sync::atomic::Ordering::SeqCst);",
        anchor="        self.last_success = None;\n",
        where="before",
        text="""        self.transport_id = None;
        self.sending_transport.store(0, std::sync::atomic::Ordering::SeqCst);
""",
    ),
    dict(
        id="#10 connect success sets the handle (smtp.rs)",
        file="core/src/smtp.rs",
        applied="self.sending_transport.store(transport_id, std::sync::atomic::Ordering::SeqCst);",
        anchor="                    self.transport_id = Some(transport_id);\n",
        where="after",
        text="""                    self.sending_transport.store(transport_id, std::sync::atomic::Ordering::SeqCst);
""",
    ),
    dict(
        id="#10 ConnectionState field (scheduler.rs)",
        file="core/src/scheduler.rs",
        applied="    /// Velta patch (#79): transport the SMTP loop is bound to (0 = none).",
        anchor="    /// Mutex to pass connectivity info between IMAP/SMTP threads and the API\n    connectivity: ConnectivityStore,\n",
        where="after",
        text="""    /// Velta patch (#79): transport the SMTP loop is bound to (0 = none).
    sending_transport: std::sync::Arc<std::sync::atomic::AtomicU32>,
""",
    ),
    dict(
        id="#10 SmtpConnectionState::new clones the handle (scheduler.rs, occurrence 1)",
        file="core/src/scheduler.rs",
        applied="let sending_transport = handlers.connection.sending_transport.clone();",
        anchor="        let state = ConnectionState {\n",
        where="before",
        occ=1,
        text="""        // Velta patch (#79): shared handle to the SMTP loop's bound
        // transport, so the connectivity HTML can report actual failover.
        let sending_transport = handlers.connection.sending_transport.clone();

""",
    ),
    dict(
        id="#10 SmtpConnectionState literal passes the handle (scheduler.rs, occurrence 1)",
        file="core/src/scheduler.rs",
        applied="\n            sending_transport,\n",
        anchor="            connectivity: handlers.connection.connectivity.clone(),\n",
        where="after",
        occ=1,
        text="""            sending_transport,
""",
    ),
    dict(
        id="#10 sending_transport accessor (scheduler.rs)",
        file="core/src/scheduler.rs",
        applied="pub(crate) fn sending_transport(&self)",
        anchor="        let conn = SmtpConnectionState { state };\n\n        (conn, handlers)\n    }\n",
        where="after",
        text="""
    /// Transport the SMTP loop is currently bound to (0 = none). Velta #79.
    pub(crate) fn sending_transport(&self) -> u32 {
        self.state.sending_transport.load(std::sync::atomic::Ordering::SeqCst)
    }
""",
    ),
    dict(
        id="#10 ImapConnectionState literal needs the field too (scheduler.rs, occurrence 2)",
        file="core/src/scheduler.rs",
        applied="sending_transport: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0)),",
        anchor="            connectivity: handlers.connection.connectivity.clone(),\n",
        where="after",
        occ=2,
        text="""            sending_transport: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0)),
""",
    ),
    dict(
        id="#10 connectivity html captures the id (scheduler/connectivity.rs)",
        file="core/src/scheduler/connectivity.rs",
        applied="sched.smtp.sending_transport()",
        anchor="    let (folders_states, smtp) = match *lock {\n",
        where="replace",
        text="""    let (folders_states, smtp, sending_transport_id) = match *lock {
""",
    ),
    dict(
        id="#10 connectivity html tuple carries the id out (scheduler/connectivity.rs)",
        file="core/src/scheduler/connectivity.rs",
        applied="sched.smtp.sending_transport()",  # sibling op's marker
        anchor="                sched.smtp.state.connectivity.clone(),\n",
        where="after",
        text="""                // Velta patch (#79): transport the SMTP loop is bound to,
                // read while the scheduler lock is held.
                sched.smtp.sending_transport(),
""",
    ),
    dict(
        id="#10 outgoing section emits smtp-via (scheduler/connectivity.rs)",
        file="core/src/scheduler/connectivity.rs",
        applied='class=\\"smtp-via\\"',
        anchor='        ret += &*escaper::encode_minimal(&detailed.to_string_smtp(self));\n',
        where="after",
        text="""        // Velta patch (#79, re-apply on core upgrades): report which
        // transport the SMTP loop is actually bound to, so clients can mark
        // the real sending relay (failover may differ from configured_addr).
        if sending_transport_id > 0 {
            let sending_addr: Option<String> = self
                .sql
                .query_row(
                    "SELECT addr FROM transports WHERE id=?",
                    (sending_transport_id,),
                    |row| row.get(0),
                )
                .await
                .ok();
            if let Some(addr) = sending_addr {
                ret += &format!(
                    "<span class=\\"smtp-via\\">{}</span>",
                    escaper::encode_minimal(&addr)
                );
            }
        }
""",
    ),
]


def load(path):
    return io.open(os.path.join(ROOT, path), encoding="utf-8").read()


def save(path, text):
    io.open(os.path.join(ROOT, path), "w", encoding="utf-8", newline="").write(text)


def find_occ(text, anchor, occ):
    idx = -1
    for _ in range(occ):
        idx = text.find(anchor, idx + 1)
        if idx < 0:
            return -1
    return idx


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "apply"
    if mode not in ("apply", "verify"):
        print(__doc__)
        return 2
    cache = {}
    missing, conflicts = [], []
    for p in PATCHES:
        if p["file"] not in cache:
            cache[p["file"]] = load(p["file"])
        text = cache[p["file"]]
        if p["applied"] and p["applied"] in text:
            continue
        occ = p.get("occ", 1)
        idx = find_occ(text, p["anchor"], occ)
        if idx < 0:
            conflicts.append(p["id"])
            continue
        if mode == "verify":
            missing.append(p["id"])
            continue
        if p["where"] == "replace":
            cache[p["file"]] = text[:idx] + p["text"] + text[idx + len(p["anchor"]):]
        else:
            at = idx if p["where"] == "before" else idx + len(p["anchor"])
            cache[p["file"]] = text[:at] + p["text"] + text[at:]
        print(f"applied: {p['id']}")
    for path, text in cache.items():
        if mode == "apply":
            save(path, text)
    if mode == "verify":
        for m in missing:
            print(f"MISSING: {m}")
        print(f"{len(PATCHES) - len(missing)}/{len(PATCHES)} patches present")
        return 1 if missing else 0
    if conflicts:
        print("\nUPSTREAM SHAPE CHANGED — port by hand (see VENDORISSUES.MD):")
        for c in conflicts:
            print(f"  CONFLICT: {c}")
        return 1
    print("done — cargo check the core, then commit together with the re-vendor")
    return 0


if __name__ == "__main__":
    sys.exit(main())
