//! Bounded asynchronous implementation of the per-operation loopback proxy.
//!
//! The public guard remains synchronous because download and metadata callers
//! own it for a blocking subprocess or request. Its listener and all sockets
//! are serviced on Tauri's Tokio runtime; DNS stays in the separate fixed-size
//! resolver pool owned by `network_security`.

use super::{
    HttpBodyMode, UpstreamProxy, CONNECT_TIMEOUT, CONNECT_TOTAL_TIMEOUT, DNS_RESOLUTION_TIMEOUT,
    IO_TIMEOUT, MAX_HTTP_REQUEST_BODY_BYTES, MAX_PROXY_HEADER_BYTES,
    MAX_UPSTREAM_RESPONSE_HEADER_BYTES, RELAY_BUFFER_BYTES, TUNNEL_IDLE_TIMEOUT,
};
use crate::ip_policy::is_public_ip;
use std::collections::VecDeque;
use std::io;
#[cfg(feature = "e2e")]
use std::io::{Read, Write};
#[cfg(feature = "e2e")]
use std::net::TcpStream as StdTcpStream;
use std::net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
#[cfg(feature = "e2e")]
use std::sync::OnceLock;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant as StdInstant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{self, Instant};

const MAX_ACTIVE_PROXY_CLIENTS: usize = 256;
const MAX_PENDING_PROXY_CLIENTS: usize = 128;
const PENDING_ADMISSION_TIMEOUT: Duration = Duration::from_secs(5);
const PROXY_START_TIMEOUT: Duration = Duration::from_secs(2);
const OVERLOAD_WRITE_TIMEOUT: Duration = Duration::from_millis(100);
const CLIENT_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const CLIENT_DRAIN_MAX_BYTES: usize = 64 * 1024;
const MAX_DRAINING_REJECTS: usize = 32;
const EXTERNAL_CANCELLATION_POLL: Duration = Duration::from_millis(25);
const MAX_CHUNK_METADATA_LINE_BYTES: usize = 8192;

fn io_timeout_error() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "proxy I/O timed out")
}

struct ProxyMetrics {
    active_connections: AtomicUsize,
    peak_active_connections: AtomicUsize,
    active_tunnels: AtomicUsize,
    peak_active_tunnels: AtomicUsize,
    pending_admissions: AtomicUsize,
    peak_pending_admissions: AtomicUsize,
    overload_rejections: AtomicUsize,
}

impl ProxyMetrics {
    fn new() -> Self {
        Self {
            active_connections: AtomicUsize::new(0),
            peak_active_connections: AtomicUsize::new(0),
            active_tunnels: AtomicUsize::new(0),
            peak_active_tunnels: AtomicUsize::new(0),
            pending_admissions: AtomicUsize::new(0),
            peak_pending_admissions: AtomicUsize::new(0),
            overload_rejections: AtomicUsize::new(0),
        }
    }

    fn track(self: &Arc<Self>, kind: MetricKind) -> MetricGuard {
        let (current, peak) = match kind {
            MetricKind::Connection => (&self.active_connections, &self.peak_active_connections),
            MetricKind::Tunnel => (&self.active_tunnels, &self.peak_active_tunnels),
        };
        let active = current.fetch_add(1, Ordering::AcqRel) + 1;
        update_peak(peak, active);
        MetricGuard {
            metrics: Arc::clone(self),
            kind,
        }
    }

    fn track_pending(self: &Arc<Self>) -> PendingMetricGuard {
        let active = self.pending_admissions.fetch_add(1, Ordering::AcqRel) + 1;
        update_peak(&self.peak_pending_admissions, active);
        PendingMetricGuard {
            metrics: Arc::clone(self),
        }
    }

    #[cfg(feature = "e2e")]
    fn snapshot(&self) -> ProxyMetricsSnapshot {
        ProxyMetricsSnapshot {
            active_connections: self.active_connections.load(Ordering::Acquire),
            peak_active_connections: self.peak_active_connections.load(Ordering::Acquire),
            active_tunnels: self.active_tunnels.load(Ordering::Acquire),
            peak_active_tunnels: self.peak_active_tunnels.load(Ordering::Acquire),
            pending_admissions: self.pending_admissions.load(Ordering::Acquire),
            peak_pending_admissions: self.peak_pending_admissions.load(Ordering::Acquire),
            overload_rejections: self.overload_rejections.load(Ordering::Acquire),
        }
    }
}

fn update_peak(peak: &AtomicUsize, observed: usize) {
    let mut current = peak.load(Ordering::Relaxed);
    while observed > current {
        match peak.compare_exchange_weak(current, observed, Ordering::Release, Ordering::Relaxed) {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }
}

#[derive(Clone, Copy)]
enum MetricKind {
    Connection,
    Tunnel,
}

struct MetricGuard {
    metrics: Arc<ProxyMetrics>,
    kind: MetricKind,
}

impl Drop for MetricGuard {
    fn drop(&mut self) {
        let current = match self.kind {
            MetricKind::Connection => &self.metrics.active_connections,
            MetricKind::Tunnel => &self.metrics.active_tunnels,
        };
        current.fetch_sub(1, Ordering::AcqRel);
    }
}

struct PendingMetricGuard {
    metrics: Arc<ProxyMetrics>,
}

impl Drop for PendingMetricGuard {
    fn drop(&mut self) {
        self.metrics
            .pending_admissions
            .fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(feature = "e2e")]
#[derive(Clone, Copy)]
struct ProxyMetricsSnapshot {
    active_connections: usize,
    peak_active_connections: usize,
    active_tunnels: usize,
    peak_active_tunnels: usize,
    pending_admissions: usize,
    peak_pending_admissions: usize,
    overload_rejections: usize,
}

struct ProxyShared {
    stopped: AtomicBool,
    operation_cancelled: Option<Arc<AtomicBool>>,
    shutdown: watch::Sender<bool>,
    upstream: Option<UpstreamProxy>,
    metrics: Arc<ProxyMetrics>,
}

impl ProxyShared {
    fn is_cancelled(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
            || self
                .operation_cancelled
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Acquire))
    }

    async fn cancelled(&self) {
        let mut shutdown = self.shutdown.subscribe();
        loop {
            if self.is_cancelled() {
                return;
            }
            tokio::select! {
                _ = shutdown.changed() => {},
                _ = time::sleep(EXTERNAL_CANCELLATION_POLL) => {},
            }
        }
    }

    async fn shutdown_notified(&self) {
        let mut shutdown = self.shutdown.subscribe();
        loop {
            if *shutdown.borrow() {
                return;
            }
            if shutdown.changed().await.is_err() {
                return;
            }
        }
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.shutdown.send_replace(true);
    }
}

struct PendingClient {
    stream: TcpStream,
    accepted_at: Instant,
    _metrics: PendingMetricGuard,
}

/// Synchronous compatibility facade. The listener and every client task run on
/// Tauri's runtime. Dropping the guard signals shutdown; the listener and all
/// tracked client tasks then finish without the caller joining them.
pub struct NetworkSecurityGuard {
    proxy_url: String,
    shared: Arc<ProxyShared>,
}

impl NetworkSecurityGuard {
    #[cfg(feature = "e2e")]
    pub fn start() -> Result<Self, String> {
        Self::start_inner(None, None)
    }

    pub fn start_with_cancellation(
        operation_cancelled: Arc<AtomicBool>,
        upstream_proxy: &str,
    ) -> Result<Self, String> {
        let upstream = super::parse_upstream_proxy(upstream_proxy)?;
        Self::start_inner(Some(operation_cancelled), upstream)
    }

    fn start_inner(
        operation_cancelled: Option<Arc<AtomicBool>>,
        upstream: Option<UpstreamProxy>,
    ) -> Result<Self, String> {
        if operation_cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            return Err("The network operation was cancelled.".into());
        }

        let listener = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| format!("Could not start the secure network proxy: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Could not configure the secure network proxy: {error}"))?;
        let bind_addr = listener
            .local_addr()
            .map_err(|error| format!("Could not inspect the secure network proxy: {error}"))?;

        let mut token = [0u8; 24];
        getrandom::fill(&mut token)
            .map_err(|error| format!("Could not create secure proxy credentials: {error}"))?;
        let token = token
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let expected_auth = Arc::<str>::from(format!(
            "Basic {}",
            super::base64_encode(format!("rosi:{token}").as_bytes())
        ));
        let proxy_url = format!("http://rosi:{token}@{bind_addr}");
        let (shutdown, _) = watch::channel(false);
        let shared = Arc::new(ProxyShared {
            stopped: AtomicBool::new(false),
            operation_cancelled,
            shutdown,
            upstream,
            metrics: Arc::new(ProxyMetrics::new()),
        });
        let task_shared = Arc::clone(&shared);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        // The listener runs Tauri's runtime on a dedicated thread. A task
        // spawned from a runtime worker can sit in that worker's LIFO slot
        // while the worker blocks in this synchronous constructor, so the
        // readiness wait must not depend on the worker pool.
        let spawned = std::thread::Builder::new()
            .name("rosi-network-proxy".into())
            .spawn(move || {
                tauri::async_runtime::block_on(async move {
                    let listener = match TcpListener::from_std(listener) {
                        Ok(listener) => listener,
                        Err(error) => {
                            let _ = ready_sender.send(Err(error.to_string()));
                            return;
                        }
                    };
                    let _ = ready_sender.send(Ok(()));
                    run_proxy(listener, task_shared, expected_auth).await;
                });
            });
        if let Err(error) = spawned {
            shared.stop();
            return Err(format!("Could not start the secure network proxy: {error}"));
        }
        match ready_receiver.recv_timeout(PROXY_START_TIMEOUT) {
            Ok(Ok(())) => Ok(Self { proxy_url, shared }),
            Ok(Err(error)) => {
                shared.stop();
                Err(format!("Could not start the secure network proxy: {error}"))
            }
            Err(error) => {
                shared.stop();
                Err(format!("Could not start the secure network proxy: {error}"))
            }
        }
    }

    pub fn proxy_url(&self) -> &str {
        &self.proxy_url
    }
}

impl Drop for NetworkSecurityGuard {
    fn drop(&mut self) {
        self.shared.stop();
    }
}

async fn run_proxy(listener: TcpListener, shared: Arc<ProxyShared>, expected_auth: Arc<str>) {
    let semaphore = Arc::new(Semaphore::new(MAX_ACTIVE_PROXY_CLIENTS));
    let drain_slots = Arc::new(Semaphore::new(MAX_DRAINING_REJECTS));
    let mut handlers = JoinSet::new();
    let mut pending = VecDeque::<PendingClient>::new();

    loop {
        if shared.is_cancelled() {
            break;
        }
        while handlers.try_join_next().is_some() {}

        while let Some(next) = pending.front() {
            if next.accepted_at.elapsed() >= PENDING_ADMISSION_TIMEOUT {
                let Some(expired) = pending.pop_front() else {
                    break;
                };
                let stream = expired.stream;
                drop(expired._metrics);
                reject_from_loop(
                    stream,
                    503,
                    "Proxy Admission Timeout",
                    &drain_slots,
                    &mut handlers,
                )
                .await;
                continue;
            }
            let Ok(permit) = Arc::clone(&semaphore).try_acquire_owned() else {
                break;
            };
            let Some(admitted) = pending.pop_front() else {
                break;
            };
            drop(admitted._metrics);
            spawn_client(
                admitted.stream,
                permit,
                Arc::clone(&shared),
                Arc::clone(&expected_auth),
                &mut handlers,
            );
        }

        let admission_deadline = pending
            .front()
            .map(|item| item.accepted_at + PENDING_ADMISSION_TIMEOUT);
        tokio::select! {
            _ = shared.cancelled() => break,
            joined = handlers.join_next(), if !handlers.is_empty() => {
                let _ = joined;
            }
            accepted = listener.accept() => {
                let (client, _) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                if shared.is_cancelled() {
                    drop(client);
                    break;
                }
                if pending.is_empty() {
                    if let Ok(permit) = Arc::clone(&semaphore).try_acquire_owned() {
                        spawn_client(
                            client,
                            permit,
                            Arc::clone(&shared),
                            Arc::clone(&expected_auth),
                            &mut handlers,
                        );
                    } else if pending.len() < MAX_PENDING_PROXY_CLIENTS {
                        pending.push_back(PendingClient {
                            stream: client,
                            accepted_at: Instant::now(),
                            _metrics: shared.metrics.track_pending(),
                        });
                    } else {
                        shared.metrics.overload_rejections.fetch_add(1, Ordering::AcqRel);
                        reject_from_loop(
                            client,
                            503,
                            "Proxy Busy",
                            &drain_slots,
                            &mut handlers,
                        )
                        .await;
                    }
                } else if pending.len() < MAX_PENDING_PROXY_CLIENTS {
                    pending.push_back(PendingClient {
                        stream: client,
                        accepted_at: Instant::now(),
                        _metrics: shared.metrics.track_pending(),
                    });
                } else {
                    shared.metrics.overload_rejections.fetch_add(1, Ordering::AcqRel);
                    reject_from_loop(
                        client,
                        503,
                        "Proxy Busy",
                        &drain_slots,
                        &mut handlers,
                    )
                    .await;
                }
            }
            _ = wait_for_admission_expiry(admission_deadline), if admission_deadline.is_some() => {}
        }
    }

    pending.clear();
    handlers.abort_all();
    while handlers.join_next().await.is_some() {}
}

async fn wait_for_admission_expiry(deadline: Option<Instant>) {
    if let Some(deadline) = deadline {
        time::sleep_until(deadline).await;
    } else {
        std::future::pending::<()>().await;
    }
}

fn spawn_client(
    client: TcpStream,
    permit: tokio::sync::OwnedSemaphorePermit,
    shared: Arc<ProxyShared>,
    expected_auth: Arc<str>,
    handlers: &mut JoinSet<()>,
) {
    let metrics = Arc::clone(&shared.metrics);
    handlers.spawn(async move {
        let _permit = permit;
        let _connection = metrics.track(MetricKind::Connection);
        tokio::select! {
            _ = shared.shutdown_notified() => {},
            _ = handle_client(client, expected_auth, Arc::clone(&shared)) => {},
        }
    });
}

async fn handle_client(mut client: TcpStream, expected_auth: Arc<str>, shared: Arc<ProxyShared>) {
    let (header, buffered) = match time::timeout(IO_TIMEOUT, read_request_header(&mut client)).await
    {
        Ok(Ok(result)) => result,
        _ => return,
    };
    let Ok(header_text) = std::str::from_utf8(&header) else {
        reject_client(&mut client, 400, "Bad Request").await;
        return;
    };
    let Some((method, target, version, headers)) = super::parse_request(header_text) else {
        reject_client(&mut client, 400, "Bad Request").await;
        return;
    };
    let auth_values: Vec<&str> = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("proxy-authorization"))
        .map(|(_, value)| value.trim())
        .collect();
    if auth_values.len() != 1 || auth_values[0] != expected_auth.as_ref() {
        reject_client(&mut client, 407, "Proxy Authentication Required").await;
        return;
    }

    if method.eq_ignore_ascii_case("CONNECT") {
        let Ok((host, port, is_literal_loopback)) = super::parse_connect_target(&target) else {
            reject_client(&mut client, 400, "Bad CONNECT Target").await;
            return;
        };
        let Some(addresses) = vet_destination(&host, port, is_literal_loopback, &shared).await
        else {
            reject_client(&mut client, 403, "Destination Blocked").await;
            return;
        };
        let (mut upstream, tunnel_leftover) = match shared.upstream.as_ref() {
            None => match connect_addresses(addresses).await {
                Some(stream) => (stream, Vec::new()),
                None => {
                    reject_client(&mut client, 403, "Destination Blocked").await;
                    return;
                }
            },
            Some(proxy) => match connect_via_upstream(proxy, &host, port).await {
                Ok(tunnel) => tunnel,
                Err(()) => {
                    reject_client(&mut client, 502, "Upstream Proxy Failed").await;
                    return;
                }
            },
        };
        if shared.is_cancelled() {
            return;
        }
        if !matches!(
            time::timeout(
                IO_TIMEOUT,
                client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n"),
            )
            .await,
            Ok(Ok(()))
        ) {
            return;
        }
        if !tunnel_leftover.is_empty()
            && !matches!(
                time::timeout(IO_TIMEOUT, client.write_all(&tunnel_leftover)).await,
                Ok(Ok(()))
            )
        {
            return;
        }
        if !buffered.is_empty()
            && !matches!(
                time::timeout(IO_TIMEOUT, upstream.write_all(&buffered)).await,
                Ok(Ok(()))
            )
        {
            return;
        }
        let _tunnel = shared.metrics.track(MetricKind::Tunnel);
        let _ = relay_bidirectional(client, upstream, Arc::clone(&shared)).await;
        return;
    }

    let Ok(url) = url::Url::parse(&target) else {
        reject_client(&mut client, 400, "Absolute URL Required").await;
        return;
    };
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        reject_client(&mut client, 403, "Destination Blocked").await;
        return;
    }
    let Some(url_host) = url.host() else {
        reject_client(&mut client, 400, "Missing Host").await;
        return;
    };
    let host = super::host_string(&url_host);
    let Some(port) = url.port_or_known_default() else {
        reject_client(&mut client, 400, "Missing Port").await;
        return;
    };
    let literal_loopback = super::host_is_loopback(&url_host);
    let Some(addresses) = vet_destination(&host, port, literal_loopback, &shared).await else {
        reject_client(&mut client, 403, "Destination Blocked").await;
        return;
    };
    let absolute_form = shared.upstream.is_some();
    let mut upstream = match shared.upstream.as_ref() {
        None => match connect_addresses(addresses).await {
            Some(stream) => stream,
            None => {
                reject_client(&mut client, 403, "Destination Blocked").await;
                return;
            }
        },
        Some(proxy) => match connect_to_upstream_proxy(proxy).await {
            Some(stream) => stream,
            None => {
                reject_client(&mut client, 502, "Upstream Proxy Failed").await;
                return;
            }
        },
    };
    let Some((forwarded, body_mode, expect_continue)) =
        super::build_forwarded_request(&method, &version, &url, &headers, absolute_form)
    else {
        reject_client(&mut client, 400, "Unsupported HTTP Request").await;
        return;
    };
    if !matches!(
        time::timeout(IO_TIMEOUT, upstream.write_all(&forwarded)).await,
        Ok(Ok(()))
    ) {
        return;
    }
    if expect_continue
        && !matches!(
            time::timeout(
                IO_TIMEOUT,
                client.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            )
            .await,
            Ok(Ok(()))
        )
    {
        return;
    }
    let copied = match body_mode {
        HttpBodyMode::None => Ok(()),
        HttpBodyMode::ContentLength(length) => {
            copy_fixed_body(&mut client, &mut upstream, &buffered, length).await
        }
        HttpBodyMode::Chunked => copy_chunked_body(&mut client, &mut upstream, &buffered).await,
    };
    if copied.is_err() || shared.is_cancelled() {
        return;
    }
    let _ = copy_response(&mut upstream, &mut client).await;
}

async fn read_request_header(stream: &mut TcpStream) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let mut bytes = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if bytes.len() >= MAX_PROXY_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "proxy header too large",
            ));
        }
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "proxy header ended",
            ));
        }
        if bytes.len() + count > MAX_PROXY_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "proxy header too large",
            ));
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let split = index + 4;
            return Ok((bytes[..split].to_vec(), bytes[split..].to_vec()));
        }
    }
}

async fn reject_client(stream: &mut TcpStream, code: u16, reason: &str) {
    write_rejection(stream, code, reason).await;
    drain_rejected_client(stream).await;
}

async fn write_rejection(stream: &mut TcpStream, code: u16, reason: &str) {
    let body = format!("{code} {reason}\n");
    let response = format!(
        "HTTP/1.1 {code} {reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = time::timeout(
        OVERLOAD_WRITE_TIMEOUT,
        stream.write_all(response.as_bytes()),
    )
    .await;
    let _ = stream.shutdown().await;
}

/// Reads and discards what a rejected client already sent. Closing a socket
/// with unread input makes BSD stacks send RST, which can discard the response
/// before the client reads it. Bounded by bytes read and by one deadline.
async fn drain_rejected_client(stream: &mut TcpStream) {
    let deadline = Instant::now() + CLIENT_DRAIN_TIMEOUT;
    let mut scratch = [0u8; 4096];
    let mut drained = 0usize;
    while drained < CLIENT_DRAIN_MAX_BYTES {
        let limit = scratch.len().min(CLIENT_DRAIN_MAX_BYTES - drained);
        match time::timeout_at(deadline, stream.read(&mut scratch[..limit])).await {
            Ok(Ok(count)) if count > 0 => drained += count,
            _ => break,
        }
    }
}

/// Accept-loop rejection. The 503 is written inline, as before, and the drain
/// runs on a tracked task so a stalled client cannot block accept or admission.
/// When every drain permit is busy the socket is dropped at once.
async fn reject_from_loop(
    mut stream: TcpStream,
    code: u16,
    reason: &str,
    drain_slots: &Arc<Semaphore>,
    drains: &mut JoinSet<()>,
) {
    write_rejection(&mut stream, code, reason).await;
    let Ok(permit) = Arc::clone(drain_slots).try_acquire_owned() else {
        return;
    };
    drains.spawn(async move {
        let _permit = permit;
        let mut stream = stream;
        drain_rejected_client(&mut stream).await;
    });
}

async fn vet_destination(
    host: &str,
    port: u16,
    allow_literal_loopback: bool,
    shared: &ProxyShared,
) -> Option<Vec<SocketAddr>> {
    let addresses = time::timeout(DNS_RESOLUTION_TIMEOUT, resolve_destination(host, port))
        .await
        .ok()??;
    let allowed = !addresses.is_empty()
        && addresses.iter().all(|address| {
            is_public_ip(address.ip())
                || (allow_literal_loopback
                    && super::e2e_allows_literal_loopback(host, address.ip()))
        });
    #[cfg(feature = "e2e")]
    super::record_proxy_decision("connection", host, &addresses, allowed);
    if !allowed || shared.is_cancelled() {
        return None;
    }
    Some(addresses)
}

async fn resolve_destination(host: &str, port: u16) -> Option<Vec<SocketAddr>> {
    if let Some(ip) = super::parse_ip_host(host) {
        return Some(vec![SocketAddr::new(ip, port)]);
    }
    #[cfg(feature = "e2e")]
    if let Some(ip) = super::e2e_proxy_dns_override(host) {
        return Some(vec![SocketAddr::new(ip, port)]);
    }

    let resolver = super::shared_dns_resolver()?;
    let mut pending = resolver.enqueue(host, port)?;
    let started = StdInstant::now();
    loop {
        match pending.response.try_recv() {
            Ok(addresses) => {
                pending.finish();
                return addresses;
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                pending.finish();
                return None;
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        let remaining = DNS_RESOLUTION_TIMEOUT.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return None;
        }
        time::sleep(remaining.min(Duration::from_millis(25))).await;
    }
}

async fn connect_addresses(addresses: Vec<SocketAddr>) -> Option<TcpStream> {
    let deadline = Instant::now() + CONNECT_TOTAL_TIMEOUT;
    for address in super::interleave_address_families(addresses) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Ok(Ok(stream)) =
            time::timeout(remaining.min(CONNECT_TIMEOUT), TcpStream::connect(address)).await
        {
            return Some(stream);
        }
    }
    None
}

/// Connects to the user's upstream proxy without applying public-IP policy to
/// that proxy. Its hostname is still resolved by the bounded DNS resolver.
async fn connect_to_upstream_proxy(proxy: &UpstreamProxy) -> Option<TcpStream> {
    let addresses = time::timeout(
        DNS_RESOLUTION_TIMEOUT,
        resolve_destination(&proxy.host, proxy.port),
    )
    .await
    .ok()??;
    connect_addresses(addresses).await
}

async fn connect_via_upstream(
    proxy: &UpstreamProxy,
    host: &str,
    port: u16,
) -> Result<(TcpStream, Vec<u8>), ()> {
    let mut stream = connect_to_upstream_proxy(proxy).await.ok_or(())?;
    let authority = authority_for(host, port);
    let request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
    time::timeout(IO_TIMEOUT, stream.write_all(request.as_bytes()))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let (status, leftover) = read_upstream_response_head(&mut stream).await?;
    if !(200..300).contains(&status) {
        return Err(());
    }
    Ok((stream, leftover))
}

fn authority_for(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

async fn read_upstream_response_head(stream: &mut TcpStream) -> Result<(u16, Vec<u8>), ()> {
    time::timeout(IO_TIMEOUT, async {
        let mut bytes = Vec::with_capacity(512);
        let mut chunk = [0u8; 1024];
        loop {
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                if end + 4 > MAX_UPSTREAM_RESPONSE_HEADER_BYTES {
                    return Err(());
                }
                let status = super::parse_status_code(&bytes[..end]).ok_or(())?;
                return Ok((status, bytes[end + 4..].to_vec()));
            }
            if bytes.len() >= MAX_UPSTREAM_RESPONSE_HEADER_BYTES {
                return Err(());
            }
            let count = stream.read(&mut chunk).await.map_err(|_| ())?;
            if count == 0 {
                return Err(());
            }
            bytes.extend_from_slice(&chunk[..count]);
        }
    })
    .await
    .map_err(|_| ())?
}

async fn copy_fixed_body(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    buffered: &[u8],
    length: u64,
) -> io::Result<()> {
    let mut reader = AsyncPrefixReader {
        stream: client,
        prefix: buffered,
        position: 0,
    };
    let mut remaining = length;
    let mut chunk = [0u8; RELAY_BUFFER_BYTES];
    while remaining > 0 {
        let count = chunk.len().min(remaining.min(usize::MAX as u64) as usize);
        let read = time::timeout(IO_TIMEOUT, reader.read_some(&mut chunk[..count]))
            .await
            .map_err(|_| io_timeout_error())?;
        let read = read?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "HTTP request body ended early",
            ));
        }
        time::timeout(IO_TIMEOUT, upstream.write_all(&chunk[..read]))
            .await
            .map_err(|_| io_timeout_error())??;
        remaining -= read as u64;
    }
    Ok(())
}

struct AsyncPrefixReader<'a> {
    stream: &'a mut TcpStream,
    prefix: &'a [u8],
    position: usize,
}

impl AsyncPrefixReader<'_> {
    async fn read_some(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.position < self.prefix.len() {
            let count = output.len().min(self.prefix.len() - self.position);
            output[..count].copy_from_slice(&self.prefix[self.position..self.position + count]);
            self.position += count;
            Ok(count)
        } else {
            self.stream.read(output).await
        }
    }

    async fn read_exact_bytes(&mut self, mut output: &mut [u8]) -> io::Result<()> {
        while !output.is_empty() {
            let count = time::timeout(IO_TIMEOUT, self.read_some(output))
                .await
                .map_err(|_| io_timeout_error())??;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "chunked HTTP request body ended early",
                ));
            }
            output = &mut output[count..];
        }
        Ok(())
    }

    async fn read_crlf_line(&mut self) -> io::Result<Vec<u8>> {
        let mut line = Vec::with_capacity(64);
        let mut byte = [0u8; 1];
        loop {
            if line.len() >= MAX_CHUNK_METADATA_LINE_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "chunk metadata line is too large",
                ));
            }
            self.read_exact_bytes(&mut byte).await?;
            line.push(byte[0]);
            if line.ends_with(b"\r\n") {
                return Ok(line);
            }
            if byte[0] == b'\n' {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid chunk metadata terminator",
                ));
            }
        }
    }
}

async fn copy_chunked_body(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    buffered: &[u8],
) -> io::Result<()> {
    let mut reader = AsyncPrefixReader {
        stream: client,
        prefix: buffered,
        position: 0,
    };
    let mut total = 0u64;
    loop {
        let line = reader.read_crlf_line().await?;
        let line_without_crlf = line
            .strip_suffix(b"\r\n")
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid chunk size line"))?;
        let size_text = line_without_crlf
            .split(|byte| *byte == b';')
            .next()
            .unwrap_or_default();
        let size_text = std::str::from_utf8(size_text)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid chunk size"))?;
        let size = u64::from_str_radix(size_text.trim(), 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid chunk size"))?;
        if size > MAX_HTTP_REQUEST_BODY_BYTES.saturating_sub(total) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP request body exceeds the configured limit",
            ));
        }
        time::timeout(IO_TIMEOUT, upstream.write_all(&line))
            .await
            .map_err(|_| io_timeout_error())??;
        if size == 0 {
            loop {
                let trailer = reader.read_crlf_line().await?;
                time::timeout(IO_TIMEOUT, upstream.write_all(&trailer))
                    .await
                    .map_err(|_| io_timeout_error())??;
                if trailer == b"\r\n" {
                    return Ok(());
                }
            }
        }
        let mut remaining = size;
        let mut chunk = [0u8; RELAY_BUFFER_BYTES];
        while remaining > 0 {
            let count = chunk.len().min(remaining.min(usize::MAX as u64) as usize);
            reader.read_exact_bytes(&mut chunk[..count]).await?;
            time::timeout(IO_TIMEOUT, upstream.write_all(&chunk[..count]))
                .await
                .map_err(|_| io_timeout_error())??;
            remaining -= count as u64;
        }
        let mut terminator = [0u8; 2];
        reader.read_exact_bytes(&mut terminator).await?;
        if &terminator != b"\r\n" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid chunk terminator",
            ));
        }
        time::timeout(IO_TIMEOUT, upstream.write_all(&terminator))
            .await
            .map_err(|_| io_timeout_error())??;
        total += size;
    }
}

async fn copy_response(upstream: &mut TcpStream, client: &mut TcpStream) -> io::Result<()> {
    let mut buffer = [0u8; RELAY_BUFFER_BYTES];
    loop {
        let count = time::timeout(IO_TIMEOUT, upstream.read(&mut buffer))
            .await
            .map_err(|_| io_timeout_error())??;
        if count == 0 {
            return Ok(());
        }
        time::timeout(IO_TIMEOUT, client.write_all(&buffer[..count]))
            .await
            .map_err(|_| io_timeout_error())??;
    }
}

struct Activity {
    started: Instant,
    last_activity_ms: AtomicU64,
    changed: tokio::sync::Notify,
}

impl Activity {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            last_activity_ms: AtomicU64::new(0),
            changed: tokio::sync::Notify::new(),
        }
    }

    fn record(&self) {
        let elapsed = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        self.last_activity_ms.store(elapsed, Ordering::Release);
        self.changed.notify_one();
    }

    fn deadline(&self) -> Instant {
        self.started
            + Duration::from_millis(self.last_activity_ms.load(Ordering::Acquire))
            + TUNNEL_IDLE_TIMEOUT
    }

    async fn idle(&self, deadline: Instant) {
        tokio::select! {
            _ = time::sleep_until(deadline) => {},
            _ = self.changed.notified() => {},
        }
    }
}

struct ActivityStream<T> {
    inner: T,
    activity: Arc<Activity>,
}

impl<T: AsyncRead + Unpin> AsyncRead for ActivityStream<T> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        let this = self.as_mut().get_mut();
        let before = buffer.filled().len();
        let result = std::pin::Pin::new(&mut this.inner).poll_read(cx, buffer);
        if matches!(&result, std::task::Poll::Ready(Ok(()))) && buffer.filled().len() > before {
            this.activity.record();
        }
        result
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for ActivityStream<T> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        let this = self.as_mut().get_mut();
        let result = std::pin::Pin::new(&mut this.inner).poll_write(cx, buffer);
        if matches!(&result, std::task::Poll::Ready(Ok(count)) if *count > 0) {
            this.activity.record();
        }
        result
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.as_mut().get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.as_mut().get_mut().inner).poll_shutdown(cx)
    }
}

async fn relay_bidirectional(
    client: TcpStream,
    upstream: TcpStream,
    shared: Arc<ProxyShared>,
) -> io::Result<()> {
    let activity = Arc::new(Activity::new());
    let mut client = ActivityStream {
        inner: client,
        activity: Arc::clone(&activity),
    };
    let mut upstream = ActivityStream {
        inner: upstream,
        activity: Arc::clone(&activity),
    };
    let relay = tokio::io::copy_bidirectional(&mut client, &mut upstream);
    tokio::pin!(relay);
    loop {
        let idle_deadline = activity.deadline();
        tokio::select! {
            result = &mut relay => return result.map(|_| ()),
            _ = shared.shutdown_notified() => {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "network operation was cancelled"));
            }
            _ = activity.idle(idle_deadline) => {
                if activity.deadline() <= Instant::now() {
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(feature = "e2e")]
struct CapacityClients {
    active: Vec<StdTcpStream>,
    pending: Vec<StdTcpStream>,
}

#[cfg(feature = "e2e")]
pub(super) fn e2e_capacity_probe() -> Result<serde_json::Value, String> {
    static RESULT: OnceLock<Result<serde_json::Value, String>> = OnceLock::new();
    RESULT.get_or_init(run_e2e_capacity_probe).clone()
}

#[cfg(feature = "e2e")]
fn run_e2e_capacity_probe() -> Result<serde_json::Value, String> {
    let cancellation = Arc::new(AtomicBool::new(false));
    let guard = NetworkSecurityGuard::start_with_cancellation(Arc::clone(&cancellation), "")?;
    let metrics = Arc::clone(&guard.shared.metrics);
    let origin = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("could not bind async proxy origin: {error}"))?;
    origin
        .set_nonblocking(true)
        .map_err(|error| format!("could not configure async proxy origin: {error}"))?;
    let origin_port = origin
        .local_addr()
        .map_err(|error| format!("could not inspect async proxy origin: {error}"))?
        .port();
    let (origin_count_sender, origin_count_receiver) = mpsc::sync_channel(1);
    let (origin_release_sender, origin_release_receiver) = mpsc::sync_channel(1);
    let origin_cancellation = Arc::clone(&cancellation);
    let origin_thread = std::thread::Builder::new()
        .name("rosi-e2e-async-proxy-origin".into())
        .spawn(move || {
            let mut streams = Vec::with_capacity(MAX_ACTIVE_PROXY_CLIENTS);
            let deadline = StdInstant::now() + Duration::from_secs(20);
            while streams.len() < MAX_ACTIVE_PROXY_CLIENTS
                && StdInstant::now() < deadline
                && !origin_cancellation.load(Ordering::Acquire)
            {
                match origin.accept() {
                    Ok((stream, _)) => streams.push(stream),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
            let accepted = streams.len();
            let _ = origin_count_sender.send(accepted);
            let _ = origin_release_receiver.recv_timeout(Duration::from_secs(10));
            let mut closed = 0usize;
            for mut stream in streams {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut byte = [0u8; 1];
                match stream.read(&mut byte) {
                    Ok(0) | Err(_) => closed += 1,
                    Ok(_) => {}
                }
            }
            (accepted, closed)
        })
        .map_err(|error| format!("could not start async proxy origin: {error}"))?;

    let capacity_phase = run_capacity_phase(&guard, origin_port, origin_count_receiver);
    let cancellation_started = StdInstant::now();
    cancellation.store(true, Ordering::Release);
    let cancellation_drained =
        wait_for_proxy_metrics(&metrics, Duration::from_secs(5), |snapshot| {
            snapshot.active_connections == 0
                && snapshot.active_tunnels == 0
                && snapshot.pending_admissions == 0
        });
    let after_cancel = metrics.snapshot();
    drop(guard);
    let _ = origin_release_sender.send(());
    let origin_result = origin_thread
        .join()
        .map_err(|_| "async proxy E2E origin thread panicked".to_owned());
    let (capacity, clients) = capacity_phase?;
    let (origin_accepted, origin_closed) = origin_result?;
    let closed_clients = clients
        .active
        .into_iter()
        .chain(clients.pending)
        .filter(|mut stream| {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut byte = [0u8; 1];
            socket_closed(stream.read(&mut byte))
        })
        .count();
    if !cancellation_drained {
        return Err(format!(
            "operation cancellation did not drain proxy tasks: active={} tunnels={} pending={}",
            after_cancel.active_connections,
            after_cancel.active_tunnels,
            after_cancel.pending_admissions
        ));
    }
    if closed_clients != MAX_ACTIVE_PROXY_CLIENTS + MAX_PENDING_PROXY_CLIENTS {
        return Err(format!(
            "operation cancellation closed {closed_clients} client sockets; expected {}",
            MAX_ACTIVE_PROXY_CLIENTS + MAX_PENDING_PROXY_CLIENTS
        ));
    }
    if origin_accepted != MAX_ACTIVE_PROXY_CLIENTS || origin_closed != MAX_ACTIVE_PROXY_CLIENTS {
        return Err(format!(
            "operation cancellation closed {origin_closed}/{origin_accepted} origin sockets; expected {}",
            MAX_ACTIVE_PROXY_CLIENTS
        ));
    }

    let drop = e2e_guard_drop_probe()?;
    Ok(serde_json::json!({
        "capacity": capacity,
        "cancellation": {
            "activeConnectionsAfterCancel": after_cancel.active_connections,
            "activeTunnelsAfterCancel": after_cancel.active_tunnels,
            "pendingAdmissionsAfterCancel": after_cancel.pending_admissions,
            "closedClientSockets": closed_clients,
            "expectedClientSockets": MAX_ACTIVE_PROXY_CLIENTS + MAX_PENDING_PROXY_CLIENTS,
            "closedOriginSockets": origin_closed,
            "expectedOriginSockets": MAX_ACTIVE_PROXY_CLIENTS,
            "elapsedMs": cancellation_started.elapsed().as_millis(),
        },
        "drop": drop,
    }))
}

#[cfg(feature = "e2e")]
fn run_capacity_phase(
    guard: &NetworkSecurityGuard,
    origin_port: u16,
    origin_count_receiver: mpsc::Receiver<usize>,
) -> Result<(serde_json::Value, CapacityClients), String> {
    let (proxy_address, authorization) = proxy_e2e_credentials(guard.proxy_url())?;
    let connect_request = format!(
        "CONNECT 127.0.0.1:{origin_port} HTTP/1.1\r\nHost: 127.0.0.1:{origin_port}\r\nProxy-Authorization: Basic {authorization}\r\n\r\n"
    );
    let mut active = Vec::with_capacity(MAX_ACTIVE_PROXY_CLIENTS);
    for index in 0..MAX_ACTIVE_PROXY_CLIENTS {
        let mut client = connect_e2e_client(proxy_address)?;
        client
            .write_all(connect_request.as_bytes())
            .map_err(|error| format!("could not open E2E tunnel {index}: {error}"))?;
        let (status, _) = read_e2e_response_head(&mut client)?;
        if status != 200 {
            return Err(format!(
                "E2E tunnel {index} received HTTP {status}, expected 200"
            ));
        }
        active.push(client);
    }

    let origin_accepted = origin_count_receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|error| format!("async proxy origin did not accept tunnels: {error}"))?;
    if origin_accepted != MAX_ACTIVE_PROXY_CLIENTS {
        return Err(format!(
            "origin accepted {origin_accepted} tunnels, expected {MAX_ACTIVE_PROXY_CLIENTS}"
        ));
    }
    if !wait_for_proxy_metrics(&guard.shared.metrics, Duration::from_secs(5), |snapshot| {
        snapshot.active_tunnels >= MAX_ACTIVE_PROXY_CLIENTS
    }) {
        let snapshot = guard.shared.metrics.snapshot();
        return Err(format!(
            "only {} of {} concurrent tunnels became active",
            snapshot.active_tunnels, MAX_ACTIVE_PROXY_CLIENTS
        ));
    }
    let at_capacity = guard.shared.metrics.snapshot();

    let mut pending = Vec::with_capacity(MAX_PENDING_PROXY_CLIENTS);
    for index in 0..MAX_PENDING_PROXY_CLIENTS {
        let mut client = connect_e2e_client(proxy_address)?;
        client
            .write_all(connect_request.as_bytes())
            .map_err(|error| format!("could not queue E2E client {index}: {error}"))?;
        let expected_pending = index + 1;
        if !wait_for_proxy_metrics(&guard.shared.metrics, Duration::from_secs(2), |snapshot| {
            snapshot.pending_admissions >= expected_pending
        }) {
            return Err(format!(
                "pending admission queue stopped at {} of {MAX_PENDING_PROXY_CLIENTS}",
                guard.shared.metrics.snapshot().pending_admissions
            ));
        }
        pending.push(client);
    }

    let mut overload = connect_e2e_client(proxy_address)?;
    overload
        .write_all(connect_request.as_bytes())
        .map_err(|error| format!("could not submit overloaded E2E request: {error}"))?;
    let (overload_status, mut response_tail) = read_e2e_response_head(&mut overload)?;
    overload
        .read_to_end(&mut response_tail)
        .map_err(|error| format!("could not read overload response: {error}"))?;
    if overload_status != 503 || !String::from_utf8_lossy(&response_tail).contains("Proxy Busy") {
        return Err(format!(
            "overload response was HTTP {overload_status} without the bounded Proxy Busy response"
        ));
    }
    let full_queue = guard.shared.metrics.snapshot();
    if full_queue.pending_admissions != MAX_PENDING_PROXY_CLIENTS
        || full_queue.peak_pending_admissions != MAX_PENDING_PROXY_CLIENTS
        || full_queue.overload_rejections == 0
    {
        return Err(format!(
            "overload metrics mismatch: pending={} peak={} rejected={}",
            full_queue.pending_admissions,
            full_queue.peak_pending_admissions,
            full_queue.overload_rejections
        ));
    }

    Ok((
        serde_json::json!({
            "requestedTunnels": MAX_ACTIVE_PROXY_CLIENTS,
            "activeLimit": MAX_ACTIVE_PROXY_CLIENTS,
            "activeAtCapacity": at_capacity.active_tunnels,
            "peakActiveTunnels": at_capacity.peak_active_tunnels,
            "peakActiveConnections": at_capacity.peak_active_connections,
            "pendingLimit": MAX_PENDING_PROXY_CLIENTS,
            "pendingHighWater": full_queue.peak_pending_admissions,
            "overloadStatus": overload_status,
            "overloadRejections": full_queue.overload_rejections,
        }),
        CapacityClients { active, pending },
    ))
}

#[cfg(feature = "e2e")]
fn proxy_e2e_credentials(proxy_url: &str) -> Result<(SocketAddr, String), String> {
    let url = url::Url::parse(proxy_url)
        .map_err(|error| format!("could not inspect E2E proxy URL: {error}"))?;
    let host = url.host_str().ok_or("E2E proxy URL has no host")?;
    let port = url
        .port_or_known_default()
        .ok_or("E2E proxy URL has no port")?;
    let address = format!("{host}:{port}")
        .parse::<SocketAddr>()
        .map_err(|error| format!("E2E proxy bind address is invalid: {error}"))?;
    let password = url.password().ok_or("E2E proxy URL has no token")?;
    let authorization = super::base64_encode(format!("rosi:{password}").as_bytes());
    Ok((address, authorization))
}

#[cfg(feature = "e2e")]
fn connect_e2e_client(address: SocketAddr) -> Result<StdTcpStream, String> {
    let stream = StdTcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|error| format!("could not connect to E2E proxy: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| format!("could not configure E2E client timeout: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| format!("could not configure E2E client timeout: {error}"))?;
    Ok(stream)
}

#[cfg(feature = "e2e")]
fn read_e2e_response_head(stream: &mut StdTcpStream) -> Result<(u16, Vec<u8>), String> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if bytes.len() >= 16 * 1024 {
            return Err("E2E proxy response header exceeded 16 KiB".into());
        }
        let count = stream
            .read(&mut chunk)
            .map_err(|error| format!("could not read E2E proxy response: {error}"))?;
        if count == 0 {
            return Err("E2E proxy closed before completing its response header".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let status = std::str::from_utf8(&bytes[..end])
                .ok()
                .and_then(|head| head.lines().next())
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|status| status.parse::<u16>().ok())
                .ok_or_else(|| "E2E proxy returned an invalid HTTP status line".to_owned())?;
            let split = end + 4;
            return Ok((status, bytes[split..].to_vec()));
        }
    }
}

#[cfg(feature = "e2e")]
fn wait_for_proxy_metrics(
    metrics: &ProxyMetrics,
    timeout: Duration,
    predicate: impl Fn(ProxyMetricsSnapshot) -> bool,
) -> bool {
    let deadline = StdInstant::now() + timeout;
    loop {
        if predicate(metrics.snapshot()) {
            return true;
        }
        if StdInstant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(feature = "e2e")]
fn e2e_guard_drop_probe() -> Result<serde_json::Value, String> {
    let guard = NetworkSecurityGuard::start()?;
    let metrics = Arc::clone(&guard.shared.metrics);
    let (address, _) = proxy_e2e_credentials(guard.proxy_url())?;
    let mut client = connect_e2e_client(address)?;
    if !wait_for_proxy_metrics(&metrics, Duration::from_secs(2), |snapshot| {
        snapshot.active_connections == 1
    }) {
        return Err("drop E2E client was not admitted".into());
    }
    let started = StdInstant::now();
    drop(guard);
    let active_after_drop = wait_for_proxy_metrics(&metrics, Duration::from_secs(5), |snapshot| {
        snapshot.active_connections == 0
    });
    let _ = client.set_read_timeout(Some(Duration::from_secs(2)));
    let mut byte = [0u8; 1];
    let closed_client = socket_closed(client.read(&mut byte));
    if !active_after_drop || !closed_client {
        return Err(format!(
            "guard drop cleanup failed: active={} clientClosed={closed_client}",
            metrics.snapshot().active_connections
        ));
    }
    Ok(serde_json::json!({
        "activeConnectionsAfterDrop": metrics.snapshot().active_connections,
        "closedClientSocket": closed_client,
        "elapsedMs": started.elapsed().as_millis(),
    }))
}

#[cfg(feature = "e2e")]
fn socket_closed(result: io::Result<usize>) -> bool {
    match result {
        Ok(0) => true,
        Ok(_) => false,
        Err(error) => !matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ),
    }
}
