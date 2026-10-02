/**
 * The paths of the sign-in routes whose URL carries a secret, in a file that
 * imports nothing: `redact.ts` strips them from the logs, and every module
 * logs, so the redaction must not pull the routes' own modules (and their
 * guards, services, notifications) into everyone's import graph.
 */

/** The one-time link of an impersonation (ADR-034): `<path><secret>`. */
export const IMPERSONATION_PATH = "/app/auth/as/";

/** The Safe Exam Browser launch ticket (ADR-027): `<path><secret>`. */
export const LAUNCH_PATH = "/app/auth/seb/";

/** GitHub's OAuth return (M2-03): its query carries the code. */
export const GITHUB_CALLBACK_PATH = "/app/auth/github/callback";
