/**
 * The paper copy's reads and writes (ADR-125 §9–§15): the paper a staff
 * member types in, the submission, the sheet and its scan. Staff only.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ANSWER_COORDINATES,
  PaperAttemptBody,
  PaperItemsQuery,
  PAPER_REFUSALS,
  type PaperAttemptCreated,
  type PaperItems,
  type PaperRefusal,
  type PaperSheet,
} from "@quiz/contracts";

import { api, refusalCodeOf } from "../api";
import type { Dict } from "../i18n";
import { paperItemsKey, paperSheetKey, resultsKey } from "../queryKeys";

/** `GET /evaluations/:id/paper/items?user=`: the student's paper, refused like the submission. */
export function usePaperItems(evaluationId: string, userId: string) {
  return useQuery<PaperItems>({
    queryKey: paperItemsKey(evaluationId, userId),
    queryFn: () =>
      api(
        `/app/api/evaluations/${evaluationId}/paper/items?${new URLSearchParams(PaperItemsQuery.parse({ user: userId }))}`,
      ),
    enabled: userId !== "",
    // A refusal is an answer, not a hiccup: it is said at once.
    retry: false,
    staleTime: Infinity,
  });
}

/** `POST /evaluations/:id/paper`: the whole copy, handed in once. */
export function useEnterPaper(evaluationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; examDate: string; answers: Record<string, unknown> }) =>
      api<PaperAttemptCreated>(`/app/api/evaluations/${evaluationId}/paper`, {
        method: "POST",
        body: JSON.stringify(PaperAttemptBody.parse({ ...input, coordinates: ANSWER_COORDINATES })),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: resultsKey(evaluationId) }),
  });
}

const sheetUrl = (evaluationId: string, attemptId: string) =>
  `/app/api/evaluations/${evaluationId}/attempts/${attemptId}/paper`;

/** The scan's address: a download, never shown inline. */
export const scanUrl = (evaluationId: string, attemptId: string) => `${sheetUrl(evaluationId, attemptId)}/scan`;

/** `GET …/attempts/:attemptId/paper`: the sheet of a paper attempt. */
export function usePaperSheet(evaluationId: string, attemptId: string) {
  return useQuery<PaperSheet>({
    queryKey: paperSheetKey(evaluationId, attemptId),
    queryFn: () => api(sheetUrl(evaluationId, attemptId)),
  });
}

/** `PUT …/paper/scan`: attaches the scan, or replaces it. */
export function useUploadScan(evaluationId: string, attemptId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api<PaperSheet>(scanUrl(evaluationId, attemptId), { method: "PUT", body: form });
    },
    onSuccess: (sheet) => qc.setQueryData(paperSheetKey(evaluationId, attemptId), sheet),
  });
}

/** The paper module's refusal of `error`, or null for anything else. */
export function paperRefusalOf(error: unknown): PaperRefusal | null {
  const code = refusalCodeOf(error);
  return PAPER_REFUSALS.find((refusal) => refusal === code) ?? null;
}

/** The words of each refusal: a code added to `PAPER_REFUSALS` without them is a compile error. */
export const REFUSAL_KEYS: Record<PaperRefusal, keyof Dict> = {
  paper_mode: "paper.refused.paper_mode",
  paper_released: "paper.refused.paper_released",
  paper_not_started: "paper.refused.paper_not_started",
  not_printable: "paper.refused.not_printable",
  paper_no_seat: "paper.refused.paper_no_seat",
  paper_conflict: "paper.refused.paper_conflict",
  answer_invalid: "paper.refused.answer_invalid",
};
