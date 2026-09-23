import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { QuestionDetail, QuestionRow } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { poolKey } from "../queryKeys";

/** What the two actions need of a question: a pool row and an editor's meta both fit. */
export type QuestionRef = Pick<QuestionRow, "id" | "internalName">;

/**
 * Duplicate and delete one question of `poolId`, the pair the pool screen
 * and the question editor both offer. The copy lands in the same pool, the
 * delete asks first (a `danger` confirm), both toast a failure and refresh
 * the pool. Only what happens AFTER differs between the two screens — the
 * editor follows the copy, and leaves the question it just deleted — so that
 * is what the caller passes, called once the pool is refreshed.
 */
export function useQuestionActions(
  poolId: string | undefined,
  {
    onDeleted,
    onDuplicated,
  }: {
    onDeleted?: () => void;
    onDuplicated?: (copy: QuestionDetail) => void;
  } = {},
): {
  duplicate: (question: QuestionRef) => void;
  askDelete: (question: QuestionRef) => Promise<void>;
  busy: boolean;
} {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();

  const duplicate = useMutation({
    mutationFn: (question: QuestionRef) =>
      api<QuestionDetail>(`/app/api/questions/${question.id}/copy`, {
        method: "POST",
        body: JSON.stringify({ targetPoolId: poolId }),
      }),
    onSuccess: async (copy) => {
      toast(t("question.duplicated"), "success");
      await qc.invalidateQueries({ queryKey: poolKey(poolId) });
      onDuplicated?.(copy);
    },
    onError: toastError("error.save"),
  });

  const remove = useMutation({
    mutationFn: (question: QuestionRef) =>
      api(`/app/api/questions/${question.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: poolKey(poolId) });
      onDeleted?.();
    },
    onError: toastError("question.deleteFailed"),
  });

  const { mutate: removeQuestion } = remove;
  const askDelete = useCallback(
    async (question: QuestionRef) => {
      const ok = await confirm({
        title: t("question.delete"),
        message: t("question.deleteConfirm", { name: question.internalName }),
        confirmLabel: t("common.delete"),
        cancelLabel: t("common.cancel"),
        danger: true,
      });
      if (ok) removeQuestion(question);
    },
    [confirm, removeQuestion, t],
  );

  return {
    duplicate: duplicate.mutate,
    askDelete,
    busy: duplicate.isPending || remove.isPending,
  };
}
