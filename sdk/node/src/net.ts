// Mrežni prefiks klijenta (core/spec/events.md §3, polje `net`). Pun IP ne napušta portal.
// Mora da daje isto što i ppd_core::net::prefix — core/spec/test-vectors/net.json.

import { isIPv4, isIPv6 } from "node:net";

/**
 * IPv4 → /24, IPv6 → /48, IPv4-mapirana IPv6 adresa (`::ffff:a.b.c.d`, i u heks obliku) →
 * kao IPv4. IPv6 prefiks je kanonski (RFC 5952). Neispravan ulaz → `null`.
 */
export function netPrefix(ip: string): string | null {
  if (isIPv4(ip)) return v4(ip);
  if (!isIPv6(ip) || ip.includes("%")) return null;
  const g = expand(ip);
  if (!g) return null;
  // ::ffff:0:0/96 — IPv4-mapirana adresa
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.0/24`;
  }
  // Prva tri grupe; ostalih pet su nule, pa je najduži niz nula uvek na kraju (RFC 5952 §4.2).
  const head = g.slice(0, 3);
  while (head.length > 0 && head[head.length - 1] === 0) head.pop();
  return `${head.map((x) => x.toString(16)).join(":")}::/48`;
}

function v4(ip: string): string {
  const [a, b, c] = ip.split(".");
  return `${a}.${b}.${c}.0/24`;
}

/** IPv6 tekst → 8 grupa od 16 bita. Ulaz je već prošao `isIPv6`. */
function expand(ip: string): number[] | null {
  let s = ip.toLowerCase();
  // ugrađen IPv4 na kraju (npr. ::ffff:1.2.3.4) → dve heks grupe
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const o = tail[1]!.split(".").map(Number);
    s = s.slice(0, -tail[1]!.length) + `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string | undefined) => (h ? h.split(":").map((x) => parseInt(x, 16)) : []);
  const left = parse(halves[0]);
  const right = parse(halves[1]);
  const fill = 8 - left.length - right.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const g = [...left, ...Array<number>(halves.length === 1 ? 0 : fill).fill(0), ...right];
  return g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null;
}
