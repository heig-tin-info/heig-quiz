/**
 * When `reconcile.deliveries` asks GitHub to deliver a webhook again
 * (ADR-011's addendum of 2026-11-22, as reviewed): what an attempt's answer
 * says, and when one delivery is asked next. The `github` module reads
 * GitHub's log and keeps the asks (`webhook_redelivery_asks`); these rules
 * decide.
 */

/** A delivery is asked again only this long after its first failed attempt: GitHub's log window. */
export const REDELIVERY_WINDOW_MS = 24 * 3_600_000;
/** The wait after a delivery's first ask; it doubles after each ask. */
export const REDELIVERY_BACKOFF_MS = 15 * 60_000;
/**
 * Taken off every wait: the passes run every 15 minutes, and two passes'
 * clocks may lie a few seconds less than that apart.
 */
export const REDELIVERY_SLACK_MS = 60_000;

/**
 * What an attempt's HTTP status says (`status_code` of GitHub's log; 0 when
 * the intake gave no answer): `delivered` (2xx); `refused` for a 413 (the
 * payload too large) or a 422 (unprocessable): the same bytes would be
 * refused again, so the delivery is never asked for; `retry` for anything
 * else — no answer, a 5xx, a 429, but also a 401 after the webhook secret
 * was rotated, or a 404, 403 or 408 from a proxy during a deploy: those pass.
 */
export function attemptVerdict(statusCode: number): "delivered" | "retry" | "refused" {
  if (statusCode >= 200 && statusCode < 300) return "delivered";
  if (statusCode === 413 || statusCode === 422) return "refused";
  return "retry";
}

/**
 * When a delivery asked `asks` times, the last at `askedAt`, may be asked
 * again: {@link REDELIVERY_BACKOFF_MS} after the first ask, then twice as
 * long after each (15 min, 30 min, 1 h, 2 h, 4 h, 8 h...), less
 * {@link REDELIVERY_SLACK_MS}. Within the 24-hour window that is about seven
 * asks: a delivery the intake keeps failing stays bounded, and an outage of
 * the intake of up to about 15 hours is still recovered.
 */
export function nextAskAt(asks: number, askedAt: Date): Date {
  return new Date(askedAt.getTime() + REDELIVERY_BACKOFF_MS * 2 ** Math.max(0, asks - 1) - REDELIVERY_SLACK_MS);
}
