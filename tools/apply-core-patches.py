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
        # Upstream 2.64.0 (smtp::Connection refactor) drops the whole
        # Connection in disconnect(); this op only clears the shared handle
        # (anchored on the end of disconnect()).
        id="#10 disconnect clears the handle (smtp.rs)",
        file="core/src/smtp.rs",
        applied=".store(0, std::sync::atomic::Ordering::SeqCst);",
        anchor="    }\n\n    /// Return true if smtp was connected but is not known",
        where="before",
        text="""        self.sending_transport
            .store(0, std::sync::atomic::Ordering::SeqCst);
""",
    ),
    dict(
        id="#10 connect success sets the handle (smtp.rs)",
        file="core/src/smtp.rs",
        applied=".store(transport_id, std::sync::atomic::Ordering::SeqCst);",
        # 2.64.0: upstream's success arm is `Ok(()) => return Ok(()),`
        # (transport_id now lives in smtp::Connection).
        anchor="                Ok(()) => return Ok(()),\n",
        where="replace",
        text="""                Ok(()) => {
                    self.sending_transport
                        .store(transport_id, std::sync::atomic::Ordering::SeqCst);
                    return Ok(());
                }
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
    assert!(smtp.connection.is_none());
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

/// Velta patch (#11, core 2.64+): the server rejected a send on this
/// transport. Upstream records an `smtp_failure` row and disconnects so the
/// next connect falls back to another transport; back the pin off for
/// VELTA_PIN_BACKOFF too, so the pin does not override that fallback. The
/// pin is retried once the backoff expires or after it connects again.
fn velta_note_send_failure(
    failed: &mut std::collections::BTreeMap<u32, tools::Time>,
    transport_id: u32,
) {
    let now = tools::Time::now();
    failed.insert(transport_id, now);
}

/// Velta patch (#11, core 2.64+): the in-memory backoff is lost on restart,
/// but upstream's `smtp_failure` row survives until the transport sends
/// successfully again. If the pin has an active failure row and no backoff
/// entry yet, start the backoff now instead of letting the pin win.
async fn velta_seed_send_failure(
    context: &Context,
    pin: Option<u32>,
    failed: &mut std::collections::BTreeMap<u32, tools::Time>,
) -> Result<()> {
    let Some(pin) = pin else { return Ok(()) };
    if failed.contains_key(&pin) {
        return Ok(());
    }
    if context
        .sql
        .exists(
            "SELECT COUNT(*) FROM smtp_failure WHERE transport_id=?",
            (pin,),
        )
        .await?
    {
        failed.insert(pin, tools::Time::now());
    }
    Ok(())
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
        velta_seed_send_failure(context, velta_pin, &mut self.velta_connect_failed).await?;
        let bound = self.connection.as_ref().map(|c| c.transport_id);
        if let (Some(pin), Some(bound)) = (velta_pin, bound)
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
        anchor="                        .store(transport_id, std::sync::atomic::Ordering::SeqCst);\n",
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

// Velta patch (#11, core 2.64+): when the pinned transport rejects a send,
// upstream's smtp_failure fallback wins; the pin is retried after the
// backoff expires, and a successful send clears the failure for good.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_velta_pin_yields_to_send_failure() -> Result<()> {
    let mut tcm = TestContextManager::new();
    let t = &tcm.unconfigured().await;

    transport::add_pseudo_transport(t, "foo@example.net").await?;
    transport::add_pseudo_transport(t, "bar@example.net").await?;
    transport::add_pseudo_transport(t, "baz@example.net").await?;
    let transports = super::upstream_sorted_transports(t).await?;
    let [(id_foo, _), (id_bar, _), (id_baz, _)] = transports[..] else {
        panic!("Unexpected number of transports");
    };
    super::record_success(t, id_baz).await?;
    t.set_ui_config(super::VELTA_SEND_TRANSPORT_KEY, Some("bar@example.net"))
        .await?;
    let pin = super::velta_pinned_transport(t).await?;
    assert_eq!(pin, Some(id_bar));
    let order = |upstream: Vec<(u32, crate::transport::ConfiguredLoginParam)>,
                 failed: &std::collections::BTreeMap<u32, crate::tools::Time>| {
        let mut v = upstream;
        super::velta_pin_first(&mut v, pin, failed);
        v.into_iter().map(|(id, _)| id).collect::<Vec<_>>()
    };

    // Pin rejected a send: upstream records the failure, the send path
    // backs the pin off -> fallback (most recently successful) goes first.
    super::record_failure(t, id_bar).await?;
    let mut failed = std::collections::BTreeMap::new();
    super::velta_note_send_failure(&mut failed, id_bar);
    assert_eq!(
        order(super::upstream_sorted_transports(t).await?, &failed),
        [id_baz, id_bar, id_foo]
    );

    // After a restart the backoff map is empty, but the smtp_failure row is
    // still active: the pin must not override it.
    let mut fresh = std::collections::BTreeMap::new();
    assert_eq!(
        order(super::upstream_sorted_transports(t).await?, &fresh),
        [id_bar, id_baz, id_foo],
        "without seeding the pin would win"
    );
    super::velta_seed_send_failure(t, pin, &mut fresh).await?;
    assert!(super::velta_pin_backed_off(&fresh, id_bar));
    assert_eq!(
        order(super::upstream_sorted_transports(t).await?, &fresh),
        [id_baz, id_bar, id_foo]
    );

    // Backoff expired: the pin is retried first again.
    let long_ago =
        crate::tools::Time::now() - super::VELTA_PIN_BACKOFF - std::time::Duration::from_secs(1);
    failed.insert(id_bar, long_ago);
    assert_eq!(
        order(super::upstream_sorted_transports(t).await?, &failed),
        [id_bar, id_baz, id_foo]
    );

    // A successful send on the pin clears the failure row: nothing to seed.
    super::record_success(t, id_bar).await?;
    let mut after = std::collections::BTreeMap::new();
    super::velta_seed_send_failure(t, pin, &mut after).await?;
    assert!(after.is_empty());
    assert_eq!(
        order(super::upstream_sorted_transports(t).await?, &after),
        [id_bar, id_baz, id_foo]
    );
    Ok(())
}
""",
    ),

    dict(
        id="#11 send rejection backs the pin off (smtp.rs)",
        file="core/src/smtp.rs",
        applied="velta_note_send_failure(&mut smtp.velta_connect_failed, transport_id);",
        anchor="""            let res = match err {
                async_smtp::error::Error::Permanent(ref response) => {
""",
        where="before",
        text="""            // Velta patch (#11): upstream just recorded an smtp_failure and
            // will fall back to another transport; do not let the pin
            // override that until its backoff expires.
            if matches!(
                err,
                async_smtp::error::Error::Permanent(_) | async_smtp::error::Error::Transient(_)
            ) {
                velta_note_send_failure(&mut smtp.velta_connect_failed, transport_id);
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
                // Velta #165: run the restart in its own task. The caller
                // (Accounts::background_fetch) wraps this in a timeout, and a
                // restart dropped between stop and start left IO stopped
                // until the user restarted core by hand; maybe_network is
                // a no-op on a stopped scheduler.
                let ctx = self.clone();
                tokio::spawn(async move { ctx.restart_io_if_running().await })
                    .await
                    .ok();
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
            // Velta #110: name the relay (addr) so the Relays modal can mark
            // it "(U)" — list_transports carries no transport ids.
            let addr = velta_transport_addr(context, transport_id).await;
            context.emit_event(EventType::Warning(format!(
                "Transport {transport_id} ({addr}): relay did not accept the push token ({err:#}) — no push notifications for this relay"
            )));
        } else {
            let addr = velta_transport_addr(context, transport_id).await;
            context.emit_event(EventType::Info(format!(
                "Transport {transport_id} ({addr}): push notifications registered — the relay will wake the app on new mail"
            )));
        }
""",
    ),

    # ---- VENDORISSUES #13 / #110: transport id -> addr for the push events ----
    dict(
        id="#13 velta_transport_addr helper (imap.rs)",
        file="core/src/imap.rs",
        applied="async fn velta_transport_addr(",
        anchor="impl Session {\n    /// Returns success if we successfully set the flag",
        where="before",
        text="""/// Velta patch (#13/#110): the relay address of a transport id, for the
/// push-registration events (empty when unknown).
async fn velta_transport_addr(context: &Context, transport_id: u32) -> String {
    context
        .sql
        .query_get_value::<String>("SELECT addr FROM transports WHERE id=?", (transport_id,))
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

""",
    ),
    # ---- VENDORISSUES #14: reply-thread queries (chat view N-replies chip
    # ---- + thread overlay). SQL lives in chat.rs; api.rs wraps it.
    dict(
        id="#14 reply-thread queries (chat.rs)",
        file="core/src/chat.rs",
        applied="Velta #14 reply-thread queries",
        # Anchored on the doc comment so `/// Returns true if device
        # message…` stays attached to was_device_msg_ever_added.
        anchor="/// Returns true if device message with a given label was ever added to the device chat.\n",
        where="before",
        text="""// Velta #14 reply-thread queries: the chat view's "N replies" chip and
// thread overlay. Replies are messages whose mime_in_reply_to carries the
// quoted message's rfc724_mid (set by Message::set_quote). Every message
// carries In-Reply-To (the chat's latest message), so only rows with a quote
// param (`q`) that are not forwards (`a`) count; incoming headers keep their
// <angle brackets>, hence the TRIM. Hidden rows (send_edit_request's own
// copy quotes the original) are not replies. Scoped to the chat on both sides so
// cross-chat Message-ID collisions cannot bleed in.
/// Returns the ids of the messages in `chat_id` that quote `message_id`
/// (its replies), oldest first. Forwards are not counted as replies.
pub async fn get_reply_ids(
    context: &Context,
    chat_id: ChatId,
    message_id: MsgId,
) -> Result<Vec<MsgId>> {
    let Some(rfc724_mid) = context
        .sql
        .query_get_value::<String>("SELECT rfc724_mid FROM msgs WHERE id=?", (message_id,))
        .await?
    else {
        return Ok(Vec::new());
    };
    context
        .sql
        .query_map_vec(
            "SELECT id FROM msgs replies \\
             WHERE chat_id=? AND TRIM(mime_in_reply_to, '<> ')=? AND (char(10) || replies.param) LIKE '%' || char(10) || 'q=%' \\
             AND (char(10) || replies.param) NOT LIKE '%' || char(10) || 'a=%' AND replies.hidden=0 \\
             ORDER BY timestamp, id",
            (chat_id, rfc724_mid),
            |row| {
                let id: MsgId = row.get(0)?;
                Ok(id)
            },
        )
        .await
}

/// Returns `(quoted message id, reply count)` for every message in `chat_id`
/// that has at least one reply (a quoting, non-forwarded message in the same chat).
pub async fn get_reply_counts(context: &Context, chat_id: ChatId) -> Result<Vec<(MsgId, u32)>> {
    context
        .sql
        .query_map_vec(
            "SELECT quoted.id, COUNT(replies.id) \\
             FROM msgs replies \\
             JOIN msgs quoted ON quoted.rfc724_mid = TRIM(replies.mime_in_reply_to, '<> ') \\
             WHERE replies.chat_id=? AND quoted.chat_id=? AND (char(10) || replies.param) LIKE '%' || char(10) || 'q=%' \\
             AND (char(10) || replies.param) NOT LIKE '%' || char(10) || 'a=%' AND replies.hidden=0 \\
             AND replies.mime_in_reply_to IS NOT NULL AND replies.mime_in_reply_to != '' \\
             GROUP BY quoted.id",
            (chat_id, chat_id),
            |row| {
                let id: MsgId = row.get(0)?;
                let n: u32 = row.get(1)?;
                Ok((id, n))
            },
        )
        .await
}

""",
    ),
    dict(
        id="#14 reply-thread queries (api.rs)",
        file="core/deltachat-jsonrpc/src/api.rs",
        applied="Velta #14 reply-thread queries (see chat.rs get_reply_ids)",
        anchor="    async fn get_message_html(&self, account_id: u32, message_id: u32) -> Result<Option<String>> {\n",
        where="before",
        text="""    // Velta #14 reply-thread queries (see chat.rs get_reply_ids).
    async fn get_reply_ids(
        &self,
        account_id: u32,
        chat_id: u32,
        message_id: u32,
    ) -> Result<Vec<u32>> {
        let ctx = self.get_context(account_id).await?;
        let ids =
            deltachat::chat::get_reply_ids(&ctx, ChatId::new(chat_id), MsgId::new(message_id))
                .await?;
        Ok(ids.iter().map(|id| id.to_u32()).collect())
    }

    // Velta #14 reply-thread queries: quoted msg id -> reply count.
    async fn get_reply_counts(
        &self,
        account_id: u32,
        chat_id: u32,
    ) -> Result<std::collections::HashMap<u32, u32>> {
        let ctx = self.get_context(account_id).await?;
        let pairs = deltachat::chat::get_reply_counts(&ctx, ChatId::new(chat_id)).await?;
        let mut out = std::collections::HashMap::new();
        for (id, n) in pairs {
            out.insert(id.to_u32(), n);
        }
        Ok(out)
    }

""",
    ),
    # ---- VENDORISSUES #15: per-transport relay capabilities for the UI ----
    # The scheduler already fetches per-transport IMAP METADATA
    # (/shared/vendor/deltachat/turn + /appversions): TURN credentials for
    # calls, the relay's iroh relay URL, supports_push, app_versions.
    # Nothing exposed it — clients cannot show which relay does calls /
    # push / iroh / web (cmcall detects the same TURN signal behaviorally).
    # Exposes it keyed by the transport's email address (the key JS already
    # holds from list_transports).
    dict(
        id="#15 BTreeMap import (transport.rs)",
        file="core/src/transport.rs",
        applied="use std::collections::BTreeMap;",
        anchor="use std::fmt;\n",
        where="before",
        text="""use std::collections::BTreeMap;
""",
    ),
    dict(
        id="#15 UnresolvedIceServer import (transport.rs)",
        file="core/src/transport.rs",
        applied="use crate::calls::UnresolvedIceServer;",
        anchor="use crate::config::Config;\n",
        where="before",
        text="""use crate::calls::UnresolvedIceServer;
""",
    ),
    dict(
        id="#15 TransportServerMetadata + Context::get_server_metadata (transport.rs)",
        file="core/src/transport.rs",
        applied="pub struct TransportServerMetadata {",
        anchor=(
            "pub(crate) async fn purge_transport_caches(context: &Context, transport_id: u32) {\n"
            "    context.quota.write().await.remove(&transport_id);\n"
            "    context.metadata.write().await.remove(&transport_id);\n"
            "}\n"
        ),
        where="after",
        text="""
/// Relay capabilities of one transport, as advertised over IMAP METADATA
/// (Velta #15).
#[derive(Debug, Serialize)]
pub struct TransportServerMetadata {
    /// iroh relay URL advertised by the relay, if any.
    pub iroh_relay: Option<String>,

    /// True if the relay accepts push device tokens.
    pub supports_push: bool,

    /// True if the relay handed out TURN credentials for calls.
    pub has_turn: bool,

    /// Relay app versions, raw JSON string, if advertised.
    pub app_versions: Option<String>,

    /// IMAP METADATA `/shared/comment`.
    pub comment: Option<String>,

    /// IMAP METADATA `/shared/admin`.
    pub admin: Option<String>,
}

impl Context {
    /// Returns relay capabilities per transport, keyed by the transport's
    /// email address. Transports the scheduler has not connected to yet are
    /// absent from the map. Velta #15.
    pub async fn get_server_metadata(&self) -> Result<BTreeMap<String, TransportServerMetadata>> {
        let rows: Vec<(u32, String)> = self
            .sql
            .query_map_vec("SELECT id, addr FROM transports", (), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .await?;
        let metadata = self.metadata.read().await;
        let mut out = BTreeMap::new();
        for (id, addr) in rows {
            let Some(m) = metadata.get(&id) else {
                continue;
            };
            out.insert(
                addr,
                TransportServerMetadata {
                    iroh_relay: m.iroh_relay.as_ref().map(|url| url.to_string()),
                    supports_push: m.supports_push,
                    has_turn: m
                        .ice_servers
                        .iter()
                        .any(|s| matches!(s, UnresolvedIceServer::Turn { .. })),
                    app_versions: m.app_versions.clone(),
                    comment: m.comment.clone(),
                    admin: m.admin.clone(),
                },
            );
        }
        Ok(out)
    }
}
""",
    ),
    dict(
        id="#15 JsonrpcTransportServerMetadata import (api.rs)",
        file="core/deltachat-jsonrpc/src/api.rs",
        applied="use types::login_param::JsonrpcTransportServerMetadata;",
        anchor="use types::login_param::EnteredLoginParam;\n",
        where="after",
        text="""use types::login_param::JsonrpcTransportServerMetadata;
""",
    ),
    dict(
        id="#15 get_server_metadata (api.rs)",
        file="core/deltachat-jsonrpc/src/api.rs",
        applied="async fn get_server_metadata(",
        anchor=(
            "    async fn list_transports(&self, account_id: u32) -> Result<Vec<EnteredLoginParam>> {\n"
            "        let ctx = self.get_context(account_id).await?;\n"
            "        let res = ctx\n"
            "            .list_transports()\n"
            "            .await?\n"
            "            .into_iter()\n"
            "            .map(|t| t.into())\n"
            "            .collect();\n"
            "        Ok(res)\n"
            "    }\n"
        ),
        where="after",
        text="""
    /// Returns relay capabilities per transport address, as advertised by the
    /// relays over IMAP METADATA: the iroh relay URL, whether push device
    /// tokens are accepted, whether TURN credentials for calls were handed
    /// out, and the relay's app versions. Transports the scheduler has not
    /// connected to yet are absent. Velta #15.
    async fn get_server_metadata(
        &self,
        account_id: u32,
    ) -> Result<BTreeMap<String, JsonrpcTransportServerMetadata>> {
        let ctx = self.get_context(account_id).await?;
        let meta = ctx.get_server_metadata().await?;
        Ok(meta
            .into_iter()
            .map(|(addr, m)| {
                (
                    addr,
                    JsonrpcTransportServerMetadata {
                        iroh_relay: m.iroh_relay,
                        supports_push: m.supports_push,
                        has_turn: m.has_turn,
                        app_versions: m.app_versions,
                        comment: m.comment,
                        admin: m.admin,
                    },
                )
            })
            .collect())
    }
""",
    ),
    dict(
        id="#15 JsonrpcTransportServerMetadata (types/login_param.rs)",
        file="core/deltachat-jsonrpc/src/api/types/login_param.rs",
        applied="pub struct JsonrpcTransportServerMetadata {",
        anchor=(
            "impl<T> IntoOption<T> for T\n"
            "where\n"
            "    T: Default + std::cmp::PartialEq,\n"
            "{\n"
            "    fn into_option(self) -> Option<T> {\n"
            "        if self == T::default() {\n"
            "            None\n"
            "        } else {\n"
            "            Some(self)\n"
            "        }\n"
            "    }\n"
            "}\n"
        ),
        where="after",
        text="""
/// Relay capabilities of one transport, as advertised over IMAP METADATA.
#[derive(Serialize, Deserialize, TypeDef, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JsonrpcTransportServerMetadata {
    /// iroh relay URL advertised by the relay, if any.
    pub iroh_relay: Option<String>,

    /// True if the relay accepts push device tokens.
    pub supports_push: bool,

    /// True if the relay handed out TURN credentials for calls.
    pub has_turn: bool,

    /// Relay app versions, raw JSON string, if advertised.
    pub app_versions: Option<String>,

    /// IMAP METADATA `/shared/comment`.
    pub comment: Option<String>,

    /// IMAP METADATA `/shared/admin`.
    pub admin: Option<String>,
}
""",
    ),
    # ---- VENDORISSUES #16: IDLE / COMPRESS / recipient limit per relay ----
    # Extends #15 (must stay after its ops: the transport/api/login_param
    # anchors are #15's own inserted text). The IMAP capabilities are only
    # known per session, so update_metadata (runs after every IMAP connect)
    # records them into ServerMetadata; None until the first connection.
    # max_smtp_rcpt_to was already parsed by upstream, just never exposed.
    dict(
        id="#16 ServerMetadata IMAP capability fields (imap.rs)",
        file="core/src/imap.rs",
        applied="pub velta_can_idle: Option<bool>,",
        anchor="    /// Consumed by get_app_versions().\n    pub app_versions: Option<String>,\n",
        where="after",
        text="""
    /// Velta #16: IMAP IDLE capability seen on the last connection;
    /// None until the transport has connected.
    pub velta_can_idle: Option<bool>,

    /// Velta #16: IMAP COMPRESS=DEFLATE capability seen on the last
    /// connection; None until the transport has connected.
    pub velta_can_compress: Option<bool>,
""",
    ),
    dict(
        id="#16 update_metadata reads the session capabilities (imap.rs)",
        file="core/src/imap.rs",
        applied="let velta_caps = (",
        anchor="        let mut lock = context.metadata.write().await;\n        let transport_id = self.transport_id();\n",
        where="after",
        text="""        // Velta #16: capabilities of this session, recorded below.
        let velta_caps = (
            Some(self.capabilities.can_idle),
            Some(self.capabilities.can_compress),
        );
""",
    ),
    dict(
        id="#16 update_metadata refreshes known entries (imap.rs)",
        file="core/src/imap.rs",
        applied="(old_metadata.velta_can_idle, old_metadata.velta_can_compress) = velta_caps;",
        anchor="        if let Some(old_metadata) = lock.get_mut(&transport_id) {\n",
        where="after",
        text="""            (old_metadata.velta_can_idle, old_metadata.velta_can_compress) = velta_caps;
""",
    ),
    dict(
        id="#16 update_metadata fills new entries (imap.rs)",
        file="core/src/imap.rs",
        applied="velta_can_idle: velta_caps.0,",
        anchor="                ice_servers_expiration_timestamp,\n                app_versions,\n            },\n",
        where="replace",
        text="""                ice_servers_expiration_timestamp,
                app_versions,
                velta_can_idle: velta_caps.0,
                velta_can_compress: velta_caps.1,
            },
""",
    ),
    dict(
        id="#16 TransportServerMetadata fields (transport.rs)",
        file="core/src/transport.rs",
        applied="pub can_idle: Option<bool>,",
        anchor="    /// IMAP METADATA `/shared/admin`.\n    pub admin: Option<String>,\n",
        where="after",
        text="""
    /// IMAP IDLE (instant delivery) support; None until connected (Velta #16).
    pub can_idle: Option<bool>,

    /// IMAP COMPRESS=DEFLATE support; None until connected (Velta #16).
    pub can_compress: Option<bool>,

    /// `/shared/vendor/deltachat/maxsmtprecipients`, if advertised (Velta #16).
    pub max_smtp_rcpt_to: Option<u32>,
""",
    ),
    dict(
        id="#16 get_server_metadata fills the fields (transport.rs)",
        file="core/src/transport.rs",
        applied="can_idle: m.velta_can_idle,",
        anchor="                    admin: m.admin.clone(),\n",
        where="after",
        text="""                    can_idle: m.velta_can_idle,
                    can_compress: m.velta_can_compress,
                    max_smtp_rcpt_to: m.max_smtp_rcpt_to,
""",
    ),
    dict(
        id="#16 get_server_metadata maps the fields (api.rs)",
        file="core/deltachat-jsonrpc/src/api.rs",
        applied="can_idle: m.can_idle,",
        anchor="                        admin: m.admin,\n",
        where="after",
        text="""                        can_idle: m.can_idle,
                        can_compress: m.can_compress,
                        max_smtp_rcpt_to: m.max_smtp_rcpt_to,
""",
    ),
    dict(
        id="#16 JsonrpcTransportServerMetadata fields (types/login_param.rs)",
        file="core/deltachat-jsonrpc/src/api/types/login_param.rs",
        applied="pub can_idle: Option<bool>,",
        anchor="    /// IMAP METADATA `/shared/admin`.\n    pub admin: Option<String>,\n",
        where="after",
        text="""
    /// IMAP IDLE (instant delivery) support; null until connected.
    pub can_idle: Option<bool>,

    /// IMAP COMPRESS=DEFLATE support; null until connected.
    pub can_compress: Option<bool>,

    /// Max recipients per SMTP message (`maxsmtprecipients`), if advertised.
    pub max_smtp_rcpt_to: Option<u32>,
""",
    ),
    dict(
        id="#17 maybe_network releases the account lock (api.rs)",
        file="core/deltachat-jsonrpc/src/api.rs",
        applied="Velta #17: do not hold the account manager lock",
        anchor=(
            "    async fn maybe_network(&self) -> Result<()> {\n"
            "        self.accounts.read().await.maybe_network().await;\n"
            "        Ok(())\n"
            "    }\n"
        ),
        where="replace",
        text="""    async fn maybe_network(&self) -> Result<()> {
        // Velta #17: do not hold the account manager lock while interrupting.
        // The interrupts wait on each scheduler's lock, which an IO restart
        // holds while tasks stuck on a dead proxy wind down (up to 30 s per
        // task); a start_io/stop_io writer queued meanwhile then blocked
        // every other RPC (get_chat, get_messages: chat switching hung).
        let contexts: Vec<_> = {
            let accounts = self.accounts.read().await;
            accounts
                .get_all()
                .into_iter()
                .filter_map(|id| accounts.get_account(id))
                .collect()
        };
        for ctx in contexts {
            ctx.maybe_network().await;
        }
        Ok(())
    }
""",
    ),
    # ---- VENDORISSUES #18 (#176): scheduler interrupts skip a held lock ----
    # An IO stop/restart holds the scheduler write lock while tasks wind
    # down (30 s each); send_msg and markseen_msgs queued behind it and the
    # UI froze (rpc timeout: send_msg, chats would not open). A starting
    # scheduler fetches and sends anyway; a stopping one ignores the signal.
    dict(
        id="#18 interrupt_inbox does not wait behind an IO restart (scheduler.rs)",
        file="core/src/scheduler.rs",
        applied="Velta #18 (interrupt_inbox): never wait behind an IO start/stop",
        anchor='    pub(crate) async fn interrupt_inbox(&self) {\n        let inner = self.inner.read().await;\n        if let InnerSchedulerState::Started(ref scheduler) = *inner {\n            scheduler.interrupt_inbox();\n        }\n    }\n',
        where="replace",
        text='    pub(crate) async fn interrupt_inbox(&self) {\n        // Velta #18 (interrupt_inbox): never wait behind an IO start/stop (#176).\n        let Ok(inner) = self.inner.try_read() else {\n            return;\n        };\n        if let InnerSchedulerState::Started(ref scheduler) = *inner {\n            scheduler.interrupt_inbox();\n        }\n    }\n',
    ),
    dict(
        id="#18 interrupt_smtp does not wait behind an IO restart (scheduler.rs)",
        file="core/src/scheduler.rs",
        applied="Velta #18 (interrupt_smtp): never wait behind an IO start/stop",
        anchor='    pub(crate) async fn interrupt_smtp(&self) {\n        let inner = self.inner.read().await;\n        if let InnerSchedulerState::Started(ref scheduler) = *inner {\n            scheduler.interrupt_smtp();\n        }\n    }\n',
        where="replace",
        text='    pub(crate) async fn interrupt_smtp(&self) {\n        // Velta #18 (interrupt_smtp): never wait behind an IO start/stop (#176).\n        let Ok(inner) = self.inner.try_read() else {\n            return;\n        };\n        if let InnerSchedulerState::Started(ref scheduler) = *inner {\n            scheduler.interrupt_smtp();\n        }\n    }\n',
    ),
    dict(
        id="#18 interrupt_ephemeral_task does not wait behind an IO restart (scheduler.rs)",
        file="core/src/scheduler.rs",
        applied="Velta #18 (interrupt_ephemeral_task): never wait behind an IO start/stop",
        anchor='    pub(crate) async fn interrupt_ephemeral_task(&self) {\n        let inner = self.inner.read().await;\n        if let InnerSchedulerState::Started(ref scheduler) = *inner {\n            scheduler.interrupt_ephemeral_task();\n        }\n    }\n',
        where="replace",
        text='    pub(crate) async fn interrupt_ephemeral_task(&self) {\n        // Velta #18 (interrupt_ephemeral_task): never wait behind an IO start/stop (#176).\n        let Ok(inner) = self.inner.try_read() else {\n            return;\n        };\n        if let InnerSchedulerState::Started(ref scheduler) = *inner {\n            scheduler.interrupt_ephemeral_task();\n        }\n    }\n',
    ),
    dict(
        id="#18 interrupt_location does not wait behind an IO restart (scheduler.rs)",
        file="core/src/scheduler.rs",
        applied="Velta #18 (interrupt_location): never wait behind an IO start/stop",
        anchor='    pub(crate) async fn interrupt_location(&self) {\n        let inner = self.inner.read().await;\n        if let InnerSchedulerState::Started(ref scheduler) = *inner {\n            scheduler.interrupt_location();\n        }\n    }\n',
        where="replace",
        text='    pub(crate) async fn interrupt_location(&self) {\n        // Velta #18 (interrupt_location): never wait behind an IO start/stop (#176).\n        let Ok(inner) = self.inner.try_read() else {\n            return;\n        };\n        if let InnerSchedulerState::Started(ref scheduler) = *inner {\n            scheduler.interrupt_location();\n        }\n    }\n',
    ),
    dict(
        id="#18 interrupt_recently_seen does not wait behind an IO restart (scheduler.rs)",
        file="core/src/scheduler.rs",
        applied="Velta #18 (interrupt_recently_seen): never wait behind an IO start/stop",
        anchor='    pub(crate) async fn interrupt_recently_seen(&self, contact_id: ContactId, timestamp: i64) {\n        let inner = self.inner.read().await;\n        if let InnerSchedulerState::Started(ref scheduler) = *inner {\n            scheduler.interrupt_recently_seen(contact_id, timestamp);\n        }\n    }\n',
        where="replace",
        text='    pub(crate) async fn interrupt_recently_seen(&self, contact_id: ContactId, timestamp: i64) {\n        // Velta #18 (interrupt_recently_seen): never wait behind an IO start/stop (#176).\n        let Ok(inner) = self.inner.try_read() else {\n            return;\n        };\n        if let InnerSchedulerState::Started(ref scheduler) = *inner {\n            scheduler.interrupt_recently_seen(contact_id, timestamp);\n        }\n    }\n',
    ),
    # ---- VENDORISSUES #19 (#177): admin groups (port of ArcaneChat/core c9b9666,
    # a2683e9, 9aa16dc). Group ID `ADMINFINGERPRINT:randomid`; every receiver
    # enforces admin-only add/remove-others/name/description/avatar/timer/pins/
    # delete-for-everyone. Deviations from ArcaneChat: validate_group_id needs a
    # 40/64-hex fingerprint; admin delete only for messages of that same admin
    # group (ArcaneChat let anyone delete anything in regular groups); no
    # broadcast secret on creation. docs/core-patches/admin-groups-plan.md.
    dict(
        id="#19 admin groups 1 (chat.rs)",
        file="core/src/chat.rs",
        applied="/// Separator between the admin's fingerprint and the random group ID in admin groups.",
        anchor="\npub(crate) const PARAM_BROADCAST_SECRET: Param = Param::Arg3;\n\n/// An chat item, such as a message or a marker.\n",
        where="replace",
        text="\npub(crate) const PARAM_BROADCAST_SECRET: Param = Param::Arg3;\n\n/// Separator between the admin's fingerprint and the random group ID in admin groups.\n///\n/// Must not be a URL-safe base64 character (`A-Za-z0-9-_`)\npub(crate) const ADMIN_GROUP_ID_SEPARATOR: char = ':';\n\n/// Returns the admin fingerprint if this is an admin group.\npub(crate) fn admin_group_fingerprint(grpid: &str) -> Option<&str> {\n    grpid\n        .split_once(ADMIN_GROUP_ID_SEPARATOR)\n        .map(|(fpr, _)| fpr)\n}\n\n/// Returns the base group ID (the random part after the fingerprint), for use in QR codes.\n///\n/// For regular groups, returns the full grpid unchanged.\npub(crate) fn admin_group_base_id(grpid: &str) -> &str {\n    grpid\n        .split_once(ADMIN_GROUP_ID_SEPARATOR)\n        .map(|(_, id)| id)\n        .unwrap_or(grpid)\n}\n\n/// An chat item, such as a message or a marker.\n",
    ),
    dict(
        id="#19 admin groups 2 (chat.rs)",
        file="core/src/chat.rs",
        applied="pub async fn get_admin_contact_id(context: &Context, grpid: &str) -> Result<Option<ContactId>> {",
        anchor="}\n\n/// Creates an unencrypted group chat.\npub async fn create_group_unencrypted(context: &Context, name: &str) -> Result<ChatId> {\n",
        where="replace",
        text="}\n\n/// Creates an encrypted group chat with an admin.\n///\n/// The group ID is composed of the creator's fingerprint and a random ID separated by\n/// [`ADMIN_GROUP_ID_SEPARATOR`].\n/// Only the admin (creator) can add/remove members or change the group name, description,\n/// or avatar. Other members can send messages and leave the group.\npub async fn create_group_with_admin(context: &Context, name: &str) -> Result<ChatId> {\n    let fingerprint = self_fingerprint(context).await?;\n    let base_grpid = create_id();\n    let grpid = format!(\"{fingerprint}{ADMIN_GROUP_ID_SEPARATOR}{base_grpid}\");\n    create_group_ext(context, Sync, grpid, name).await\n}\n\n/// Returns the contact ID of the group admin for an admin group, or `None` for regular groups.\n///\n/// For admin groups (where `grpid` is `FINGERPRINT.GRPID`), this looks up the contact\n/// whose key fingerprint matches the fingerprint in the group ID.\n/// Returns [`ContactId::SELF`] if the admin is the current user.\npub async fn get_admin_contact_id(context: &Context, grpid: &str) -> Result<Option<ContactId>> {\n    let Some(admin_fpr) = admin_group_fingerprint(grpid) else {\n        return Ok(None);\n    };\n\n    // Check self first (cheaper and handles the case where the contact is not yet in the DB).\n    use crate::key::self_fingerprint_opt;\n    if let Some(self_fpr) = self_fingerprint_opt(context).await?\n        && self_fpr == admin_fpr\n    {\n        return Ok(Some(ContactId::SELF));\n    }\n\n    // `admin_group_fingerprint` guarantees admin_fpr is non-empty.\n    let contact_id = context\n        .sql\n        .query_row_optional(\n            \"SELECT id FROM contacts WHERE fingerprint=?\",\n            (admin_fpr,),\n            |row| row.get::<_, ContactId>(0),\n        )\n        .await?;\n    Ok(contact_id)\n}\n\n/// Creates an unencrypted group chat.\npub async fn create_group_unencrypted(context: &Context, name: &str) -> Result<ChatId> {\n",
    ),
    dict(
        id="#19 admin groups 3 (chat.rs)",
        file="core/src/chat.rs",
        applied="\"Only the group admin can add other members to this group\"",
        anchor="        return Ok(false);\n    }\n    if from_handshake && chat.param.get_int(Param::Unpromoted).unwrap_or_default() == 1 {\n        let now = time();\n",
        where="replace",
        text="        return Ok(false);\n    }\n\n    if let Some(admin_fpr) = admin_group_fingerprint(&chat.grpid) {\n        let self_fpr = self_fingerprint(context).await?;\n        ensure!(\n            self_fpr == admin_fpr,\n            \"Only the group admin can add other members to this group\"\n        );\n    }\n\n    if from_handshake && chat.param.get_int(Param::Unpromoted).unwrap_or_default() == 1 {\n        let now = time();\n",
    ),
    dict(
        id="#19 admin groups 4 (chat.rs)",
        file="core/src/chat.rs",
        applied="\"Only the group admin can remove other members from this group\"",
        anchor="    }\n\n    let mut sync = Nosync;\n\n",
        where="replace",
        text="    }\n\n    if contact_id != ContactId::SELF\n        && let Some(admin_fpr) = admin_group_fingerprint(&chat.grpid)\n    {\n        let self_fpr = self_fingerprint(context).await?;\n        ensure!(\n            self_fpr == admin_fpr,\n            \"Only the group admin can remove other members from this group\"\n        );\n    }\n\n    let mut sync = Nosync;\n\n",
    ),
    dict(
        id="#19 admin groups 5 (chat.rs)",
        file="core/src/chat.rs",
        applied="\"Only the group admin can change the description of this group\"",
        anchor="    }\n\n    let old_description = get_chat_description(context, chat_id).await?;\n    if old_description == new_description {\n",
        where="replace",
        text="    }\n\n    if let Some(admin_fpr) = admin_group_fingerprint(&chat.grpid) {\n        let self_fpr = self_fingerprint(context).await?;\n        ensure!(\n            self_fpr == admin_fpr,\n            \"Only the group admin can change the description of this group\"\n        );\n    }\n\n    let old_description = get_chat_description(context, chat_id).await?;\n    if old_description == new_description {\n",
    ),
    dict(
        id="#19 admin groups 6 (chat.rs)",
        file="core/src/chat.rs",
        applied="\"Only the group admin can rename this group\"",
        anchor="            ));\n        } else {\n            context\n                .sql\n",
        where="replace",
        text="            ));\n        } else {\n            if let Some(admin_fpr) = admin_group_fingerprint(&chat.grpid) {\n                let self_fpr = self_fingerprint(context).await?;\n                ensure!(\n                    self_fpr == admin_fpr,\n                    \"Only the group admin can rename this group\"\n                );\n            }\n            context\n                .sql\n",
    ),
    dict(
        id="#19 admin groups 7 (chat.rs)",
        file="core/src/chat.rs",
        applied="\"Only the group admin can change the profile image of this group\"",
        anchor="        ));\n        bail!(\"Failed to set profile image\");\n    }\n    let mut msg = Message::new(Viewtype::Text);\n",
        where="replace",
        text="        ));\n        bail!(\"Failed to set profile image\");\n    }\n    if let Some(admin_fpr) = admin_group_fingerprint(&chat.grpid) {\n        let self_fpr = self_fingerprint(context).await?;\n        ensure!(\n            self_fpr == admin_fpr,\n            \"Only the group admin can change the profile image of this group\"\n        );\n    }\n    let mut msg = Message::new(Viewtype::Text);\n",
    ),
    dict(
        id="#19 admin groups 1 (tools.rs)",
        file="core/src/tools.rs",
        applied="/// - regular group IDs generated with `create_id()` and admin group IDs",
        anchor="    let alphabet = base64::alphabet::URL_SAFE.as_str();\n    s.chars().all(|c| alphabet.contains(c)) && s.len() > 10 && s.len() <= 32\n}\n\n",
        where="replace",
        text="    let alphabet = base64::alphabet::URL_SAFE.as_str();\n    s.chars().all(|c| alphabet.contains(c)) && s.len() > 10 && s.len() <= 32\n}\n\n/// Returns true if given string is a valid group ID.\n///\n/// Accepts both:\n/// - regular group IDs generated with `create_id()` and admin group IDs\npub(crate) fn validate_group_id(s: &str) -> bool {\n    if validate_id(s) {\n        return true;\n    }\n    // Admin group grpid: FINGERPRINT<SEPARATOR>base_grpid\n    if let Some((fpr, base_id)) = s.split_once(':') {\n        // Velta #19: a real (v4 or v6) fingerprint, never empty.\n        matches!(fpr.len(), 40 | 64)\n            && fpr.chars().all(|c| matches!(c, '0'..='9' | 'A'..='F'))\n            && validate_id(base_id)\n    } else {\n        false\n    }\n}\n\n",
    ),
    dict(
        id="#19 admin groups 1 (mimeparser.rs)",
        file="core/src/mimeparser.rs",
        applied="get_filemeta, parse_receive_headers, time, truncate_msg_text, validate_group_id,",
        anchor="use crate::simplify::{SimplifiedText, simplify};\nuse crate::sync::SyncItems;\nuse crate::tools::{get_filemeta, parse_receive_headers, time, truncate_msg_text, validate_id};\nuse crate::{chatlist_events, location, tools};\n\n",
        where="replace",
        text="use crate::simplify::{SimplifiedText, simplify};\nuse crate::sync::SyncItems;\nuse crate::tools::{\n    get_filemeta, parse_receive_headers, time, truncate_msg_text, validate_group_id,\n};\nuse crate::{chatlist_events, location, tools};\n\n",
    ),
    dict(
        id="#19 admin groups 2 (mimeparser.rs)",
        file="core/src/mimeparser.rs",
        applied=".filter(|s| validate_group_id(s))",
        anchor="    pub fn get_chat_group_id(&self) -> Option<&str> {\n        self.get_header(HeaderDef::ChatGroupId)\n            .filter(|s| validate_id(s))\n    }\n\n",
        where="replace",
        text="    pub fn get_chat_group_id(&self) -> Option<&str> {\n        self.get_header(HeaderDef::ChatGroupId)\n            .filter(|s| validate_group_id(s))\n    }\n\n",
    ),
    dict(
        id="#19 admin groups 1 (qr.rs)",
        file="core/src/qr.rs",
        applied="use crate::chat::ADMIN_GROUP_ID_SEPARATOR;",
        anchor="\nuse crate::autorelay::login_param_from_host;\nuse crate::config::Config;\nuse crate::configure::MAX_RELAYS;\n",
        where="replace",
        text="\nuse crate::autorelay::login_param_from_host;\nuse crate::chat::ADMIN_GROUP_ID_SEPARATOR;\nuse crate::config::Config;\nuse crate::configure::MAX_RELAYS;\n",
    ),
    dict(
        id="#19 admin groups 2 (qr.rs)",
        file="core/src/qr.rs",
        applied=".map(|base_id| format!(\"{}{ADMIN_GROUP_ID_SEPARATOR}{base_id}\", fingerprint.hex()))",
        anchor="        .filter(|&s| validate_id(s))\n        .map(|s| s.to_string());\n    let grpid = param\n        .get(\"x\")\n        .filter(|&s| validate_id(s))\n        .map(|s| s.to_string());\n\n    let grpname = decode_name(&param, \"g\")?;\n    let broadcast_name = decode_name(&param, \"b\")?;\n\n    let mut is_v3 = param.get(\"v\") == Some(&\"3\");\n",
        where="replace",
        text="        .filter(|&s| validate_id(s))\n        .map(|s| s.to_string());\n\n    let grpname = decode_name(&param, \"g\")?;\n    let admin_grpname = decode_name(&param, \"z\")?;\n    let broadcast_name = decode_name(&param, \"b\")?;\n\n    // For admin groups, reconstruct the full grpid as FINGERPRINT<SEP>base_grpid.\n    let grpid = if admin_grpname.is_some() {\n        param\n            .get(\"x\")\n            .filter(|&s| validate_id(s))\n            .map(|base_id| format!(\"{}{ADMIN_GROUP_ID_SEPARATOR}{base_id}\", fingerprint.hex()))\n    } else {\n        param\n            .get(\"x\")\n            .filter(|&s| validate_id(s))\n            .map(|s| s.to_string())\n    };\n    let grpname = grpname.or(admin_grpname);\n\n    let mut is_v3 = param.get(\"v\") == Some(&\"3\");\n",
    ),
    dict(
        id="#19 admin groups 1 (securejoin.rs)",
        file="core/src/securejoin.rs",
        applied="self, Chat, ChatId, ChatIdBlocked, admin_group_base_id, admin_group_fingerprint,",
        anchor="use percent_encoding::{AsciiSet, utf8_percent_encode};\n\nuse crate::chat::{self, Chat, ChatId, ChatIdBlocked, get_chat_id_by_grpid, load_broadcast_secret};\nuse crate::config::Config;\nuse crate::constants::{Blocked, Chattype, NON_ALPHANUMERIC_WITHOUT_DOT};\n",
        where="replace",
        text="use percent_encoding::{AsciiSet, utf8_percent_encode};\n\nuse crate::chat::{\n    self, Chat, ChatId, ChatIdBlocked, admin_group_base_id, admin_group_fingerprint,\n    get_chat_id_by_grpid, load_broadcast_secret,\n};\nuse crate::config::Config;\nuse crate::constants::{Blocked, Chattype, NON_ALPHANUMERIC_WITHOUT_DOT};\n",
    ),
    dict(
        id="#19 admin groups 2 (securejoin.rs)",
        file="core/src/securejoin.rs",
        applied="// Admin group: put only the base (random) grpid in x=, use z= for the group name",
        anchor="            format!(\n                \"https://i.delta.chat/#{fingerprint}&v=3&x={grpid}&j={invitenumber}&s={auth}&a={self_addr_urlencoded}{r_param}&n={self_name_urlencoded}&b={chat_name_urlencoded}\",\n            )\n        } else {\n",
        where="replace",
        text="            format!(\n                \"https://i.delta.chat/#{fingerprint}&v=3&x={grpid}&j={invitenumber}&s={auth}&a={self_addr_urlencoded}{r_param}&n={self_name_urlencoded}&b={chat_name_urlencoded}\",\n            )\n        } else if admin_group_fingerprint(grpid).is_some() {\n            // Admin group: put only the base (random) grpid in x=, use z= for the group name\n            let base_grpid = admin_group_base_id(grpid);\n            format!(\n                \"https://i.delta.chat/#{fingerprint}&v=3&x={base_grpid}&i={invitenumber}&s={auth}&a={self_addr_urlencoded}{r_param}&n={self_name_urlencoded}&z={chat_name_urlencoded}\",\n            )\n        } else {\n",
    ),
    dict(
        id="#19 admin groups 3 (securejoin.rs)",
        file="core/src/securejoin.rs",
        applied="// If we are not the admin, abort the secure-join instead of",
        anchor="            }\n            if let Some(joining_chat_id) = joining_chat_id {\n                chat::add_contact_to_chat_ext(context, Nosync, joining_chat_id, contact_id, true)\n                    .await?;\n",
        where="replace",
        text="            }\n            if let Some(joining_chat_id) = joining_chat_id {\n                // In admin groups, only the admin may add members.\n                // If we are not the admin, abort the secure-join instead of\n                // forwarding an add-member message that will be rejected anyway.\n                if let Some(admin_fpr) = admin_group_fingerprint(&grpid) {\n                    let my_fpr = self_fingerprint(context).await?;\n                    if my_fpr != admin_fpr {\n                        info!(\n                            context,\n                            \"Aborting secure-join: we are not the admin of group.\"\n                        );\n                        return Ok(HandshakeMessage::Ignore);\n                    }\n                }\n\n                chat::add_contact_to_chat_ext(context, Nosync, joining_chat_id, contact_id, true)\n                    .await?;\n",
    ),
    dict(
        id="#19 admin groups 1 (ephemeral.rs)",
        file="core/src/ephemeral.rs",
        applied="use crate::chat::{Chat, ChatId, ChatIdBlocked, admin_group_fingerprint, send_msg};",
        anchor="use tokio::time::timeout;\n\nuse crate::chat::{ChatId, ChatIdBlocked, send_msg};\nuse crate::config::Config;\nuse crate::contact::ContactId;\n",
        where="replace",
        text="use tokio::time::timeout;\n\nuse crate::chat::{Chat, ChatId, ChatIdBlocked, admin_group_fingerprint, send_msg};\nuse crate::config::Config;\nuse crate::contact::ContactId;\n",
    ),
    dict(
        id="#19 admin groups 2 (ephemeral.rs)",
        file="core/src/ephemeral.rs",
        applied="\"Only the group admin can change the ephemeral timer of this group\"",
        anchor="    /// If timer value is 0, disable ephemeral message timer.\n    pub async fn set_ephemeral_timer(self, context: &Context, timer: Timer) -> Result<()> {\n        if timer == self.get_ephemeral_timer(context).await? {\n            return Ok(());\n",
        where="replace",
        text="    /// If timer value is 0, disable ephemeral message timer.\n    pub async fn set_ephemeral_timer(self, context: &Context, timer: Timer) -> Result<()> {\n        ensure!(!self.is_special(), \"Invalid chat ID\");\n\n        let chat = Chat::load_from_db(context, self).await?;\n        if admin_group_fingerprint(&chat.grpid).is_some() {\n            ensure!(\n                crate::chat::get_admin_contact_id(context, &chat.grpid).await?\n                    == Some(ContactId::SELF),\n                \"Only the group admin can change the ephemeral timer of this group\"\n            );\n        }\n\n        if timer == self.get_ephemeral_timer(context).await? {\n            return Ok(());\n",
    ),
    dict(
        id="#19 admin groups 1 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="self, Chat, ChatId, ChatIdBlocked, ChatVisibility, admin_group_fingerprint, is_contact_in_chat,",
        anchor="\nuse crate::chat::{\n    self, Chat, ChatId, ChatIdBlocked, ChatVisibility, is_contact_in_chat, save_broadcast_secret,\n};\nuse crate::config::Config;\n",
        where="replace",
        text="\nuse crate::chat::{\n    self, Chat, ChatId, ChatIdBlocked, ChatVisibility, admin_group_fingerprint, is_contact_in_chat,\n    save_broadcast_secret,\n};\nuse crate::config::Config;\n",
    ),
    dict(
        id="#19 admin groups 2 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="let grpid = chat.grpid.clone();",
        anchor="    let in_fresh = state == MessageState::InFresh;\n\n    let sort_timestamp = chat_id\n        .calc_sort_timestamp(context, mime_parser.timestamp_sent, sort_to_bottom)\n",
        where="replace",
        text="    let in_fresh = state == MessageState::InFresh;\n\n    let grpid = chat.grpid.clone();\n\n    let sort_timestamp = chat_id\n        .calc_sort_timestamp(context, mime_parser.timestamp_sent, sort_to_bottom)\n",
    ),
    dict(
        id="#19 admin groups 3 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="let sender_is_admin = is_group_admin_contact(context, &grpid, from_id).await?;",
        anchor="        let is_from_in_chat =\n            !chat_contacts.contains(&ContactId::SELF) || chat_contacts.contains(&from_id);\n\n        info!(\n",
        where="replace",
        text="        let is_from_in_chat =\n            !chat_contacts.contains(&ContactId::SELF) || chat_contacts.contains(&from_id);\n        let sender_is_admin = is_group_admin_contact(context, &grpid, from_id).await?;\n\n        info!(\n",
    ),
    dict(
        id="#19 admin groups 4 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="\"Ignoring ephemeral timer change to {ephemeral_timer:?} for chat {chat_id} because sender {from_id} is not the admin.\",",
        anchor="                context,\n                \"Ignoring ephemeral timer change to {ephemeral_timer:?} for chat {chat_id} because sender {from_id} is not a member.\",\n            );\n        } else if get_previous_message(context, mime_parser)\n",
        where="replace",
        text="                context,\n                \"Ignoring ephemeral timer change to {ephemeral_timer:?} for chat {chat_id} because sender {from_id} is not a member.\",\n            );\n        } else if !sender_is_admin {\n            warn!(\n                context,\n                \"Ignoring ephemeral timer change to {ephemeral_timer:?} for chat {chat_id} because sender {from_id} is not the admin.\",\n            );\n        } else if get_previous_message(context, mime_parser)\n",
    ),
    dict(
        id="#19 admin groups 5 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="if is_from_in_chat && is_group_admin_contact(context, &grpid, from_id).await? {",
        anchor="        let is_from_in_chat =\n            !chat_contacts.contains(&ContactId::SELF) || chat_contacts.contains(&from_id);\n        if is_from_in_chat {\n            let new_pinned_state = mime_parser.is_system_message == SystemMessage::MessagePinned;\n            handle_pinned_state_from_wire(context, &msg_to_change, new_pinned_state).await?;\n",
        where="replace",
        text="        let is_from_in_chat =\n            !chat_contacts.contains(&ContactId::SELF) || chat_contacts.contains(&from_id);\n        if is_from_in_chat && is_group_admin_contact(context, &grpid, from_id).await? {\n            let new_pinned_state = mime_parser.is_system_message == SystemMessage::MessagePinned;\n            handle_pinned_state_from_wire(context, &msg_to_change, new_pinned_state).await?;\n",
    ),
    dict(
        id="#19 admin groups 6 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Velta #19: the admin of an admin group may delete others' messages of",
        anchor="                continue;\n            };\n            if msg.from_id != from_id {\n                warn!(context, \"Delete message: Bad sender.\");\n                continue;\n",
        where="replace",
        text="                continue;\n            };\n            // Velta #19: the admin of an admin group may delete others' messages of\n            // that group, with a request sent to that group (regular groups: own only).\n            let admin_may_delete = msg.from_id != from_id && {\n                let msg_chat = Chat::load_from_db(context, msg.chat_id).await?;\n                admin_group_fingerprint(&msg_chat.grpid).is_some()\n                    && mime_parser.get_chat_group_id() == Some(msg_chat.grpid.as_str())\n                    && is_group_admin_contact(context, &msg_chat.grpid, from_id).await?\n            };\n            if msg.from_id != from_id && !admin_may_delete {\n                warn!(context, \"Delete message: Bad sender.\");\n                continue;\n",
    ),
    dict(
        id="#19 admin groups 7 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="\"Ignoring creation of admin group {grpid}: sender {from_id} is not the admin.\"",
        anchor="            && mime_parser.get_header(HeaderDef::ChatGroupMemberRemoved).is_none()\n    {\n        // Group does not exist but should be created.\n        let grpname = mime_parser\n",
        where="replace",
        text="            && mime_parser.get_header(HeaderDef::ChatGroupMemberRemoved).is_none()\n    {\n        // For admin groups the grpid encodes the admin's fingerprint.\n        // Only accept group creation if the sender is that admin;\n        // otherwise a non-admin could send a message with the admin-grpid\n        // and implicitly create the group on receivers that are not yet\n        // members, potentially manipulating group state.\n        if !is_group_admin_contact(context, grpid, from_id).await? {\n            info!(\n                context,\n                \"Ignoring creation of admin group {grpid}: sender {from_id} is not the admin.\"\n            );\n            return Ok(None);\n        }\n        // Group does not exist but should be created.\n        let grpname = mime_parser\n",
    ),
    dict(
        id="#19 admin groups 8 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Velta #19: admin-only membership changes (apply_group_changes).",
        anchor="        !chat_contacts.contains(&ContactId::SELF) || chat_contacts.contains(&from_id);\n\n    if let Some(removed_addr) = mime_parser.get_header(HeaderDef::ChatGroupMemberRemoved) {\n        if !is_from_in_chat {\n",
        where="replace",
        text="        !chat_contacts.contains(&ContactId::SELF) || chat_contacts.contains(&from_id);\n\n    // Velta #19: admin-only membership changes (apply_group_changes).\n    let sender_is_admin = is_group_admin_contact(context, &chat.grpid, from_id).await?;\n\n    if let Some(removed_addr) = mime_parser.get_header(HeaderDef::ChatGroupMemberRemoved) {\n        if !is_from_in_chat {\n",
    ),
    dict(
        id="#19 admin groups 9 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// In admin groups, non-admins can only remove themselves (leave the group)",
        anchor="        }\n        if let Some(id) = removed_id {\n            silent = id == from_id;\n            better_msg = Some(stock_str::msg_del_member_local(context, id, from_id).await);\n        } else {\n            warn!(context, \"Removed {removed_addr:?} has no contact id.\")\n        }\n    } else if let Some(added_addr) = mime_parser.get_header(HeaderDef::ChatGroupMemberAdded) {\n        if !is_from_in_chat {\n            better_msg = Some(String::new());\n        } else if let Some(key) = mime_parser.gossiped_keys.get(added_addr) {\n",
        where="replace",
        text="        }\n        if let Some(id) = removed_id {\n            // In admin groups, non-admins can only remove themselves (leave the group)\n            if !sender_is_admin && id != from_id {\n                info!(\n                    context,\n                    \"Ignoring member removal by non-admin in admin group {}\", chat.id\n                );\n                removed_id = None;\n                better_msg = Some(String::new());\n            } else {\n                silent = id == from_id;\n                better_msg = Some(stock_str::msg_del_member_local(context, id, from_id).await);\n            }\n        } else {\n            warn!(context, \"Removed {removed_addr:?} has no contact id.\")\n        }\n    } else if let Some(added_addr) = mime_parser.get_header(HeaderDef::ChatGroupMemberAdded) {\n        if !is_from_in_chat || !sender_is_admin {\n            better_msg = Some(String::new());\n        } else if let Some(key) = mime_parser.gossiped_keys.get(added_addr) {\n",
    ),
    dict(
        id="#19 admin groups 10 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Velta #19: only the admin's stale member list is applied.",
        anchor="        if from_is_key_contact != chat.grpid.is_empty()\n            && chat.member_list_is_stale(context).await?\n        {\n            info!(context, \"Member list is stale.\");\n",
        where="replace",
        text="        if from_is_key_contact != chat.grpid.is_empty()\n            && chat.member_list_is_stale(context).await?\n            // Velta #19: only the admin's stale member list is applied.\n            && sender_is_admin\n        {\n            info!(context, \"Member list is stale.\");\n",
    ),
    dict(
        id="#19 admin groups 11 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Velta #19: only the admin's member timestamps are applied.",
        anchor="        } else if let Some(ref chat_group_member_timestamps) =\n            mime_parser.chat_group_member_timestamps()\n        {\n            send_event_chat_modified |= update_chats_contacts_timestamps(\n",
        where="replace",
        text="        } else if let Some(ref chat_group_member_timestamps) =\n            mime_parser.chat_group_member_timestamps()\n            // Velta #19: only the admin's member timestamps are applied.\n            && sender_is_admin\n        {\n            send_event_chat_modified |= update_chats_contacts_timestamps(\n",
    ),
    dict(
        id="#19 admin groups 12 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// For group state changes (name/description/avatar), treat non-admins as non-members.",
        anchor="    // ========== Apply chat name changes ==========\n\n    let group_name_timestamp = mime_parser\n        .get_header(HeaderDef::ChatGroupNameTimestamp)\n",
        where="replace",
        text="    // ========== Apply chat name changes ==========\n\n    let sender_is_admin = is_group_admin_contact(context, &chat.grpid, from_id).await?;\n    // For group state changes (name/description/avatar), treat non-admins as non-members.\n    let can_modify_group_state = is_from_in_chat && sender_is_admin;\n\n    let group_name_timestamp = mime_parser\n        .get_header(HeaderDef::ChatGroupNameTimestamp)\n",
    ),
    dict(
        id="#19 admin groups 13 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Velta #19: admin-only group name.",
        anchor="        let group_name_timestamp = group_name_timestamp.unwrap_or(mime_parser.timestamp_sent);\n        // To provide group name consistency, compare names if timestamps are equal.\n        if is_from_in_chat\n            && (chat_group_name_timestamp, grpname) < (group_name_timestamp, &chat.name)\n            && chat\n",
        where="replace",
        text="        let group_name_timestamp = group_name_timestamp.unwrap_or(mime_parser.timestamp_sent);\n        // To provide group name consistency, compare names if timestamps are equal.\n        // Velta #19: admin-only group name.\n        if can_modify_group_state\n            && (chat_group_name_timestamp, grpname) < (group_name_timestamp, &chat.name)\n            && chat\n",
    ),
    dict(
        id="#19 admin groups 14 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Velta #19: admin-only \"name changed\" message.",
        anchor="            .is_some()\n        {\n            if is_from_in_chat {\n                let old_name = &sanitize_single_line(old_name);\n                better_msg.get_or_insert(\n",
        where="replace",
        text="            .is_some()\n        {\n            // Velta #19: admin-only \"name changed\" message.\n            if can_modify_group_state {\n                let old_name = &sanitize_single_line(old_name);\n                better_msg.get_or_insert(\n",
    ),
    dict(
        id="#19 admin groups 15 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Attempt to change group name by non-member or non-admin, trash it.",
        anchor="                );\n            } else {\n                // Attempt to change group name by non-member, trash it.\n                *better_msg = Some(String::new());\n            }\n",
        where="replace",
        text="                );\n            } else {\n                // Attempt to change group name by non-member or non-admin, trash it.\n                *better_msg = Some(String::new());\n            }\n",
    ),
    dict(
        id="#19 admin groups 16 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Velta #19: admin-only group description.",
        anchor="        let new_timestamp = timestamp_in_header.unwrap_or(mime_parser.timestamp_sent);\n        // To provide consistency, compare descriptions if timestamps are equal.\n        if is_from_in_chat\n            && (old_timestamp, &old_description) < (new_timestamp, &new_description)\n            && chat\n",
        where="replace",
        text="        let new_timestamp = timestamp_in_header.unwrap_or(mime_parser.timestamp_sent);\n        // To provide consistency, compare descriptions if timestamps are equal.\n        // Velta #19: admin-only group description.\n        if can_modify_group_state\n            && (old_timestamp, &old_description) < (new_timestamp, &new_description)\n            && chat\n",
    ),
    dict(
        id="#19 admin groups 17 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Attempt to change group description by non-member or non-admin, trash it.",
        anchor="            .is_some()\n        {\n            if is_from_in_chat {\n                better_msg\n                    .get_or_insert(stock_str::msg_chat_description_changed(context, from_id).await);\n            } else {\n                // Attempt to change group description by non-member, trash it.\n                *better_msg = Some(String::new());\n            }\n",
        where="replace",
        text="            .is_some()\n        {\n            if can_modify_group_state {\n                better_msg\n                    .get_or_insert(stock_str::msg_chat_description_changed(context, from_id).await);\n            } else {\n                // Attempt to change group description by non-member or non-admin, trash it.\n                *better_msg = Some(String::new());\n            }\n",
    ),
    dict(
        id="#19 admin groups 18 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Velta #19: admin-only explicit avatar change.",
        anchor="        && let Some(avatar_action) = &mime_parser.group_avatar\n    {\n        if is_from_in_chat {\n            // this is just an explicit message containing the group-avatar,\n            // apart from that, the group-avatar is send along with various other messages\n",
        where="replace",
        text="        && let Some(avatar_action) = &mime_parser.group_avatar\n    {\n        // Velta #19: admin-only explicit avatar change.\n        if can_modify_group_state {\n            // this is just an explicit message containing the group-avatar,\n            // apart from that, the group-avatar is send along with various other messages\n",
    ),
    dict(
        id="#19 admin groups 19 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="// Attempt to change group avatar by non-member or non-admin, trash it.",
        anchor="            );\n        } else {\n            // Attempt to change group avatar by non-member, trash it.\n            *better_msg = Some(String::new());\n        }\n",
        where="replace",
        text="            );\n        } else {\n            // Attempt to change group avatar by non-member or non-admin, trash it.\n            *better_msg = Some(String::new());\n        }\n",
    ),
    dict(
        id="#19 admin groups 20 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="&& can_modify_group_state",
        anchor="\n    if let Some(avatar_action) = &mime_parser.group_avatar\n        && is_from_in_chat\n        && chat\n            .param\n",
        where="replace",
        text="\n    if let Some(avatar_action) = &mime_parser.group_avatar\n        && can_modify_group_state\n        && chat\n            .param\n",
    ),
    dict(
        id="#19 admin groups 21 (receive_imf.rs)",
        file="core/src/receive_imf.rs",
        applied="if let Some(admin_fpr) = admin_group_fingerprint(grpid) {",
        anchor="}\n\nasync fn lookup_key_contact_by_fingerprint(\n    context: &Context,\n",
        where="replace",
        text="}\n\nasync fn get_contact_fingerprint(\n    context: &Context,\n    contact_id: ContactId,\n) -> Result<Option<String>> {\n    if contact_id == ContactId::SELF {\n        Ok(self_fingerprint_opt(context).await?.map(|s| s.to_string()))\n    } else {\n        Ok(Contact::get_by_id(context, contact_id)\n            .await?\n            .fingerprint()\n            .map(|f| f.hex()))\n    }\n}\n\nasync fn is_group_admin_contact(\n    context: &Context,\n    grpid: &str,\n    contact_id: ContactId,\n) -> Result<bool> {\n    if let Some(admin_fpr) = admin_group_fingerprint(grpid) {\n        let contact_fpr = get_contact_fingerprint(context, contact_id).await?;\n        Ok(contact_fpr.as_deref() == Some(admin_fpr))\n    } else {\n        Ok(true)\n    }\n}\n\nasync fn lookup_key_contact_by_fingerprint(\n    context: &Context,\n",
    ),
    dict(
        id="#19 admin groups 1 (message.rs)",
        file="core/src/message.rs",
        applied="crate::chat::get_admin_contact_id(context, &chat.grpid).await? == Some(ContactId::SELF)",
        anchor="    for &msg_id in msg_ids {\n        let msg = Message::load_from_db(context, msg_id).await?;\n        ensure!(\n            !delete_for_all || msg.from_id == ContactId::SELF,\n            \"Can delete only own messages for others\"\n        );\n",
        where="replace",
        text="    for &msg_id in msg_ids {\n        let msg = Message::load_from_db(context, msg_id).await?;\n        // Velta #19: the admin of an admin group may delete others' messages there.\n        let is_admin_of_chat = if delete_for_all && msg.from_id != ContactId::SELF {\n            let chat = Chat::load_from_db(context, msg.chat_id).await?;\n            crate::chat::get_admin_contact_id(context, &chat.grpid).await? == Some(ContactId::SELF)\n        } else {\n            false\n        };\n        ensure!(\n            !delete_for_all || msg.from_id == ContactId::SELF || is_admin_of_chat,\n            \"Can delete only own messages for others\"\n        );\n",
    ),
    dict(
        id="#19 admin groups 1 (api.rs)",
        file="core/deltachat-jsonrpc/src/api.rs",
        applied="async fn create_group_with_admin(&self, account_id: u32, name: String) -> Result<u32> {",
        anchor="        let ctx = self.get_context(account_id).await?;\n        chat::create_group(&ctx, &name).await.map(|id| id.to_u32())\n    }\n\n",
        where="replace",
        text="        let ctx = self.get_context(account_id).await?;\n        chat::create_group(&ctx, &name).await.map(|id| id.to_u32())\n    }\n\n    /// Create a new encrypted group chat with an admin.\n    ///\n    /// Similar to [`Self::create_group_chat`], but only the creator (admin) can add/remove\n    /// members or change the group name, description, avatar, etc.\n    /// Other members can send messages and leave the group.\n    /// The `group_admin_id` field in [`FullChat`] will be set to the admin's contact ID.\n    async fn create_group_with_admin(&self, account_id: u32, name: String) -> Result<u32> {\n        let ctx = self.get_context(account_id).await?;\n        chat::create_group_with_admin(&ctx, &name)\n            .await\n            .map(|id| id.to_u32())\n    }\n\n",
    ),
    dict(
        id="#19 admin groups 8 (chat.rs)",
        file="core/deltachat-jsonrpc/src/api/types/chat.rs",
        applied="self, ChatVisibility, get_admin_contact_id, get_chat_contacts, get_past_chat_contacts,",
        anchor="\nuse anyhow::{Context as _, Result, bail};\nuse deltachat::chat::{self, ChatVisibility, get_chat_contacts, get_past_chat_contacts};\nuse deltachat::chat::{Chat, ChatId};\nuse deltachat::constants::Chattype;\n",
        where="replace",
        text="\nuse anyhow::{Context as _, Result, bail};\nuse deltachat::chat::{\n    self, ChatVisibility, get_admin_contact_id, get_chat_contacts, get_past_chat_contacts,\n};\nuse deltachat::chat::{Chat, ChatId};\nuse deltachat::constants::Chattype;\n",
    ),
    dict(
        id="#19 admin groups 9 (chat.rs)",
        file="core/deltachat-jsonrpc/src/api/types/chat.rs",
        applied="/// Contact ID of the group admin for admin-controlled groups, or `null` for regular groups.",
        anchor="    freshness: ContactFreshness,\n    mailing_list_address: Option<String>,\n}\n\n",
        where="replace",
        text="    freshness: ContactFreshness,\n    mailing_list_address: Option<String>,\n\n    /// Contact ID of the group admin for admin-controlled groups, or `null` for regular groups.\n    group_admin_id: Option<u32>,\n}\n\n",
    ),
    dict(
        id="#19 admin groups 10 (chat.rs)",
        file="core/deltachat-jsonrpc/src/api/types/chat.rs",
        applied="let group_admin_id = get_admin_contact_id(context, &chat.grpid)",
        anchor="        let mailing_list_address = chat.get_mailinglist_addr().map(|s| s.to_string());\n\n        Ok(FullChat {\n            id: chat_id,\n",
        where="replace",
        text="        let mailing_list_address = chat.get_mailinglist_addr().map(|s| s.to_string());\n\n        let group_admin_id = get_admin_contact_id(context, &chat.grpid)\n            .await?\n            .map(|id| id.to_u32());\n\n        Ok(FullChat {\n            id: chat_id,\n",
    ),
    dict(
        id="#19 admin groups 11 (chat.rs)",
        file="core/deltachat-jsonrpc/src/api/types/chat.rs",
        applied="group_admin_id,",
        anchor="            freshness,\n            mailing_list_address,\n        })\n    }\n",
        where="replace",
        text="            freshness,\n            mailing_list_address,\n            group_admin_id,\n        })\n    }\n",
    ),
    dict(
        id="#19 admin groups 1 (chat_tests.rs)",
        file="core/src/chat/chat_tests.rs",
        applied="/// Velta #19 (admin groups): sets up an admin group of Alice (admin) with Bob and Charlie.",
        anchor="use strum::IntoEnumIterator;\nuse tokio::fs;\n\n#[tokio::test(flavor = \"multi_thread\", worker_threads = 2)]\n",
        where="replace",
        text="use strum::IntoEnumIterator;\nuse tokio::fs;\n\n/// Velta #19 (admin groups): sets up an admin group of Alice (admin) with Bob and Charlie.\nasync fn velta_admin_group_setup(\n    tcm: &mut TestContextManager,\n) -> Result<(\n    TestContext,\n    TestContext,\n    TestContext,\n    ChatId,\n    ChatId,\n    ChatId,\n)> {\n    let alice = tcm.alice().await;\n    let bob = tcm.bob().await;\n    let charlie = tcm.charlie().await;\n    let alice_bob = alice.add_or_lookup_contact_id(&bob).await;\n    let alice_charlie = alice.add_or_lookup_contact_id(&charlie).await;\n\n    let alice_chat_id = create_group_with_admin(&alice, \"Moderated\").await?;\n    let grpid = Chat::load_from_db(&alice, alice_chat_id).await?.grpid;\n    let alice_fpr = self_fingerprint(&alice).await?;\n    assert_eq!(admin_group_fingerprint(&grpid), Some(alice_fpr));\n    assert!(crate::tools::validate_id(admin_group_base_id(&grpid)));\n    assert_eq!(\n        get_admin_contact_id(&alice, &grpid).await?,\n        Some(ContactId::SELF)\n    );\n\n    add_contact_to_chat(&alice, alice_chat_id, alice_bob).await?;\n    add_contact_to_chat(&alice, alice_chat_id, alice_charlie).await?;\n    let sent = alice.send_text(alice_chat_id, \"hi\").await;\n    let bob_chat_id = bob.recv_msg(&sent).await.chat_id;\n    let charlie_chat_id = charlie.recv_msg(&sent).await.chat_id;\n    bob_chat_id.accept(&bob).await?;\n    charlie_chat_id.accept(&charlie).await?;\n    assert_eq!(Chat::load_from_db(&bob, bob_chat_id).await?.grpid, grpid);\n    assert_eq!(\n        get_admin_contact_id(&bob, &grpid).await?,\n        Some(bob.add_or_lookup_contact_id(&alice).await)\n    );\n    Ok((\n        alice,\n        bob,\n        charlie,\n        alice_chat_id,\n        bob_chat_id,\n        charlie_chat_id,\n    ))\n}\n\n#[tokio::test(flavor = \"multi_thread\", worker_threads = 2)]\nasync fn test_velta_admin_group_non_admin_api_refused() -> Result<()> {\n    let mut tcm = TestContextManager::new();\n    let (_alice, bob, charlie, _a, bob_chat_id, _c) = velta_admin_group_setup(&mut tcm).await?;\n    let bob_charlie = bob.add_or_lookup_contact_id(&charlie).await;\n    let fiona = tcm.fiona().await;\n    let bob_fiona = bob.add_or_lookup_contact_id(&fiona).await;\n\n    assert!(\n        remove_contact_from_chat(&bob, bob_chat_id, bob_charlie)\n            .await\n            .is_err()\n    );\n    assert!(\n        add_contact_to_chat(&bob, bob_chat_id, bob_fiona)\n            .await\n            .is_err()\n    );\n    assert!(set_chat_name(&bob, bob_chat_id, \"Hijacked\").await.is_err());\n    assert!(\n        bob_chat_id\n            .set_ephemeral_timer(\n                &bob,\n                Timer::Enabled {\n                    duration: 60.try_into()?\n                }\n            )\n            .await\n            .is_err()\n    );\n    // Leaving is always allowed.\n    remove_contact_from_chat(&bob, bob_chat_id, ContactId::SELF).await?;\n    Ok(())\n}\n\n#[tokio::test(flavor = \"multi_thread\", worker_threads = 2)]\nasync fn test_velta_admin_group_forged_removal_ignored() -> Result<()> {\n    let mut tcm = TestContextManager::new();\n    let (alice, bob, charlie, alice_chat_id, bob_chat_id, charlie_chat_id) =\n        velta_admin_group_setup(&mut tcm).await?;\n\n    // Bob bypasses his own API check (a patched or buggy client) and \"removes\" Charlie.\n    let bob_chat = Chat::load_from_db(&bob, bob_chat_id).await?;\n    let bob_charlie = bob.add_or_lookup_contact_id(&charlie).await;\n    let charlie_contact = Contact::get_by_id(&bob, bob_charlie).await?;\n    let fpr = charlie_contact.fingerprint().map(|f| f.hex());\n    send_member_removal_msg(\n        &bob,\n        &bob_chat,\n        bob_charlie,\n        charlie_contact.get_addr(),\n        fpr.as_deref(),\n    )\n    .await?;\n    let sent = bob.pop_sent_msg().await;\n    alice.recv_msg_trash(&sent).await;\n    charlie.recv_msg_trash(&sent).await;\n    let alice_charlie = alice.add_or_lookup_contact_id(&charlie).await;\n    assert!(is_contact_in_chat(&alice, alice_chat_id, alice_charlie).await?);\n    assert!(is_contact_in_chat(&charlie, charlie_chat_id, ContactId::SELF).await?);\n\n    // The admin can remove Bob.\n    let alice_bob = alice.add_or_lookup_contact_id(&bob).await;\n    remove_contact_from_chat(&alice, alice_chat_id, alice_bob).await?;\n    let sent = alice.pop_sent_msg().await;\n    charlie.recv_msg(&sent).await;\n    let charlie_bob = charlie.add_or_lookup_contact_id(&bob).await;\n    assert!(!is_contact_in_chat(&charlie, charlie_chat_id, charlie_bob).await?);\n\n    // Charlie can leave.\n    remove_contact_from_chat(&charlie, charlie_chat_id, ContactId::SELF).await?;\n    let sent = charlie.pop_sent_msg().await;\n    alice.recv_msg(&sent).await;\n    assert!(!is_contact_in_chat(&alice, alice_chat_id, alice_charlie).await?);\n    Ok(())\n}\n\n#[tokio::test(flavor = \"multi_thread\", worker_threads = 2)]\nasync fn test_velta_admin_group_forged_rename_ignored() -> Result<()> {\n    let mut tcm = TestContextManager::new();\n    let (alice, bob, charlie, alice_chat_id, bob_chat_id, charlie_chat_id) =\n        velta_admin_group_setup(&mut tcm).await?;\n    SystemTime::shift(Duration::from_secs(60));\n\n    bob.sql\n        .execute(\n            \"UPDATE chats SET name='Hijacked', name_normalized='hijacked' WHERE id=?\",\n            (bob_chat_id,),\n        )\n        .await?;\n    let mut msg = Message::new_text(\"renamed\".to_string());\n    msg.param.set_cmd(SystemMessage::GroupNameChanged);\n    msg.param.set(Param::Arg, \"Moderated\");\n    send_msg(&bob, bob_chat_id, &mut msg).await?;\n    let sent = bob.pop_sent_msg().await;\n    alice.recv_msg_trash(&sent).await;\n    assert_eq!(\n        Chat::load_from_db(&alice, alice_chat_id).await?.name,\n        \"Moderated\"\n    );\n\n    // The admin can rename.\n    set_chat_name(&alice, alice_chat_id, \"Renamed\").await?;\n    let sent = alice.pop_sent_msg().await;\n    charlie.recv_msg(&sent).await;\n    assert_eq!(\n        Chat::load_from_db(&charlie, charlie_chat_id).await?.name,\n        \"Renamed\"\n    );\n    Ok(())\n}\n\n#[tokio::test(flavor = \"multi_thread\", worker_threads = 2)]\nasync fn test_velta_admin_group_delete_for_all() -> Result<()> {\n    let mut tcm = TestContextManager::new();\n    let (alice, bob, charlie, alice_chat_id, bob_chat_id, charlie_chat_id) =\n        velta_admin_group_setup(&mut tcm).await?;\n\n    // A non-admin cannot delete others' messages for everyone.\n    let sent = alice.send_text(alice_chat_id, \"from admin\").await;\n    let bob_admin_msg = bob.recv_msg(&sent).await;\n    charlie.recv_msg(&sent).await;\n    assert!(\n        crate::message::delete_msgs_ext(&bob, &[bob_admin_msg.id], true)\n            .await\n            .is_err()\n    );\n\n    // The admin can delete Bob's message for everyone.\n    let sent = bob.send_text(bob_chat_id, \"spam\").await;\n    let alice_spam = alice.recv_msg(&sent).await;\n    let charlie_spam = charlie.recv_msg(&sent).await;\n    crate::message::delete_msgs_ext(&alice, &[alice_spam.id], true).await?;\n    let sent = alice.pop_sent_msg().await;\n    charlie.recv_msg_trash(&sent).await;\n    assert_eq!(charlie_chat_id, charlie_spam.chat_id);\n    let gone = Message::load_from_db_optional(&charlie, charlie_spam.id).await?;\n    assert!(gone.is_none_or(|m| m.chat_id.is_trash()));\n    Ok(())\n}\n\n#[tokio::test(flavor = \"multi_thread\", worker_threads = 2)]\nasync fn test_velta_regular_group_no_delete_others() -> Result<()> {\n    // Regression guard for the ArcaneChat port: in a REGULAR group nobody\n    // may delete another member's message for everyone.\n    let mut tcm = TestContextManager::new();\n    let alice = tcm.alice().await;\n    let bob = tcm.bob().await;\n    let alice_bob = alice.add_or_lookup_contact_id(&bob).await;\n    let alice_chat_id = create_group(&alice, \"Plain\").await?;\n    add_contact_to_chat(&alice, alice_chat_id, alice_bob).await?;\n    let sent = alice.send_text(alice_chat_id, \"keep me\").await;\n    let bob_msg = bob.recv_msg(&sent).await;\n    bob_msg.chat_id.accept(&bob).await?;\n    let alice_msg_id = sent.sender_msg_id;\n    assert!(\n        crate::message::delete_msgs_ext(&bob, &[bob_msg.id], true)\n            .await\n            .is_err()\n    );\n    // Bob forges the delete request on the wire (patched client).\n    let mut msg = Message::new_text(\"x\".to_owned());\n    msg.param.set_int(Param::GuaranteeE2ee, 1);\n    msg.param.set(Param::DeleteRequestFor, &bob_msg.rfc724_mid);\n    msg.hidden = true;\n    send_msg(&bob, bob_msg.chat_id, &mut msg).await?;\n    let sent = bob.pop_sent_msg().await;\n    alice.recv_msg_trash(&sent).await;\n    alice.assert_warn(\"Delete message: Bad sender.\").await;\n    let kept = Message::load_from_db(&alice, alice_msg_id).await?;\n    assert_eq!(kept.chat_id, alice_chat_id);\n    assert_eq!(kept.text, \"keep me\");\n    Ok(())\n}\n\n#[tokio::test(flavor = \"multi_thread\", worker_threads = 2)]\nasync fn test_velta_admin_group_pin_and_timer_from_non_admin_ignored() -> Result<()> {\n    let mut tcm = TestContextManager::new();\n    let (alice, bob, _charlie, alice_chat_id, bob_chat_id, _c) =\n        velta_admin_group_setup(&mut tcm).await?;\n    let sent = alice.send_text(alice_chat_id, \"pin me\").await;\n    let bob_msg = bob.recv_msg(&sent).await;\n    let alice_msg_id = sent.sender_msg_id;\n\n    set_pinned_state(&bob, bob_msg.id, true).await?;\n    if let Some(sent) = bob.pop_sent_msg_opt().await {\n        alice.recv_msg_opt(&sent).await;\n    }\n    assert!(\n        !get_pinned_messages(&alice, alice_chat_id)\n            .await?\n            .contains(&alice_msg_id)\n    );\n\n    // The admin's pin reaches Bob.\n    set_pinned_state(&alice, alice_msg_id, true).await?;\n    let sent = alice.pop_sent_msg().await;\n    bob.recv_msg_opt(&sent).await;\n    assert!(\n        get_pinned_messages(&bob, bob_chat_id)\n            .await?\n            .contains(&bob_msg.id)\n    );\n    Ok(())\n}\n\n#[tokio::test(flavor = \"multi_thread\", worker_threads = 2)]\nasync fn test_velta_admin_group_securejoin_qr() -> Result<()> {\n    let mut tcm = TestContextManager::new();\n    let (alice, bob, _charlie, alice_chat_id, bob_chat_id, _c) =\n        velta_admin_group_setup(&mut tcm).await?;\n    let grpid = Chat::load_from_db(&alice, alice_chat_id).await?.grpid;\n\n    let qr = get_securejoin_qr(&alice, Some(alice_chat_id)).await?;\n    assert!(qr.contains(\"&z=\"));\n    assert!(!qr.contains(\"&g=\"));\n    assert!(qr.contains(&format!(\"x={}\", admin_group_base_id(&grpid))));\n\n    let fiona = tcm.fiona().await;\n    match check_qr(&fiona, &qr).await? {\n        Qr::AskVerifyGroup {\n            grpid: g, grpname, ..\n        } => {\n            assert_eq!(g, grpid);\n            assert_eq!(grpname, \"Moderated\");\n        }\n        other => panic!(\"unexpected {other:?}\"),\n    }\n    let fiona_chat_id = tcm.exec_securejoin_qr(&fiona, &alice, &qr).await;\n    assert_eq!(\n        Chat::load_from_db(&fiona, fiona_chat_id).await?.grpid,\n        grpid\n    );\n\n    // A non-admin cannot even produce a working invite: Bob aborts the handshake.\n    let bob_qr = get_securejoin_qr(&bob, Some(bob_chat_id)).await?;\n    let dom = tcm.dom().await;\n    join_securejoin(&dom, &bob_qr).await?;\n    let request = dom.pop_sent_msg().await;\n    bob.recv_msg_trash(&request).await;\n    let auth_required = bob.pop_sent_msg_opt().await;\n    if let Some(auth_required) = auth_required {\n        dom.recv_msg_trash(&auth_required).await;\n        if let Some(request_with_auth) = dom.pop_sent_msg_opt().await {\n            bob.recv_msg_trash(&request_with_auth).await;\n        }\n    }\n    let bob_dom = bob.add_or_lookup_contact_id(&dom).await;\n    assert!(!is_contact_in_chat(&bob, bob_chat_id, bob_dom).await?);\n    Ok(())\n}\n\n#[tokio::test(flavor = \"multi_thread\", worker_threads = 2)]\n",
    ),
    dict(
        id="#19 admin groups 1 (tools_tests.rs)",
        file="core/src/tools/tools_tests.rs",
        applied="// Velta #19 (admin groups): FINGERPRINT:base_id.",
        anchor="    let buf = create_id();\n    assert_eq!(buf.len(), 24);\n}\n\n",
        where="replace",
        text="    let buf = create_id();\n    assert_eq!(buf.len(), 24);\n}\n\n#[test]\nfn test_velta_validate_group_id() {\n    // Velta #19 (admin groups): FINGERPRINT:base_id.\n    let id = create_id();\n    assert!(validate_group_id(&id));\n    let fpr = \"0123456789ABCDEF0123456789ABCDEF01234567\";\n    assert!(validate_group_id(&format!(\"{fpr}:{id}\")));\n    assert!(!validate_group_id(&format!(\"{}:{id}\", fpr.to_lowercase())));\n    assert!(!validate_group_id(&format!(\"{fpr}:short\")));\n    assert!(!validate_group_id(&format!(\"{fpr}:{id}:{id}\")));\n    assert!(!validate_group_id(&format!(\":{id}\")));\n    assert!(!validate_group_id(\"a b:aaaaaaaaaaaa\"));\n}\n\n",
    ),

    # ---- VENDORISSUES #20 (#178): database encryption at rest ----
    # Accounts::new/load_accounts and add_account opened every database with
    # an empty passphrase, so a SQLCipher-encrypted dc.db stayed closed and a
    # fresh one was created plaintext. When the embedding app provides a raw
    # key (VELTA_DB_KEY, format x'<64 hex>'), open with it instead: existing
    # encrypted databases unlock, fresh ones are encrypted at creation. A
    # plaintext database + nonempty key returns Ok(false) (account stays
    # closed) -- the app must migrate plaintext files BEFORE handing the key
    # over (velta-app db_key::startup does, pre-spawn). Empty/unset env keeps
    # upstream behavior byte-for-byte.
    dict(
        id="#20 keyed open at startup (accounts.rs, load_accounts)",
        file="core/src/accounts.rs",
        applied="open with the app-provided raw key when",
        anchor="            // Try to open without a passphrase,\n            // but do not return an error if account is passphare-protected.\n            ctx.open(\"\".to_string()).await?;\n",
        where="replace",
        text="            // Try to open without a passphrase,\n            // but do not return an error if account is passphare-protected.\n            // Velta patch #20 (#178): open with the app-provided raw key when\n            // one is set (empty = upstream plaintext behavior).\n            let velta_db_key = std::env::var(\"VELTA_DB_KEY\").unwrap_or_default();\n            ctx.open(velta_db_key).await?;\n",
    ),
    dict(
        id="#20 keyed creation (accounts.rs, add_account)",
        file="core/src/accounts.rs",
        applied="encrypted at creation",
        anchor="        // Try to open without a passphrase,\n        // but do not return an error if account is passphare-protected.\n        ctx.open(\"\".to_string()).await?;\n",
        where="replace",
        text="        // Try to open without a passphrase,\n        // but do not return an error if account is passphare-protected.\n        // Velta patch #20 (#178): a fresh database is encrypted at creation\n        // when the app provides a raw key (empty = upstream behavior).\n        let velta_db_key = std::env::var(\"VELTA_DB_KEY\").unwrap_or_default();\n        ctx.open(velta_db_key).await?;\n",
    ),

    dict(
        id="#20 keyed-open guard test (accounts.rs tests)",
        file="core/src/accounts.rs",
        applied="test_velta_keyed_open_roundtrip",
        anchor="    /// Tests that accounts share stock string translations.\n",
        where="before",
        text="""    /// Velta #20 (#178): the raw SQLCipher key form (x'<64 hex>') that the
    /// VELTA_DB_KEY patch passes round-trips through the deprecated (upstream
    /// #7403) passphrase API: sets encryption on a fresh database, reopens
    /// it, and a wrong key reports false instead of erroring. Doubles as the
    /// core-bump guard: fails to COMPILE if `Context::open` disappears.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_velta_keyed_open_roundtrip() -> Result<()> {
        let key = "x'00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'";
        let other = "x'ff112233445566778899aabbccddeeff00112233445566778899aabbccddee00'";
        let dir = tempfile::tempdir()?.keep();

        let mut accounts = Accounts::new(dir.clone(), true).await?;
        let id = accounts.add_closed_account().await?;
        let ctx = accounts.get_account(id).context("no account")?;
        assert!(
            ctx.open(key.to_string()).await?,
            "set the raw key on a fresh db"
        );
        drop(accounts);
        drop(ctx);

        // Reopening without the key (load_accounts passes an empty
        // passphrase upstream) leaves the account closed, not an error.
        let accounts = Accounts::new(dir.clone(), true).await?;
        let ctx = accounts.get_account(id).context("no account")?;
        assert!(!ctx.is_open().await, "empty passphrase must not open");
        assert!(
            !ctx.open(other.to_string()).await?,
            "wrong key must report false while closed"
        );
        assert!(ctx.open(key.to_string()).await?, "same key must reopen");
        Ok(())
    }

"""
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
    # Normalize CRLF → LF: a Windows checkout materialises core/ with CRLF
    # (text=auto), and the quilt table's LF-only markers/anchors would
    # false-MISS in verify (both #10 scheduler ops, 2026-10-23). Writes stay
    # byte-exact via newline=""; on an LF tree this is a no-op.
    with io.open(os.path.join(core, relpath), encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


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
