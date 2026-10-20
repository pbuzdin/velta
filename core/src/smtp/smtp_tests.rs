use anyhow::Result;

use crate::test_utils::{TestContext, TestContextManager};
use crate::transport;

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

async fn sorted_transport_addrs(t: &TestContext) -> Result<String> {
    let transports = super::sorted_transports(t).await?;
    let addrs: Vec<String> = transports
        .into_iter()
        .map(|(_transport_id, transport)| transport.addr)
        .collect();
    Ok(addrs.join(" "))
}

async fn sorted_transport_ids(t: &TestContext) -> Result<Vec<u32>> {
    let transports = super::sorted_transports(t).await?;
    Ok(transports
        .into_iter()
        .map(|(transport_id, _transport)| transport_id)
        .collect())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_smtp_candidates() -> Result<()> {
    let mut tcm = TestContextManager::new();
    let t = &tcm.unconfigured().await;

    transport::add_pseudo_transport(t, "foo@example.net").await?;
    transport::add_pseudo_transport(t, "bar@example.net").await?;
    transport::add_pseudo_transport(t, "baz@example.net").await?;

    // By default first added transport is used first.
    assert_eq!(
        sorted_transport_addrs(t).await?,
        "foo@example.net bar@example.net baz@example.net"
    );
    assert_eq!(sorted_transport_ids(t).await?, [1, 2, 3]);

    super::record_success(t, 3).await?;
    assert_eq!(sorted_transport_ids(t).await?, [3, 1, 2]);

    super::record_success(t, 2).await?;
    assert_eq!(sorted_transport_ids(t).await?, [2, 3, 1]);

    super::record_success(t, 3).await?;
    assert_eq!(sorted_transport_ids(t).await?, [3, 2, 1]);

    super::record_failure(t, 3).await?;
    assert_eq!(sorted_transport_ids(t).await?, [2, 1, 3]);

    // New transport is added before all failing transports.
    transport::add_pseudo_transport(t, "qux@example.net").await?;
    assert_eq!(
        sorted_transport_addrs(t).await?,
        "bar@example.net foo@example.net qux@example.net baz@example.net"
    );
    assert_eq!(sorted_transport_ids(t).await?, [2, 1, 4, 3]);

    super::record_success(t, 4).await?;
    assert_eq!(sorted_transport_ids(t).await?, [4, 2, 1, 3]);

    super::record_failure(t, 4).await?;
    assert_eq!(sorted_transport_ids(t).await?, [2, 1, 3, 4]);
    super::record_failure(t, 3).await?;
    assert_eq!(sorted_transport_ids(t).await?, [2, 1, 4, 3]);
    super::record_failure(t, 2).await?;
    assert_eq!(sorted_transport_ids(t).await?, [1, 4, 3, 2]);

    Ok(())
}
