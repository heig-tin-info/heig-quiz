/** Portal API client: session cookies + double-submit CSRF header. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Me, MePatch, PublicConfig } from "@quiz/contracts";

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

/** Whether `error` is the API's refusal `code` (the `error` field of its body). */
export const refusedWith = (error: unknown, code: string): boolean =>
  error instanceof ApiError && (error.body as { error?: string } | null)?.error === code;

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
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    const error = new ApiError(res.status, await res.json().catch(() => null));
    // ADR-051 §6: whichever write learnt it, the station's page is told once.
    if (refusedWith(error, "kiosk_suspended")) window.dispatchEvent(new Event(KIOSK_SUSPENDED_EVENT));
    throw error;
  }
  // No body to parse: a 204, or a 202 (the journal's Refresh).
  if (res.status === 202 || res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

/**
 * The refusals the SPA words itself, by their `error` code: the server's
 * `message` is English, and these reach a reader on any screen.
 */
const WORDED: Partial<Record<string, keyof Dict>> = {
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
  // ADR-054: a second switch-on while they run, and an action that needs them.
  super_powers_active: "error.superPowersActive",
  super_powers_required: "error.superPowersRequired",
  // ADR-055 §6: the test e-mail of an admin account without an address.
  no_email: "error.noEmail",
  // ADR-056 §5 and §10: a regrade across other variables, a poll on a parameterized question.
  variables_changed: "error.variablesChanged",
  poll_parameterized: "error.pollParameterized",
};

/** Server-provided error message of a failed call (or its worded code), or the fallback. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  const body = err.body as { error?: string; message?: string } | null;
  const worded = body?.error ? WORDED[body.error] : undefined;
  return worded ? translateNow(worded) : (body?.message ?? fallback);
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
