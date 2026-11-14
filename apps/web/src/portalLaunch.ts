import { useMutation } from "@tanstack/react-query";

import { api } from "./api";

/**
 * A launch into the workspace portal: a POST under the CSRF check (never a
 * link a cross-site page could make a browser follow), answering `{ url }`,
 * then the page goes there in the same tab. The student's *Open workspace*
 * (ADR-047, audit L7) and the staff's *Open in workspace* (ADR-129 §5).
 * `busy` stays true once answered, the page is leaving; `launch` does
 * nothing meanwhile, so a double click posts once.
 */
export function usePortalLaunch(path: string, onError: (error: unknown) => void) {
  const mutation = useMutation({
    mutationFn: () => api<{ url: string }>(path, { method: "POST" }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError,
  });
  const busy = mutation.isPending || mutation.isSuccess;
  return { busy, launch: () => (busy ? undefined : mutation.mutate()) };
}
