/** Portal API client: session cookies + double-submit CSRF header. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Me, MePatch, PublicConfig } from "@quiz/contracts";

import { connection } from "./realtime/connection";

import type { Dict } from "./i18n/en";
import { translateNow } from "./i18n/current";
import { configKey, meKey } from "./queryKeys";

function csrfToken(): string {
  return (
    document.cookie
      .split("; ")
      .find((c) => c.startsWith("quiz_csrf="))
      ?.slice("quiz_csrf=".length) ?? ""
  );
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API ${status}`);
  }
}

/**
 * Dispatched on `window` by every call answered `423 kiosk_suspended`: the
 * station this kiosk session sits on could not prove its integrity (ADR-051
 * §6). The autosave, the state writes and the submit all learn it here, and
 * `useStationAttestation` alone listens.
 */
export const KIOSK_SUSPENDED_EVENT = "quiz:kiosk-suspended";

/** The code of an API refusal (the `error` field of its body), or null for anything else. */
export function refusalCodeOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { error?: unknown } | null)?.error;
  return typeof code === "string" ? code : null;
}

/** Whether `error` is the API's refusal `code`. */
export const refusedWith = (error: unknown, code: string): boolean => refusalCodeOf(error) === code;

/** Whether `error` is a 404: something gone, or never the reader's (invariant 6). */
export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

/**
 * What a screen may tune on a shared read (`useClassroom`, `useEvaluation`,
 * `usePool`…): whether it runs now, and whether a failure is retried. The
 * key, the URL and the type stay the hook's.
 */
export interface ReadOptions {
  enabled?: boolean;
  retry?: boolean;
}

export async function api<T>(
  path: string,
  init: RequestInit & { csv?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") {
    headers.set("x-csrf-token", csrfToken());
  }
  if (init.body instanceof Blob) {
    headers.set("content-type", init.body.type || "application/octet-stream");
  } else if (init.body instanceof FormData) {
    // Multipart: the browser writes the content type WITH its boundary, and
    // a hand-set header would leave the server unable to split the parts.
  } else if (init.body && !init.csv) {
    headers.set("content-type", "application/json");
  }
  if (init.csv) {
    headers.set("content-type", "text/csv");
    init.body = init.csv;
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch (error) {
    if (!init.signal?.aborted) connection.suspect();
    throw error;
  }
  if ([502, 503, 504].includes(res.status)) connection.suspect();
  if (!res.ok) {
    const error = new ApiError(res.status, await res.json().catch(() => null));
    // ADR-051 §6: whichever write learnt it, the station's page is told once.
    if (refusedWith(error, "kiosk_suspended")) window.dispatchEvent(new Event(KIOSK_SUSPENDED_EVENT));
    throw error;
  }
  // No body to parse: a 204, or a 202 (the journal's Refresh).
  if (res.status === 204) {
    return undefined as T;
  }
  // A 202 may carry a body (a student's run, a grading pass) or none (the
  // journal's Refresh); only the empty one reads as undefined.
  const text = await res.text();
  if (res.status === 202 && text === "") {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/**
 * The refusals the SPA words itself, by their `error` code: the server's
 * `message` is English, and these reach a reader on any screen.
 */
const WORDED: Partial<Record<string, keyof Dict>> = {
  // A 404 of any route: something gone, or never the reader's (invariant 6).
  not_found: "error.notFound",
  // ADR-034: every write of an admin acting as a student, in production.
  impersonation_read_only: "error.impersonationReadOnly",
  // ADR-050: publishing the correction, and a Reopen it forbids.
  correction_not_open: "error.correctionNotOpen",
  correction_not_allowed: "error.correctionNotAllowed",
  correction_published: "error.correctionPublished",
  // F-ADMIN-06: "Run now" on a task whose run is still going.
  task_running: "error.taskRunning",
  // F-GH-04, D28: a classroom's organization is held by its journal; and a
  // connect to an organization the App is not (or no longer) installed on.
  journal_attached: "error.githubJournalAttached",
  app_not_installed: "error.githubAppNotInstalled",
  // F-PROJ-17, ADR-070 §5: a roster removal, unclaim or e-mail change whose
  // GitHub access GitHub refused to take away first.
  revoke_failed: "error.githubRevokeFailed",
  // A teacher's self-enroll while they hold another line of the classroom.
  already_enrolled: "error.alreadyEnrolled",
  // ADR-054: a second switch-on while they run, and an action that needs them.
  super_powers_active: "error.superPowersActive",
  super_powers_required: "error.superPowersRequired",
  // ADR-055 §6: the test e-mail of an admin account without an address.
  no_email: "error.noEmail",
  // ADR-056 §5 and §10: a regrade across other variables, a poll on a parameterized question.
  variables_changed: "error.variablesChanged",
  poll_parameterized: "error.pollParameterized",
  // A per-minute guard (`budget.ts`): the test e-mail, the AI connection test.
  rate_limited: "error.rateLimited",
  // ADR-058: the AI settings without a master key, and a cap over its ceiling.
  llm_disabled: "error.llmDisabled",
  cap_too_high: "error.capTooHigh",
  // ADR-059: the editor's wand.
  llm_not_configured: "error.llmNotConfigured",
  llm_budget_exhausted: "error.llmBudgetExhausted",
  llm_failed: "error.llmFailed",
  statement_empty: "error.statementEmpty",
  item_not_empty: "error.itemNotEmpty",
  generate_unsupported: "error.generateUnsupported",
  // ADR-060: the LLM review.
  not_published: "error.notPublished",
  review_unsupported: "error.reviewUnsupported",
  no_review: "error.noReview",
  no_fix: "error.noFix",
  fix_stale: "error.fixStale",
  // A course's code is unique across the instance: at creation and on edit.
  duplicate_code: "courses.codeTaken",
  // ADR-068: what only a course owner may do, the last owner, a second seat.
  owner_required: "error.ownerRequired",
  last_owner: "error.lastOwner",
  already_staff: "error.alreadyStaff",
};

/** Server-provided error message of a failed call (or its worded code), or the fallback. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  const body = err.body as { error?: string; message?: string } | null;
  const worded = body?.error ? WORDED[body.error] : undefined;
  return worded ? translateNow(worded) : (body?.message ?? fallback);
}

/**
 * What a refused write says on a screen that words its own refusals: the
 * code's entry in the screen's `table`, else the server's message (or its
 * code worded by `WORDED`), else `error.save`. The project page and the
 * student's project row each keep a table and nothing else.
 */
export function wordedRefusal(
  error: unknown,
  table: Partial<Record<string, keyof Dict>>,
  t: (key: keyof Dict) => string,
): string {
  const code = refusalCodeOf(error);
  const key = code !== null && Object.hasOwn(table, code) ? table[code] : undefined;
  return key ? t(key) : apiErrorMessage(error, t("error.save"));
}

/**
 * The public configuration (`/app/api/config`), the one unauthenticated
 * endpoint. A failure is not an error state for its readers: each falls back
 * to what the platform does without the option.
 */
export function usePublicConfig() {
  return useQuery<PublicConfig>({
    queryKey: configKey,
    queryFn: () => api<PublicConfig>("/app/api/config"),
    retry: false,
  });
}

/** Current session, or null when signed out (401). */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: meKey,
    retry: false,
    queryFn: async () => {
      try {
        return await api<Me>("/app/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

/**
 * `PATCH /me` — one account preference — then the session refetched, so every
 * screen reading `useMe()` sees the saved value. The body is the patch as
 * given: one field per call, which is what each settings row sends.
 */
export function useMePatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: MePatch) =>
      api("/app/api/me", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
}
