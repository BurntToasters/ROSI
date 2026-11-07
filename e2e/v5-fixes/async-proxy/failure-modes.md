# Async proxy failure modes

This inventory was written before the implementation change. The existing
`NetworkSecurityGuard` synchronous constructors and credential-bearing proxy
URL remain the caller contract. The listener and every client operation must
run on Tauri's Tokio runtime, with admission and DNS work bounded independently.

1. **The caller has no ambient Tokio handle.** A synchronous downloader or
   metadata caller must still start the guard through Tauri's shared runtime;
   startup failures are returned and never cause an unproxied network fallback.
2. **Many long-lived CONNECT tunnels consume all service capacity.** At least
   256 active connections must be serviceable without a fixed 32-worker queue.
3. **A burst exceeds connection capacity.** Pending admission is capped; excess
   clients receive an explicit bounded 503 response and do not create tasks or
   retain sockets indefinitely.
4. **An owner cancels or drops its guard with idle or active connections.** The
   listener, pending sockets, client tasks, and both tunnel endpoints are
   cancelled and released promptly.
5. **Cancellation happens during DNS, connect, header parsing, body copying,
   or upstream-proxy negotiation.** The caller wait returns without accumulating
   unabortable DNS jobs or leaving connection tasks behind.
6. **A DNS storm outlives its callers.** Resolver workers and queued lookups
   stay independently bounded; dropping a wait removes queued work and running
   system lookups remain capped by the fixed resolver worker count.
7. **A peer sends a partial or oversized request header or an idle tunnel.**
   Header limits and idle deadlines terminate it without busy polling or a
   blocked runtime worker.
8. **Authentication is missing, duplicated, or incorrect.** Exactly one valid
   proxy credential is required before resolving or connecting to a destination.
9. **A hostname resolves to a private, mixed public/private, or changing
   address set.** Reject unsafe answer sets and connect directly only to the
   exact addresses that were vetted; retain IPv4 and IPv6 classification.
10. **An upstream HTTP proxy is configured.** Preserve its existing CONNECT and
    absolute-form behavior while still vetting the requested destination; do
    not apply destination policy to the user's upstream itself.
11. **A CONNECT request arrives with tunnel payload already buffered after its
    headers, or the upstream sends payload with its success headers.** Preserve
    both byte sequences exactly and relay both directions with TCP half-close
    behavior.
12. **A half-close is mistaken for full connection closure.** Forward the
    remaining response in the opposite direction until both sides end or the
    idle deadline expires.
13. **Plain HTTP uses ambiguous or excessive framing.** Enforce header and body
    byte limits, reject conflicting or repeated framing headers, copy only the
    framed body, and never forward a pipelined second request on the connection.
14. **Backpressure or slow peers stall a connection.** Async reads/writes and
    per-operation deadlines must not block unrelated connections or grow
    buffers without a limit.
15. **A task exits through I/O error, cancellation, or panic.** Admission slots
    and active-socket ownership are released, and shutdown still drains or
    aborts all tracked tasks.
16. **The new capacity probe is missing, synthetic, or only checks configuration
    constants.** The existing `e2e_network_pipelining_probe` must exercise real
    loopback traffic and report observed 256-tunnel service, overload rejection,
    cancellation cleanup, and unchanged pipeline blocking in repeatable JSON.
17. **A rejected client still has unread input when the server closes.** Writing
    the 503, calling `shutdown()`, and dropping the socket makes the BSD stack
    send RST, which can discard the response before the client reads it (the
    overload probe saw `os error 54`). After the write, read and discard client
    bytes until EOF, 64 KiB, or 250 ms, whichever comes first, then drop. The
    probe keeps its strict `read_to_end`.
18. **A slow or never-closing client holds the drain open.** The 250 ms deadline
    is fixed when the drain starts and is not extended by arriving bytes. Loop
    drains (`Proxy Busy`, `Proxy Admission Timeout`) run as tracked tasks, so a
    stalled client never blocks accept or admission, and cancellation or guard
    drop aborts them with the other handlers.
19. **A client sends more than the drain cap.** Reading stops at 64 KiB through a
    fixed 4 KiB scratch buffer, so no buffer grows past the cap. Bytes beyond the
    cap may still reset the connection; that is accepted because the 503 is
    already written and the peer is misbehaving.
20. **Drains multiply under a flood of rejected clients.** Loop drains take a
    permit from a fixed `MAX_DRAINING_REJECTS` semaphore without waiting. When no
    permit is free the socket is dropped immediately, as before this change.
    Handler drains run inside an existing active-connection permit and are
    bounded by the same deadline.
21. **The "Proxy Admission Timeout" 503 keeps its pending admission during the
    drain.** The expired entry's `PendingMetricGuard` is released before the 503
    is written, so `pending_admissions` never counts a client that is only being
    drained. The 128-entry pending cap is unaffected because expired entries have
    already left the queue.
22. **The DNS capacity probe reads a transient queue state.** The resolver
    enforces its queue limit under the pool lock, but a worker pop can remove one
    queued job between two probe samples. Under full-gate load worker wakeups are
    late: the pool rejected five callers at the limit (`rejectedDelta=5`), yet the
    sampled `maxQueueLen` stayed at 15, so the probe never saw 16 queued beside 4
    active workers and failed with `reachedCapacity=false`. The probe must hold its
    own lookups at a gate until 4 workers are busy, the queue is observed at 16,
    and the overflow callers are rejected, so each capacity state it checks is
    stable. A missed sample must not be able to fail a correct pool.
23. **A held probe lookup outlives the probe.** The gate reopens on every exit
    path from a batch, including a failed spawn or a failed capacity check, and a
    held lookup returns after a fixed fail-safe timeout, so the process-wide
    resolver cannot stay blocked. Ordinary `rosi-dns-delay-` lookups used by other
    specs keep their existing synthetic delay and are not gated.
24. **A cancel is signalled before a relay task subscribes.** Download and metadata
    cancellation are `watch` channels whose value stays `true`. A receiver
    created or cloned after the signal reads `true` at once, so
    `ProxyShared::cancelled()` checks the current value before it awaits a
    change and returns without waiting. A guard started after cancel fails with
    the existing cancelled error.
25. **The cancellation sender is dropped without signalling.** The session that
    owns the sender ends without cancelling the operation. `changed()` returns an
    error, which can never become a cancel, so the wait stays pending on the
    shutdown signal alone. No busy loop starts, and guard drop still stops every
    task.
26. **A blocking resolver caller needs the current value.** Blocking code reads
    the cancellation synchronously with `borrow()` (guard start and `is_cancelled`),
    never through a poll loop on the relay side. The blocking DNS probe keeps its
    per-caller `AtomicBool`, which it sets itself, and the blocking
    `is_public_http_destination` path is unchanged. The blocking DNS caller still
    checks its oneshot reply every 25 ms (`try_recv` then sleep). That loop runs on
    a plain thread, not in the relay, so the 25 ms bound is kept deliberately; the
    relay itself never polls.
27. **A DNS oneshot sender is dropped without a reply.** A worker panic or pool
    stop drops the job, and the waiting relay task receives a closed error. It
    returns `None` (the existing "Destination Blocked" 403), never hangs, and
    leaves no queue entry behind.
28. **The resolver queue is full.** `enqueue` still rejects under the pool lock
    before any oneshot is created. The caller gets `None` at once, and the
    rejected count the DNS probe checks still increments.
29. **Cancellation arrives during DNS.** Guard cancel or drop aborts the client
    task that waits on the reply. Dropping `PendingDnsJob` removes a queued job,
    while a running lookup finishes and its reply is discarded. The answer-count
    cap (more than 32 answers) and `ip_policy` vetting run unchanged.
30. **An idle tunnel wakes the relay with nothing to do.** With one open idle
    tunnel, the relay task and the listener wake only for I/O, cancellation, or
    the idle deadline. A debug counter records any other wake, and the probe
    requires at most 2 such wakes in a 5 s window (the old 25 ms poll would give
    about 200 in that window).
31. **A metadata caller cancels through the process-utility sender.** `process_util`
    holds the reservation cancellation as a `watch` sender, and metadata guards
    subscribe to it like downloads. A cancelled stalled thumbnail therefore wakes
    its relay at once and closes its fixture socket within the scenario's 5 s.
    No `AtomicBool` cancel source feeds a relay any more.

The native E2E probe is the acceptance mechanism for concurrency and cleanup.
Rust unit tests must not be added after implementation; existing network and
upstream-proxy E2E specs remain required regression coverage.

## Repeatable probe evidence

The new `asyncProxy` object is added to the existing
`e2e_network_pipelining_probe` result; it does not add a Tauri command. Its
`capacity` section reports `requestedTunnels`, `activeLimit`,
`activeAtCapacity`, `peakActiveTunnels`, `pendingLimit`, `pendingHighWater`,
`overloadStatus`, and `overloadRejections`. The `cancellation` section reports
`activeConnectionsAfterCancel`, `activeTunnelsAfterCancel`,
`pendingAdmissionsAfterCancel`, `closedClientSockets`,
`expectedClientSockets`, `closedOriginSockets`, `expectedOriginSockets`, and
`elapsedMs`. The `drop` section reports `activeConnectionsAfterDrop`,
`closedClientSocket`, and `elapsedMs`. Acceptance requires 256 simultaneously
open tunnels, a full bounded pending queue followed by HTTP 503, and zero
active/pending resources after both operation cancellation and guard drop. The
same result records the existing pipelining check so the new runner proves
that the second request was never forwarded.
