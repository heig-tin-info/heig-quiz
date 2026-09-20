/**
 * Seeded randomness for the whole platform (PLAN-MVP §1.1, decision D19).
 *
 * xmur3 string hash -> mulberry32 generator: thirty lines, no dependency, and
 * bit-for-bit identical on Node and in every browser because it only uses
 * `Math.imul`, 32-bit shifts and a division by 2^32. A permutation is NEVER
 * stored; it is always recomputed from `(attempt.seed, item.id, purpose)`, so
 * a reload, the teacher preview and a regrade all reproduce the exact view the
 * student had.
 */

/** 32-bit string hash (xmur3), used to derive one stream per purpose. */
export function hashSeed(...parts: (string | number)[]): number {
  const s = parts.join("\u0001");
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32 PRNG: returns a [0,1) generator. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, pure: returns a new array. Same seed => same permutation, forever. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Alias of {@link shuffle}, kept because the work-package brief names the
 * seeded shuffle `seededShuffle`. Both names denote the same function.
 */
export const seededShuffle = shuffle;

/** Deterministic pick of one element. Throws on an empty array. */
export function pick<T>(items: readonly T[], seed: number): T {
  if (items.length === 0) throw new RangeError("pick: empty array");
  return items[Math.floor(rng(seed)() * items.length)]!;
}

/**
 * The one and only seed derivation used by the platform.
 *
 * Purposes in use: `"items"` (question order), `"choices"` (mcq),
 * `"options:<blankIndex>"` (cloze selects).
 */
export function streamSeed(attemptSeed: number, itemId: string, purpose: string): number {
  return hashSeed(attemptSeed, itemId, purpose);
}
