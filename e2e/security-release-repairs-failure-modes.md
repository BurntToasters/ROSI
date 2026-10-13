# Security and release repair failure modes

This inventory is written before the new regression coverage and production
changes. It covers the F06/F07/F08 audit findings and the two development
advisories that beta 2 reported without review.

## F06: full acceptance versus partial build-VM proof

1. A `--skip-e2e` run is labeled as a complete quality gate and can authorize
   a release even though GUI E2E never ran.
2. A proof is accepted after HEAD, source files, dependency locks, platform,
   or produced artifact hashes differ from the values that were checked. A
   reuse flag must not let the full release suite report success with a stale
   native binary.
3. An old proof is reused after its freshness window, or a local proof is
   accepted without identifying whether its E2E scope was full or skipped.
4. Hosted CI success for another commit, a different workflow, or only one
   component job is mistaken for successful aggregate `ci-gate` evidence for
   the exact candidate SHA.
5. A partial VM build proof is discarded even when an exact candidate has a
   successful hosted aggregate; partial build validation must remain usable
   when joined to already accepted candidate proof.
6. Hardening release proof accidentally imposes branch protection on `beta`;
   `main` remains protected and `beta` remains intentionally unprotected.
7. The canonical suite rejects `xdg-download-dir` skips on macOS/Windows even
   though the scenario is intentionally Linux-only, or accepts that skip on
   Linux and thereby omits a required Linux assertion.

## F07: selectors notice recovery

1. Strict notice generation fails because the exact `selectors@0.38.0` source
   lacks packaged license text.
2. A notice is copied from another selectors version, a different revision,
   or SPDX prose instead of the source package's actual notice.
3. Strict mode or missing-license detection is weakened, hiding future missing
   notices.
4. A reviewed omission applies to more than the exact package, version,
   source revision, and immutable source URL.
5. An offline source-fetch failure is mistaken for proof that upstream has no
   notice.

## F09: versioned bundled binary license notices

1. The bundled-license manifest omits the version-matched yt-dlp component
   notice or points to a missing/wrong file; generation must fail closed.
2. The notice count is changed without checking that the new versioned label
   and the source file's actual text render in the licenses iframe. Assert the
   expected manifest entry and compare its rendered text with the packaged
   notice contents.
3. A stale fixed count either rejects a valid newly added notice or a relaxed
   lower bound accepts a missing notice. Compare the rendered count with the
   manifest and separately verify the required component notice.

## F08: destination-level URL enforcement and handoffs

1. A URL uses a private literal, localhost name, integer/hex/octal/shorthand
   IPv4 spelling, IPv4-mapped IPv6, link-local or unique-local IPv6 address.
2. A hostname resolves to a loopback, private, link-local, shared, reserved,
   documentation, multicast, or otherwise non-global address.
3. A hostname has both public and forbidden A/AAAA answers and the client
   silently chooses the public answer or lets the OS resolve again.
4. DNS changes between validation and connect, so a preflight lookup approves
   a public answer but the eventual socket reaches a private answer.
5. An HTTP redirect targets a private address or a hostname that now resolves
   privately; every redirect connection must pass the same pinned policy.
6. yt-dlp discovers CDN, subtitle, playlist, thumbnail, or media URLs that
   differ from the original page host; downloads, formats, and previews must
   keep using the same enforcing proxy.
7. A metadata thumbnail URL is passed to the webview as `<img src>`, letting
   Chromium resolve and connect outside the backend policy. Preview must fetch
   it through the enforced boundary, cap its bytes, validate a safe raster
   MIME type, and return data rather than a remote URL.
8. A proxy cannot bind, DNS fails, an answer set is empty, a destination is
   malformed, or an unsupported protocol is requested; each case must fail
   closed without falling back to a direct sidecar connection.
9. The E2E loopback exception permits only explicit loopback fixtures in the
   E2E build when opted in. It must not permit a DNS alias to loopback, be
   active in production, or remain effective when the E2E setting is off.
10. `open_external` hands a URL to another application after hostname
    validation. ROSI can reject currently private DNS answers before handoff,
    but later connections are performed by the external browser and are
    outside ROSI's pinned-connection guarantee.
11. An operation is cancelled while a proxy connection is waiting on a slow
    peer. Dropping the operation guard must stop both ends of the socket and
    release the bounded proxy workers promptly.
12. Untrusted clients send more proxy requests than the proxy can serve and
    cause one detached thread per request. The connection pool and pending
    queue need fixed limits, with excess work rejected without deadlocking the
    listener.
13. HTTP forwarding sends an absolute-form request target to the origin,
    duplicates `Connection` headers, or reuses a tunnel for pipelined requests
    without rechecking the next request's destination. Origin requests must
    use origin-form targets and connection-specific headers must be normalized
    while preserving ordinary bodies and range requests.
14. A standard library call unavailable on the supported Rust toolchain leaves
    the new network boundary uncompilable; relaying must use a supported
    bounded mechanism.
15. Queue and activity entries disappear during startup because a public URL's
    DNS lookup is unavailable or transiently fails. Persistence normalization
    must remain syntactic; DNS policy belongs at operation and connect time.
16. IPv6 host strings that include URL brackets fail IP parsing, causing valid
    global IPv6 literals to be rejected or bypassing classification. Test a
    public IPv6 literal without establishing an external connection and reject
    unique-local IPv6 literals.
17. Proxy decision logs from an earlier run make a later DNS-rebinding test
    pass despite the current proxy never rejecting the destination. Clear the
    trace before every full run and bind evidence to current attempts.
18. Non-E2E placeholder DNS helpers remain compiled in production and trigger
    warning-denied builds as unused items.
19. Extractor metadata parsing performs DNS lookups just to recover URL text,
    dropping valid metadata when offline. Parse URL syntax independently, then
    enforce DNS at the actual thumbnail fetch or external handoff.
20. A user yt-dlp config or plugin changes proxy/downloader behavior, an
    external downloader fetches non-HTTP protocols directly, or a network
    reference embedded in a media playlist reaches FFmpeg without the pinned
    proxy. Disable untrusted config/plugin injection and constrain every
    network-capable tool to the guarded HTTP(S)/native playlist paths; local
    conversion and probe subprocesses must not fetch network inputs.
21. HTTP-only success tests hide a broken or bypassed HTTPS CONNECT tunnel. A
    local test CA must prove successful verified TLS through the proxy without
    changing machine trust or depending on an uncontrolled public host.
22. An HTTP client pipelines an unreviewed second absolute URL after its first
    request and a one-shot proxy blindly tunnels those bytes to the first
    destination. The smoke must observe that only the first origin-form request
    reaches the fixture.
23. A URL with embedded username/password passes syntax-only validation and is
    retained in the queue or handed to an external application. Reject URL
    credentials independently of DNS so persistence remains offline-safe.
24. A system DNS lookup blocks inside an operation-owned proxy worker and
    survives guard cancellation, consuming threads until the platform resolver
    eventually returns. Resolution callers need bounded waits and cancellation
    checks even though an already-running OS lookup itself may not be interruptible.
25. Repeated cancelled DNS operations create one detached thread per lookup or
    leave unbounded pending work. Use a shared fixed worker pool, bounded queue,
    remove cancelled queued work, and fail closed when capacity is exhausted.
26. DNS is checked but the socket later resolves the hostname again, or only
    one answer from a mixed public/private response is checked. Classify the
    complete bounded answer set and connect only to those exact addresses.
27. Metadata, formats, or manual-download IPC performs blocking DNS validation
    before its cancellable operation is reserved. Cancellation can return while
    preflight is stalled and the delayed command can start later; keep initial
    acceptance syntactic and prove that cancellation during delayed connection
    resolution closes the reserved operation within a bounded interval, stays
    closed beyond the synthetic DNS delay, and permits a successful replacement
    metadata request without a later proxy decision or destination request.
28. Metadata parsing finishes yt-dlp and then blocks in a thumbnail body read.
    Cancelling the IPC must stop the active proxy sockets while the transform is
    running, settle promptly, close the fixture connection, reject the stale
    result, and allow a fresh metadata request to succeed.
29. The pinned yt-dlp sidecar rejects an unsupported custom-CA option and then
    every discovery/download operation fails before it can prove HTTPS proxy
    behavior. Use only a CLI option supported by the pinned sidecar and pass
    the fixture CA through a narrowly scoped E2E child-process trust setting.
30. Repairing custom-CA trust disables certificate validation or leaks the
    fixture trust override into production children. The E2E HTTPS fixture
    must succeed with the intended CA, a certificate signed by an unrelated CA
    must fail, and production builds must not accept or propagate the override.
31. The HTTP proxy sends a TCP write-half-close immediately after forwarding
    the request body. An origin with default half-close handling can close its
    response side before a delayed or streamed body is complete. A guarded
    multi-chunk download must finish with the expected bounded body hash, and
    cancelling another in-flight stream must still close the active sockets
    promptly without publishing a stale success.
32. Queue submission containing only rejected URLs must return a structured
    skipped count so callers can distinguish safe rejection from an IPC shape
    failure. It must never retain credential-bearing URLs.
33. The thumbnail helper's HTTP client must not create a nested or unconfigured
    runtime from the metadata worker. The prior blocking client panicked its
    internal event loop; the repaired path uses an async client from a plain
    worker, installs the selected Rustls provider, and keeps cancellation and
    body limits intact.
34. Concurrent proxy workers append JSONL decisions without serialization.
    Interleaved bytes make cancellation evidence unreadable and can hide a
    late DNS connection. E2E traces must contain one complete JSON object per
    line under concurrent activity.
35. After a deliberately cancelled metadata promise settles, a synchronous
    WebDriver result read can surface the expected IPC rejection as a driver
    command error and prevent the test from checking replacement metadata.
    Read the already-recorded result through the asynchronous bridge and keep
    the cancellation assertion separate from the replacement request.
36. The origin's socket-close callback can run before its active-request
    counter decrement is observed by the test, creating a false leak report.
    Wait for both the close event and the zero-active invariant before
    asserting cancellation cleanup.
37. Two preview requests are started concurrently even though the tracked
    metadata slot intentionally replaces the older reservation. Scheduler
    order can cancel the fixture request whose success is being asserted.
    Sequence the rebinding preview and extractor-thumbnail checks so the
    replacement policy is deterministic.
38. The security and main WebKit suites share one persistent profile, so
    security downloads and renderer state contaminate main-suite assumptions
    about fresh statistics and beta-profile migration. Run those suites in
    separate profiles while retaining one aggregate evidence report.
39. A direct media URL can expose only one combined format even when it has an
    audio stream. An audio-only selector that requires `bestaudio` then fails
    before FFmpeg extraction; retain the guarded audio preference with a
    guarded combined-format fallback.

## F07 advisory review: two unreviewed development findings

1. The current package graph includes `GHSA-C475-QRG2-PJ4R` and
   `GHSA-VFJ7-8CJW-P6XM` without an exact package, affected range, dependency
   path, and dev-only/production classification.
2. The basic-ftp finding stays affected despite a narrowly scoped override to
   its fixed release, or that major override breaks get-uri's used Client API.
3. The braces finding has no patched compatible release and is merely left
   unreviewed; the record must identify the exact GHSA, package, exploit
   preconditions, consumer surface, dev-only status, and re-review date.
4. A broad tooling migration creates unrelated lock churn or changes runtime
   dependencies while attempting to clear dev-only findings.
5. A warning/allowlist update masks an advisory without a documented review,
   or labels a package dev-only without verifying every affected lock node.
6. `package.json` and `package-lock.json` disagree after a targeted update.
