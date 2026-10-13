# Network destination policy

ROSI applies one destination policy to every network request it makes for
previews, metadata, thumbnails, downloads, and media tools. The rules live in
`src-tauri/src/ip_policy.rs` and are used by the URL pre-check in
`validation.rs` and the per-operation proxy in `network_security.rs`.

## Layers

1. **URL syntax** (`is_syntactically_safe_http_url`): http or https only, no
   credentials, and literal IP hosts must be public. Domain names pass here;
   they are checked when the operation resolves them.
2. **Pinned proxy** (`network_security.rs`): every HTTP request and HTTPS
   CONNECT is resolved, every returned address must be public, and the
   connection is made to exactly those addresses. Redirects go back through the
   proxy and are checked again.
3. **External opener** (`is_safe_external_url`): DNS answers are checked before
   the link is handed to the system browser. ROSI cannot control redirects the
   browser follows after that.

## Blocked destinations

- **IPv4**: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (shared CGNAT),
  `127.0.0.0/8`, `169.254.0.0/16` (link-local, including cloud metadata
  `169.254.169.254`), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`,
  `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`,
  `203.0.113.0/24`, `224.0.0.0/4` (multicast and reserved), and
  `255.255.255.255`.
- **IPv6**: only global unicast `2000::/3` is allowed. Also blocked are
  `2001::/23`, `2001:db8::/32`, `2002::/16` (6to4), `3fff::/20`
  (documentation), and every IPv4-mapped or IPv4-compatible address.
- **Hostnames**: `localhost` and `*.localhost`, dynamic-DNS names that embed an
  IP address (`*.nip.io`, `*.sslip.io`, `*.xip.io`, `*.localtest.me`,
  `*.lvh.me`), and numeric hosts in inet_aton forms (for example `0x7f000001`),
  which are checked as their IPv4 value.

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
address that was not checked.

## Intentionally unreachable

Private and LAN servers, such as NAS devices, routers, services bound to the
local machine, or media servers on RFC 1918 addresses, are blocked on purpose.
A URL taken from a web page must not make ROSI contact internal services.
Users who need such a source must obtain the media another way.

Loopback literals are accepted only in E2E builds (the `e2e` feature) when
`ROSI_E2E_ALLOW_LOOPBACK=1` is set. Release builds never include that path.

## Upstream proxies: not supported in v5

ROSI connects directly. It cannot chain to a corporate or geographic proxy,
so users who must route all traffic through one cannot download in v5.

This is a deliberate limit. The pinned proxy must own each socket to check the
address it connects to. An upstream proxy would resolve the destination name
itself, so ROSI could no longer verify the address that is reached, and a
name controlled by the destination could point at a private address. Adding
upstream proxy support needs a design that keeps that check.
