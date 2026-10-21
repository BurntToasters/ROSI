# Upstream HTTP proxy: failure modes

Scope: the optional `upstreamProxy` setting (`http://HOST:PORT`). When set, the
per-operation checking proxy in `network_security.rs` still vets every
destination locally, then reaches it through the user's upstream proxy. When
empty, behavior must be unchanged.

Each item names how the feature could fail and where the spec
(`upstream-proxy.spec.js`) or review catches it. "Review" means no E2E
assertion exists and the item relies on code review.

## A. Setting validation (settings save and load)

1. An `https://`, `socks5://`, or `ftp://` value is accepted. Spec: invalid
   value list, every row must return `ok: false`.
2. Userinfo (`http://user:pass@host:8080`) is accepted, so credentials reach
   the settings file. Spec: invalid list.
3. A path (`http://host:8080/x`) or query or fragment is accepted. Spec.
4. A single trailing `/` is rejected (regression against the allowed form).
   Spec: `http://[::1]:3128/` is in the valid list.
5. Whitespace (leading, trailing, or internal) is silently trimmed and saved.
   Spec: `" http://proxy.example:8080"` must be refused.
6. Port `0`, `65536`, a missing port, a non-digit port, `+8080`, or `-1` is
   accepted. Spec: port rows.
7. An unbracketed IPv6 literal (`http://::1:8080`) is accepted or split at the
   wrong colon. Spec: invalid row.
8. A bracketed IPv6 literal (`http://[::1]:3128`) is rejected. Spec: valid row.
9. Hostnames such as `proxy_1.example`, `-bad.example`, or all-numeric
   `999.1.1.1` are accepted. Spec: invalid rows.
10. A value over 2048 bytes is accepted, or 2048 bytes is rejected. Spec: a
    2049-byte value must be refused.
11. A refused value is saved anyway, or the other fields in the same save are
    lost. Spec: after a refused save, `getSettings().upstreamProxy` is
    unchanged, and the error `details` lists `upstreamProxy`.
12. A stored invalid value (hand-edited file) makes the whole settings file
    fall back to defaults. Review: `read_upstream_proxy` falls back to `""`
    for that key only. A settings-file E2E would need a restart, so it is not
    in this spec.
13. A non-string JSON value (number, bool, object) panics or is saved. Spec:
    the validation list includes a number.
14. A legacy ROSI 4 settings import with no `upstreamProxy` key gets `""`.
    Review: `migrate_settings_from` uses the same default path as other keys.

## B. Vetting bypass attempts

15. A private destination (`private.test`, which the E2E DNS map resolves to
    `127.0.0.1`) is sent to the upstream proxy. Spec: the download over HTTP
    and over HTTPS (CONNECT) fails, and the upstream log has no entry for
    `private.test`.
16. The upstream is contacted before vetting and the blocked request still
    reaches it as a connection attempt. Spec: the upstream log length does not
    change for blocked downloads.
17. Local DNS fails for a destination. It must fail closed (403) and never
    contact the upstream. Review: the unresolvable case cannot be produced from
    the spec (the E2E DNS maps always resolve `private.test`).
18. Literal loopback or private addresses through the upstream are allowed
    without the E2E allowance. Covered by the existing policy matrix
    (`network-policy.spec.js`), which runs the same vetting code.
19. The vetted IP is replaced by the hostname for the upstream, so a DNS answer
    that changes between vetting and the upstream's own lookup can reach a
    private address. This is a documented limit (the upstream is trusted and
    resolves names itself). Not testable from E2E. Recorded in
    `docs/NETWORK-POLICY.md`.
20. The ROSI proxy credential (`Proxy-Authorization: Basic rosi:<token>`) is
    forwarded to the upstream. Spec: every upstream entry has
    `proxyAuthorization: null`.
21. A client `Proxy-Authorization` header is forwarded upstream. Spec: same
    assertion as 20.
22. An absolute-form request with userinfo, or a non-http scheme, reaches the
    upstream. Existing checks run before the upstream is opened (403). Review.
23. The upstream host (the user's own proxy) is vetted and refused when it is
    private or loopback. The spec uses `127.0.0.1` as the upstream, so the
    positive run proves it is not vetted. Spec: the relay run succeeds.

## C. Upstream failures

24. The upstream refuses connections (closed port). ROSI must answer 502, not
    403, and the download must fail with a clear message. Spec: `deadPort` run,
    message contains `502`.
25. The upstream answers CONNECT with a non-2xx status (`407` in the refuse
    mode). Must map to 502 for yt-dlp. Spec: refuse mode, message contains
    `502`.
26. The upstream sends a response header block over 16 KiB before the status
    line ends. Must fail with 502 and must not grow memory without bound.
    Spec: oversized mode.
27. The upstream sends a status line that is not HTTP (`not an http response`).
    Must map to 502. Spec: malformed mode.
27a. The upstream sends bytes that never contain a blank line (a slow or
    endless header). The read must end after one total 20 s budget, not after
    20 s per read, and a cancel must interrupt it. Review: the deadline is set
    in `read_upstream_response_head`; the spec's stall mode covers the cancel.
28. The upstream closes the socket before sending a status line. Must map to
    502. Spec: close mode.
29. The upstream returns `200` and then sends bytes in the same packet as the
    header. Those bytes must reach the client, not be dropped. Review: the
    leftover after `\r\n\r\n` is written to the client after the 200. Not in
    the spec (the upstream would need to send data before the client does).
30. Plain HTTP: the upstream returns `407`. The status passes through to yt-dlp
    unchanged (only CONNECT maps to 502). Review: documented in
    `docs/NETWORK-POLICY.md`.
31. Plain HTTP with the upstream down must also produce 502. Spec: the
    `deadPort` run includes a plain HTTP download.
32. The upstream accepts CONNECT and never answers. ROSI must wait only for
    the IO timeout and must not hang the download. Spec: stall mode, then the
    download is cancelled (see D.36).

## D. Cancellation and lifetime

33. A cancel during the CONNECT wait leaves the upstream socket open. Spec:
    stall mode, then `cancelDownload`. The upstream records that its socket
    closed, and the activity outcome is `cancelled`.
34. A cancel during the upstream connect (before the socket is registered) is
    ignored. Connect uses the same `ActiveSockets` registration as direct
    connections. Review.
35. The setting is re-read mid-operation, so an in-flight download switches
    route. Review: the guard takes its upstream value once at start, and the
    spec does not exercise a mid-download change (a plain byte stream does not
    make a second upstream request to observe).
36. The operation's cancellation flag is not wired into the upstream sockets.
    Same as 33 (covered by the cancel-mid-connect spec).

## E. Protocol shape

37. HTTPS (`CONNECT`) through the upstream is not used, and HTTPS goes direct.
    Spec: an HTTPS download succeeds, and the upstream log has a `CONNECT`
    entry for `127.0.0.1:<tls port>`.
38. Plain HTTP is sent to the upstream in origin form (`GET /clip-one.mp4`),
    which a proxy cannot route. Spec: the upstream entry target is the full
    absolute URL.
39. The absolute-form request drops `Host` or `Connection: close`. Review:
    `build_forwarded_request` is shared with the direct path.
40. The download body is corrupted by the relay. Spec: the SHA-256 of the
    downloaded file matches the fixture.

## F. Thumbnails and format listing

41. Format listing (`-F`) ignores the upstream and goes direct. Spec: the
    `getFormats` call on the page URL succeeds, and the upstream log has the
    page request.
42. Video info thumbnails go direct. Spec: `getVideoInfo` returns a PNG data
    URL, and the upstream log has the thumbnail request.
43. A failed thumbnail fetch through the upstream fails the whole metadata
    call. Thumbnails must be omitted instead. Review: `fetch_thumbnail_data_url`
    is unchanged and returns `None` on any error.

## G. Empty-setting regression

44. An empty `upstreamProxy` (the default) changes the direct path. Spec:
    a download with the setting cleared succeeds, and the upstream log is not
    touched by it. Review: `connect_addresses` is the same code as before, and
    `vet_destination` returns the same addresses.
45. A new default changes the saved defaults. Spec: the first `getSettings`
    reports `upstreamProxy: ""`.
