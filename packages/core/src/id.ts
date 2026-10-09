/**
 * A fresh OPAQUE id, minted by an editor for what it creates (a diagram's
 * element, a categorize card): eight base-36 characters that say nothing,
 * since a starter reaches the student with its ids (ADR-036).
 * `crypto.getRandomValues` exists in every browser and in Node ≥ 19, the two
 * places an editor or a seed runs. Unseeded: the seeded streams are `rng.ts`.
 */
export function newId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}
