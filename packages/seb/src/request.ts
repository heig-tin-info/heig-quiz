/**
 * What a SEB request carries, and how it is checked.
 *
 * References:
 *   [SPEC-CK] https://safeexambrowser.org/developer/seb-config-key.html
 *             « the LMS creates a SHA256 hash value from the absolute URL
 *             without Fragment part with appended Config Key hash string »
 *   [AM]      mod/quiz/accessrule/seb/classes/seb_access_manager.php
 *             `check_key()`: `hash('sha256', $url . $validkey) === $key`
 *
 * Ported from `heig-classroom/apps/codespace/src/seb/verify.ts` (M6-02),
 * the formulas only: which requests are checked, and against which keys, is
 * the caller's business (ADR-027, ADR-051 §3). One divergence, Quiz's
 * (ADR-051): the absolute URL is never re-encoded through `URL`.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** The Config Key hash SEB sends on every request: `sha256(URL + Config Key)`. */
export const CONFIG_KEY_HEADER = "x-safeexambrowser-configkeyhash";

/**
 * The Browser Exam Key hash SEB sends beside it, `sha256(URL + BEK)`: the
 * BEK is SEB's own, one per platform and version
 * (https://safeexambrowser.org/developer/seb-integration.html).
 */
export const REQUEST_HASH_HEADER = "x-safeexambrowser-requesthash";

/**
 * The absolute URL SEB hashed for a request: the origin of the public URL
 * followed by the path and query AS RECEIVED, without a fragment. Nothing the
 * client sends (`Host`, `X-Forwarded-*`) enters it. Never re-encoded through
 * `URL`: SEB hashes the URL it requested, byte for byte, and `new URL` would
 * normalise a percent-encoding or a dot segment it did not send.
 */
export function absoluteRequestUrl(publicUrl: string, target: string): string {
  const hash = target.indexOf("#");
  return new URL(publicUrl).origin + (hash < 0 ? target : target.slice(0, hash));
}

/** `sha256(url + key)`, hex, the formula of [AM:check_key]. */
export function expectedHash(url: string, key: string): string {
  return createHash("sha256").update(`${url}${key}`, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hexadecimal hashes, case and surrounding
 * whitespace ignored. `timingSafeEqual` demands equal lengths, and comparing
 * the lengths first would short-circuit: the digests of both sides are
 * compared instead, always 32 bytes, and equal digests mean equal strings.
 */
export function hashesEqual(a: string, b: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text.trim().toLowerCase(), "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Whether `header` is the hash of `url` under at least one of `keys` (the
 * Browser Exam Keys an activity accepts, `check_browser_exam_keys` of [AM]).
 * Every key is compared, never stopping at the first match, so the duration
 * does not tell which one matched. False for an empty list or no header.
 */
export function anyKeyMatches(url: string, keys: readonly string[], header: unknown): boolean {
  if (typeof header !== "string") return false;
  let matched = false;
  for (const key of keys) if (hashesEqual(expectedHash(url, key), header)) matched = true;
  return matched;
}
