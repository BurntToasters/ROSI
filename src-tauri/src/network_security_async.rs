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
use std::net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{self, Instant};

/// E2E-only probes of this proxy. Not compiled into release builds.
#[cfg(feature = "e2e")]
#[path = "network_security/e2e_async.rs"]
pub(super) mod e2e_async;

const MAX_ACTIVE_PROXY_CLIENTS: usize = 256;
const MAX_PENDING_PROXY_CLIENTS: usize = 128;
const PENDING_ADMISSION_TIMEOUT: Duration = Duration::from_secs(5);
const PROXY_START_TIMEOUT: Duration = Duration::from_secs(2);
const OVERLOAD_WRITE_TIMEOUT: Duration = Duration::from_millis(100);
const CLIENT_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const CLIENT_DRAIN_MAX_BYTES: usize = 64 * 1024;
const MAX_DRAINING_REJECTS: usize = 32;
const MAX_CHUNK_METADATA_LINE_BYTES: usize = 8192;
/// Budget for a client to finish sending its request head, before the
/// proxy-authorization check. Kept short so a local process cannot hold a
/// connection slot for long without authenticating.
const PRE_AUTH_HEADER_TIMEOUT: Duration = Duration::from_secs(5);

/// Why a destination was not vetted. Only `Refused` is a policy decision.
#[derive(Clone, Copy)]
enum DestinationError {
    Refused,
    ResolveFailed,
    Cancelled,
}

/// Why a direct connect to a vetted destination failed.
#[derive(Clone, Copy)]
enum ConnectError {
    TimedOut,
    Failed,
}

fn io_timeout_error() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "proxy I/O timed out")
}

/// Compares secrets without returning at the first differing byte. Only the
/// length is compared directly.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

/// Chunk trailers are forwarded upstream, so each one gets the checks a request
/// header line gets: clean line endings, then a token name before the colon.
fn is_valid_trailer_line(line: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(line) else {
        return false;
    };
    if !super::has_clean_header_bytes(text) {
        return false;
    }
    let Some(text) = text.strip_suffix("\r\n") else {
        return false;
    };
    let Some((name, _)) = text.split_once(':') else {
        return false;
    };
    !name.is_empty() && name.bytes().all(super::is_header_token_byte)
}

struct ProxyMetrics {
    active_connections: AtomicUsize,
    peak_active_connections: AtomicUsize,
    active_tunnels: AtomicUsize,
    peak_active_tunnels: AtomicUsize,
    pending_admissions: AtomicUsize,
    peak_pending_admissions: AtomicUsize,
    overload_rejections: AtomicUsize,
    /// E2E only: relay or listener wakes that made no I/O progress and were
    /// not a cancellation. A polling sleep would make this grow while idle.
    #[cfg(feature = "e2e")]
    idle_wakeups: AtomicU64,
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
            #[cfg(feature = "e2e")]
            idle_wakeups: AtomicU64::new(0),
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

/// Where an operation's cancellation comes from. Downloader and metadata
/// sessions both own a watch sender, and their proxies await the change.
enum OperationCancel {
    #[cfg(feature = "e2e")]
    Absent,
    Signal(watch::Receiver<bool>),
}

impl OperationCancel {
    /// Synchronous read of the current value, for blocking callers and checks
    /// that run between awaits.
    fn is_set(&self) -> bool {
        match self {
            #[cfg(feature = "e2e")]
            Self::Absent => false,
            Self::Signal(receiver) => *receiver.borrow(),
        }
    }
}

/// Completes once a signal reports cancellation. A signal whose sender is gone
/// can never change again, so it stays pending and the shutdown wait decides.
async fn signal_cancelled(signal: &mut Option<watch::Receiver<bool>>) {
    let Some(receiver) = signal.as_mut() else {
        return std::future::pending().await;
    };
    loop {
        // Reads the current value first, so a signal sent before this
        // receiver was cloned or subscribed is not missed.
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return std::future::pending().await;
        }
    }
}

struct ProxyShared {
    stopped: AtomicBool,
    operation_cancelled: OperationCancel,
    shutdown: watch::Sender<bool>,
    upstream: Option<UpstreamProxy>,
    metrics: Arc<ProxyMetrics>,
}

impl ProxyShared {
    fn is_cancelled(&self) -> bool {
        self.stopped.load(Ordering::Acquire) || self.operation_cancelled.is_set()
    }

    /// Completes when the operation is cancelled or the guard stops. Waits on
    /// the change itself; it never wakes on a timer.
    async fn cancelled(&self) {
        let mut shutdown = self.shutdown.subscribe();
        let mut signal = match &self.operation_cancelled {
            OperationCancel::Signal(receiver) => Some(receiver.clone()),
            #[cfg(feature = "e2e")]
            OperationCancel::Absent => None,
        };
        loop {
            if self.is_cancelled() {
                return;
            }
            tokio::select! {
                _ = shutdown.changed() => {},
                _ = signal_cancelled(&mut signal) => {},
            }
            #[cfg(feature = "e2e")]
            self.note_idle_wakeup();
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
        Self::start_inner(OperationCancel::Absent, None)
    }

    /// Guard for a download or metadata session. The receiver's current value
    /// is read before the guard starts, and a later change wakes its client tasks.
    pub fn start_with_cancel_signal(
        operation_cancelled: watch::Receiver<bool>,
        upstream_proxy: &str,
    ) -> Result<Self, String> {
        let upstream = super::parse_upstream_proxy(upstream_proxy)?;
        Self::start_inner(OperationCancel::Signal(operation_cancelled), upstream)
    }

    fn start_inner(
        operation_cancelled: OperationCancel,
        upstream: Option<UpstreamProxy>,
    ) -> Result<Self, String> {
        if operation_cancelled.is_set() {
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
    let (header, buffered) =
        match time::timeout(PRE_AUTH_HEADER_TIMEOUT, read_request_header(&mut client)).await {
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
    if auth_values.len() != 1
        || !constant_time_eq(auth_values[0].as_bytes(), expected_auth.as_bytes())
    {
        reject_client(&mut client, 407, "Proxy Authentication Required").await;
        return;
    }

    if method.eq_ignore_ascii_case("CONNECT") {
        let Ok((host, port, is_literal_loopback)) = super::parse_connect_target(&target) else {
            reject_client(&mut client, 400, "Bad CONNECT Target").await;
            return;
        };
        let addresses = match vet_destination(&host, port, is_literal_loopback, &shared).await {
            Ok(addresses) => addresses,
            Err(error) => {
                reject_destination(&mut client, error).await;
                return;
            }
        };
        let (mut upstream, tunnel_leftover) = match shared.upstream.as_ref() {
            None => match connect_addresses(addresses).await {
                Ok(stream) => (stream, Vec::new()),
                Err(error) => {
                    reject_connect_failure(&mut client, error).await;
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
    let addresses = match vet_destination(&host, port, literal_loopback, &shared).await {
        Ok(addresses) => addresses,
        Err(error) => {
            reject_destination(&mut client, error).await;
            return;
        }
    };
    let absolute_form = shared.upstream.is_some();
    // Framing is validated before any upstream connection is opened.
    let Some((forwarded, body_mode, expect_continue)) =
        super::build_forwarded_request(&method, &version, &url, &headers, absolute_form)
    else {
        reject_client(&mut client, 400, "Unsupported HTTP Request").await;
        return;
    };
    let mut upstream = match shared.upstream.as_ref() {
        None => match connect_addresses(addresses).await {
            Ok(stream) => stream,
            Err(error) => {
                reject_connect_failure(&mut client, error).await;
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
    if !shared.is_cancelled()
        && copied
            .as_ref()
            .is_err_and(|error| error.kind() == io::ErrorKind::InvalidInput)
    {
        // Only a malformed chunk trailer is answered; other body errors close.
        reject_client(&mut client, 400, "Bad Request").await;
        return;
    }
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
        // A terminator can straddle the previous read by up to three bytes, so
        // only the new bytes and that overlap are searched.
        let previous_len = bytes.len();
        bytes.extend_from_slice(&chunk[..count]);
        let search_start = previous_len.saturating_sub(3);
        if let Some(offset) = bytes[search_start..]
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        {
            let split = search_start + offset + 4;
            return Ok((bytes[..split].to_vec(), bytes[split..].to_vec()));
        }
    }
}

async fn reject_client(stream: &mut TcpStream, code: u16, reason: &str) {
    write_rejection(stream, code, reason).await;
    drain_rejected_client(stream).await;
}

/// Policy refusals are 403. Resolution failures are 502. A cancelled proxy
/// answers nothing, since the client is being torn down.
async fn reject_destination(stream: &mut TcpStream, error: DestinationError) {
    match error {
        DestinationError::Refused => reject_client(stream, 403, "Destination Blocked").await,
        DestinationError::ResolveFailed => reject_client(stream, 502, "Bad Gateway").await,
        DestinationError::Cancelled => {}
    }
}

async fn reject_connect_failure(stream: &mut TcpStream, error: ConnectError) {
    match error {
        ConnectError::TimedOut => reject_client(stream, 504, "Gateway Timeout").await,
        ConnectError::Failed => reject_client(stream, 502, "Bad Gateway").await,
    }
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
) -> Result<Vec<SocketAddr>, DestinationError> {
    let addresses = time::timeout(DNS_RESOLUTION_TIMEOUT, resolve_destination(host, port))
        .await
        .ok()
        .flatten()
        .ok_or(DestinationError::ResolveFailed)?;
    let allowed = !addresses.is_empty()
        && addresses.iter().all(|address| {
            is_public_ip(address.ip())
                || (allow_literal_loopback
                    && super::e2e_allows_literal_loopback(host, address.ip()))
        });
    #[cfg(feature = "e2e")]
    super::e2e::record_proxy_decision("connection", host, &addresses, allowed);
    if shared.is_cancelled() {
        return Err(DestinationError::Cancelled);
    }
    if addresses.is_empty() {
        return Err(DestinationError::ResolveFailed);
    }
    if !allowed {
        return Err(DestinationError::Refused);
    }
    Ok(addresses)
}

async fn resolve_destination(host: &str, port: u16) -> Option<Vec<SocketAddr>> {
    if let Some(ip) = super::parse_ip_host(host) {
        return Some(vec![SocketAddr::new(ip, port)]);
    }
    #[cfg(feature = "e2e")]
    if let Some(ip) = super::e2e::e2e_proxy_dns_override(host) {
        return Some(vec![SocketAddr::new(ip, port)]);
    }

    let resolver = super::shared_dns_resolver()?;
    let mut pending = resolver.enqueue(host, port)?;
    // The worker sends one reply. A closed reply means the worker dropped the
    // job (pool stop or panic), which is a refusal. Dropping this future before
    // the reply cancels the queued job through `PendingDnsJob::drop`. Callers
    // wrap this in `DNS_RESOLUTION_TIMEOUT`.
    let answer = (&mut pending.response).await;
    pending.finish();
    answer.ok().flatten()
}

async fn connect_addresses(addresses: Vec<SocketAddr>) -> Result<TcpStream, ConnectError> {
    let deadline = Instant::now() + CONNECT_TOTAL_TIMEOUT;
    let mut timed_out = false;
    for address in super::interleave_address_families(addresses) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            timed_out = true;
            break;
        }
        match time::timeout(remaining.min(CONNECT_TIMEOUT), TcpStream::connect(address)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(_)) => {}
            Err(_) => timed_out = true,
        }
    }
    Err(if timed_out {
        ConnectError::TimedOut
    } else {
        ConnectError::Failed
    })
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
    connect_addresses(addresses).await.ok()
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
    let mut trailer_bytes = 0usize;
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
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid chunk size"))?
            .trim_matches(|c: char| c == ' ' || c == '\t');
        // Only hex digits form a size, so a sign or prefix is refused.
        if size_text.is_empty() || !size_text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid chunk size",
            ));
        }
        let size = u64::from_str_radix(size_text, 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid chunk size"))?;
        if size > MAX_HTTP_REQUEST_BODY_BYTES.saturating_sub(total) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP request body exceeds the configured limit",
            ));
        }
        // The chunk extension (if any) is dropped, so the forwarded size line is canonical.
        let canonical_size_line = format!("{size:x}\r\n");
        time::timeout(
            IO_TIMEOUT,
            upstream.write_all(canonical_size_line.as_bytes()),
        )
        .await
        .map_err(|_| io_timeout_error())??;
        if size == 0 {
            loop {
                let trailer = reader.read_crlf_line().await?;
                trailer_bytes += trailer.len();
                if trailer_bytes > MAX_PROXY_HEADER_BYTES {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "chunk trailers exceed the header limit",
                    ));
                }
                if trailer != b"\r\n" && !is_valid_trailer_line(&trailer) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "invalid chunk trailer",
                    ));
                }
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
    /// E2E only: count of I/O records, used to tell progress from a bare wake.
    #[cfg(feature = "e2e")]
    records: AtomicU64,
}

impl Activity {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            last_activity_ms: AtomicU64::new(0),
            changed: tokio::sync::Notify::new(),
            #[cfg(feature = "e2e")]
            records: AtomicU64::new(0),
        }
    }

    fn record(&self) {
        let elapsed = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        self.last_activity_ms.store(elapsed, Ordering::Release);
        #[cfg(feature = "e2e")]
        self.records.fetch_add(1, Ordering::AcqRel);
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
    let relay_loop = async {
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
    };
    #[cfg(feature = "e2e")]
    let relay_loop =
        e2e_async::count_bare_wakeups(relay_loop, Arc::clone(&activity), Arc::clone(&shared));
    relay_loop.await
}
