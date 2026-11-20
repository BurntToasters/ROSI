//! E2E-only probes and test overrides for the pinned proxy. This module is
//! compiled only with the `e2e` feature, so a release build contains none of
//! the probe commands, the `ROSI_E2E_*` environment overrides, or the DNS
//! hold and delay hosts.

use super::{
    async_proxy, base64_encode, parse_ip_host, resolve_system_dns_with_cancel, shared_dns_resolver,
    DnsResolverPool, DnsResolverShared, NetworkSecurityGuard, DNS_RESOLVER_WORKERS,
    MAX_PENDING_DNS_QUERIES,
};
use crate::ip_policy::is_public_ip;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// Lookups for the probe's synthetic hosts. `None` means an ordinary host that
/// goes to the system resolver.
pub(super) fn synthetic_dns_lookup(
    host: &str,
    port: u16,
    shared: &DnsResolverShared,
) -> Option<Vec<SocketAddr>> {
    if host.starts_with("rosi-dns-hold-") {
        hold_e2e_lookup(shared);
        return Some(vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)]);
    }

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

    None
}

/// A literal loopback address is allowed only when the runner opted in.
pub(super) fn allows_literal_loopback(host: &str, address: IpAddr) -> bool {
    std::env::var("ROSI_E2E_ALLOW_LOOPBACK").as_deref() == Ok("1")
        && parse_ip_host(host).is_some_and(|literal| literal == address && literal.is_loopback())
}

/// Trusts the test CA named by `ROSI_E2E_TLS_CA`, when one is set.
pub(super) fn add_test_ca(builder: reqwest::ClientBuilder) -> Option<reqwest::ClientBuilder> {
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

const E2E_DNS_DELAY: Duration = Duration::from_secs(2);
/// Fail-safe for lookups the capacity probe holds at its gate. The probe
/// reopens the gate itself; this bound only keeps a failed probe from leaving
/// workers blocked for the rest of the process.
const E2E_DNS_HOLD_TIMEOUT: Duration = Duration::from_secs(30);

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
    /// While closed, lookups for `rosi-dns-hold-` hosts stay on their worker
    /// until the gate reopens. Ordinary lookups are not affected.
    fn set_lookup_gate(&self, closed: bool) {
        let mut state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.lookup_gate_closed = closed;
        drop(state);
        self.shared.lookup_gate.notify_all();
    }

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

/// Holds a probe lookup on its worker while the gate is closed. The wait is
/// bounded by `E2E_DNS_HOLD_TIMEOUT`, and a stopped pool releases it at once.
fn hold_e2e_lookup(shared: &DnsResolverShared) {
    let deadline = Instant::now() + E2E_DNS_HOLD_TIMEOUT;
    let mut state = shared
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.synthetic_lookups_started = state.synthetic_lookups_started.saturating_add(1);
    while state.lookup_gate_closed && !state.stopped {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let (next, _) = shared
            .lookup_gate
            .wait_timeout(state, remaining)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state = next;
    }
}

/// Closes the lookup gate for one probe batch and reopens it on drop, so every
/// exit from the batch releases the held workers.
struct E2eLookupGate {
    resolver: Arc<DnsResolverPool>,
}

impl E2eLookupGate {
    fn close(resolver: Arc<DnsResolverPool>) -> Self {
        resolver.set_lookup_gate(true);
        Self { resolver }
    }
}

impl Drop for E2eLookupGate {
    fn drop(&mut self) {
        self.resolver.set_lookup_gate(false);
    }
}

pub(super) fn e2e_preflight_dns_override(host: &str) -> Option<IpAddr> {
    let configured = std::env::var("ROSI_E2E_DNS_MAP").ok()?;
    configured
        .split(',')
        .filter_map(|mapping| mapping.trim().split_once('='))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case(host))
        .and_then(|(_, address)| address.trim().parse::<IpAddr>().ok())
}

pub(super) fn e2e_proxy_dns_override(host: &str) -> Option<IpAddr> {
    let configured = std::env::var("ROSI_E2E_PROXY_DNS_MAP").ok()?;
    configured
        .split(',')
        .filter_map(|mapping| mapping.trim().split_once('='))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case(host))
        .and_then(|(_, address)| address.trim().parse::<IpAddr>().ok())
}

pub(super) fn record_proxy_decision(
    stage: &str,
    host: &str,
    addresses: &[SocketAddr],
    allowed: bool,
) {
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

/// Spawns probe callers for `indexes`. Each caller uses a `rosi-dns-hold-`
/// host, so its lookup stays on a worker while the gate is closed.
fn spawn_e2e_dns_callers(
    batch: usize,
    indexes: std::ops::Range<usize>,
    cancellations: &[Arc<AtomicBool>],
    result_sender: &mpsc::Sender<(Duration, bool)>,
    callers: &mut Vec<thread::JoinHandle<()>>,
) -> Result<(), String> {
    for index in indexes {
        let cancellation = Arc::clone(&cancellations[index]);
        let result_sender = result_sender.clone();
        let host = format!("rosi-dns-hold-{batch}-{index}.invalid");
        let caller = thread::Builder::new()
            .name(format!("rosi-e2e-dns-caller-{batch}-{index}"))
            .spawn(move || {
                let started = Instant::now();
                let result = resolve_system_dns_with_cancel(&host, 443, Some(&cancellation));
                let _ = result_sender.send((started.elapsed(), result.is_none()));
            })
            .map_err(|error| error.to_string())?;
        callers.push(caller);
    }
    Ok(())
}

/// Polls resolver state until `ready` holds or the deadline passes. Callers
/// only use it for states that stay put while the gate is closed.
fn wait_for_resolver_state(
    resolver: &DnsResolverPool,
    deadline: Instant,
    ready: impl Fn(&DnsResolverSnapshot) -> bool,
) -> bool {
    loop {
        if ready(&resolver.snapshot()) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(2));
    }
}

fn e2e_dns_cancellation_probe() -> Result<serde_json::Value, String> {
    const BATCHES: usize = 3;
    const CALLERS_PER_BATCH: usize = 24;
    const OVERFLOW_CALLERS: u64 =
        (CALLERS_PER_BATCH - DNS_RESOLVER_WORKERS - MAX_PENDING_DNS_QUERIES) as u64;

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

    let mut batches_at_queue_limit = 0usize;
    for batch in 0..BATCHES {
        let (idle, waited) = wait_for_idle(idle_budget_left);
        idle_wait += waited;
        idle_budget_left = idle_budget_left.saturating_sub(waited);
        idle_reached &= idle;
        // Per-batch baseline: the probe-wide one goes stale after batch 0.
        let batch_before = resolver.snapshot();
        let batch_start = Instant::now();
        // The gate keeps every lookup of this batch on its worker until the
        // phases below have read their states. Its guard reopens it on every
        // exit from the batch, including the error paths.
        let gate = E2eLookupGate::close(Arc::clone(&resolver));
        let cancellations = (0..CALLERS_PER_BATCH)
            .map(|_| Arc::new(AtomicBool::new(false)))
            .collect::<Vec<_>>();
        let (result_sender, result_receiver) = mpsc::channel();
        let mut callers = Vec::with_capacity(CALLERS_PER_BATCH);

        // Phase 1 holds every worker. Phase 2 fills the queue to its limit
        // while the workers stay held. Phase 3 sends callers that must be
        // rejected. Each wait reads a state that cannot change until the gate
        // opens, so a loaded runner cannot make it miss the state.
        let submit_deadline = batch_start + Duration::from_secs(10);
        let mut workers_held = false;
        let mut queue_full = false;
        let mut overflow_rejected = false;
        let mut time_to_capacity = None;
        let mut spawn_error = None;
        'phases: {
            if let Err(error) = spawn_e2e_dns_callers(
                batch,
                0..DNS_RESOLVER_WORKERS,
                &cancellations,
                &result_sender,
                &mut callers,
            ) {
                spawn_error = Some(error);
                break 'phases;
            }
            workers_held = wait_for_resolver_state(&resolver, submit_deadline, |state| {
                state.active_workers == DNS_RESOLVER_WORKERS
            });
            if !workers_held {
                break 'phases;
            }
            if let Err(error) = spawn_e2e_dns_callers(
                batch,
                DNS_RESOLVER_WORKERS..DNS_RESOLVER_WORKERS + MAX_PENDING_DNS_QUERIES,
                &cancellations,
                &result_sender,
                &mut callers,
            ) {
                spawn_error = Some(error);
                break 'phases;
            }
            queue_full = wait_for_resolver_state(&resolver, submit_deadline, |state| {
                state.queue_len == MAX_PENDING_DNS_QUERIES
                    && state.active_workers == DNS_RESOLVER_WORKERS
            });
            if !queue_full {
                break 'phases;
            }
            time_to_capacity = Some(batch_start.elapsed());
            if let Err(error) = spawn_e2e_dns_callers(
                batch,
                DNS_RESOLVER_WORKERS + MAX_PENDING_DNS_QUERIES..CALLERS_PER_BATCH,
                &cancellations,
                &result_sender,
                &mut callers,
            ) {
                spawn_error = Some(error);
                break 'phases;
            }
            overflow_rejected = wait_for_resolver_state(&resolver, submit_deadline, |state| {
                state
                    .rejected_requests
                    .saturating_sub(batch_before.rejected_requests)
                    >= OVERFLOW_CALLERS
                    && state.queue_len == MAX_PENDING_DNS_QUERIES
            });
        }
        let observed = resolver.snapshot();
        max_time_to_capacity = max_time_to_capacity.max(time_to_capacity.unwrap_or(Duration::ZERO));

        for cancellation in &cancellations {
            cancellation.store(true, Ordering::Release);
        }
        for caller in callers.drain(..) {
            let _ = caller.join();
        }
        drop(result_sender);
        drop(gate);
        while let Ok((elapsed, returned_without_answer)) = result_receiver.try_recv() {
            max_caller_return = max_caller_return.max(elapsed);
            callers_returned_without_answer += usize::from(returned_without_answer);
        }

        if spawn_error.is_some() || !(workers_held && queue_full && overflow_rejected) {
            return Err(format!(
                "bounded DNS E2E callers did not reach the resolver queue limit (batch={batch} elapsedMs={} heldWorkers={workers_held} queueFull={queue_full} overflowRejected={overflow_rejected} activeWorkers={} queueLen={} attemptsDelta={} rejectedDelta={} syntheticLookupsDelta={} workersStarted={} idleReached={idle} idleWaitMs={} spawnError={spawn_error:?})",
                batch_start.elapsed().as_millis(),
                observed.active_workers,
                observed.queue_len,
                observed.request_attempts.saturating_sub(batch_before.request_attempts),
                observed.rejected_requests.saturating_sub(batch_before.rejected_requests),
                observed.synthetic_lookups_started.saturating_sub(batch_before.synthetic_lookups_started),
                observed.workers_started,
                idle_wait.as_millis(),
            ));
        }
        batches_at_queue_limit += 1;
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
        "batchesAtQueueLimit": batches_at_queue_limit,
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
    let malformed_header_statuses = e2e_malformed_header_probe()?;
    let async_proxy = async_proxy::e2e_async::e2e_capacity_probe()?;
    Ok(serde_json::json!({
        "requests": requests,
        "responseStatus": response_status,
        "responseBody": response_body,
        "secondTargetForwarded": requests.iter().any(|line| line.contains("/blocked") || line.contains("private.test")),
        "asyncProxy": async_proxy,
        "dnsResolution": dns_resolution,
        "ipv6Classification": ipv6_classification,
        "policyMatrix": policy_matrix,
        "malformedHeaderStatuses": malformed_header_statuses,
    }))
}

/// Sends header blocks with a bare LF, a control byte and a DEL byte to a
/// fresh proxy. Each must get HTTP 400 before authentication or forwarding.
fn e2e_malformed_header_probe() -> Result<Vec<Option<u16>>, String> {
    let guard = NetworkSecurityGuard::start()?;
    let proxy_url = url::Url::parse(guard.proxy_url())
        .map_err(|error| format!("could not inspect secure proxy URL: {error}"))?;
    let proxy_host = proxy_url.host_str().ok_or("secure proxy has no host")?;
    let proxy_port = proxy_url
        .port_or_known_default()
        .ok_or("secure proxy has no port")?;
    let proxy_address = format!("{proxy_host}:{proxy_port}");
    let requests: [&[u8]; 3] = [
        b"GET http://127.0.0.1:9/ HTTP/1.1\r\nX-A: b\nX-Injected: 1\r\n\r\n",
        b"GET http://127.0.0.1:9/ HTTP/1.1\r\nX-A: b\x01c\r\n\r\n",
        b"GET http://127.0.0.1:9/ HTTP/1.1\r\nX-A: b\x7fc\r\n\r\n",
    ];
    let mut statuses = Vec::new();
    for request in requests {
        let mut client = TcpStream::connect(proxy_address.as_str())
            .map_err(|error| format!("could not connect to the secure proxy: {error}"))?;
        let _ = client.set_read_timeout(Some(Duration::from_secs(4)));
        client
            .write_all(request)
            .map_err(|error| format!("could not send malformed header: {error}"))?;
        let mut response = Vec::new();
        let _ = client.read_to_end(&mut response);
        let text = String::from_utf8_lossy(&response);
        statuses.push(
            text.lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|status| status.parse::<u16>().ok()),
        );
    }
    drop(guard);
    Ok(statuses)
}

/// Fixed literals with expected verdicts, checked by the V5 network policy
/// E2E spec. NAT64 rows are public only when the embedded IPv4 is public.
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
