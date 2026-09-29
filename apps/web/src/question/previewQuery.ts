import type { PreviewResult, PreviewSolution } from "@quiz/contracts";

import { api } from "../api";
import { questionPreviewKey } from "../queryKeys";

/**
 * The student view of one version of a question (`POST /questions/:id/preview`,
 * seed 0, built by `studentView` on the server). One request and one cache
 * entry per (question, source), for every surface that shows it: the editor's
 * Try panel, its version history, the student preview page, and the
 * evaluation's question picker. Spread into `useQuery`, so a key can never
 * drift from the body it caches.
 */
export const questionPreviewQuery = (id: string, source: "draft" | number) => ({
  queryKey: questionPreviewKey(id, source),
  queryFn: () =>
    api<PreviewResult>(`/app/api/questions/${id}/preview`, {
      method: "POST",
      body: JSON.stringify({ source }),
    }),
});

/**
 * The key of that same view (`POST /questions/:id/preview/solution`), for the
 * "Show answers" of a preview: a request of its own, made on the click.
 */
export const questionSolutionQuery = (id: string, source: "draft" | number) => ({
  queryKey: [...questionPreviewKey(id, source), "solution"] as const,
  queryFn: () =>
    api<PreviewSolution>(`/app/api/questions/${id}/preview/solution`, {
      method: "POST",
      body: JSON.stringify({ source }),
    }),
});
