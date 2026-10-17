//! Connects two iroh 1.3 endpoints via ONLY the given relay (no IP transports) and echoes data.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use iroh::dns::{BoxIter, DnsError, DnsResolver, Resolver, TxtRecordData};
use iroh::endpoint::presets;
use iroh::{Endpoint, RelayMode, RelayUrl};
use n0_future::boxed::BoxFuture;

const ALPN: &[u8] = b"velta/relay-probe/0";

/// Static resolver: the box's DNS returns fake IPs, so pin the relay host.
#[derive(Debug, Clone)]
struct Pinned(String, IpAddr);
impl Resolver for Pinned {
    fn lookup_ipv4(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv4Addr>, DnsError>> {
        let me = self.clone();
        Box::pin(async move {
            let v: Vec<Ipv4Addr> = match me.1 {
                IpAddr::V4(ip) if host.trim_end_matches('.') == me.0 => vec![ip],
                _ => vec![],
            };
            Ok(Box::new(v.into_iter()) as BoxIter<Ipv4Addr>)
        })
    }
    fn lookup_ipv6(&self, _host: String) -> BoxFuture<Result<BoxIter<Ipv6Addr>, DnsError>> {
        Box::pin(async move { Ok(Box::new(Vec::<Ipv6Addr>::new().into_iter()) as BoxIter<Ipv6Addr>) })
    }
    fn lookup_txt(&self, _host: String) -> BoxFuture<Result<BoxIter<TxtRecordData>, DnsError>> {
        Box::pin(async move { Ok(Box::new(Vec::<TxtRecordData>::new().into_iter()) as BoxIter<TxtRecordData>) })
    }
    fn clear_cache(&self) {}
    fn reset(&self) -> Box<dyn Resolver> {
        Box::new(self.clone())
    }
}

async fn ep(relay: &RelayUrl, pin: Option<&Pinned>) -> Result<Endpoint> {
    let mut b = Endpoint::builder(presets::Minimal)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::custom([relay.clone()]))
        .clear_ip_transports();
    if let Some(p) = pin {
        b = b.dns_resolver(DnsResolver::custom(p.clone()));
    }
    Ok(b.bind().await?)
}

#[tokio::main]
async fn main() -> Result<()> {
    let relay: RelayUrl = std::env::args().nth(1).context("usage: probe <relay-url> [pin-ip]")?.parse()?;
    let pin = std::env::args()
        .nth(2)
        .map(|ip| Ok::<_, anyhow::Error>(Pinned(relay.host_str().unwrap().to_string(), ip.parse()?)))
        .transpose()?;
    let t0 = Instant::now();
    let a = ep(&relay, pin.as_ref()).await?;
    let b = ep(&relay, pin.as_ref()).await?;
    for (n, e) in [("A", &a), ("B", &b)] {
        tokio::time::timeout(Duration::from_secs(20), e.online()).await.context("endpoint did not get home relay")?;
        let addr = e.addr();
        println!("{n} id={} addrs={:?}", e.id().fmt_short(), addr.addrs);
        if !addr.relay_urls().any(|u| u == &relay) {
            bail!("{n}: home relay is not {relay}");
        }
    }
    let b_addr = b.addr();
    let server = tokio::spawn(async move {
        let conn = b.accept().await.context("no incoming")?.await?;
        let (mut s, mut r) = conn.accept_bi().await?;
        let msg = r.read_to_end(1024).await?;
        s.write_all(&msg).await?;
        s.finish()?;
        conn.closed().await;
        b.close().await;
        anyhow::Ok(())
    });
    let conn = tokio::time::timeout(Duration::from_secs(20), a.connect(b_addr, ALPN)).await??;
    let (mut s, mut r) = conn.open_bi().await?;
    s.write_all(b"hello via a7 iroh-relay 1.x").await?;
    s.finish()?;
    let echo = r.read_to_end(1024).await?;
    println!("echo: {:?}", String::from_utf8_lossy(&echo));
    let paths = conn.paths();
    println!("paths: {paths:?}");
    assert_eq!(echo, b"hello via a7 iroh-relay 1.x");
    conn.close(0u32.into(), b"done");
    let _ = server.await;
    a.close().await;
    println!("OK in {:?}", t0.elapsed());
    Ok(())
}
