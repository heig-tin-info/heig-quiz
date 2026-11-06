/**
 * The unlock password of an evaluation's Safe Exam Browser (ADR-027,
 * addendum of 2026-11-06): what a teacher types on SEB's lock screen after a
 * user-session switch, and what Ctrl+Q / Cmd+Q asks for. Three lowercase
 * letters then three digits, from an alphabet a teacher can dictate in a
 * noisy room: no `i`, `l`, `o`, no `0`, `1`. One per evaluation, drawn by the
 * api from the CSPRNG; the randomness is injected so the rule stays pure.
 */

/** The letters of a password: the lowercase alphabet without `i`, `l` and `o`. */
export const SEB_UNLOCK_LETTERS = "abcdefghjkmnpqrstuvwxyz";
/** The digits of a password: without `0` and `1`. */
export const SEB_UNLOCK_DIGITS = "23456789";

const FORMAT = new RegExp(`^[${SEB_UNLOCK_LETTERS}]{3}[${SEB_UNLOCK_DIGITS}]{3}$`);

/** Whether `value` has the form of an unlock password, e.g. `cde234`. */
export const isSebUnlockPassword = (value: string): boolean => FORMAT.test(value);

/**
 * A fresh unlock password. `randomBelow(n)` returns a uniform integer in
 * `[0, n)`: `node:crypto`'s `randomInt` in the api, never `Math.random`.
 */
export function drawSebUnlockPassword(randomBelow: (n: number) => number): string {
  const pick = (alphabet: string) => alphabet[randomBelow(alphabet.length)]!;
  return [0, 1, 2].map(() => pick(SEB_UNLOCK_LETTERS)).join("") + [0, 1, 2].map(() => pick(SEB_UNLOCK_DIGITS)).join("");
}
