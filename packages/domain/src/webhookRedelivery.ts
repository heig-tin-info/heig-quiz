/**
 * When `reconcile.deliveries` asks GitHub to deliver a webhook again
 * (ADR-011's addendum of 2026-11-22, as reviewed): what an attempt's answer
 * says, and how often one delivery is asked. The `github` module reads GitHub's
 * log and keeps the asks (`webhook_redelivery_asks`); these rules decide.
 */

/** One delivery is asked again at most this many times... */
export const REDELIVERY_MAX_ASKS = 3;
/** ...and no longer than this after its first ask. */
export const REDELIVERY_ASK_WINDOW_MS = 24 * 3_600_000;

/**
 * What an attempt's HTTP status says (`status_code` of GitHub's log; 0 or
 * none when the intake gave no answer): `delivered` (2xx); `retry` when the
 * intake did not answer, was overloaded (429) or failed (5xx) — another try
 * may get through; `refused` for any other answer (a 4xx: a signature
 * refused, a body too large): the same bytes would be refused again, so the
 * delivery is never asked for.
 */
export function attemptVerdict(statusCode: number): "delivered" | "retry" | "refused" {
  if (statusCode >= 200 && statusCode < 300) return "delivered";
  if (statusCode < 100 || statusCode === 429 || statusCode >= 500) return "retry";
  return "refused";
}

/** What the asks of one delivery recorded so far: none, or its count, its first, and a refusal seen. */
export interface RedeliveryAsks {
  asks: number;
  firstAskedAt: Date;
  refusedAt: Date | null;
}

/**
 * Whether a delivery whose last attempt calls for a retry may be asked again
 * now: never asked; or asked fewer than {@link REDELIVERY_MAX_ASKS} times,
 * the first less than {@link REDELIVERY_ASK_WINDOW_MS} ago, and never found
 * refused. A delivery the intake keeps failing (a payload it cannot take)
 * thus costs three asks, not one every pass.
 */
export function mayAskAgain(asked: RedeliveryAsks | undefined, now: Date): boolean {
  if (asked === undefined) return true;
  return (
    asked.refusedAt === null &&
    asked.asks < REDELIVERY_MAX_ASKS &&
    now.getTime() - asked.firstAskedAt.getTime() < REDELIVERY_ASK_WINDOW_MS
  );
}
