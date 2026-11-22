# Network destination policy

ROSI applies one destination policy to every network request it makes for
previews, metadata, thumbnails, downloads, and media tools. The rules live in
`src-tauri/src/ip_policy.rs` and are used by the URL pre-check in
`validation.rs` and the per-operation proxy in `network_security.rs`.

## Layers

1. **URL syntax** (`is_syntactically_safe_http_url`): http or https only, no
   credentials, and literal IP hosts and the reserved hostnames below must be
   public. Other domain names pass here; they are checked when the operation
   resolves them.
2. **Pinned proxy** (`network_security.rs`): every HTTP request and HTTPS
   CONNECT is resolved, every returned address must be public, and the
   connection is made to exactly those addresses. Redirects go back through the
   proxy and are checked again. With an upstream proxy configured, the vetted
   destination is reached through it instead (see below).
3. **External opener** (`is_safe_external_url`): DNS answers are checked before
   the link is handed to the system browser. ROSI cannot control redirects the
   browser follows after that.

## Blocked destinations

- **IPv4**: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (shared CGNAT),
  `127.0.0.0/8`, `169.254.0.0/16` (link-local, including cloud metadata
  `169.254.169.254`), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`,
  `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`,
  `203.0.113.0/24`, `224.0.0.0/4` (multicast), `240.0.0.0/4` (reserved),
  and `255.255.255.255`. The code blocks every address from `224.0.0.0` upward,
  so these ranges are covered by one rule.
- **IPv6**: only global unicast `2000::/3` is allowed. Also blocked are
  `2001::/23`, `2001:db8::/32`, `2002::/16` (6to4), `3fff::/20`
  (documentation), and every IPv4-mapped or IPv4-compatible address.
- **Hostnames**: `localhost` and `*.localhost`, dynamic-DNS names that embed an
  IP address (`*.nip.io`, `*.sslip.io`, `*.xip.io`, `*.localtest.me`,
  `*.lvh.me`), and numeric hosts in inet_aton forms (for example `0x7f000001`),
  which are checked as their IPv4 value.

Hostname rules run in the URL pre-checks in `validation.rs`, not in the pinned
proxy. The proxy checks only the addresses a name resolves to, so a name that
resolves to a blocked address is still refused there.

Destination ports are not restricted. The address rules apply to every port.

## NAT64 (RFC 6052)

Networks with DNS64 and NAT64 reach IPv4-only hosts through `64:ff9b::/96`.
ROSI allows that prefix only when the embedded IPv4 address (the last 32 bits)
passes the IPv4 rules above. For example, `64:ff9b::808:808` (8.8.8.8) is
allowed, while `64:ff9b::7f00:1` (127.0.0.1) and `64:ff9b::a9fe:a9fe`
(169.254.169.254) are blocked. The local-use prefix `64:ff9b:1::/48` is always
blocked.

## Vetted address is the connected address

Each connection resolves the host once, checks every address, and connects to
that same list. A DNS answer that changes later cannot move the socket to an
address that was not checked. With an upstream proxy this holds only for the
local check; the upstream resolves the name itself (see below).

## Intentionally unreachable

Private and LAN servers, such as NAS devices, routers, services bound to the
local machine, or media servers on RFC 1918 addresses, are blocked on purpose.
A URL taken from a web page must not make ROSI contact internal services.
Users who need such a source must obtain the media another way.

Loopback literals are accepted only in E2E builds (the `e2e` feature) when
`ROSI_E2E_ALLOW_LOOPBACK=1` is set. Release builds never include that path.

## Optional upstream HTTP proxy

Networks that allow only an HTTP proxy can be reached through the `upstreamProxy`
setting, `http://HOST:PORT` (IPv6 hosts in brackets, optional trailing `/`).
The default is empty, which connects directly. Other schemes, credentials,
paths, queries, fragments, whitespace, and values over 2048 bytes are refused.

When it is set, each operation (downloads, format listing, video info, and
thumbnails) reads the value once when it starts:

- Every destination is still resolved and vetted locally with the rules above.
  A blocked destination gets 403 and the upstream proxy is never contacted.
- HTTPS: after vetting, ROSI opens a CONNECT tunnel through the upstream proxy
  to the destination hostname. Any answer other than 2xx, a malformed or
  oversized (over 16 KiB) status block, a status block that does not finish
  within 20 seconds, or an unreachable upstream reaches yt-dlp as 502.
- HTTP: the request is sent to the upstream in absolute form. The upstream's
  response is passed through unchanged, so a 407 from the upstream reaches
  yt-dlp as 407.
- The upstream proxy's own address is not vetted, so it may be on a private
  network or on loopback.

Limits to understand before enabling it:

- **Local DNS must resolve every destination.** ROSI cannot check an address the
  upstream proxy resolves itself. The upstream receives the hostname, not the
  address ROSI vetted. A name that resolves to a public address for ROSI and to
  a private address for the upstream (DNS rebinding) is not detected. This is
  the main cost of chaining, and the reason the setting is opt-in.
- **The upstream proxy is trusted.** It sees every destination hostname and
  the URLs of plain HTTP requests. Use only a proxy you control or that your
  network requires.
- **No proxy authentication.** Credentials in the URL are refused, and ROSI
  sends none upstream. A proxy that requires authentication will fail with 502
  (CONNECT) or its own 407 (HTTP).
- **HTTP proxies only.** SOCKS is not supported.
- **Changes apply to the next operation.** An operation already running keeps
  the route it started with.

## Accepted risks

- **Proxy token on the yt-dlp command line.** Each operation's proxy token is
  passed to yt-dlp as part of its proxy URL on the command line, so other
  processes of the same user can read it. This is accepted: the proxy listens
  on loopback only, the token is created per operation and stops working when
  the operation ends, and the proxy reaches only destinations that pass the
  same vetting as every other request. A process that reads the token gains
  nothing it could not already do as that user.

## Request framing and DNS answers

- The proxy accepts only CRLF line endings in a request header block. A bare
  LF or CR, a byte below 0x20 other than HTAB, or 0x7F anywhere in the request
  line or headers is refused with 400 before authentication or forwarding.
- A DNS lookup that returns more than 32 answers is cut to the first 32. Every
  kept address must still be public, and the connection is made only to those
  addresses.

## Local proxy answers

The local proxy writes these answers itself (`network_security_async.rs`):

- 400: an unsupported request, or a request that fails the framing rules above.
- 403 `Destination Blocked`: the address rules refuse the destination.
- 502 `Bad Gateway`: DNS resolution fails or returns no address, or a direct
  connection fails.
- 502 `Upstream Proxy Failed`: the upstream proxy cannot be reached or refuses
  the tunnel. Upstream timeouts also return 502.
- 504 `Gateway Timeout`: a direct connection attempt times out and no address
  connects.
