//! Per-operation outbound proxy that pins every destination to a vetted IP.
//!
//! yt-dlp follows extractor-supplied URLs and redirects itself, so checking a
//! URL once before launching the process is not a network security boundary.
//! Every HTTP request and HTTPS CONNECT sent through this short-lived proxy is
//! resolved and checked again here, then connected to the exact vetted
//! address. Client networking runs as bounded tasks on Tauri's Tokio runtime;
//! DNS uses an independent fixed-size resolver and drops cancelled queued jobs.
//!
//! When the user configures an upstream HTTP proxy, the vetted destination is
//! reached through it instead: CONNECT for HTTPS, and absolute-form requests
//! for plain HTTP. The destination is still resolved and vetted locally first,
//! and the upstream itself is not vetted (it is the user's own proxy).

use crate::constants::MAX_UPSTREAM_PROXY_BYTES;
use crate::ip_policy::is_public_ip;
use reqwest::redirect::Policy;
use reqwest::Client;
use std::collections::VecDeque;
#[cfg(feature = "e2e")]
use std::io::{self, Read, Write};
#[cfg(feature = "e2e")]
use std::net::TcpStream;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Condvar, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant};

const MAX_PROXY_HEADER_BYTES: usize = 64 * 1024;
/// Status line and headers of the upstream proxy's answer to CONNECT.
const MAX_UPSTREAM_RESPONSE_HEADER_BYTES: usize = 16 * 1024;
const MAX_HTTP_REQUEST_BODY_BYTES: u64 = 64 * 1024 * 1024;
const THUMBNAIL_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Per-address connect attempt.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
/// Budget for all addresses of one destination.
const CONNECT_TOTAL_TIMEOUT: Duration = Duration::from_secs(12);
const IO_TIMEOUT: Duration = Duration::from_secs(20);
/// A tunnel with no traffic in either direction for this long is closed.
/// yt-dlp reopens a dropped pooled connection on its next request.
const TUNNEL_IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const RELAY_BUFFER_BYTES: usize = 16 * 1024;
const DNS_RESOLVER_WORKERS: usize = 4;
const MAX_PENDING_DNS_QUERIES: usize = 16;
const MAX_DNS_ANSWER_COUNT: usize = 32;
const DNS_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(5);
const DNS_RESOLUTION_POLL_INTERVAL: Duration = Duration::from_millis(25);
const DNS_RESOLVER_START_TIMEOUT: Duration = Duration::from_secs(1);
#[cfg(feature = "e2e")]
const E2E_DNS_DELAY: Duration = Duration::from_secs(2);

static DNS_RESOLVER: OnceLock<Option<Arc<DnsResolverPool>>> = OnceLock::new();
static NEXT_DNS_JOB_ID: AtomicU64 = AtomicU64::new(1);

struct DnsJob {
    id: u64,
    host: String,
    port: u16,
    cancelled: Arc<AtomicBool>,
    response: SyncSender<Option<Vec<SocketAddr>>>,
}

struct DnsResolverState {
    queue: VecDeque<DnsJob>,
    stopped: bool,
    #[cfg(feature = "e2e")]
    workers_started: usize,
    #[cfg(feature = "e2e")]
    active_workers: usize,
    #[cfg(feature = "e2e")]
    max_active_workers: usize,
    #[cfg(feature = "e2e")]
    peak_queue_len: usize,
    #[cfg(feature = "e2e")]
    request_attempts: u64,
    #[cfg(feature = "e2e")]
    rejected_requests: u64,
    #[cfg(feature = "e2e")]
    cancelled_waits: u64,
    #[cfg(feature = "e2e")]
    synthetic_lookups_started: u64,
}

struct DnsResolverShared {
    state: Mutex<DnsResolverState>,
    queue_ready: Condvar,
}

struct DnsResolverPool {
    shared: Arc<DnsResolverShared>,
}

struct PendingDnsJob {
    id: u64,
    cancelled: Arc<AtomicBool>,
    response: Receiver<Option<Vec<SocketAddr>>>,
    shared: Arc<DnsResolverShared>,
    finished: bool,
}

impl PendingDnsJob {
    fn finish(&mut self) {
        self.finished = true;
    }

    fn cancel(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        if self.cancelled.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let queued_len = state.queue.len();
        state.queue.retain(|job| job.id != self.id);
        #[cfg(feature = "e2e")]
        {
            state.cancelled_waits = state.cancelled_waits.saturating_add(1);
        }
        if state.queue.len() != queued_len {
            drop(state);
            self.shared.queue_ready.notify_one();
        }
    }
}

impl Drop for PendingDnsJob {
    fn drop(&mut self) {
        self.cancel();
    }
}

type ParsedHttpRequest = (String, String, String, Vec<(String, String)>);

#[path = "network_security_async.rs"]
mod async_proxy;
pub use async_proxy::NetworkSecurityGuard;

/// A validated upstream HTTP proxy. The host is kept without IPv6 brackets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpstreamProxy {
    host: String,
    port: u16,
}

/// Parses the `upstreamProxy` setting. An empty value means direct
/// connections. Otherwise the value must be `http://HOST:PORT` (IPv6 hosts in
/// brackets), with at most one trailing `/`. Credentials, paths, queries,
/// fragments, whitespace, other schemes, and values over the byte limit are
/// refused, because the upstream connection carries no proxy authentication.
pub fn parse_upstream_proxy(value: &str) -> Result<Option<UpstreamProxy>, String> {
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_UPSTREAM_PROXY_BYTES {
        return Err(format!(
            "upstreamProxy exceeds maximum length of {MAX_UPSTREAM_PROXY_BYTES}."
        ));
    }
    let invalid = || {
        "upstreamProxy must be empty or http://HOST:PORT, with no credentials, path, query, or fragment."
            .to_string()
    };
    if value
        .bytes()
        .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err(invalid());
    }
    let rest = match value.get(..7) {
        Some(scheme) if scheme.eq_ignore_ascii_case("http://") => &value[7..],
        _ => return Err(invalid()),
    };
    if rest.contains(['@', '?', '#']) {
        return Err(invalid());
    }
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.contains('/') {
        return Err(invalid());
    }
    let (host, port_text) = if let Some(bracketed) = authority.strip_prefix('[') {
        let (address, after) = bracketed.split_once(']').ok_or_else(invalid)?;
        address.parse::<Ipv6Addr>().map_err(|_| invalid())?;
        let port_text = after.strip_prefix(':').ok_or_else(invalid)?;
        (address.to_string(), port_text)
    } else {
        let (host, port_text) = authority.rsplit_once(':').ok_or_else(invalid)?;
        if !is_valid_proxy_host(host) {
            return Err(invalid());
        }
        (host.to_string(), port_text)
    };
    let port = parse_proxy_port(port_text).ok_or_else(invalid)?;
    Ok(Some(UpstreamProxy { host, port }))
}

fn is_valid_proxy_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    if host
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return host.parse::<Ipv4Addr>().is_ok();
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn parse_proxy_port(text: &str) -> Option<u16> {
    if text.is_empty() || text.len() > 5 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<u16>().ok().filter(|port| *port != 0)
}

#[cfg(feature = "e2e")]
#[derive(Clone, Copy)]
struct DnsResolverSnapshot {
    workers_started: usize,
    active_workers: usize,
    max_active_workers: usize,
    queue_len: usize,
    peak_queue_len: usize,
    request_attempts: u64,
    rejected_requests: u64,
    cancelled_waits: u64,
    synthetic_lookups_started: u64,
}

impl DnsResolverPool {
    fn start() -> Result<Self, String> {
        let shared = Arc::new(DnsResolverShared {
            state: Mutex::new(DnsResolverState {
                queue: VecDeque::new(),
                stopped: false,
                #[cfg(feature = "e2e")]
                workers_started: 0,
                #[cfg(feature = "e2e")]
                active_workers: 0,
                #[cfg(feature = "e2e")]
                max_active_workers: 0,
                #[cfg(feature = "e2e")]
                peak_queue_len: 0,
                #[cfg(feature = "e2e")]
                request_attempts: 0,
                #[cfg(feature = "e2e")]
                rejected_requests: 0,
                #[cfg(feature = "e2e")]
                cancelled_waits: 0,
                #[cfg(feature = "e2e")]
                synthetic_lookups_started: 0,
            }),
            queue_ready: Condvar::new(),
        });
        let (ready_sender, ready_receiver) = mpsc::channel();

        for worker in 0..DNS_RESOLVER_WORKERS {
            let worker_shared = Arc::clone(&shared);
            let worker_ready = ready_sender.clone();
            if let Err(error) = thread::Builder::new()
                .name(format!("rosi-dns-resolver-{worker}"))
                .spawn(move || {
                    #[cfg(feature = "e2e")]
                    {
                        let mut state = worker_shared
                            .state
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        state.workers_started += 1;
                    }
                    let _ = worker_ready.send(());
                    dns_resolver_worker(worker_shared);
                })
            {
                stop_dns_resolver(&shared);
                return Err(format!("Could not start the bounded DNS resolver: {error}"));
            }
        }
        drop(ready_sender);

        for _ in 0..DNS_RESOLVER_WORKERS {
            if ready_receiver
                .recv_timeout(DNS_RESOLVER_START_TIMEOUT)
                .is_err()
            {
                stop_dns_resolver(&shared);
                return Err("The bounded DNS resolver did not start in time.".into());
            }
        }

        Ok(Self { shared })
    }

    fn enqueue(&self, host: &str, port: u16) -> Option<PendingDnsJob> {
        let id = NEXT_DNS_JOB_ID.fetch_add(1, Ordering::Relaxed);
        let cancelled = Arc::new(AtomicBool::new(false));
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        let mut state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        #[cfg(feature = "e2e")]
        {
            state.request_attempts = state.request_attempts.saturating_add(1);
        }
        if state.stopped || state.queue.len() >= MAX_PENDING_DNS_QUERIES {
            #[cfg(feature = "e2e")]
            {
                state.rejected_requests = state.rejected_requests.saturating_add(1);
            }
            return None;
        }
        state.queue.push_back(DnsJob {
            id,
            host: host.to_owned(),
            port,
            cancelled: Arc::clone(&cancelled),
            response: response_sender,
        });
        #[cfg(feature = "e2e")]
        {
            state.peak_queue_len = state.peak_queue_len.max(state.queue.len());
        }
        drop(state);
        self.shared.queue_ready.notify_one();
        Some(PendingDnsJob {
            id,
            cancelled,
            response: response_receiver,
            shared: Arc::clone(&self.shared),
            finished: false,
        })
    }

    fn cancel(&self, pending: &mut PendingDnsJob) {
        pending.cancel();
    }

    #[cfg(feature = "e2e")]
    fn snapshot(&self) -> DnsResolverSnapshot {
        let state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        DnsResolverSnapshot {
            workers_started: state.workers_started,
            active_workers: state.active_workers,
            max_active_workers: state.max_active_workers,
            queue_len: state.queue.len(),
            peak_queue_len: state.peak_queue_len,
            request_attempts: state.request_attempts,
            rejected_requests: state.rejected_requests,
            cancelled_waits: state.cancelled_waits,
            synthetic_lookups_started: state.synthetic_lookups_started,
        }
    }
}

fn shared_dns_resolver() -> Option<Arc<DnsResolverPool>> {
    DNS_RESOLVER
        .get_or_init(|| DnsResolverPool::start().ok().map(Arc::new))
        .clone()
}

fn stop_dns_resolver(shared: &DnsResolverShared) {
    let mut state = shared
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.stopped = true;
    for job in state.queue.drain(..) {
        job.cancelled.store(true, Ordering::Release);
    }
    drop(state);
    shared.queue_ready.notify_all();
}

fn dns_resolver_worker(shared: Arc<DnsResolverShared>) {
    loop {
        let job = {
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            loop {
                if state.stopped {
                    return;
                }
                if let Some(job) = state.queue.pop_front() {
                    #[cfg(feature = "e2e")]
                    {
                        state.active_workers += 1;
                        state.max_active_workers =
                            state.max_active_workers.max(state.active_workers);
                    }
                    break job;
                }
                state = shared
                    .queue_ready
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        };

        let resolved = if job.cancelled.load(Ordering::Acquire) {
            None
        } else {
            resolve_dns_addresses(&job.host, job.port, &shared)
        };
        let _ = job.response.send(resolved);
        #[cfg(feature = "e2e")]
        {
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.active_workers = state.active_workers.saturating_sub(1);
        }
    }
}

fn resolve_dns_addresses(
    host: &str,
    port: u16,
    shared: &DnsResolverShared,
) -> Option<Vec<SocketAddr>> {
    #[cfg(not(feature = "e2e"))]
    let _ = shared;

    #[cfg(feature = "e2e")]
    if host.starts_with("rosi-dns-delay-") {
        record_proxy_decision("dns-resolving", host, &[], false);
        {
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.synthetic_lookups_started = state.synthetic_lookups_started.saturating_add(1);
        }
        thread::sleep(E2E_DNS_DELAY);
        return Some(vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)]);
    }

    let addresses = (host, port).to_socket_addrs().ok()?;
    let mut resolved = Vec::new();
    for address in addresses {
        if resolved.len() >= MAX_DNS_ANSWER_COUNT {
            return None;
        }
        resolved.push(address);
    }
    Some(resolved)
}

fn parse_request(header_text: &str) -> Option<ParsedHttpRequest> {
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next()?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next()?.to_owned();
    let target = request_parts.next()?.to_owned();
    let version = request_parts.next()?.to_owned();
    if request_parts.next().is_some()
        || !matches!(version.as_str(), "HTTP/1.0" | "HTTP/1.1")
        || method.is_empty()
        || !method.bytes().all(is_header_token_byte)
    {
        return None;
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            return None;
        }
        let (name, value) = line.split_once(':')?;
        if name.is_empty() || !name.bytes().all(is_header_token_byte) {
            return None;
        }
        headers.push((name.to_owned(), value.trim().to_owned()));
    }
    Some((method, target, version, headers))
}

fn is_header_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

enum HttpBodyMode {
    None,
    ContentLength(u64),
    Chunked,
}

fn build_forwarded_request(
    method: &str,
    version: &str,
    url: &url::Url,
    headers: &[(String, String)],
    absolute_form: bool,
) -> Option<(Vec<u8>, HttpBodyMode, bool)> {
    let content_lengths: Vec<&str> = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.as_str())
        .collect();
    let transfer_encodings: Vec<&str> = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"))
        .map(|(_, value)| value.as_str())
        .collect();
    if content_lengths.len() > 1 || transfer_encodings.len() > 1 {
        return None;
    }
    let content_length = content_lengths
        .first()
        .map(|value| value.parse::<u64>())
        .transpose()
        .ok()?;
    if content_length.is_some_and(|length| length > MAX_HTTP_REQUEST_BODY_BYTES) {
        return None;
    }
    let body_mode = match (content_length, transfer_encodings.first()) {
        (Some(_), Some(_)) => return None,
        (Some(length), None) if length > 0 => HttpBodyMode::ContentLength(length),
        (Some(_), None) | (None, None) => HttpBodyMode::None,
        (None, Some(value)) if value.eq_ignore_ascii_case("chunked") => HttpBodyMode::Chunked,
        (None, Some(_)) => return None,
    };

    let mut connection_tokens = Vec::new();
    for (_, value) in headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("connection"))
    {
        connection_tokens.extend(
            value
                .split(',')
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(str::to_ascii_lowercase),
        );
    }
    let expect_continue = headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("expect") && value.eq_ignore_ascii_case("100-continue")
    });
    let url_host = url.host()?;
    let host = host_string(&url_host);
    let port = url.port_or_known_default()?;
    let host_authority = if matches!(url_host, url::Host::Ipv6(_)) {
        format!("[{host}]")
    } else {
        host
    };
    let authority = if url.port().is_some() || port != 80 {
        format!("{host_authority}:{port}")
    } else {
        host_authority
    };
    let mut target = if url.path().is_empty() {
        "/".to_owned()
    } else {
        url.path().to_owned()
    };
    if let Some(query) = url.query() {
        target.push('?');
        target.push_str(query);
    }
    if absolute_form {
        target = format!("http://{authority}{target}");
    }
    let mut request = format!("{method} {target} {version}\r\n").into_bytes();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host"
                | "connection"
                | "proxy-authorization"
                | "proxy-authenticate"
                | "proxy-connection"
                | "keep-alive"
                | "upgrade"
                | "expect"
        ) || connection_tokens.iter().any(|token| token == &lower)
        {
            continue;
        }
        request.extend_from_slice(name.as_bytes());
        request.extend_from_slice(b": ");
        request.extend_from_slice(value.as_bytes());
        request.extend_from_slice(b"\r\n");
    }
    request.extend_from_slice(format!("Host: {authority}\r\nConnection: close\r\n\r\n").as_bytes());
    Some((request, body_mode, expect_continue))
}

fn parse_connect_target(target: &str) -> Result<(String, u16, bool), ()> {
    let url = url::Url::parse(&format!("https://{target}/")).map_err(|_| ())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(());
    }
    let url_host = url.host().ok_or(())?;
    let host = host_string(&url_host);
    let port = url.port_or_known_default().ok_or(())?;
    let is_literal_loopback = host_is_loopback(&url_host);
    Ok((host, port, is_literal_loopback))
}

fn host_string(host: &url::Host<&str>) -> String {
    match host {
        url::Host::Domain(domain) => (*domain).to_owned(),
        url::Host::Ipv4(address) => address.to_string(),
        url::Host::Ipv6(address) => address.to_string(),
    }
}

fn host_is_loopback(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Ipv4(address) => address.is_loopback(),
        url::Host::Ipv6(address) => address.is_loopback(),
        url::Host::Domain(_) => false,
    }
}

/// Resolves a destination and applies the policy. Returns the vetted addresses
/// only when every one is allowed; the caller must connect to those exact
/// addresses (direct) or hand the hostname to the upstream proxy.
fn parse_status_code(head: &[u8]) -> Option<u16> {
    let line_end = head
        .windows(2)
        .position(|window| window == b"\r\n")
        .unwrap_or(head.len());
    let line = std::str::from_utf8(&head[..line_end]).ok()?;
    let mut parts = line.splitn(3, ' ');
    let version = parts.next()?;
    let code = parts.next()?;
    if version != "HTTP/1.0" && version != "HTTP/1.1" {
        return None;
    }
    if code.len() != 3 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    code.parse::<u16>().ok()
}

/// Alternate address families, keeping the resolver's order within each.
fn interleave_address_families(addresses: Vec<SocketAddr>) -> Vec<SocketAddr> {
    let first_is_v6 = addresses.first().is_some_and(SocketAddr::is_ipv6);
    let (mut preferred, mut other): (VecDeque<_>, VecDeque<_>) = addresses
        .into_iter()
        .partition(|address| address.is_ipv6() == first_is_v6);
    let mut ordered = Vec::with_capacity(preferred.len() + other.len());
    loop {
        match (preferred.pop_front(), other.pop_front()) {
            (None, None) => break,
            (first, second) => ordered.extend(first.into_iter().chain(second)),
        }
    }
    ordered
}

fn parse_ip_host(host: &str) -> Option<IpAddr> {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
        .parse::<IpAddr>()
        .ok()
}

fn resolve_destination(host: &str, port: u16) -> Option<Vec<SocketAddr>> {
    if let Some(ip) = parse_ip_host(host) {
        return Some(vec![SocketAddr::new(ip, port)]);
    }
    #[cfg(feature = "e2e")]
    if let Some(mapped) = e2e_preflight_dns_override(host) {
        return Some(vec![SocketAddr::new(mapped, port)]);
    }
    resolve_system_dns(host, port)
}

fn resolve_system_dns(host: &str, port: u16) -> Option<Vec<SocketAddr>> {
    resolve_system_dns_with_cancel(host, port, None)
}

fn resolve_system_dns_with_cancel(
    host: &str,
    port: u16,
    cancelled: Option<&AtomicBool>,
) -> Option<Vec<SocketAddr>> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return None;
    }
    let resolver = shared_dns_resolver()?;
    let mut pending = resolver.enqueue(host, port)?;
    let deadline = Instant::now() + DNS_RESOLUTION_TIMEOUT;

    loop {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            resolver.cancel(&mut pending);
            return None;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            resolver.cancel(&mut pending);
            return None;
        }
        match pending
            .response
            .recv_timeout(remaining.min(DNS_RESOLUTION_POLL_INTERVAL))
        {
            Ok(result) => {
                pending.finish();
                return result;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                pending.finish();
                return None;
            }
        }
    }
}

#[cfg(feature = "e2e")]
fn e2e_preflight_dns_override(host: &str) -> Option<IpAddr> {
    let configured = std::env::var("ROSI_E2E_DNS_MAP").ok()?;
    configured
        .split(',')
        .filter_map(|mapping| mapping.trim().split_once('='))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case(host))
        .and_then(|(_, address)| address.trim().parse::<IpAddr>().ok())
}

#[cfg(feature = "e2e")]
fn e2e_proxy_dns_override(host: &str) -> Option<IpAddr> {
    let configured = std::env::var("ROSI_E2E_PROXY_DNS_MAP").ok()?;
    configured
        .split(',')
        .filter_map(|mapping| mapping.trim().split_once('='))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case(host))
        .and_then(|(_, address)| address.trim().parse::<IpAddr>().ok())
}

#[cfg(feature = "e2e")]
fn record_proxy_decision(stage: &str, host: &str, addresses: &[SocketAddr], allowed: bool) {
    use std::fs::OpenOptions;

    static TRACE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let Some(path) = std::env::var_os("ROSI_E2E_PROXY_TRACE") else {
        return;
    };
    let _lock = TRACE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Ok(mut trace) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let addresses = addresses
        .iter()
        .map(|address| address.ip().to_string())
        .collect::<Vec<_>>();
    let event = serde_json::json!({
        "stage": stage,
        "host": host,
        "addresses": addresses,
        "allowed": allowed,
    });
    let _ = writeln!(trace, "{event}");
}

fn e2e_allows_literal_loopback(host: &str, address: IpAddr) -> bool {
    #[cfg(feature = "e2e")]
    {
        std::env::var("ROSI_E2E_ALLOW_LOOPBACK").as_deref() == Ok("1")
            && parse_ip_host(host)
                .is_some_and(|literal| literal == address && literal.is_loopback())
    }
    #[cfg(not(feature = "e2e"))]
    {
        let _ = (host, address);
        false
    }
}

/// Resolves a web URL and requires every returned address to be public. The
/// E2E-only exception applies to an explicit literal loopback address when the
/// runner opted in; DNS aliases to loopback are never granted it.
pub fn is_public_http_destination(value: &str, allow_e2e_loopback: bool) -> bool {
    let Ok(url) = url::Url::parse(value.trim()) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(url_host) = url.host() else {
        return false;
    };
    let host = host_string(&url_host);
    let Some(port) = url.port_or_known_default() else {
        return false;
    };
    let allow_loopback = allow_e2e_loopback && host_is_loopback(&url_host);
    let Some(addresses) = resolve_destination(&host, port) else {
        #[cfg(feature = "e2e")]
        record_proxy_decision("preflight", &host, &[], false);
        return false;
    };
    let allowed = !addresses.is_empty()
        && addresses.iter().all(|address| {
            is_public_ip(address.ip())
                || (allow_loopback && e2e_allows_literal_loopback(&host, address.ip()))
        });
    #[cfg(feature = "e2e")]
    record_proxy_decision("preflight", &host, &addresses, allowed);
    allowed
}

/// Fetches an extractor-selected thumbnail through the active pinned proxy
/// and returns a bounded raster data URL. Network, redirect, decoding, size,
/// or MIME failures omit the thumbnail without failing video metadata.
pub fn fetch_thumbnail_data_url(guard: &NetworkSecurityGuard, value: &str) -> Option<String> {
    let initial = match url::Url::parse(value.trim()) {
        Ok(url) => url,
        Err(_) => return None,
    };
    if !matches!(initial.scheme(), "http" | "https")
        || !initial.username().is_empty()
        || initial.password().is_some()
        || !crate::validation::is_syntactically_safe_http_url(value)
    {
        return None;
    }
    let proxy = match reqwest::Proxy::all(guard.proxy_url()) {
        Ok(proxy) => proxy,
        Err(_) => return None,
    };
    let builder = Client::builder()
        .proxy(proxy)
        .redirect(Policy::limited(5))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(Duration::from_secs(10));
    let builder = add_e2e_test_ca(builder)?;
    tauri::async_runtime::block_on(async move {
        let client = match builder.build() {
            Ok(client) => client,
            Err(_) => return None,
        };
        let mut response = match client
            .get(initial)
            .header(reqwest::header::ACCEPT, "image/png, image/jpeg, image/webp")
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return None,
        };
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > THUMBNAIL_MAX_BYTES as u64)
        {
            return None;
        }
        let mut bytes = Vec::with_capacity(response.content_length().unwrap_or(0) as usize);
        while let Some(chunk) = match response.chunk().await {
            Ok(chunk) => chunk,
            Err(_) => return None,
        } {
            if bytes.len().saturating_add(chunk.len()) > THUMBNAIL_MAX_BYTES {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return None;
        }
        let mime = sniff_raster_mime(&bytes)?;
        Some(format!("data:{mime};base64,{}", base64_encode(&bytes)))
    })
}

fn add_e2e_test_ca(builder: reqwest::ClientBuilder) -> Option<reqwest::ClientBuilder> {
    #[cfg(feature = "e2e")]
    {
        let Ok(certificate_path) = std::env::var("ROSI_E2E_TLS_CA") else {
            return Some(builder);
        };
        if certificate_path.trim().is_empty() {
            return Some(builder);
        }
        let bytes = std::fs::read(certificate_path).ok()?;
        let certificate = reqwest::Certificate::from_pem(&bytes).ok()?;
        Some(builder.add_root_certificate(certificate))
    }
    #[cfg(not(feature = "e2e"))]
    {
        Some(builder)
    }
}

fn sniff_raster_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        encoded.push(ALPHABET[(first >> 2) as usize] as char);
        encoded.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            encoded.push(ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() > 2 {
            encoded.push(ALPHABET[(third & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
    }
    encoded
}

#[cfg(feature = "e2e")]
fn e2e_dns_cancellation_probe() -> Result<serde_json::Value, String> {
    const BATCHES: usize = 3;
    const CALLERS_PER_BATCH: usize = 24;

    let resolver = shared_dns_resolver().ok_or("bounded DNS resolver did not start")?;
    let mut max_caller_return = Duration::ZERO;
    let mut max_time_to_capacity = Duration::ZERO;
    let mut callers_returned_without_answer = 0usize;
    let probe_started = Instant::now();

    // Lookups from earlier specs or batches can still hold workers. Wait
    // for a quiet pool, within one shared budget, so baselines start clean.
    let wait_for_idle = |budget: Duration| {
        let started = Instant::now();
        let idle = loop {
            let snapshot = resolver.snapshot();
            if snapshot.active_workers == 0 && snapshot.queue_len == 0 {
                break true;
            }
            if started.elapsed() >= budget {
                break false;
            }
            thread::sleep(Duration::from_millis(10));
        };
        (idle, started.elapsed())
    };
    let mut idle_budget_left = Duration::from_secs(20);
    let mut idle_wait = Duration::ZERO;
    let mut idle_reached = true;
    let (idle, waited) = wait_for_idle(idle_budget_left);
    idle_wait += waited;
    idle_budget_left = idle_budget_left.saturating_sub(waited);
    idle_reached &= idle;
    let before = resolver.snapshot();

    for batch in 0..BATCHES {
        let (idle, waited) = wait_for_idle(idle_budget_left);
        idle_wait += waited;
        idle_budget_left = idle_budget_left.saturating_sub(waited);
        idle_reached &= idle;
        // Per-batch baseline: the probe-wide one goes stale after batch 0.
        let batch_before = resolver.snapshot();
        let batch_start = Instant::now();
        let cancellations = (0..CALLERS_PER_BATCH)
            .map(|_| Arc::new(AtomicBool::new(false)))
            .collect::<Vec<_>>();
        let (result_sender, result_receiver) = mpsc::channel();
        let mut callers = Vec::with_capacity(CALLERS_PER_BATCH);
        let mut spawn_error = None;

        for (index, cancellation) in cancellations.iter().enumerate() {
            let cancellation = Arc::clone(cancellation);
            let result_sender = result_sender.clone();
            let host = format!("rosi-dns-delay-{batch}-{index}.invalid");
            match thread::Builder::new()
                .name(format!("rosi-e2e-dns-caller-{batch}-{index}"))
                .spawn(move || {
                    let started = Instant::now();
                    let result = resolve_system_dns_with_cancel(&host, 443, Some(&cancellation));
                    let _ = result_sender.send((started.elapsed(), result.is_none()));
                }) {
                Ok(caller) => callers.push(caller),
                Err(error) => {
                    spawn_error = Some(error.to_string());
                    break;
                }
            }
        }
        drop(result_sender);

        // Latched per batch: a loaded runner may only show full capacity in a
        // sample that is later drained by a finishing worker.
        let submit_deadline = batch_start + Duration::from_secs(5);
        let mut all_attempted = false;
        let mut reached_capacity = false;
        let mut time_to_capacity = None;
        let mut last_queue_len = 0;
        let mut last_active = 0;
        let mut max_queue_len = 0;
        let mut max_active = 0;
        while Instant::now() < submit_deadline {
            let snapshot = resolver.snapshot();
            last_queue_len = snapshot.queue_len;
            last_active = snapshot.active_workers;
            max_queue_len = max_queue_len.max(snapshot.queue_len);
            max_active = max_active.max(snapshot.active_workers);
            let attempts = snapshot
                .request_attempts
                .saturating_sub(batch_before.request_attempts);
            all_attempted |= attempts >= CALLERS_PER_BATCH as u64;
            if !reached_capacity
                && snapshot.queue_len == MAX_PENDING_DNS_QUERIES
                && snapshot.active_workers == DNS_RESOLVER_WORKERS
                && snapshot.synthetic_lookups_started > batch_before.synthetic_lookups_started
            {
                reached_capacity = true;
                time_to_capacity = Some(batch_start.elapsed());
            }
            if all_attempted && reached_capacity {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        max_time_to_capacity = max_time_to_capacity.max(time_to_capacity.unwrap_or(Duration::ZERO));

        for cancellation in &cancellations {
            cancellation.store(true, Ordering::Release);
        }
        for caller in callers {
            let _ = caller.join();
        }
        while let Ok((elapsed, returned_without_answer)) = result_receiver.try_recv() {
            max_caller_return = max_caller_return.max(elapsed);
            callers_returned_without_answer += usize::from(returned_without_answer);
        }

        if let Some(error) = spawn_error {
            return Err(format!("could not start bounded DNS E2E caller: {error}"));
        }
        if !all_attempted || !reached_capacity {
            let end = resolver.snapshot();
            return Err(format!(
                "bounded DNS E2E callers did not reach the resolver queue limit (batch={batch} elapsedMs={} lastQueueLen={last_queue_len} lastActiveWorkers={last_active} maxQueueLen={max_queue_len} maxActiveWorkers={max_active} attemptsDelta={} syntheticLookupsDelta={} rejectedDelta={} workersStarted={} idleReached={idle} idleWaitMs={} allAttempted={all_attempted} reachedCapacity={reached_capacity})",
                batch_start.elapsed().as_millis(),
                end.request_attempts.saturating_sub(batch_before.request_attempts),
                end.synthetic_lookups_started.saturating_sub(batch_before.synthetic_lookups_started),
                end.rejected_requests.saturating_sub(batch_before.rejected_requests),
                end.workers_started,
                idle_wait.as_millis(),
            ));
        }
    }

    let drain_deadline = Instant::now() + E2E_DNS_DELAY + Duration::from_secs(1);
    loop {
        let snapshot = resolver.snapshot();
        if snapshot.active_workers == 0 && snapshot.queue_len == 0 {
            break;
        }
        if Instant::now() >= drain_deadline {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    let after = resolver.snapshot();
    Ok(serde_json::json!({
        "batches": BATCHES,
        "requestAttempts": after.request_attempts.saturating_sub(before.request_attempts),
        "workersStarted": after.workers_started,
        "workerLimit": DNS_RESOLVER_WORKERS,
        "maxActiveWorkers": after.max_active_workers,
        "queueHighWater": after.peak_queue_len,
        "queueLimit": MAX_PENDING_DNS_QUERIES,
        "rejectedRequests": after.rejected_requests.saturating_sub(before.rejected_requests),
        "cancelledWaits": after.cancelled_waits.saturating_sub(before.cancelled_waits),
        "syntheticLookupsStarted": after.synthetic_lookups_started.saturating_sub(before.synthetic_lookups_started),
        "syntheticDelayMs": E2E_DNS_DELAY.as_millis(),
        "maxCallerReturnMs": max_caller_return.as_millis(),
        "maxTimeToCapacityMs": max_time_to_capacity.as_millis(),
        "idleReached": idle_reached,
        "idleWaitMs": idle_wait.as_millis(),
        "callersReturnedWithoutAnswer": callers_returned_without_answer,
        "pendingAfterDrain": after.queue_len,
        "activeAfterDrain": after.active_workers,
        "totalElapsedMs": probe_started.elapsed().as_millis(),
    }))
}

/// Fixed native E2E probe. It has no inputs and only returns bounded request
/// observations; production builds do not compile the Tauri command wrapper.
#[cfg(feature = "e2e")]
pub fn e2e_pipelining_probe() -> Result<serde_json::Value, String> {
    use std::net::TcpListener;

    let guard = NetworkSecurityGuard::start()?;
    let origin = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("could not bind pipeline fixture: {error}"))?;
    origin
        .set_nonblocking(true)
        .map_err(|error| format!("could not configure pipeline fixture: {error}"))?;
    let origin_address = origin
        .local_addr()
        .map_err(|error| format!("could not inspect pipeline fixture: {error}"))?;
    let origin_thread = thread::Builder::new()
        .name("rosi-e2e-pipeline-fixture".into())
        .spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match origin.accept() {
                    Ok(accepted) => break accepted,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            return Vec::<String>::new();
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return Vec::<String>::new(),
                }
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut received = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        if received.len() + count > 64 * 1024 {
                            break;
                        }
                        received.extend_from_slice(&chunk[..count]);
                    }
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            || error.kind() == io::ErrorKind::TimedOut =>
                    {
                        break;
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
            let requests = received
                .split(|byte| *byte == b'\n')
                .filter_map(|line| {
                    let line = line.strip_suffix(b"\r")?;
                    line.starts_with(b"GET ")
                        .then(|| String::from_utf8_lossy(line).into_owned())
                })
                .collect::<Vec<_>>();
            let body = b"OK";
            let response = format!(
                "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body);
            requests
        })
        .map_err(|error| format!("could not start pipeline fixture: {error}"))?;

    let proxy_url = url::Url::parse(guard.proxy_url())
        .map_err(|error| format!("could not inspect secure proxy URL: {error}"))?;
    let proxy_host = proxy_url.host_str().ok_or("secure proxy has no host")?;
    let proxy_port = proxy_url
        .port_or_known_default()
        .ok_or("secure proxy has no port")?;
    let proxy_address = format!("{proxy_host}:{proxy_port}");
    let password = proxy_url.password().ok_or("secure proxy has no token")?;
    let authorization = base64_encode(format!("rosi:{password}").as_bytes());
    let mut client = TcpStream::connect(proxy_address.as_str())
        .map_err(|error| format!("could not connect to the secure proxy: {error}"))?;
    let _ = client.set_read_timeout(Some(Duration::from_secs(4)));
    let request = format!(
        "GET http://127.0.0.1:{}/first HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nProxy-Authorization: Basic {authorization}\r\nConnection: keep-alive\r\n\r\nGET http://private.test:{}/blocked HTTP/1.1\r\nHost: private.test:{}\r\nProxy-Authorization: Basic {authorization}\r\nConnection: close\r\n\r\n",
        origin_address.port(),
        origin_address.port(),
        origin_address.port(),
        origin_address.port()
    );
    client
        .write_all(request.as_bytes())
        .map_err(|error| format!("could not send pipeline fixture: {error}"))?;
    let mut response = Vec::new();
    client
        .read_to_end(&mut response)
        .map_err(|error| format!("could not read pipeline fixture response: {error}"))?;
    drop(client);
    let requests = origin_thread
        .join()
        .map_err(|_| "pipeline fixture thread failed".to_owned())?;
    drop(guard);

    let response_text = String::from_utf8_lossy(&response);
    let (response_head, response_body) = response_text.split_once("\r\n\r\n").unwrap_or(("", ""));
    let response_status = response_head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok());
    let dns_resolution = e2e_dns_cancellation_probe()?;
    let ipv6_classification = serde_json::json!({
        "publicBracketedIsPublic": parse_ip_host("[2606:4700:4700::1111]").is_some_and(is_public_ip),
        "uniqueLocalBracketedIsPrivate": parse_ip_host("[fd00::1]").is_some_and(|address| !is_public_ip(address)),
    });
    let policy_matrix = e2e_policy_matrix();
    let async_proxy = async_proxy::e2e_capacity_probe()?;
    Ok(serde_json::json!({
        "requests": requests,
        "responseStatus": response_status,
        "responseBody": response_body,
        "secondTargetForwarded": requests.iter().any(|line| line.contains("/blocked") || line.contains("private.test")),
        "asyncProxy": async_proxy,
        "dnsResolution": dns_resolution,
        "ipv6Classification": ipv6_classification,
        "policyMatrix": policy_matrix,
    }))
}

/// Fixed literals with expected verdicts, checked by the V5 network policy
/// E2E spec. NAT64 rows are public only when the embedded IPv4 is public.
#[cfg(feature = "e2e")]
fn e2e_policy_matrix() -> serde_json::Value {
    const ADDRESSES: [(&str, bool); 44] = [
        ("8.8.8.8", true),
        ("1.1.1.1", true),
        ("2606:4700:4700::1111", true),
        ("64:ff9b::808:808", true),
        ("64:ff9b::101:101", true),
        ("0.0.0.0", false),
        ("10.0.0.1", false),
        ("100.64.0.1", false),
        ("127.0.0.1", false),
        ("169.254.169.254", false),
        ("172.16.0.1", false),
        ("192.0.0.1", false),
        ("192.0.2.1", false),
        ("192.88.99.1", false),
        ("192.168.1.1", false),
        ("198.18.0.1", false),
        ("198.51.100.1", false),
        ("203.0.113.1", false),
        ("224.0.0.1", false),
        ("255.255.255.255", false),
        ("::", false),
        ("::1", false),
        ("::ffff:8.8.8.8", false),
        ("::8.8.8.8", false),
        ("fe80::1", false),
        ("fd00::1", false),
        ("fc00::1", false),
        ("ff02::1", false),
        ("2001::1", false),
        ("2001:db8::1", false),
        ("2002::1", false),
        ("3fff::1", false),
        ("64:ff9b::7f00:1", false),
        ("64:ff9b::a00:1", false),
        ("64:ff9b::c0a8:101", false),
        ("64:ff9b::a9fe:a9fe", false),
        ("64:ff9b::ffff:ffff", false),
        ("64:ff9b::6440:1", false),
        ("64:ff9b::", false),
        ("64:ff9b::1", false),
        ("64:ff9b::e000:1", false),
        ("64:ff9b:1::1", false),
        ("64:ff9b::c000:201", false),
        ("64:ff9b::ac10:1", false),
    ];
    let loopback_allowed = std::env::var("ROSI_E2E_ALLOW_LOOPBACK").as_deref() == Ok("1");
    let urls: [(&str, bool); 14] = [
        ("https://8.8.8.8/", true),
        ("https://[2606:4700:4700::1111]/", true),
        ("https://[64:ff9b::808:808]/", true),
        ("https://[64:ff9b::7f00:1]/", false),
        ("http://100.64.0.1/", false),
        ("http://198.18.0.1/", false),
        ("http://192.0.2.1/", false),
        ("http://240.0.0.1/", false),
        ("http://[::ffff:8.8.8.8]/", false),
        ("http://10.0.0.1/", false),
        ("http://localhost/", false),
        ("http://localtest.me/", false),
        ("http://127.0.0.1:9/", loopback_allowed),
        ("http://0x7f000001/", loopback_allowed),
    ];
    let address_rows: Vec<_> = ADDRESSES
        .iter()
        .map(|(text, expected)| {
            let actual = parse_ip_host(text).is_some_and(is_public_ip);
            serde_json::json!({ "address": text, "expected": expected, "actual": actual })
        })
        .collect();
    let url_rows: Vec<_> = urls
        .iter()
        .map(|(url, expected)| {
            let actual = crate::validation::is_syntactically_safe_http_url(url);
            serde_json::json!({ "url": url, "expected": expected, "actual": actual })
        })
        .collect();
    serde_json::json!({ "addresses": address_rows, "urls": url_rows })
}
