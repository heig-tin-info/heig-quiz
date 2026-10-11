/**
 * F-EVAL-12: the room restriction of an evaluation, a list of IP addresses
 * and CIDR ranges (`192.168.1.0/24`, `2001:db8::/32`; a bare address is its
 * own /32 or /128), matched on the address's BITS by `ipaddr.js` — never on
 * its text, so `10.2` no longer admits `10.200.0.7` (security audit L10). An
 * empty list restricts nothing; an unknown address is outside any non-empty
 * list. An IPv4 address seen through an IPv6 socket (`::ffff:10.20.0.7`) is
 * the IPv4 address it carries, on either side.
 *
 * Stored lists predate the rule: they held text prefixes, which the contract
 * now refuses. Compatibility, without a migration: a legacy entry of one to
 * three whole IPv4 octets ending in a dot (`10.20.`) reads as the range it
 * always meant (`10.20.0.0/16`); any other entry that is not an address or a
 * range matches nothing, so a list never widens.
 * TODO(audit L10): drop {@link legacyPrefix} once no production evaluation
 * holds such an entry (`select id from evaluations where exists (select 1
 * from unnest(ip_allowlist) e where e ~ '\.$')` returns nothing).
 */
import ipaddr from "ipaddr.js";

type Range = [ipaddr.IPv4 | ipaddr.IPv6, number];

/**
 * An entry as the contract writes it: a canonical address (dotted quad, or
 * IPv6 without a zone) and an optional decimal prefix length — none of the
 * lenient forms `ipaddr.js` would also read (`10.1`, `010.0.0.1`, `/08`).
 */
function parseRange(text: string): Range | null {
  const [address = "", bits, ...rest] = text.split("/");
  if (rest.length > 0 || (bits !== undefined && !/^(0|[1-9]\d{0,2})$/.test(bits))) return null;
  const v4 = ipaddr.IPv4.isValidFourPartDecimal(address);
  if (!v4 && !(address.includes(":") && !address.includes("%") && ipaddr.IPv6.isValid(address))) return null;
  const cidr = `${address}/${bits ?? (v4 ? 32 : 128)}`;
  if (!ipaddr.isValidCIDR(cidr)) return null;
  const [base, length] = ipaddr.parseCIDR(cidr);
  // A mapped range (`::ffff:10.20.0.0/112`) is the IPv4 range it covers.
  if (base instanceof ipaddr.IPv6 && base.isIPv4MappedAddress() && length >= 96) {
    return [base.toIPv4Address(), length - 96];
  }
  return [base, length];
}

/** A legacy text prefix of whole IPv4 octets (`10.`, `10.20.`, `10.20.30.`), as its range. */
function legacyPrefix(text: string): Range | null {
  if (!/^(\d{1,3}\.){1,3}$/.test(text)) return null;
  const octets = text.slice(0, -1).split(".");
  return parseRange(`${[...octets, "0", "0", "0"].slice(0, 4).join(".")}/${octets.length * 8}`);
}

/** Whether `text` is what an allowlist entry may be: an IP address or a CIDR range. */
export function isIpRange(text: string): boolean {
  return parseRange(text) !== null;
}

/** Whether `address` lies in `range`; the two families never match each other. */
const inRange = (address: ipaddr.IPv4 | ipaddr.IPv6, [base, bits]: Range): boolean =>
  address instanceof ipaddr.IPv4
    ? base instanceof ipaddr.IPv4 && address.match(base, bits)
    : base instanceof ipaddr.IPv6 && address.match(base, bits);

export function ipAllowed(allowlist: readonly string[], ip: string | undefined): boolean {
  if (allowlist.length === 0) return true;
  if (ip === undefined || !ipaddr.isValid(ip)) return false;
  const address = ipaddr.process(ip);
  return allowlist.some((entry) => {
    const range = parseRange(entry.trim()) ?? legacyPrefix(entry.trim());
    return range !== null && inRange(address, range);
  });
}
