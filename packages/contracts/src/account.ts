/**
 * The end of an account's identity (ADR-117): the two routes that
 * pseudonymize one, the codes they refuse with, and the two one-time query
 * parameters that tell a page what just happened to its account.
 */
/**
 * `POST` — the caller pseudonymizes their own account (ADR-117 §5): their
 * own `portal` session only, a student account only. `204`, and the
 * session is gone.
 */
export const SELF_PSEUDONYMIZE_PATH = "/app/api/me/pseudonymize";

/**
 * `POST` — an administrator, Super Powers on, pseudonymizes any account
 * (ADR-117 §6). `204`. The route's pattern, and the address of one account.
 */
export const ADMIN_PSEUDONYMIZE_ROUTE = "/app/api/admin/users/:id/pseudonymize";
export const adminPseudonymizePath = (userId: string): string => ADMIN_PSEUDONYMIZE_ROUTE.replace(":id", userId);

/**
 * Why an account is not pseudonymized now (`error` of the refusal, the
 * `account` module's `AccountError`): `not_found` (404), the others 409.
 * `already_anonymized`; `open_attempt`, an exam attempt in progress;
 * `running_classroom`, a seat in a classroom still running; `staff`, a
 * staff account asked by anyone but an administrator; `not_due`, the
 * lifecycle's term not come (the job's own refusal, never a route's).
 */
export const PSEUDONYMIZE_REFUSALS = [
  "not_found",
  "already_anonymized",
  "open_attempt",
  "running_classroom",
  "staff",
  "not_due",
] as const;
export type PseudonymizeRefusal = (typeof PSEUDONYMIZE_REFUSALS)[number];

/**
 * Added once to the address a sign-in lands on when it ended a dormancy
 * (ADR-117 §5): the page shows one notice and drops the parameter.
 */
export const REACTIVATED_PARAM = "reactivated";

/**
 * Carried by the landing page after a self-pseudonymization: the session is
 * gone, the page says in one sentence what happened.
 */
export const ANONYMIZED_PARAM = "anonymized";
