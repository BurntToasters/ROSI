//! E2E-only probes for the asynchronous proxy: capacity, cancellation, guard
//! drop and idle-wake measurements. Compiled only with the `e2e` feature.

use super::{
    Activity, NetworkSecurityGuard, ProxyMetrics, ProxyShared, MAX_ACTIVE_PROXY_CLIENTS,
    MAX_PENDING_PROXY_CLIENTS,
};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener, TcpStream as StdTcpStream};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant as StdInstant};
use tokio::sync::watch;
use tokio::time::Instant;

#[derive(Clone, Copy)]
struct ProxyMetricsSnapshot {
    active_connections: usize,
    peak_active_connections: usize,
    active_tunnels: usize,
    peak_active_tunnels: usize,
    pending_admissions: usize,
    peak_pending_admissions: usize,
    overload_rejections: usize,
    idle_wakeups: u64,
}

impl ProxyMetrics {
    fn snapshot(&self) -> ProxyMetricsSnapshot {
        ProxyMetricsSnapshot {
            active_connections: self.active_connections.load(Ordering::Acquire),
            peak_active_connections: self.peak_active_connections.load(Ordering::Acquire),
            active_tunnels: self.active_tunnels.load(Ordering::Acquire),
            peak_active_tunnels: self.peak_active_tunnels.load(Ordering::Acquire),
            pending_admissions: self.pending_admissions.load(Ordering::Acquire),
            peak_pending_admissions: self.peak_pending_admissions.load(Ordering::Acquire),
            overload_rejections: self.overload_rejections.load(Ordering::Acquire),
            idle_wakeups: self.idle_wakeups.load(Ordering::Acquire),
        }
    }
}

impl ProxyShared {
    pub(super) fn note_idle_wakeup(&self) {
        if !self.is_cancelled() {
            self.metrics.idle_wakeups.fetch_add(1, Ordering::AcqRel);
        }
    }
}

/// E2E only: counts each poll of a tunnel's relay that found no I/O since the
/// previous poll, was not an idle close, and was not a cancellation. The first
/// poll is the start of the tunnel, not a wake.
pub(super) fn count_bare_wakeups<F: std::future::Future>(
    inner: F,
    activity: Arc<Activity>,
    shared: Arc<ProxyShared>,
) -> impl std::future::Future<Output = F::Output> {
    let mut inner = Box::pin(inner);
    let mut polls = 0u64;
    let mut seen_records = 0u64;
    std::future::poll_fn(move |cx| {
        let records = activity.records.load(Ordering::Acquire);
        let bare = polls > 0
            && records == seen_records
            && activity.deadline() > Instant::now()
            && !shared.is_cancelled();
        if bare {
            shared.metrics.idle_wakeups.fetch_add(1, Ordering::AcqRel);
        }
        polls += 1;
        seen_records = records;
        std::future::Future::poll(inner.as_mut(), cx)
    })
}

struct CapacityClients {
    active: Vec<StdTcpStream>,
    pending: Vec<StdTcpStream>,
}

pub(in crate::network_security) fn e2e_capacity_probe() -> Result<serde_json::Value, String> {
    static RESULT: OnceLock<Result<serde_json::Value, String>> = OnceLock::new();
    RESULT.get_or_init(run_e2e_capacity_probe).clone()
}

fn run_e2e_capacity_probe() -> Result<serde_json::Value, String> {
    let (cancel_sender, cancel_receiver) = watch::channel(false);
    let guard = NetworkSecurityGuard::start_with_cancel_signal(cancel_receiver.clone(), "")?;
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
    let origin_cancellation = cancel_receiver.clone();
    let origin_thread = std::thread::Builder::new()
        .name("rosi-e2e-async-proxy-origin".into())
        .spawn(move || {
            let mut streams = Vec::with_capacity(MAX_ACTIVE_PROXY_CLIENTS);
            let deadline = StdInstant::now() + Duration::from_secs(20);
            while streams.len() < MAX_ACTIVE_PROXY_CLIENTS
                && StdInstant::now() < deadline
                && !*origin_cancellation.borrow()
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
    cancel_sender.send_replace(true);
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

    let cancellation_elapsed_ms = cancellation_started.elapsed().as_millis();
    let drop = e2e_guard_drop_probe()?;
    let idle = e2e_idle_wakeup_probe()?;
    Ok(serde_json::json!({
        "capacity": capacity,
        "idle": idle,
        "cancellation": {
            "activeConnectionsAfterCancel": after_cancel.active_connections,
            "activeTunnelsAfterCancel": after_cancel.active_tunnels,
            "pendingAdmissionsAfterCancel": after_cancel.pending_admissions,
            "closedClientSockets": closed_clients,
            "expectedClientSockets": MAX_ACTIVE_PROXY_CLIENTS + MAX_PENDING_PROXY_CLIENTS,
            "closedOriginSockets": origin_closed,
            "expectedOriginSockets": MAX_ACTIVE_PROXY_CLIENTS,
            "elapsedMs": cancellation_elapsed_ms,
        },
        "drop": drop,
    }))
}

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
    let authorization =
        crate::network_security::base64_encode(format!("rosi:{password}").as_bytes());
    Ok((address, authorization))
}

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

/// Measurement window for the idle check. Shorter than the 60 s in the plan so
/// the suite stays fast; the tunnel idle deadline is 15 s, so it stays open.
const E2E_IDLE_WINDOW: Duration = Duration::from_secs(5);

/// Holds one CONNECT tunnel open with no traffic for `E2E_IDLE_WINDOW` and
/// reports the relay wakes counted during that window. A healthy relay has
/// none: it wakes only for I/O, cancellation, or its idle deadline.
fn e2e_idle_wakeup_probe() -> Result<serde_json::Value, String> {
    let guard = NetworkSecurityGuard::start()?;
    let metrics = Arc::clone(&guard.shared.metrics);
    let origin = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("could not bind idle origin: {error}"))?;
    origin
        .set_nonblocking(true)
        .map_err(|error| format!("could not configure idle origin: {error}"))?;
    let origin_port = origin
        .local_addr()
        .map_err(|error| format!("could not inspect idle origin: {error}"))?
        .port();
    let (release_sender, release_receiver) = mpsc::sync_channel::<()>(1);
    let origin_thread = std::thread::Builder::new()
        .name("rosi-e2e-async-proxy-idle-origin".into())
        .spawn(move || {
            let deadline = StdInstant::now() + Duration::from_secs(20);
            let held = loop {
                match origin.accept() {
                    Ok((stream, _)) => break Some(stream),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        if StdInstant::now() >= deadline {
                            break None;
                        }
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break None,
                }
            };
            let _ = release_receiver.recv_timeout(Duration::from_secs(30));
            drop(held);
        })
        .map_err(|error| format!("could not start idle origin: {error}"))?;

    let (address, authorization) = proxy_e2e_credentials(guard.proxy_url())?;
    let mut client = connect_e2e_client(address)?;
    let connect_request = format!(
        "CONNECT 127.0.0.1:{origin_port} HTTP/1.1\r\nHost: 127.0.0.1:{origin_port}\r\nProxy-Authorization: Basic {authorization}\r\n\r\n"
    );
    client
        .write_all(connect_request.as_bytes())
        .map_err(|error| format!("could not open idle E2E tunnel: {error}"))?;
    let (status, _) = read_e2e_response_head(&mut client)?;
    if status != 200 {
        return Err(format!(
            "idle E2E tunnel received HTTP {status}, expected 200"
        ));
    }
    if !wait_for_proxy_metrics(&metrics, Duration::from_secs(5), |snapshot| {
        snapshot.active_tunnels == 1
    }) {
        return Err("idle E2E tunnel did not become active".into());
    }
    let baseline = metrics.snapshot().idle_wakeups;
    std::thread::sleep(E2E_IDLE_WINDOW);
    let after = metrics.snapshot();
    let idle_wakeups = after.idle_wakeups.saturating_sub(baseline);
    if after.active_tunnels != 1 {
        return Err(format!(
            "idle E2E tunnel closed during the {}s window (active={})",
            E2E_IDLE_WINDOW.as_secs(),
            after.active_tunnels
        ));
    }
    drop(client);
    drop(guard);
    let _ = release_sender.send(());
    origin_thread
        .join()
        .map_err(|_| "idle E2E origin thread panicked".to_owned())?;
    Ok(serde_json::json!({
        "openTunnels": 1,
        "windowMs": E2E_IDLE_WINDOW.as_millis(),
        "activeTunnelsAtWindowEnd": after.active_tunnels,
        "idleWakeups": idle_wakeups,
    }))
}

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
