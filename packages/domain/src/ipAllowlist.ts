/**
 * F-EVAL-12: the room restriction of an evaluation, a list of IP addresses
 * and CIDR ranges (`192.168.1.0/24`, `2001:db8::/32`, a bare address being
 * its own /32 or /128), matched on the address's BITS — never on its text,
 * so `10.2` no longer admits `10.200.0.7` (security audit L10). An empty
 * list restricts nothing; an unknown address is outside any non-empty list.
 *
 * An IPv4 address seen through an IPv6 socket (`::ffff:10.20.0.7`) is the
 * IPv4 address it carries, on either side.
 *
 * Stored lists predate the rule: they held text prefixes, which the contract
 * now refuses. Compatibility, without a migration: a legacy entry of one to
 * three whole IPv4 octets ending in a dot (`10.20.`) is read as the range it
 * always meant (`10.20.0.0/16`); any other entry that is not an address or a
 * range matches nothing, so a list never widens.
 */

/** An address as bytes: 4 for IPv4, 16 for IPv6. */
type Bytes = number[];

const V4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function parseV4(text: string): Bytes | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => V4_OCTET.test(p))) return null;
  return parts.map(Number);
}

function parseV6(text: string): Bytes | null {
  if (text.includes("%")) return null; // a zone id names an interface, not a room
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string): Bytes | null => {
    if (half === "") return [];
    const out: Bytes = [];
    const pieces = half.split(":");
    for (const [i, piece] of pieces.entries()) {
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseV4(piece);
        if (!v4) return null;
        out.push(...v4);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
        const n = parseInt(piece, 16);
        out.push(n >> 8, n & 0xff);
      }
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;
  const gap = 16 - head.length - tail.length;
  return gap >= 2 ? [...head, ...new Array<number>(gap).fill(0), ...tail] : null;
}

/** `::ffff:a.b.c.d` is IPv4 `a.b.c.d`. */
function unmapped(bytes: Bytes): Bytes {
  const mapped =
    bytes.length === 16 && bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? bytes.slice(12) : bytes;
}

/** An address's bytes, IPv4-mapped IPv6 folded to IPv4; null when `text` is not an address. */
export function parseIp(text: string): Bytes | null {
  const bytes = text.includes(":") ? parseV6(text) : parseV4(text);
  return bytes && unmapped(bytes);
}

interface Range {
  base: Bytes;
  bits: number;
}

function parseRange(text: string): Range | null {
  const slash = text.indexOf("/");
  const address = slash === -1 ? text : text.slice(0, slash);
  const raw = parseV4(address) ?? (address.includes(":") ? parseV6(address) : null);
  if (!raw) return null;
  const width = raw.length * 8;
  let bits = width;
  if (slash !== -1) {
    const suffix = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(suffix)) return null;
    bits = Number(suffix);
    if (bits > width) return null;
  }
  const base = unmapped(raw);
  // A mapped range (`::ffff:10.0.0.0/104`) is the IPv4 range it covers.
  if (base.length !== raw.length) {
    if (bits < 96) return null;
    bits -= 96;
  }
  return { base, bits };
}

/** A legacy text prefix of whole IPv4 octets (`10.`, `10.20.`, `10.20.30.`), as its range. */
function legacyPrefix(text: string): Range | null {
  const m = /^((?:\d{1,3}\.){1,3})$/.exec(text);
  if (!m) return null;
  const octets = m[1]!.slice(0, -1).split(".");
  if (!octets.every((o) => V4_OCTET.test(o))) return null;
  const base = [...octets.map(Number), 0, 0, 0].slice(0, 4);
  return { base, bits: octets.length * 8 };
}

/** Whether `text` is what an allowlist entry may be: an IP address or a CIDR range. */
export function isIpRange(text: string): boolean {
  return parseRange(text) !== null;
}

function contains(range: Range, address: Bytes): boolean {
  if (range.base.length !== address.length) return false;
  for (let i = 0; i < range.bits; i += 8) {
    const keep = Math.min(8, range.bits - i);
    const mask = (0xff << (8 - keep)) & 0xff;
    if ((range.base[i / 8]! & mask) !== (address[i / 8]! & mask)) return false;
  }
  return true;
}

export function ipAllowed(allowlist: readonly string[], ip: string | undefined): boolean {
  if (allowlist.length === 0) return true;
  const address = ip === undefined ? null : parseIp(ip);
  if (!address) return false;
  return allowlist.some((entry) => {
    const range = parseRange(entry.trim()) ?? legacyPrefix(entry.trim());
    return range !== null && contains(range, address);
  });
}
