//! Windows side of the DNS tunnel (tunnel.rs): soartunnel.dll from the
//! bundle's resources, the adapters' DNS servers from GetAdaptersAddresses,
//! and the core reached over JSON-RPC (the deltachat-rpc-server sidecar).

use serde_json::{json, Value};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use tauri::Manager;

pub const LIB_NAME: &str = "soartunnel.dll";

/// The DLL ships as a bundle resource next to the sidecar. Always an
/// absolute path: a bare name would let LoadLibrary search the CWD/PATH.
pub fn lib_path(app: Option<&tauri::AppHandle>) -> PathBuf {
    use tauri::path::BaseDirectory;
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from));
    let candidates = [
        app.and_then(|a| a.path().resolve(LIB_NAME, BaseDirectory::Resource).ok()),
        exe_dir.as_ref().map(|d| d.join(LIB_NAME)),
        exe_dir.as_ref().map(|d| d.join("resources").join(LIB_NAME)),
    ];
    let mut first = None;
    for c in candidates.into_iter().flatten() {
        if c.is_file() {
            return c;
        }
        first.get_or_insert(c);
    }
    // Missing: libloading reports the error with this path.
    first.unwrap_or_else(|| PathBuf::from(LIB_NAME))
}

/// Interface types (ipifcons.h).
const IF_TYPE_ETHERNET_CSMACD: u32 = 6;
const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
const IF_TYPE_IEEE80211: u32 = 71;
const IF_TYPE_WWANPP: u32 = 243;
const IF_TYPE_WWANPP2: u32 = 244;
const IF_OPER_STATUS_UP: i32 = 1;

/// {"dns": ["192.168.1.1:53", "[2001:db8::1]:53"], "transport": "wifi",
/// "platform": "windows"}: the DNS servers of every adapter that is up,
/// the transport of the first one that has any. Shaped like NetInfo.kt's
/// snapshot so tunnel.rs treats both the same.
pub fn network_info() -> Option<Value> {
    let (dns, transport) = adapters_dns()?;
    Some(json!({"dns": dns, "transport": transport, "platform": "windows", "private_dns": false}))
}

fn transport_name(if_type: u32) -> &'static str {
    match if_type {
        IF_TYPE_IEEE80211 => "wifi",
        IF_TYPE_ETHERNET_CSMACD => "ethernet",
        IF_TYPE_WWANPP | IF_TYPE_WWANPP2 => "cellular",
        _ => "other",
    }
}

/// A resolver soar can use: no loopback / unspecified, no link-local IPv6
/// (needs a zone id) and not the fec0:0:0:ffff::1-3 placeholders Windows
/// lists on adapters without IPv6 DNS.
pub fn resolver_string(ip: std::net::IpAddr) -> Option<String> {
    match ip {
        std::net::IpAddr::V4(v4) if v4.is_loopback() || v4.is_unspecified() || v4.is_link_local() => None,
        std::net::IpAddr::V4(v4) => Some(format!("{v4}:53")),
        std::net::IpAddr::V6(v6) => {
            let seg = v6.segments();
            if v6.is_loopback() || v6.is_unspecified() || (seg[0] & 0xffc0) == 0xfe80 || (seg[0] & 0xffc0) == 0xfec0 {
                None
            } else if let Some(v4) = v6.to_ipv4_mapped() {
                resolver_string(v4.into())
            } else {
                Some(format!("[{v6}]:53"))
            }
        }
    }
}

fn adapters_dns() -> Option<(Vec<String>, &'static str)> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_FRIENDLY_NAME, GAA_FLAG_SKIP_MULTICAST,
        GAA_FLAG_SKIP_UNICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKADDR_IN6};

    const ERROR_BUFFER_OVERFLOW: u32 = 111;
    let flags = GAA_FLAG_SKIP_UNICAST | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_FRIENDLY_NAME;
    // u64 words keep the buffer aligned for the structs inside.
    let mut size: u32 = 16 * 1024;
    let mut buf: Vec<u64>;
    let mut tries = 0;
    loop {
        buf = vec![0u64; (size as usize).div_ceil(8)];
        let r = unsafe {
            GetAdaptersAddresses(AF_UNSPEC as u32, flags, std::ptr::null(), buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH, &mut size)
        };
        match r {
            0 => break,
            ERROR_BUFFER_OVERFLOW if tries < 3 => tries += 1,
            _ => return None,
        }
    }
    let mut dns = Vec::new();
    let mut transport = "other";
    let mut p = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !p.is_null() {
        let a = unsafe { &*p };
        p = a.Next;
        if a.OperStatus != IF_OPER_STATUS_UP || a.IfType == IF_TYPE_SOFTWARE_LOOPBACK {
            continue;
        }
        let before = dns.len();
        let mut d = a.FirstDnsServerAddress;
        while !d.is_null() {
            let server = unsafe { &*d };
            d = server.Next;
            let sa = server.Address.lpSockaddr;
            if sa.is_null() {
                continue;
            }
            let ip: std::net::IpAddr = unsafe {
                match (*sa).sa_family {
                    AF_INET => {
                        let s = &*(sa as *const SOCKADDR_IN);
                        Ipv4Addr::from(u32::from_be(s.sin_addr.S_un.S_addr)).into()
                    }
                    AF_INET6 => {
                        let s = &*(sa as *const SOCKADDR_IN6);
                        Ipv6Addr::from(s.sin6_addr.u.Byte).into()
                    }
                    _ => continue,
                }
            };
            if let Some(r) = resolver_string(ip) {
                if !dns.contains(&r) {
                    dns.push(r);
                }
            }
        }
        if before == 0 && dns.len() > before {
            transport = transport_name(a.IfType);
        }
    }
    Some((dns, transport))
}

fn app() -> Option<tauri::AppHandle> {
    super::imp::app_handle()
}

async fn call(method: &str, params: Value) -> Result<Value, String> {
    let app = app().ok_or("app not ready")?;
    crate::sidecar_call(&app, method, params).await
}

/// None until the sidecar answers.
pub async fn account_ids() -> Option<Vec<u32>> {
    let v = call("get_all_account_ids", json!([])).await.ok()?;
    serde_json::from_value(v).ok()
}

/// (proxy_url, proxy_enabled) of one account.
pub async fn proxy_config(id: u32) -> Option<(String, bool)> {
    let url = call("get_config", json!([id, "proxy_url"])).await.ok()?;
    let enabled = call("get_config", json!([id, "proxy_enabled"])).await.ok()?;
    Some((url.as_str().unwrap_or_default().to_string(), enabled.as_str() == Some("1")))
}

pub async fn set_config(id: u32, key: &str, value: Option<&str>) -> Result<(), String> {
    call("set_config", json!([id, key, value])).await.map(|_| ())
}

/// The sidecar has no restart_io_if_running: restart IO only for accounts
/// that are configured (the page starts IO for those at boot).
pub async fn restart_io(id: u32) {
    if call("is_configured", json!([id])).await.ok().and_then(|v| v.as_bool()) != Some(true) {
        return;
    }
    let _ = call("stop_io", json!([id])).await;
    let _ = call("start_io", json!([id])).await;
}

/// Tells the core the network changed; false when the sidecar is not up.
pub async fn maybe_network() -> bool {
    call("maybe_network", json!([])).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolver_filter() {
        assert_eq!(resolver_string("192.0.2.1".parse().unwrap()).as_deref(), Some("192.0.2.1:53"));
        assert_eq!(resolver_string("2001:db8::1".parse().unwrap()).as_deref(), Some("[2001:db8::1]:53"));
        assert_eq!(resolver_string("::ffff:192.0.2.1".parse().unwrap()).as_deref(), Some("192.0.2.1:53"));
        for bad in ["127.0.0.1", "0.0.0.0", "169.254.1.1", "::1", "fe80::1", "fec0:0:0:ffff::1"] {
            assert_eq!(resolver_string(bad.parse().unwrap()), None, "{bad}");
        }
    }
}
