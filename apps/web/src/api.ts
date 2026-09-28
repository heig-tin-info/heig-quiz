/** Portal API client: session cookies + double-submit CSRF header. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Me, MePatch } from "@quiz/contracts";

import type { Dict } from "./i18n/en";
import { translateNow } from "./i18n/current";
import { meKey } from "./queryKeys";

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
    throw new ApiError(res.status, await res.json().catch(() => null));
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/**
 * The refusals the SPA words itself, by their `error` code: the server's
 * `message` is English, and these reach a reader on any screen.
 */
const WORDED: Partial<Record<string, keyof Dict>> = {
  // ADR-034: every write of an admin acting as a student, in production.
  impersonation_read_only: "error.impersonationReadOnly",
};

/** Server-provided error message of a failed call (or its worded code), or the fallback. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  const body = err.body as { error?: string; message?: string } | null;
  const worded = body?.error ? WORDED[body.error] : undefined;
  return worded ? translateNow(worded) : (body?.message ?? fallback);
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
