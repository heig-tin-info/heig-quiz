import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { QuestionDetail } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { NewQuestionForm } from "../question/NewQuestionForm";
import { QUESTION_TYPE_IDS } from "../questionTypes";
import { FormDialog, FormError } from "../ui";

/**
 * "New question" from the pool screen: a type and an internal name, created
 * in the category the sidebar has selected (none means the pool's root).
 */
export function NewQuestionModal({
  poolId,
  categoryId,
  initialType,
  onClose,
  onCreated,
}: {
  poolId: string;
  categoryId: string | null;
  /** The palette can ask for a type ("New question — Code"). */
  initialType: string;
  onClose: () => void;
  onCreated: (question: QuestionDetail) => void;
}) {
  const t = useT();
  const [type, setType] = useState<string>(initialType);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api<QuestionDetail>(`/app/api/pools/${poolId}/questions`, {
        method: "POST",
        body: JSON.stringify({
          type,
          internalName: name.trim(),
          ...(categoryId ? { categoryId } : {}),
        }),
      }),
    onSuccess: onCreated,
  });
  return (
    <FormDialog
      title={t("pool.newQuestion")}
      onClose={onClose}
      onSubmit={() => create.mutate()}
      submitLabel={t("pool.newQuestionAction")}
      submitting={create.isPending}
      canSubmit={name.trim() !== ""}
      error={<FormError error={create.error} fallback={t("pool.createFailed")} />}
    >
      <NewQuestionForm
        types={QUESTION_TYPE_IDS}
        value={type}
        onChange={setType}
        name={name}
        onName={setName}
      />
    </FormDialog>
  );
}
