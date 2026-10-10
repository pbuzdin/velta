#!/usr/bin/env python3
"""apply-core-patches.py — Velta's quilt for the vendored chatmail core.

Every Velta change inside the vendored `core/` tree MUST be an op in PATCHES
below (VENDORISSUES.MD documents the intent of each numbered patch).
Re-vendoring upstream replaces the whole `core/` tree; this tool re-inserts
the ops, proves they are in, and proves nothing else differs from upstream.

An op is: file, id, applied (a marker string that occurs in the op's own
inserted text and proves the op is in), anchor (exact upstream text), text
(the block to insert), where ("after" | "before" | "replace" the anchor),
occ (1-based occurrence of the anchor, for deliberately ambiguous anchors).

Modes (run from anywhere; paths resolve against the repo root):
  apply                 insert every op whose marker is missing (default).
                        Fails (exit 1) if an anchor is gone — the upstream
                        shape changed: port the op by hand, then fix PATCHES.
  verify                every op's marker must be present; exit 1 otherwise.
                        A missing marker is a failure whether or not the
                        anchor still exists (the old tool silently skipped
                        ops whose marker AND anchor were both gone).
  tree-check            whole-tree check: pristine upstream + `apply` must
                        equal the vendored tree byte-for-byte (CRLF/LF-only
                        differences tolerated outside test-data/, where
                        upstream's .gitattributes keeps bytes verbatim).
                        Any file outside the quilt's declared files that
                        differs, any extra or missing file, or any drift in
                        a declared file fails (exit 1). Git-ignored paths
                        are skipped.
      --upstream DIR    pristine upstream tree (e.g. an extracted tag tarball)
      --fetch           download github.com/chatmail/core tag v<version>
                        (version read from core/Cargo.toml) into a temp dir
  self-test             run the tool's own unit tests (no network, temp dirs)

Common option: --core DIR  operate on another core tree (default: <repo>/core).
"""
import argparse, io, os, shutil, subprocess, sys, tarfile, tempfile, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CORE = os.path.join(ROOT, "core")
UPSTREAM_REPO = "chatmail/core"

# Each op's `file` is relative to the repo root and always starts with
# "core/" (mapped onto --core). Keep ops minimal; one marker per op, and the
# marker must occur in the op's own `text` (lint-checked).
PATCHES = [
    # ---- VENDORISSUES #7 (animated WebP) RETIRED at core 2.63.0: upstream
    # chatmail/core#8777 (in 2.63.0) keeps animated WebPs byte-exact via the
    # real decoder's has_animation() (avatars still flatten — deliberate).
    # Do not re-add.

    # ---- VENDORISSUES #10 (#79): expose the SMTP loop's bound transport ----
    # Temporary until chatmail/core#8798 ships a client-facing API.
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
        # Upstream #8797 (2.63.0) already resets transport_id/from in
        # disconnect(); this op only clears the shared handle.
        id="#10 disconnect clears the handle (smtp.rs)",
        file="core/src/smtp.rs",
        applied=".store(0, std::sync::atomic::Ordering::SeqCst);",
        anchor="        self.last_success = None;\n    }\n",
        where="before",
        text="""        self.sending_transport
            .store(0, std::sync::atomic::Ordering::SeqCst);
""",
    ),
    dict(
        id="#10 connect success sets the handle (smtp.rs)",
        file="core/src/smtp.rs",
        applied=".store(transport_id, std::sync::atomic::Ordering::SeqCst);",
        anchor="                    self.transport_id = Some(transport_id);\n",
        where="after",
        text="""                    self.sending_transport
                        .store(transport_id, std::sync::atomic::Ordering::SeqCst);
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
        applied="            sending_transport,\n",
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
        self.state
            .sending_transport
            .load(std::sync::atomic::Ordering::SeqCst)
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
        applied="let (folders_states, smtp, sending_transport_id) = match *lock {",
        anchor="    let (folders_states, smtp) = match *lock {\n",
        where="replace",
        text="""    let (folders_states, smtp, sending_transport_id) = match *lock {
""",
    ),
    dict(
        id="#10 connectivity html tuple carries the id out (scheduler/connectivity.rs)",
        file="core/src/scheduler/connectivity.rs",
        applied="                sched.smtp.sending_transport(),\n",
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
        // the real sending relay (failover may differ from the pin).
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
    dict(
        id="#10 test: disconnect clears the shared handle (smtp_tests.rs)",
        file="core/src/smtp/smtp_tests.rs",
        applied="async fn test_velta_disconnect_clears_sending_transport()",
        anchor="use crate::transport;\n",
        where="after",
        text="""
// Velta patch (#10/#79): the connectivity HTML's smtp-via marker reads the
// shared handle; a disconnected loop must report "not bound" (0).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_velta_disconnect_clears_sending_transport() -> Result<()> {
    let mut smtp = super::Smtp::new();
    let handle = smtp.sending_transport.clone();
    handle.store(7, std::sync::atomic::Ordering::SeqCst);
    smtp.disconnect();
    assert_eq!(handle.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(smtp.transport_id.is_none());
    Ok(())
}
""",
    ),

    # ---- VENDORISSUES #11: user-pinned send transport ("Use for sending") ----
    # Keyed by the Velta-owned ui config `ui.velta.send_transport` (transport
    # addr), NOT configured_addr — chatmail/core#8711 removes ConfiguredAddr.
    # Pinned transport first, then upstream's most-recently-successful order
    # (#8771) as failover; a pin that failed to connect within
    # VELTA_PIN_BACKOFF drops behind the most recently successful transport.
    dict(
        id="#11 Smtp remembers connect failures (smtp.rs)",
        file="core/src/smtp.rs",
        applied="pub(crate) velta_connect_failed: std::collections::BTreeMap<u32, tools::Time>,",
        anchor="    pub(crate) last_send_error: Option<String>,\n",
        where="after",
        text="""
    /// Velta patch (#11): when each transport last failed to connect (cleared
    /// on success). A pinned send transport that failed within
    /// `VELTA_PIN_BACKOFF` is tried second, not first.
    pub(crate) velta_connect_failed: std::collections::BTreeMap<u32, tools::Time>,
""",
    ),
    dict(
        id="#11 pinned send transport ordering (smtp.rs)",
        file="core/src/smtp.rs",
        applied="pub(crate) const VELTA_SEND_TRANSPORT_KEY: &str = \"ui.velta.send_transport\";",
        anchor="/// Returns transports with their IDs in the order in which they should be tried.\nasync fn sorted_transports(context: &Context) -> Result<Vec<(u32, ConfiguredLoginParam)>> {\n",
        where="replace",
        text="""/// Velta patch (#11, re-apply on core upgrades): ui config key holding the
/// address of the transport the user chose for sending ("Use for sending").
/// Velta-owned so upstream's removal of `ConfiguredAddr` (#8711) can't break
/// it. Unset, empty, or naming a removed transport = no pin.
pub(crate) const VELTA_SEND_TRANSPORT_KEY: &str = "ui.velta.send_transport";

/// Velta patch (#11): how long a pinned transport that failed to connect
/// yields to the most recently successful one. Bounds the cost of a dead pin
/// to one connect timeout per window; after it the pin is tried first again.
pub(crate) const VELTA_PIN_BACKOFF: std::time::Duration = std::time::Duration::from_secs(300);

/// Velta patch (#11): id of the pinned send transport, if the pin names an
/// existing transport.
pub(crate) async fn velta_pinned_transport(context: &Context) -> Result<Option<u32>> {
    let Some(addr) = context
        .get_ui_config(VELTA_SEND_TRANSPORT_KEY)
        .await?
        .map(|addr| addr.trim().to_lowercase())
        .filter(|addr| !addr.is_empty())
    else {
        return Ok(None);
    };
    context
        .sql
        .query_get_value("SELECT id FROM transports WHERE addr=?", (addr,))
        .await
}

/// Velta patch (#11): whether the pin is backing off after a recent connect
/// failure.
fn velta_pin_backed_off(
    connect_failed: &std::collections::BTreeMap<u32, tools::Time>,
    pin: u32,
) -> bool {
    connect_failed
        .get(&pin)
        .is_some_and(|failed_at| time_elapsed(failed_at) < VELTA_PIN_BACKOFF)
}

/// Velta patch (#11): moves the pinned transport to the front of upstream's
/// order — or to second place, behind the most recently successful
/// transport, while it is backing off.
fn velta_pin_first(
    transports: &mut Vec<(u32, ConfiguredLoginParam)>,
    pin: Option<u32>,
    connect_failed: &std::collections::BTreeMap<u32, tools::Time>,
) {
    let Some(pin) = pin else { return };
    let Some(pos) = transports.iter().position(|(id, _)| *id == pin) else {
        return;
    };
    let entry = transports.remove(pos);
    let at = if velta_pin_backed_off(connect_failed, pin) {
        transports.len().min(1)
    } else {
        0
    };
    transports.insert(at, entry);
}

/// Returns transports with their IDs in the order in which they should be
/// tried: the user's pinned send transport first (Velta patch #11), then
/// upstream's most-recently-successful order. Test-only since the patch:
/// `connect_configured` also applies the connect-failure backoff.
#[cfg(test)]
async fn sorted_transports(context: &Context) -> Result<Vec<(u32, ConfiguredLoginParam)>> {
    let mut transports = upstream_sorted_transports(context).await?;
    let pin = velta_pinned_transport(context).await?;
    velta_pin_first(&mut transports, pin, &Default::default());
    Ok(transports)
}

/// Upstream's order (most recently successful first), unchanged body.
async fn upstream_sorted_transports(context: &Context) -> Result<Vec<(u32, ConfiguredLoginParam)>> {
""",
    ),
    dict(
        id="#11 a live connection yields to the pin (smtp.rs)",
        file="core/src/smtp.rs",
        applied="Pinned send transport {pin} differs from bound transport {bound}, reconnecting.",
        anchor="""        if self.is_connected() {
            return Ok(());
        }

        self.connectivity.set_connecting(context);
""",
        where="before",
        text="""        // Velta patch (#11): the user pinned another transport (or the pin's
        // backoff expired) — drop the live connection so the next connect
        // tries the pin first.
        let velta_pin = velta_pinned_transport(context).await?;
        if let (Some(pin), Some(bound)) = (velta_pin, self.transport_id)
            && pin != bound
            && !velta_pin_backed_off(&self.velta_connect_failed, pin)
        {
            info!(
                context,
                "Pinned send transport {pin} differs from bound transport {bound}, reconnecting."
            );
            self.disconnect();
        }

""",
    ),
    dict(
        id="#11 connect loop uses the pinned order (smtp.rs)",
        file="core/src/smtp.rs",
        applied="velta_pin_first(&mut transports, velta_pin, &self.velta_connect_failed);",
        anchor="        for (transport_id, lp) in sorted_transports(context).await? {\n",
        where="replace",
        text="""        // Velta patch (#11): pinned transport first unless backing off.
        let mut transports = upstream_sorted_transports(context).await?;
        velta_pin_first(&mut transports, velta_pin, &self.velta_connect_failed);
        for (transport_id, lp) in transports {
""",
    ),
    dict(
        id="#11 connect success clears the failure (smtp.rs)",
        file="core/src/smtp.rs",
        applied="self.velta_connect_failed.remove(&transport_id);",
        anchor="                    self.transport_id = Some(transport_id);\n",
        where="after",
        text="""                    self.velta_connect_failed.remove(&transport_id);
""",
    ),
    dict(
        id="#11 connect failure is remembered (smtp.rs)",
        file="core/src/smtp.rs",
        applied=".insert(transport_id, tools::Time::now());",
        anchor="""                        "Failed to connect to SMTP transport {transport_id}: {err:#}."
                    );
""",
        where="after",
        text="""                    self.velta_connect_failed
                        .insert(transport_id, tools::Time::now());
""",
    ),
    dict(
        id="#11 tests (smtp_tests.rs)",
        file="core/src/smtp/smtp_tests.rs",
        applied="async fn test_velta_pinned_send_transport()",
        anchor="use crate::transport;\n",
        where="after",
        text="""
// Velta patch (#11): "Use for sending" pins a transport via the ui config
// key; the pin goes first, upstream's recency order is the failover.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_velta_pinned_send_transport() -> Result<()> {
    let mut tcm = TestContextManager::new();
    let t = &tcm.unconfigured().await;

    transport::add_pseudo_transport(t, "foo@example.net").await?;
    transport::add_pseudo_transport(t, "bar@example.net").await?;
    transport::add_pseudo_transport(t, "baz@example.net").await?;
    let transports = super::sorted_transports(t).await?;
    let [(id_foo, _), (id_bar, _), (id_baz, _)] = transports[..] else {
        panic!("Unexpected number of transports");
    };
    super::record_success(t, id_baz).await?;
    let ids = |v: Vec<(u32, crate::transport::ConfiguredLoginParam)>| {
        v.into_iter().map(|(id, _)| id).collect::<Vec<_>>()
    };

    // No pin: upstream order (most recently successful first).
    assert_eq!(
        ids(super::sorted_transports(t).await?),
        [id_baz, id_foo, id_bar]
    );

    // Pin wins over recency (case-insensitive addr).
    t.set_ui_config(super::VELTA_SEND_TRANSPORT_KEY, Some("Bar@Example.net"))
        .await?;
    assert_eq!(super::velta_pinned_transport(t).await?, Some(id_bar));
    assert_eq!(
        ids(super::sorted_transports(t).await?),
        [id_bar, id_baz, id_foo]
    );

    // A pin naming a removed/unknown transport is ignored.
    t.set_ui_config(super::VELTA_SEND_TRANSPORT_KEY, Some("gone@example.net"))
        .await?;
    assert_eq!(super::velta_pinned_transport(t).await?, None);
    assert_eq!(
        ids(super::sorted_transports(t).await?),
        [id_baz, id_foo, id_bar]
    );

    // Empty = unset.
    t.set_ui_config(super::VELTA_SEND_TRANSPORT_KEY, Some(""))
        .await?;
    assert_eq!(super::velta_pinned_transport(t).await?, None);
    Ok(())
}

// Velta patch (#11): a pin that just failed to connect drops behind the most
// recently successful transport; once VELTA_PIN_BACKOFF passed (or the pin
// connected again) it is first again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_velta_pin_backoff() -> Result<()> {
    let mut tcm = TestContextManager::new();
    let t = &tcm.unconfigured().await;

    transport::add_pseudo_transport(t, "foo@example.net").await?;
    transport::add_pseudo_transport(t, "bar@example.net").await?;
    transport::add_pseudo_transport(t, "baz@example.net").await?;
    let transports = super::sorted_transports(t).await?;
    let [(id_foo, _), (id_bar, _), (id_baz, _)] = transports[..] else {
        panic!("Unexpected number of transports");
    };
    super::record_success(t, id_baz).await?;
    let upstream = super::upstream_sorted_transports(t).await?;
    let order = |pin, failed: &std::collections::BTreeMap<u32, crate::tools::Time>| {
        let mut v = upstream.clone();
        super::velta_pin_first(&mut v, pin, failed);
        v.into_iter().map(|(id, _)| id).collect::<Vec<_>>()
    };
    let mut failed = std::collections::BTreeMap::new();

    assert_eq!(order(Some(id_bar), &failed), [id_bar, id_baz, id_foo]);

    // Just failed: behind the most recently successful transport.
    failed.insert(id_bar, crate::tools::Time::now());
    assert!(super::velta_pin_backed_off(&failed, id_bar));
    assert_eq!(order(Some(id_bar), &failed), [id_baz, id_bar, id_foo]);

    // Backoff expired: first again.
    let long_ago =
        crate::tools::Time::now() - super::VELTA_PIN_BACKOFF - std::time::Duration::from_secs(1);
    failed.insert(id_bar, long_ago);
    assert!(!super::velta_pin_backed_off(&failed, id_bar));
    assert_eq!(order(Some(id_bar), &failed), [id_bar, id_baz, id_foo]);

    // A single transport stays first even while backing off.
    let mut only = vec![upstream[0].clone()];
    failed.insert(upstream[0].0, crate::tools::Time::now());
    super::velta_pin_first(&mut only, Some(upstream[0].0), &failed);
    assert_eq!(only.len(), 1);
    Ok(())
}
""",
    ),

    # ---- VENDORISSUES #12 (#42/#25 P8): bounded background_fetch ----
    # Originally 78df479; silently dropped by the 2.63.0 re-vendor (2aac743)
    # because it never was a quilt op. Restored here.
    dict(
        id="#12 background_fetch bounds the wait and restarts I/O (context.rs)",
        file="core/src/context.rs",
        applied="background_fetch: work not done within 10s, restarting IO to drop a stale connection.",
        anchor="""            self.scheduler.interrupt_inbox_idle().await;
            let include_smtp = false;
            self.wait_for_work_done(include_smtp).await;
""",
        where="replace",
        text="""            self.scheduler.interrupt_inbox_idle().await;
            let include_smtp = false;
            // Velta patch (#12, #42/#25 P8, re-apply on core upgrades): bound
            // the wait. After the interrupt, the fetch runs on the existing
            // session; if that socket died quietly (NAT timeout, Doze
            // freezer), the read blocks for up to `crate::net::TIMEOUT`
            // before erroring, so a push wake-up would wait out the stale
            // connection instead of delivering. If the fetch does not finish
            // quickly, restart IO so the wake-up reconnects on fresh sockets.
            if tokio::time::timeout(
                std::time::Duration::from_secs(10),
                self.wait_for_work_done(include_smtp),
            )
            .await
            .is_err()
            {
                warn!(
                    self,
                    "background_fetch: work not done within 10s, restarting IO to drop a stale connection."
                );
                self.restart_io_if_running().await;
                self.wait_for_work_done(include_smtp).await;
            }
""",
    ),

    # ---- VENDORISSUES #13 (UnifiedPush diagnostics): push-token events ----
    # Originally f133237; silently dropped by the 2.63.0 re-vendor (2aac743).
    # app.js's Diagnostics chat matches these Info/Warning texts.
    dict(
        id="#13 register_token emits accepted/rejected events (imap.rs)",
        file="core/src/imap.rs",
        applied="push notifications registered — the relay will wake the app on new mail",
        anchor="""                "Transport {transport_id}: Failed to store device token: {err:#}."
            );
        }
""",
        where="replace",
        text="""                "Transport {transport_id}: Failed to store device token: {err:#}."
            );
            // Velta patch (#13, re-apply on core upgrades): surface the
            // per-relay push availability to the UI (the Diagnostics chat
            // shows Info/Warning events): a relay that rejects the token
            // means no push wake-ups for that account.
            context.emit_event(EventType::Warning(format!(
                "Transport {transport_id}: relay did not accept the push token ({err:#}) — no push notifications for this relay"
            )));
        } else {
            context.emit_event(EventType::Info(format!(
                "Transport {transport_id}: push notifications registered — the relay will wake the app on new mail"
            )));
        }
""",
    ),
]


# --------------------------------------------------------------------------
# engine
# --------------------------------------------------------------------------

def rel(p):
    """Op file path ("core/src/x.rs") -> path relative to the core tree."""
    assert p["file"].startswith("core/"), p["file"]
    return p["file"][len("core/"):]


def lint(patches):
    """Static checks on the op table; returns a list of problems."""
    problems, seen_ids, seen_markers = [], set(), {}
    for p in patches:
        for key in ("id", "file", "applied", "anchor", "text", "where"):
            if not p.get(key):
                problems.append(f"{p.get('id', '?')}: missing {key}")
        if p["id"] in seen_ids:
            problems.append(f"{p['id']}: duplicate id")
        seen_ids.add(p["id"])
        if p["where"] not in ("after", "before", "replace"):
            problems.append(f"{p['id']}: bad where={p['where']!r}")
        if p["applied"] not in p["text"]:
            problems.append(f"{p['id']}: marker does not occur in the op's own text")
        if p["applied"] in p["anchor"]:
            problems.append(f"{p['id']}: marker occurs in the upstream anchor (proves nothing)")
        key = (p["file"], p["applied"])
        if key in seen_markers:
            problems.append(f"{p['id']}: shares its marker with {seen_markers[key]}")
        seen_markers[key] = p["id"]
    return problems


def find_occ(text, anchor, occ):
    idx = -1
    for _ in range(occ):
        idx = text.find(anchor, idx + 1)
        if idx < 0:
            return -1
    return idx


def read(core, relpath):
    with io.open(os.path.join(core, relpath), encoding="utf-8", newline="") as f:
        return f.read()


def write(core, relpath, text):
    with io.open(os.path.join(core, relpath), "w", encoding="utf-8", newline="") as f:
        f.write(text)


def apply_ops(core, patches, out=print):
    """Inserts every op whose marker is missing. Returns (applied, conflicts)."""
    cache, applied, conflicts = {}, [], []
    for p in patches:
        f = rel(p)
        if f not in cache:
            if not os.path.exists(os.path.join(core, f)):
                conflicts.append(f"{p['id']} (file {p['file']} missing)")
                continue
            cache[f] = read(core, f)
        text = cache[f]
        if p["applied"] in text:
            continue
        idx = find_occ(text, p["anchor"], p.get("occ", 1))
        if idx < 0:
            conflicts.append(p["id"])
            continue
        if p["where"] == "replace":
            text = text[:idx] + p["text"] + text[idx + len(p["anchor"]):]
        else:
            at = idx if p["where"] == "before" else idx + len(p["anchor"])
            text = text[:at] + p["text"] + text[at:]
        if p["applied"] not in text:  # cannot happen after lint, but be strict
            conflicts.append(f"{p['id']} (marker absent after insertion)")
            continue
        cache[f] = text
        applied.append(p["id"])
        out(f"applied: {p['id']}")
    if not conflicts:
        for f, text in cache.items():
            write(core, f, text)
    return applied, conflicts


def verify_ops(core, patches):
    """Returns a list of (op id, reason) for every op whose marker is absent."""
    cache, failures = {}, []
    for p in patches:
        f = rel(p)
        if f not in cache:
            path = os.path.join(core, f)
            cache[f] = read(core, f) if os.path.exists(path) else None
        text = cache[f]
        if text is None:
            failures.append((p["id"], f"file {p['file']} missing"))
        elif p["applied"] not in text:
            has_anchor = find_occ(text, p["anchor"], p.get("occ", 1)) >= 0
            failures.append((p["id"], "marker missing (anchor present: run apply)" if has_anchor
                             else "marker missing AND anchor gone (upstream shape changed: port by hand)"))
    return failures


# --------------------------------------------------------------------------
# whole-tree check
# --------------------------------------------------------------------------

SKIP_DIRS = {".git", "target", "node_modules"}


def walk(top):
    # Follow directory symlinks: upstream ships e.g. python/tests/data/key ->
    # ../../../test-data/key, which a Windows checkout materialises as a real
    # directory; both then list the same files with the same bytes.
    out = set()
    for dirpath, dirnames, filenames in os.walk(top, followlinks=True):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith("target-")]
        for name in filenames:
            out.add(os.path.relpath(os.path.join(dirpath, name), top).replace(os.sep, "/"))
    return out


def git_ignored(core, paths):
    """Subset of `paths` (relative to core) that git ignores in core's repo."""
    if not paths:
        return set()
    try:
        r = subprocess.run(["git", "-C", core, "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            return set()
        r = subprocess.run(["git", "-C", core, "check-ignore", "--stdin", "-z"],
                           input="\0".join(sorted(paths)) + "\0", capture_output=True, text=True)
    except FileNotFoundError:
        return set()
    return {p for p in r.stdout.split("\0") if p}


def same_content(a, b, relpath):
    with open(a, "rb") as fa, open(b, "rb") as fb:
        da, db = fa.read(), fb.read()
    if da == db:
        return True
    # upstream core/.gitattributes: `* text=auto` (git normalises EOLs) except
    # `test-data/** text=false` (raw mail, CRLF is content). Tolerate EOL-only
    # differences only where git itself would normalise them.
    if relpath.startswith("test-data/"):
        return False
    return da.replace(b"\r\n", b"\n") == db.replace(b"\r\n", b"\n")


def tree_check(core, upstream, patches, out=print):
    """Pristine upstream + apply == vendored core? Returns list of problems."""
    problems = []
    with tempfile.TemporaryDirectory(prefix="velta-quilt-") as tmp:
        work = os.path.join(tmp, "core")
        shutil.copytree(upstream, work, symlinks=True,
                        ignore=shutil.ignore_patterns(".git"))
        _, conflicts = apply_ops(work, patches, out=lambda *_: None)
        for c in conflicts:
            problems.append(f"QUILT DOES NOT APPLY TO PRISTINE: {c}")
        if conflicts:
            return problems
        declared = {rel(p) for p in patches}
        up, ven = walk(work), walk(core)
        ignored = git_ignored(core, up | ven)
        for f in sorted((up | ven) - ignored):
            if f not in ven:
                problems.append(f"MISSING (in upstream, not vendored): {f}")
            elif f not in up:
                problems.append(f"EXTRA (vendored, not in upstream; make it a quilt op or remove): {f}")
            elif not same_content(os.path.join(work, f), os.path.join(core, f), f):
                if f in declared:
                    problems.append(f"DRIFT (pristine+quilt != vendored): {f}")
                else:
                    problems.append(f"UNDECLARED CHANGE (outside the quilt's files): {f}")
    return problems


def core_version(core):
    for line in read(core, "Cargo.toml").splitlines():
        if line.startswith("version"):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("cannot read version from core/Cargo.toml")


def fetch_upstream(version, dest):
    url = f"https://github.com/{UPSTREAM_REPO}/archive/refs/tags/v{version}.tar.gz"
    print(f"fetching {url}")
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        top = tar.getnames()[0].split("/")[0]
        kw = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
        tar.extractall(dest, **kw)
    return os.path.join(dest, top)


# --------------------------------------------------------------------------
# self-test
# --------------------------------------------------------------------------

def self_test():
    import unittest

    OPS = [
        dict(id="A", file="core/src/a.rs", applied="// velta A", anchor="fn a() {\n",
             where="after", text="    // velta A\n"),
        dict(id="B", file="core/src/b.rs", applied="// velta B", anchor="fn b() {}\n",
             where="replace", text="fn b() { /* velta B */ } // velta B\n"),
        dict(id="C", file="core/src/b.rs", applied="// velta C", anchor="fn c() {}\n",
             where="before", occ=2, text="// velta C\n"),
    ]
    PRISTINE = {
        "src/a.rs": "fn a() {\n}\n",
        "src/b.rs": "fn b() {}\nfn c() {}\nfn c() {}\n",
        "src/other.rs": "fn other() {}\n",
        "test-data/mail.eml": "Subject: x\r\n\r\nbody\r\n",
        "README.md": "readme\n",
    }

    def mk(root, files):
        for f, t in files.items():
            path = os.path.join(root, f)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(t)
        return root

    quiet = lambda *_: None

    class T(unittest.TestCase):
        def setUp(self):
            self.tmp = tempfile.mkdtemp(prefix="velta-quilt-test-")
            self.up = mk(os.path.join(self.tmp, "up"), PRISTINE)
            self.core = os.path.join(self.tmp, "core")
            shutil.copytree(self.up, self.core)

        def tearDown(self):
            shutil.rmtree(self.tmp)

        def edit(self, f, old, new):
            t = read(self.core, f)
            self.assertIn(old, t)
            write(self.core, f, t.replace(old, new, 1))

        def test_real_table_lints_clean(self):
            self.assertEqual(lint(PATCHES), [])

        def test_lint_catches_shared_or_foreign_markers(self):
            bad = [dict(OPS[0]), dict(OPS[0], id="A2"), dict(OPS[1], applied="not in text")]
            probs = "\n".join(lint(bad))
            self.assertIn("shares its marker", probs)
            self.assertIn("does not occur in the op's own text", probs)

        def test_apply_then_verify_and_idempotent(self):
            self.assertEqual(len(verify_ops(self.core, OPS)), 3)
            applied, conflicts = apply_ops(self.core, OPS, out=quiet)
            self.assertEqual((len(applied), conflicts), (3, []))
            self.assertEqual(verify_ops(self.core, OPS), [])
            b = read(self.core, "src/b.rs")
            self.assertEqual(b, "fn b() { /* velta B */ } // velta B\nfn c() {}\n// velta C\nfn c() {}\n")
            applied, conflicts = apply_ops(self.core, OPS, out=quiet)
            self.assertEqual((applied, conflicts), ([], []))
            self.assertEqual(read(self.core, "src/b.rs"), b)

        def test_verify_fails_when_marker_and_anchor_both_gone(self):
            # The old false green: marker AND anchor missing was skipped.
            apply_ops(self.core, OPS, out=quiet)
            self.edit("src/a.rs", "fn a() {\n    // velta A\n", "fn renamed() {\n")
            failures = verify_ops(self.core, OPS)
            self.assertEqual([f[0] for f in failures], ["A"])
            self.assertIn("anchor gone", failures[0][1])

        def test_apply_conflict_writes_nothing(self):
            self.edit("src/a.rs", "fn a() {\n", "fn z() {\n")
            applied, conflicts = apply_ops(self.core, OPS, out=quiet)
            self.assertEqual(conflicts, ["A"])
            self.assertEqual(read(self.core, "src/b.rs"), PRISTINE["src/b.rs"])

        def test_tree_check_clean(self):
            apply_ops(self.core, OPS, out=quiet)
            self.assertEqual(tree_check(self.core, self.up, OPS), [])

        def test_tree_check_undeclared_change(self):
            apply_ops(self.core, OPS, out=quiet)
            self.edit("src/other.rs", "other", "other2")
            probs = tree_check(self.core, self.up, OPS)
            self.assertEqual(probs, ["UNDECLARED CHANGE (outside the quilt's files): src/other.rs"])

        def test_tree_check_drift_in_declared_file(self):
            apply_ops(self.core, OPS, out=quiet)
            self.edit("src/a.rs", "}\n", "}\n// hand edit\n")
            probs = tree_check(self.core, self.up, OPS)
            self.assertEqual(probs, ["DRIFT (pristine+quilt != vendored): src/a.rs"])

        def test_tree_check_unapplied_quilt_is_drift(self):
            probs = tree_check(self.core, self.up, OPS)
            self.assertEqual(sorted(probs), ["DRIFT (pristine+quilt != vendored): src/a.rs",
                                             "DRIFT (pristine+quilt != vendored): src/b.rs"])

        def test_tree_check_extra_and_missing(self):
            apply_ops(self.core, OPS, out=quiet)
            mk(self.core, {"src/new.rs": "x\n"})
            os.remove(os.path.join(self.core, "README.md"))
            probs = sorted(tree_check(self.core, self.up, OPS))
            self.assertEqual(probs, [
                "EXTRA (vendored, not in upstream; make it a quilt op or remove): src/new.rs",
                "MISSING (in upstream, not vendored): README.md"])

        def test_tree_check_eol_rules(self):
            apply_ops(self.core, OPS, out=quiet)
            # CRLF->LF outside test-data/: git would normalise, tolerated.
            write(self.core, "README.md", "readme\r\n")
            self.assertEqual(tree_check(self.core, self.up, OPS), [])
            # Inside test-data/: bytes are content.
            write(self.core, "test-data/mail.eml", "Subject: x\n\nbody\n")
            self.assertEqual(tree_check(self.core, self.up, OPS),
                             ["UNDECLARED CHANGE (outside the quilt's files): test-data/mail.eml"])

        def test_tree_check_quilt_must_apply_to_pristine(self):
            write(self.up, "src/a.rs", "fn moved() {\n}\n")
            probs = tree_check(self.core, self.up, OPS)
            self.assertEqual(probs, ["QUILT DOES NOT APPLY TO PRISTINE: A"])

    suite = unittest.defaultTestLoader.loadTestsFromTestCase(T)
    res = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if res.wasSuccessful() else 1


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", nargs="?", default="apply",
                    choices=["apply", "verify", "tree-check", "self-test"])
    ap.add_argument("--core", default=DEFAULT_CORE)
    ap.add_argument("--upstream")
    ap.add_argument("--fetch", action="store_true")
    a = ap.parse_args(argv)
    core = os.path.abspath(a.core)

    if a.mode == "self-test":
        return self_test()

    problems = lint(PATCHES)
    if problems:
        for p in problems:
            print(f"QUILT TABLE ERROR: {p}")
        return 1

    if a.mode == "apply":
        applied, conflicts = apply_ops(core, PATCHES)
        if conflicts:
            print("\nUPSTREAM SHAPE CHANGED — nothing written; port by hand (see VENDORISSUES.MD):")
            for c in conflicts:
                print(f"  CONFLICT: {c}")
            return 1
        print(f"done — {len(applied)} applied, {len(PATCHES) - len(applied)} already present. "
              "Now: verify, tree-check, cargo check; commit together with the re-vendor")
        return 0

    if a.mode == "verify":
        failures = verify_ops(core, PATCHES)
        for op_id, why in failures:
            print(f"MISSING: {op_id}: {why}")
        print(f"{len(PATCHES) - len(failures)}/{len(PATCHES)} patch ops present")
        return 1 if failures else 0

    # tree-check
    if not a.upstream and not a.fetch:
        print("tree-check needs --upstream DIR or --fetch")
        return 2
    with tempfile.TemporaryDirectory(prefix="velta-upstream-") as tmp:
        upstream = a.upstream or fetch_upstream(core_version(core), tmp)
        problems = tree_check(core, os.path.abspath(upstream), PATCHES)
    for p in problems:
        print(p)
    if problems:
        print(f"tree-check FAILED: {len(problems)} problem(s). Every core change must be a quilt op.")
        return 1
    print(f"tree-check OK: vendored core == upstream v{core_version(core)} + {len(PATCHES)} quilt ops "
          f"({len({p['file'] for p in PATCHES})} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
