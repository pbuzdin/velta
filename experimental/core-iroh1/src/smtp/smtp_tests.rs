use anyhow::Result;

use crate::test_utils::TestContextManager;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_smtp_candidates() -> Result<()> {
    let mut tcm = TestContextManager::new();
    let t = &tcm.unconfigured().await;

    transport::add_pseudo_transport(t, "foo@example.net").await?;
    transport::add_pseudo_transport(t, "bar@example.net").await?;
    transport::add_pseudo_transport(t, "baz@example.net").await?;

    let transports = super::sorted_transports(t).await?;
    let [
        (transport_id1, ref transport1),
        (transport_id2, ref transport2),
        (transport_id3, ref transport3),
    ] = transports[..]
    else {
        panic!("Unexpected number of transports");
    };

    // By default first added transport is used first.
    assert_eq!(transport1.addr, "foo@example.net");
    assert_eq!(transport2.addr, "bar@example.net");
    assert_eq!(transport3.addr, "baz@example.net");

    super::record_success(t, transport_id3).await?;
    let transports2 = super::sorted_transports(t).await?;
    assert_eq!(transports2[0].0, transport_id3);
    assert_eq!(transports2[1].0, transport_id1);
    assert_eq!(transports2[2].0, transport_id2);

    super::record_success(t, transport_id2).await?;
    let transports3 = super::sorted_transports(t).await?;
    assert_eq!(transports3[0].0, transport_id2);
    assert_eq!(transports3[1].0, transport_id3);
    assert_eq!(transports3[2].0, transport_id1);

    super::record_success(t, transport_id3).await?;
    let transports4 = super::sorted_transports(t).await?;
    assert_eq!(transports4[0].0, transport_id3);
    assert_eq!(transports4[1].0, transport_id2);
    assert_eq!(transports4[2].0, transport_id1);

    Ok(())
}
