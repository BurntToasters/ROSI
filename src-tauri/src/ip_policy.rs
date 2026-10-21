//! Shared destination policy for IP literals. The URL pre-check in
//! `validation` and the per-operation proxy in `network_security` both use
//! these rules, so an address cannot pass one check and fail the other.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// True when the address is a globally routable unicast destination.
pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

/// Excludes special-use ranges (RFC 6890): this network, private, shared
/// CGNAT, loopback, link-local, documentation, benchmarking, multicast, and
/// reserved space.
pub fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
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

pub fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    // Well-known NAT64 prefix 64:ff9b::/96 (RFC 6052). DNS64 networks reach
    // IPv4-only hosts through it, so it is public only when the embedded IPv4
    // address (the last 32 bits) is itself public.
    if segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2..6] == [0, 0, 0, 0] {
        let embedded = (u32::from(segments[6]) << 16) | u32::from(segments[7]);
        return is_public_ipv4(Ipv4Addr::from(embedded));
    }
    if ip.to_ipv4_mapped().is_some() || ip.to_ipv4().is_some() {
        return false;
    }
    // Only global unicast 2000::/3 is permitted. This excludes unspecified,
    // loopback, unique-local, link-local, multicast, and future-use ranges.
    if (segments[0] & 0xe000) != 0x2000 {
        return false;
    }
    // Special-purpose 2001::/23, documentation 2001:db8::/32, 6to4
    // 2002::/16, and documentation 3fff::/20 are not public destinations.
    // Local-use NAT64 64:ff9b:1::/48 is already outside 2000::/3.
    if (segments[0] == 0x2001 && (segments[1] & 0xfe00) == 0)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || segments[0] == 0x2002
        || (segments[0] == 0x3fff && (segments[1] & 0xfff0) == 0)
    {
        return false;
    }
    true
}
