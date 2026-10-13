# Network destination policy: failure modes

Scope: finding 9a (one shared IP classifier), 9b (NAT64 64:ff9b::/96 allowed
only for public embedded IPv4), 9c (documented, no proxy chaining).

## Finding 9a: consolidation

1. URL pre-check still uses the weak classifier, so a literal such as
   `100.64.0.1`, `198.18.0.1`, `192.0.2.1` or `240.0.0.1` passes the URL check
   but fails at the proxy. Detected by the URL matrix rows.
2. The URL pre-check blocks something the proxy allows (a regression that
   would stop legitimate public URLs). Detected by public rows in the matrix.
3. IPv4-compatible `::a.b.c.d` or IPv4-mapped `::ffff:a.b.c.d` form of a
   private address slips through when the mapped check is removed. Detected by
   the mapped and compatible rows.
4. Removing `canonical_ipv4` handling lets `0x7f000001` or `2130706433` as a
   domain host bypass the check. Not in the probe matrix: covered by code
   review and by keeping the function byte-identical.
5. Rebinding suffixes (`.nip.io`, `.sslip.io`, `.localtest.me`, `.lvh.me`,
   `.xip.io`) stop being blocked during the refactor. Not in the matrix (the
   classifier is literal-only); code review keeps `is_rebinding_hostname`
   unchanged.
6. E2E loopback exception breaks: a literal `127.0.0.1` URL is rejected while
   `ROSI_E2E_ALLOW_LOOPBACK=1`. Detected by the loopback URL row, whose expected
   value follows the environment variable.
7. The exception leaks into production: `e2e_allows_loopback` or
   `e2e_allows_literal_loopback` compiles without `#[cfg(feature = "e2e")]`.
   Covered by keeping both `cfg` gates in place; `cargo clippy` without the e2e
   feature must still pass.
8. A caller of the removed `is_private_ipv4`/`is_private_ipv6` is missed, so the
   build breaks. Caught by `cargo check` and `cargo clippy --all-targets`.
9. The shared module compiles with a dead-code warning under `-D warnings`
   (for example an unused helper). Caught by clippy.
10. Probe fields stay present but the matrix is empty (a silent pass). The spec
    asserts the exact row count.

## Finding 9b: NAT64

11. 64:ff9b::/96 is allowed regardless of embedded IPv4. Detected by the
    NAT64 rows for `127.0.0.1`, `10.0.0.1`, `192.168.1.1`, `169.254.169.254`,
    `255.255.255.255`, `0.0.0.0`, `100.64.0.1`.
12. 64:ff9b::/96 is blocked entirely (the old behavior). Detected by the public
    NAT64 rows `64:ff9b::808:808` and `64:ff9b::101:101`.
13. Local-use 64:ff9b:1::/48 becomes allowed. Detected by the
    `64:ff9b:1::1` row.
14. NAT64 check runs after the generic `to_ipv4()` rejection, so the rule never
    applies. Detected by the public NAT64 rows.
15. The embedded IPv4 is read from the wrong 32 bits (first 32 instead of last
    32). Detected by the NAT64 rows; each row embeds a different IPv4 value.
16. The proxy connects to a different address than the one vetted (DNS answer
    changes between check and connect). Code review: the vetted vector is the
    exact vector passed to `TcpStream::connect_timeout`. Not testable in the
    fixed-literal probe; documented as a limitation.
17. A DNS name that resolves to a NAT64 address with a private embedded IPv4 is
    allowed. The check runs on every resolved `SocketAddr`, so it is blocked.
    Not in the probe (no DNS fixture for this); covered by code review.
18. Compatibility-form `::a.b.c.d` (deprecated IPv4-compatible) with a public
    embedded IPv4 becomes allowed by accident. Keep it blocked. Detected by the
    `::8.8.8.8` row (expected blocked).

## Finding 9c: documentation

19. `docs/NETWORK-POLICY.md` claims a behavior the code does not implement, for
    example proxy chaining or an allowed private range. Code review against the
    constants and rules in `ip_policy.rs`.
20. The doc contains an em dash, which fails `validate-no-em-dash`. Checked by
    running that validator.

## Harness

21. The runner refuses a stale binary (older than the stamp) so the probe
    reflects the current code. Checked in the runner.
22. The app does not start, so the spec reports a failure rather than passing.
    The spec asserts `outcome.ok === true`.
23. The probe is reachable only from the main window. The spec runs in the main
    window through `waitForAppReady`.
24. A bare rebinding apex such as `localtest.me` (public DNS answers 127.0.0.1)
    passes the URL pre-check because only subdomains were matched. Detected by
    the `http://localtest.me/` URL matrix row.
