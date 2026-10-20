//! Mrežni prefiks klijenta (`spec/events.md` §3, polje `net`). Pun IP ne napušta portal:
//! SDK i collector šalju i čuvaju samo prefiks.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// IPv4 → /24, IPv6 → /48, IPv4-mapirana IPv6 adresa (`::ffff:a.b.c.d`) → kao IPv4.
/// IPv6 je u kanonskom obliku (RFC 5952), kao što ga daje `Display` za `Ipv6Addr`.
pub fn prefix(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(a) => v4(a),
        IpAddr::V6(a) => match a.to_ipv4_mapped() {
            Some(m) => v4(m),
            None => {
                let s = a.segments();
                format!("{}/48", Ipv6Addr::new(s[0], s[1], s[2], 0, 0, 0, 0, 0))
            }
        },
    }
}

/// Isto, iz teksta. Neispravan ulaz (uključujući zonu `%eth0`, port, razmake) → `None`.
pub fn prefix_str(s: &str) -> Option<String> {
    s.parse::<IpAddr>().ok().map(prefix)
}

fn v4(a: Ipv4Addr) -> String {
    let [a, b, c, _] = a.octets();
    format!("{a}.{b}.{c}.0/24")
}
