/**
 * F-EVAL-12: the room restriction of an evaluation, a list of address
 * prefixes matched literally against the request address. An empty list
 * restricts nothing; an unknown address is outside any non-empty list.
 */
export function ipAllowed(allowlist: readonly string[], ip: string | undefined): boolean {
  if (allowlist.length === 0) return true;
  if (ip === undefined) return false;
  return allowlist.some((prefix) => ip.startsWith(prefix));
}
