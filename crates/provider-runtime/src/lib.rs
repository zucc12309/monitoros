//! Guarded network egress for providers and add-ons (spec §8, §17).
//!
//! Every add-on/provider HTTP request from the UI goes through `guarded_get_json`:
//!  * https only, no userinfo, no private/loopback/link-local/metadata hosts
//!  * DNS is resolved *here*, every resolved address is checked, and the
//!    connection is pinned to a checked address (defeats DNS rebinding)
//!  * redirects are refused; response size and time are capped

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use url::{Host, Url};

pub const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum GuardError {
    #[error("invalid URL")]
    InvalidUrl,
    #[error("only https URLs are allowed")]
    Scheme,
    #[error("credentials in URLs are not allowed")]
    Credentials,
    #[error("host is not allowed: {0}")]
    BlockedHost(String),
    #[error("{0} resolves to a private or reserved address")]
    PrivateAddress(String),
    #[error("DNS lookup failed for {0}")]
    Dns(String),
    #[error("redirects are not followed; use the final URL")]
    Redirect,
    #[error("HTTP {0}")]
    Status(u16),
    #[error("response exceeds {MAX_BODY_BYTES} bytes")]
    TooLarge,
    #[error("request timed out")]
    Timeout,
    #[error("network error: {0}")]
    Network(String),
    #[error("response is not JSON")]
    NotJson,
}

pub fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || o[0] == 0
        || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        || o[0] >= 240
}

pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_ipv4(v4);
            }
            let seg0 = v6.segments()[0];
            v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (seg0 & 0xfe00) == 0xfc00 // ULA
                || (seg0 & 0xffc0) == 0xfe80 // link-local
                || v6 == Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0) // NAT64 prefix base
                || seg0 == 0x2001 && v6.segments()[1] == 0x0db8 // documentation
        }
    }
}

const BLOCKED_SUFFIXES: &[&str] = &[".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

/// Syntactic checks (no DNS). Mirrors packages/provider-sdk/src/url-guard.ts.
pub fn check_url(raw: &str) -> Result<Url, GuardError> {
    let url = Url::parse(raw.trim()).map_err(|_| GuardError::InvalidUrl)?;
    if url.scheme() != "https" {
        return Err(GuardError::Scheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(GuardError::Credentials);
    }
    match url.host() {
        None => Err(GuardError::InvalidUrl),
        Some(Host::Ipv4(ip)) if is_blocked_ipv4(ip) => Err(GuardError::PrivateAddress(ip.to_string())),
        Some(Host::Ipv6(ip)) if is_blocked_ip(IpAddr::V6(ip)) => Err(GuardError::PrivateAddress(ip.to_string())),
        Some(Host::Domain(d)) => {
            let d = d.to_ascii_lowercase();
            if d == "localhost" || !d.contains('.') || BLOCKED_SUFFIXES.iter().any(|s| d.ends_with(s)) || d == "metadata.google.internal" {
                Err(GuardError::BlockedHost(d))
            } else {
                Ok(url)
            }
        }
        Some(_) => Ok(url),
    }
}

/// Resolve and verify every address. Returns one safe address to pin to.
pub async fn resolve_public(url: &Url) -> Result<SocketAddr, GuardError> {
    let host = url.host_str().ok_or(GuardError::InvalidUrl)?.trim_matches(['[', ']']).to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|_| GuardError::Dns(host.clone()))?.collect();
    if addrs.is_empty() {
        return Err(GuardError::Dns(host));
    }
    if let Some(bad) = addrs.iter().find(|a| is_blocked_ip(a.ip())) {
        return Err(GuardError::PrivateAddress(format!("{host} ({})", bad.ip())));
    }
    Ok(addrs[0])
}

/// Policy for a request. Add-ons/providers always use `Strict`; `UserLan`
/// is only for sources the user explicitly marked as on their home network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Egress {
    Strict,
    UserLan,
}

async fn guarded_get_bytes(raw: &str, timeout: Duration, egress: Egress, accept: &str) -> Result<Vec<u8>, GuardError> {
    let (url, addr) = match egress {
        Egress::Strict => {
            let url = check_url(raw)?;
            let addr = resolve_public(&url).await?;
            (url, Some(addr))
        }
        Egress::UserLan => {
            let url = Url::parse(raw.trim()).map_err(|_| GuardError::InvalidUrl)?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err(GuardError::Scheme);
            }
            if !url.username().is_empty() || url.password().is_some() {
                return Err(GuardError::Credentials);
            }
            (url, None)
        }
    };
    let host = url.host_str().ok_or(GuardError::InvalidUrl)?.to_string();
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout.min(MAX_TIMEOUT))
        .user_agent(concat!("MonitorOS/", env!("CARGO_PKG_VERSION")));
    if let Some(addr) = addr {
        builder = builder.resolve(&host, addr); // pin: no second DNS lookup
    }
    let client = builder.build().map_err(|e| GuardError::Network(e.to_string()))?;
    let mut res = client.get(url).header("accept", accept).send().await.map_err(|e| {
        if e.is_timeout() {
            GuardError::Timeout
        } else {
            GuardError::Network(e.without_url().to_string())
        }
    })?;
    if res.status().is_redirection() {
        return Err(GuardError::Redirect);
    }
    if !res.status().is_success() {
        return Err(GuardError::Status(res.status().as_u16()));
    }
    if res.content_length().is_some_and(|l| l as usize > MAX_BODY_BYTES) {
        return Err(GuardError::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| GuardError::Network(e.without_url().to_string()))? {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(GuardError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub async fn guarded_get_json(raw: &str, timeout: Duration) -> Result<serde_json::Value, GuardError> {
    let body = guarded_get_bytes(raw, timeout, Egress::Strict, "application/json").await?;
    serde_json::from_slice(&body).map_err(|_| GuardError::NotJson)
}

pub async fn guarded_get_text(raw: &str, timeout: Duration, egress: Egress) -> Result<String, GuardError> {
    let body = guarded_get_bytes(raw, timeout, egress, "text/plain, audio/x-mpegurl, */*").await?;
    Ok(String::from_utf8_lossy(&body).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_and_reserved_literals() {
        for u in [
            "http://example.com",
            "file:///etc/passwd",
            "https://user:pw@example.com",
            "https://localhost/",
            "https://foo.local/",
            "https://intranet/",
            "https://127.0.0.1/",
            "https://127.1/",
            "https://2130706433/",
            "https://0x7f000001/",
            "https://10.1.2.3/",
            "https://172.16.0.1/",
            "https://192.168.0.1/",
            "https://169.254.169.254/",
            "https://100.64.0.1/",
            "https://0.0.0.0/",
            "https://[::1]/",
            "https://[fd12::1]/",
            "https://[fe80::1]/",
            "https://[::ffff:127.0.0.1]/",
        ] {
            assert!(check_url(u).is_err(), "{u} should be blocked");
        }
    }

    #[test]
    fn allows_public_https() {
        assert!(check_url("https://v3-cinemeta.strem.io/manifest.json").is_ok());
        assert!(check_url("https://8.8.8.8/").is_ok());
    }

    #[tokio::test]
    async fn user_lan_policy_still_refuses_non_http() {
        assert!(matches!(guarded_get_text("file:///etc/hosts", Duration::from_secs(1), Egress::UserLan).await, Err(GuardError::Scheme)));
        assert!(matches!(guarded_get_text("http://u:p@192.168.1.2/x.m3u", Duration::from_secs(1), Egress::UserLan).await, Err(GuardError::Credentials)));
        assert!(guarded_get_text("http://192.168.1.2/x.m3u", Duration::from_secs(1), Egress::Strict).await.is_err());
    }

    #[tokio::test]
    async fn redirects_are_refused() {
        // Local server answering with a redirect; reachable only under the user-LAN policy.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            let _ = s.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\nContent-Length: 0\r\n\r\n").await;
        });
        let r = guarded_get_text(&format!("http://{addr}/list.m3u"), Duration::from_secs(3), Egress::UserLan).await;
        assert!(matches!(r, Err(GuardError::Redirect)), "{r:?}");
    }

    #[tokio::test]
    async fn dns_names_resolving_to_loopback_are_blocked() {
        // localtest.me-style names are common rebinding vectors; use a name we
        // know resolves locally without network: "localhost." passes the
        // syntactic dot check, so the DNS check must catch it.
        let url = Url::parse("https://localhost./x").unwrap();
        match resolve_public(&url).await {
            Err(GuardError::PrivateAddress(_)) | Err(GuardError::Dns(_)) => {}
            other => panic!("expected block, got {other:?}"),
        }
    }
}
