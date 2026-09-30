/**
 * Every key name appearing anywhere in a serialised payload, at any depth:
 * what the leak tests of the student view search for a forbidden key
 * (invariant 4, docs/05 §5.7).
 */
export function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) keysOf(child, out);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.add(key);
    keysOf(child, out);
  }
  return out;
}
