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
