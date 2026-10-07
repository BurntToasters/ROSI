//! Per-operation outbound proxy that pins every destination to a vetted IP.
//!
//! yt-dlp follows extractor-supplied URLs and redirects itself, so checking a
//! URL once before launching the process is not a network security boundary.
//! Every HTTP request and HTTPS CONNECT sent through this short-lived proxy is
//! resolved and checked again here, then connected to the exact vetted
//! address. The proxy uses a fixed worker pool and closes active sockets when
//! its owning operation ends.

use reqwest::redirect::Policy;
use reqwest::Client;
use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::net::{
    IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs,
};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Condvar, Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_PROXY_HEADER_BYTES: usize = 64 * 1024;
const MAX_HTTP_REQUEST_BODY_BYTES: u64 = 64 * 1024 * 1024;
const THUMBNAIL_MAX_BYTES: usize = 2 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(20);
const PROXY_WORKERS: usize = 8;
const MAX_PENDING_PROXY_CLIENTS: usize = 32;
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
}

type ParsedHttpRequest = (String, String, String, Vec<(String, String)>);

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
        })
    }

    fn cancel(&self, pending: &PendingDnsJob) {
        pending.cancelled.store(true, Ordering::Release);
        let mut state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let queued_len = state.queue.len();
        state.queue.retain(|job| job.id != pending.id);
        #[cfg(feature = "e2e")]
        {
            state.cancelled_waits = state.cancelled_waits.saturating_add(1);
        }
        if state.queue.len() != queued_len {
            drop(state);
            self.shared.queue_ready.notify_one();
        }
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

struct ProxyShared {
    stopped: AtomicBool,
    operation_cancelled: Option<Arc<AtomicBool>>,
    queued: Mutex<VecDeque<TcpStream>>,
    queue_ready: Condvar,
    active: Mutex<HashMap<u64, Vec<TcpStream>>>,
    next_id: AtomicU64,
}

impl ProxyShared {
    fn new(operation_cancelled: Option<Arc<AtomicBool>>) -> Self {
        Self {
            stopped: AtomicBool::new(false),
            operation_cancelled,
            queued: Mutex::new(VecDeque::new()),
            queue_ready: Condvar::new(),
            active: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    fn enqueue(&self, mut stream: TcpStream) {
        let mut queued = self
            .queued
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.stopped.load(Ordering::Acquire) || self.operation_is_cancelled() {
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
        if queued.len() >= MAX_PENDING_PROXY_CLIENTS {
            drop(queued);
            let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
            write_proxy_error(&mut stream, 503, "Proxy Busy");
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
        queued.push_back(stream);
        self.queue_ready.notify_one();
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        let mut queued = self
            .queued
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for stream in queued.drain(..) {
            let _ = stream.shutdown(Shutdown::Both);
        }
        drop(queued);
        let active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for sockets in active.values() {
            for socket in sockets {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
        self.queue_ready.notify_all();
    }

    fn next_client(&self) -> Option<TcpStream> {
        let mut queued = self
            .queued
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if self.stopped.load(Ordering::Acquire) {
                return None;
            }
            if self.operation_is_cancelled() {
                drop(queued);
                self.stop();
                return None;
            }
            if let Some(stream) = queued.pop_front() {
                return Some(stream);
            }
            queued = self
                .queue_ready
                .wait(queued)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn operation_is_cancelled(&self) -> bool {
        self.operation_cancelled
            .as_ref()
            .is_some_and(|cancelled| cancelled.load(Ordering::Acquire))
    }
}

struct ActiveSockets {
    shared: Arc<ProxyShared>,
    id: u64,
}

impl ActiveSockets {
    fn register(&self, stream: &TcpStream) -> io::Result<()> {
        let clone = stream.try_clone()?;
        let mut active = self
            .shared
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.shared.stopped.load(Ordering::Acquire) || self.shared.operation_is_cancelled() {
            let _ = clone.shutdown(Shutdown::Both);
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "network operation was cancelled",
            ));
        }
        active.entry(self.id).or_default().push(clone);
        Ok(())
    }
}

impl Drop for ActiveSockets {
    fn drop(&mut self) {
        self.shared
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.id);
    }
}

/// Owns the per-operation loopback proxy. Retain it until the process or HTTP
/// operation finishes; dropping it closes the listener, queued sockets, and
/// both ends of every active connection.
pub struct NetworkSecurityGuard {
    proxy_url: String,
    bind_addr: SocketAddr,
    shared: Arc<ProxyShared>,
    listener_thread: Option<JoinHandle<()>>,
}

impl NetworkSecurityGuard {
    /// Starts an authenticated loopback proxy. Any bind, entropy, or thread
    /// startup failure is returned; callers must not fall back to direct I/O.
    pub fn start() -> Result<Self, String> {
        Self::start_inner(None)
    }

    /// Starts a proxy that shuts down its listener and active sockets when
    /// the owning tracked operation is cancelled.
    pub fn start_with_cancellation(operation_cancelled: Arc<AtomicBool>) -> Result<Self, String> {
        Self::start_inner(Some(operation_cancelled))
    }

    fn start_inner(operation_cancelled: Option<Arc<AtomicBool>>) -> Result<Self, String> {
        if operation_cancelled
            .as_ref()
            .is_some_and(|cancelled| cancelled.load(Ordering::Acquire))
        {
            return Err("The network operation was cancelled.".into());
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
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
            base64_encode(format!("rosi:{token}").as_bytes())
        ));
        let proxy_url = format!("http://rosi:{token}@{bind_addr}");
        let shared = Arc::new(ProxyShared::new(operation_cancelled));

        for worker in 0..PROXY_WORKERS {
            let worker_shared = Arc::clone(&shared);
            let worker_auth = Arc::clone(&expected_auth);
            if let Err(error) = thread::Builder::new()
                .name(format!("rosi-network-worker-{worker}"))
                .spawn(move || proxy_worker(worker_shared, worker_auth))
            {
                shared.stop();
                return Err(format!(
                    "Could not start the secure network proxy workers: {error}"
                ));
            }
        }

        let listener_shared = Arc::clone(&shared);
        let listener_thread = match thread::Builder::new()
            .name("rosi-network-listener".into())
            .spawn(move || {
                while !listener_shared.stopped.load(Ordering::Acquire) {
                    if listener_shared.operation_is_cancelled() {
                        listener_shared.stop();
                        break;
                    }
                    match listener.accept() {
                        Ok((stream, _)) => listener_shared.enqueue(stream),
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            }) {
            Ok(thread) => thread,
            Err(error) => {
                shared.stop();
                return Err(format!("Could not start the secure network proxy: {error}"));
            }
        };

        Ok(Self {
            proxy_url,
            bind_addr,
            shared,
            listener_thread: Some(listener_thread),
        })
    }

    /// Credential-bearing proxy URL for a subprocess or HTTP client. Treat it
    /// as an ephemeral secret and do not log it.
    pub fn proxy_url(&self) -> &str {
        &self.proxy_url
    }
}

impl Drop for NetworkSecurityGuard {
    fn drop(&mut self) {
        self.shared.stop();
        // The listener is nonblocking. Wake it and join only that bounded
        // accept loop; request workers are fixed-count and exit asynchronously.
        let _ = TcpStream::connect_timeout(&self.bind_addr, Duration::from_millis(100));
        if let Some(listener_thread) = self.listener_thread.take() {
            let _ = listener_thread.join();
        }
    }
}

fn proxy_worker(shared: Arc<ProxyShared>, expected_auth: Arc<str>) {
    while let Some(mut client) = shared.next_client() {
        let _ = client.set_read_timeout(Some(IO_TIMEOUT));
        let _ = client.set_write_timeout(Some(IO_TIMEOUT));
        let id = shared.next_id.fetch_add(1, Ordering::Relaxed);
        let active = ActiveSockets {
            shared: Arc::clone(&shared),
            id,
        };
        if active.register(&client).is_err() {
            continue;
        }
        handle_proxy_client(&mut client, &expected_auth, &active);
    }
}

fn handle_proxy_client(client: &mut TcpStream, expected_auth: &str, active: &ActiveSockets) {
    let Ok((header, buffered)) = read_request_header(client) else {
        return;
    };
    let Ok(header_text) = std::str::from_utf8(&header) else {
        write_proxy_error(client, 400, "Bad Request");
        return;
    };
    let Some((method, target, version, headers)) = parse_request(header_text) else {
        write_proxy_error(client, 400, "Bad Request");
        return;
    };
    let auth_values: Vec<&str> = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("proxy-authorization"))
        .map(|(_, value)| value.trim())
        .collect();
    if auth_values.len() != 1 || auth_values[0] != expected_auth {
        write_proxy_error(client, 407, "Proxy Authentication Required");
        return;
    }

    if method.eq_ignore_ascii_case("CONNECT") {
        let Ok((host, port, is_literal_loopback)) = parse_connect_target(&target) else {
            write_proxy_error(client, 400, "Bad CONNECT Target");
            return;
        };
        let Some(mut upstream) =
            connect_vetted_destination(&host, port, is_literal_loopback, active)
        else {
            write_proxy_error(client, 403, "Destination Blocked");
            return;
        };
        if active.shared.stopped.load(Ordering::Acquire) {
            return;
        }
        if client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .is_err()
        {
            return;
        }
        let _ = relay_bidirectional(client, &mut upstream, &active.shared, &buffered);
        return;
    }

    let Ok(url) = url::Url::parse(&target) else {
        write_proxy_error(client, 400, "Absolute URL Required");
        return;
    };
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        write_proxy_error(client, 403, "Destination Blocked");
        return;
    }
    let Some(url_host) = url.host() else {
        write_proxy_error(client, 400, "Missing Host");
        return;
    };
    let host = host_string(&url_host);
    let Some(port) = url.port_or_known_default() else {
        write_proxy_error(client, 400, "Missing Port");
        return;
    };
    let literal_loopback = host_is_loopback(&url_host);
    let Some(mut upstream) = connect_vetted_destination(&host, port, literal_loopback, active)
    else {
        write_proxy_error(client, 403, "Destination Blocked");
        return;
    };

    let Some((forwarded, body_mode, expect_continue)) =
        build_forwarded_request(&method, &version, &url, &headers)
    else {
        write_proxy_error(client, 400, "Unsupported HTTP Request");
        return;
    };
    if upstream.write_all(&forwarded).is_err() {
        return;
    }
    if expect_continue && client.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").is_err() {
        return;
    }
    let copied = match body_mode {
        HttpBodyMode::None => Ok(()),
        HttpBodyMode::ContentLength(length) => {
            copy_fixed_body(client, &mut upstream, &buffered, length, active)
        }
        HttpBodyMode::Chunked => copy_chunked_body(client, &mut upstream, &buffered, active),
    };
    if copied.is_err() || active.shared.stopped.load(Ordering::Acquire) {
        return;
    }
    // The forwarded request already has `Connection: close`, and this proxy
    // handles one request per upstream socket. Do not send a TCP FIN before
    // reading the response: some HTTP servers treat a peer half-close as a
    // signal to close their write side before a delayed or streamed body ends.
    let _ = io::copy(&mut upstream, client);
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

fn copy_fixed_body(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    buffered: &[u8],
    mut remaining: u64,
    active: &ActiveSockets,
) -> io::Result<()> {
    let prefix_count = buffered.len().min(remaining as usize);
    if prefix_count > 0 {
        upstream.write_all(&buffered[..prefix_count])?;
        remaining -= prefix_count as u64;
    }
    let mut chunk = [0u8; RELAY_BUFFER_BYTES];
    while remaining > 0 {
        if active.shared.stopped.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "network operation was cancelled",
            ));
        }
        let limit = chunk.len().min(remaining as usize);
        let count = client.read(&mut chunk[..limit])?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "HTTP request body ended early",
            ));
        }
        upstream.write_all(&chunk[..count])?;
        remaining -= count as u64;
    }
    Ok(())
}

struct PrefixReader<'a> {
    client: &'a mut TcpStream,
    prefix: &'a [u8],
    position: usize,
}

impl PrefixReader<'_> {
    fn read_some(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.position < self.prefix.len() {
            let count = output.len().min(self.prefix.len() - self.position);
            output[..count].copy_from_slice(&self.prefix[self.position..self.position + count]);
            self.position += count;
            Ok(count)
        } else {
            self.client.read(output)
        }
    }

    fn read_exact_bytes(&mut self, mut output: &mut [u8]) -> io::Result<()> {
        while !output.is_empty() {
            let count = self.read_some(output)?;
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

    fn read_crlf_line(&mut self) -> io::Result<Vec<u8>> {
        let mut line = Vec::with_capacity(64);
        let mut byte = [0u8; 1];
        loop {
            if line.len() >= 8192 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "chunk metadata line is too large",
                ));
            }
            self.read_exact_bytes(&mut byte)?;
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

fn copy_chunked_body(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    buffered: &[u8],
    active: &ActiveSockets,
) -> io::Result<()> {
    let mut reader = PrefixReader {
        client,
        prefix: buffered,
        position: 0,
    };
    let mut total = 0u64;
    loop {
        if active.shared.stopped.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "network operation was cancelled",
            ));
        }
        let line = reader.read_crlf_line()?;
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
        upstream.write_all(&line)?;
        if size == 0 {
            loop {
                let trailer = reader.read_crlf_line()?;
                upstream.write_all(&trailer)?;
                if trailer == b"\r\n" {
                    return Ok(());
                }
            }
        }
        let mut remaining = size;
        let mut chunk = [0u8; RELAY_BUFFER_BYTES];
        while remaining > 0 {
            if active.shared.stopped.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "network operation was cancelled",
                ));
            }
            let count = chunk.len().min(remaining as usize);
            reader.read_exact_bytes(&mut chunk[..count])?;
            upstream.write_all(&chunk[..count])?;
            remaining -= count as u64;
        }
        let mut terminator = [0u8; 2];
        reader.read_exact_bytes(&mut terminator)?;
        if &terminator != b"\r\n" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid chunk terminator",
            ));
        }
        upstream.write_all(&terminator)?;
        total += size;
    }
}

fn read_request_header(stream: &mut TcpStream) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let mut bytes = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if bytes.len() >= MAX_PROXY_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "proxy header too large",
            ));
        }
        let count = stream.read(&mut chunk)?;
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

fn connect_vetted_destination(
    host: &str,
    port: u16,
    allow_literal_loopback: bool,
    active: &ActiveSockets,
) -> Option<TcpStream> {
    let addresses = resolve_connection_destination(host, port, &active.shared.stopped)?;
    let allowed = !addresses.is_empty()
        && addresses.iter().all(|address| {
            is_public_ip(address.ip())
                || (allow_literal_loopback && e2e_allows_literal_loopback(host, address.ip()))
        });
    #[cfg(feature = "e2e")]
    record_proxy_decision("connection", host, &addresses, allowed);
    if !allowed || active.shared.stopped.load(Ordering::Acquire) {
        return None;
    }

    let deadline = Instant::now() + CONNECT_TIMEOUT;
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Ok(stream) = TcpStream::connect_timeout(&address, remaining) {
            let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
            let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
            if active.register(&stream).is_err() {
                let _ = stream.shutdown(Shutdown::Both);
                return None;
            }
            return Some(stream);
        }
    }
    None
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

fn resolve_connection_destination(
    host: &str,
    port: u16,
    cancelled: &AtomicBool,
) -> Option<Vec<SocketAddr>> {
    if let Some(ip) = parse_ip_host(host) {
        return Some(vec![SocketAddr::new(ip, port)]);
    }
    #[cfg(feature = "e2e")]
    if let Some(mapped) = e2e_proxy_dns_override(host) {
        return Some(vec![SocketAddr::new(mapped, port)]);
    }
    resolve_system_dns_with_cancel(host, port, Some(cancelled))
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
    let pending = resolver.enqueue(host, port)?;
    let deadline = Instant::now() + DNS_RESOLUTION_TIMEOUT;

    loop {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            resolver.cancel(&pending);
            return None;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            resolver.cancel(&pending);
            return None;
        }
        match pending
            .response
            .recv_timeout(remaining.min(DNS_RESOLUTION_POLL_INTERVAL))
        {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
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

pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    let [a, b, c, _] = octets;
    !(a == 0
        || a == 10
        || (a == 100 && (64..=127).contains(&b))
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if ip.to_ipv4_mapped().is_some() || ip.to_ipv4().is_some() {
        return false;
    }
    let segments = ip.segments();
    // Only global unicast 2000::/3 is permitted. This excludes unspecified,
    // loopback, unique-local, link-local, multicast, and future-use ranges.
    if (segments[0] & 0xe000) != 0x2000 {
        return false;
    }
    // Special-purpose 2001::/23, documentation 2001:db8::/32, 6to4
    // 2002::/16, and documentation 3fff::/20 are not public destinations.
    if (segments[0] == 0x2001 && (segments[1] & 0xfe00) == 0)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || segments[0] == 0x2002
        || (segments[0] == 0x3fff && (segments[1] & 0xfff0) == 0)
    {
        return false;
    }
    true
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

fn write_proxy_error(stream: &mut TcpStream, code: u16, reason: &str) {
    let body = format!("{code} {reason}\n");
    let response = format!(
        "HTTP/1.1 {code} {reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn relay_bidirectional(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    shared: &ProxyShared,
    initial_client_data: &[u8],
) -> io::Result<()> {
    if shared.stopped.load(Ordering::Acquire) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "network operation was cancelled",
        ));
    }
    upstream.write_all(initial_client_data)?;
    client.set_nonblocking(true)?;
    upstream.set_nonblocking(true)?;

    let mut client_to_upstream = [0u8; RELAY_BUFFER_BYTES];
    let mut client_to_upstream_len = 0usize;
    let mut client_to_upstream_offset = 0usize;
    let mut upstream_to_client = [0u8; RELAY_BUFFER_BYTES];
    let mut upstream_to_client_len = 0usize;
    let mut upstream_to_client_offset = 0usize;
    let mut client_read_open = true;
    let mut upstream_read_open = true;

    loop {
        if shared.stopped.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "network operation was cancelled",
            ));
        }
        let mut progressed = false;
        if client_to_upstream_offset < client_to_upstream_len {
            match upstream
                .write(&client_to_upstream[client_to_upstream_offset..client_to_upstream_len])
            {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => {
                    client_to_upstream_offset += count;
                    progressed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
            if client_to_upstream_offset == client_to_upstream_len {
                client_to_upstream_len = 0;
                client_to_upstream_offset = 0;
            }
        }
        if upstream_to_client_offset < upstream_to_client_len {
            match client
                .write(&upstream_to_client[upstream_to_client_offset..upstream_to_client_len])
            {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => {
                    upstream_to_client_offset += count;
                    progressed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
            if upstream_to_client_offset == upstream_to_client_len {
                upstream_to_client_len = 0;
                upstream_to_client_offset = 0;
            }
        }

        if client_read_open && client_to_upstream_len == 0 {
            match client.read(&mut client_to_upstream) {
                Ok(0) => {
                    client_read_open = false;
                    let _ = upstream.shutdown(Shutdown::Write);
                    progressed = true;
                }
                Ok(count) => {
                    client_to_upstream_len = count;
                    progressed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
        if upstream_read_open && upstream_to_client_len == 0 {
            match upstream.read(&mut upstream_to_client) {
                Ok(0) => {
                    upstream_read_open = false;
                    let _ = client.shutdown(Shutdown::Write);
                    progressed = true;
                }
                Ok(count) => {
                    upstream_to_client_len = count;
                    progressed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
        if !client_read_open
            && !upstream_read_open
            && client_to_upstream_len == 0
            && upstream_to_client_len == 0
        {
            return Ok(());
        }
        if !progressed {
            thread::sleep(Duration::from_millis(2));
        }
    }
}

#[cfg(feature = "e2e")]
fn e2e_dns_cancellation_probe() -> Result<serde_json::Value, String> {
    const BATCHES: usize = 3;
    const CALLERS_PER_BATCH: usize = 24;

    let resolver = shared_dns_resolver().ok_or("bounded DNS resolver did not start")?;
    let before = resolver.snapshot();
    let mut max_caller_return = Duration::ZERO;
    let mut callers_returned_without_answer = 0usize;
    let probe_started = Instant::now();

    for batch in 0..BATCHES {
        let batch_start = Instant::now();
        let before_attempts = resolver.snapshot().request_attempts;
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

        let submit_deadline = batch_start + Duration::from_secs(1);
        let mut all_attempted = false;
        let mut reached_capacity = false;
        while Instant::now() < submit_deadline {
            let snapshot = resolver.snapshot();
            let attempts = snapshot.request_attempts.saturating_sub(before_attempts);
            all_attempted = attempts >= CALLERS_PER_BATCH as u64;
            reached_capacity = snapshot.queue_len == MAX_PENDING_DNS_QUERIES
                && snapshot.active_workers == DNS_RESOLVER_WORKERS
                && snapshot.synthetic_lookups_started > before.synthetic_lookups_started;
            if all_attempted && reached_capacity {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }

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
            return Err("bounded DNS E2E callers did not reach the resolver queue limit".into());
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
    Ok(serde_json::json!({
        "requests": requests,
        "responseStatus": response_status,
        "responseBody": response_body,
        "secondTargetForwarded": requests.iter().any(|line| line.contains("/blocked") || line.contains("private.test")),
        "dnsResolution": dns_resolution,
        "ipv6Classification": ipv6_classification,
    }))
}
