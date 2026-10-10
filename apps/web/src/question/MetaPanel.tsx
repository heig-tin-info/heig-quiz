import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  ConceptNotFound,
  ConceptWriteRefusal,
  type CategoryNode,
  type QuestionMeta,
  type QuestionPatch,
} from "@quiz/contracts";

import { api, ApiError, apiErrorMessage } from "../api";
import { ConceptPicker } from "../concepts/ConceptPicker";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { Card, ErrorText, Field, FieldLabel, SectionHeading, Segmented, Select } from "../ui";
import { categoryPaths } from "../pool/categories";
import { poolKey, questionKey } from "../queryKeys";

/**
 * What a question IS, next to what it says: name, category, difficulty,
 * concepts and the shuffle switch, in the editor's side panel.
 *
 * These are metadata, not content: each one is a `PATCH /questions/:id` of
 * its own, applied when the control is left, and none of them touches the
 * draft the type's editor owns.
 *
 * The concepts (ADR-081 third addendum §5) are saved as ids on every change
 * of the picker — the picker is where a new concept is created, so the patch
 * never asks the server to create one. A refusal (a concept merged or gone
 * meanwhile: 422) is said under the picker, which goes back to what the
 * question holds.
 */

/** The concepts saved, or the reason they were not. */
function conceptRefusal(error: unknown, t: ReturnType<typeof useT>): string {
  const body = error instanceof ApiError ? error.body : null;
  if (ConceptNotFound.safeParse(body).success) return t("question.meta.conceptGone");
  if (ConceptWriteRefusal.safeParse(body).success) return t("question.meta.conceptRefused");
  return apiErrorMessage(error, t("question.meta.saveFailed"));
}

export function MetaPanel({
  meta,
  categories,
  poolName,
  poolConceptIds,
  disabled,
}: {
  meta: QuestionMeta;
  categories: CategoryNode[];
  poolName: string;
  /** The concepts the pool already uses: the picker offers them first. */
  poolConceptIds?: readonly string[] | undefined;
  disabled?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const [name, setName] = useState(meta.internalName);
  /** The picker's list while its save is in flight; null: the question's own. */
  const [concepts, setConcepts] = useState<string[] | null>(null);
  const [conceptError, setConceptError] = useState<string | null>(null);

  const send = (body: QuestionPatch) =>
    api(`/app/api/questions/${meta.id}`, { method: "PATCH", body: JSON.stringify(body) });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: questionKey(meta.id) });
    // Prefix match: this also refreshes the pool's concepts (`["pool", id,
    // "concepts"]`) and its lists, which a concept just joined or left.
    await qc.invalidateQueries({ queryKey: poolKey(meta.poolId) });
  };

  const patch = useMutation({
    mutationFn: send,
    onSuccess: refresh,
    onError: toastError("question.meta.saveFailed"),
  });

  const saveConcepts = useMutation({
    mutationFn: (ids: string[]) => send({ concepts: ids }),
    onMutate: (ids) => {
      setConcepts(ids);
      setConceptError(null);
    },
    onSuccess: refresh,
    onError: (error) => setConceptError(conceptRefusal(error, t)),
    onSettled: () => setConcepts(null),
  });

  return (
    <Card className="space-y-4 p-4">
      <SectionHeading title={t("question.meta")} />

      <Field
        label={t("question.meta.name")}
        fullWidth
        disabled={disabled}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const trimmed = name.trim();
          if (trimmed && trimmed !== meta.internalName) patch.mutate({ internalName: trimmed });
          else setName(meta.internalName);
        }}
      />

      <Select
        label={t("question.meta.category")}
        disabled={disabled}
        value={meta.categoryId ?? ""}
        onChange={(e) => patch.mutate({ categoryId: e.target.value === "" ? null : e.target.value })}
      >
        <option value="">{t("question.meta.noCategory")}</option>
        {categoryPaths(categories).map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </Select>

      {/* Laid out like `Field`: the label row, then the control, 6 px apart. */}
      <div className="flex flex-col items-start gap-1.5">
        <FieldLabel>{t("question.meta.difficulty")}</FieldLabel>
        <div>
          <Segmented
            name="difficulty"
            disabled={disabled}
            value={String(meta.difficulty)}
            options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => patch.mutate({ difficulty: Number(v) })}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <ConceptPicker
          value={concepts ?? meta.concepts.map((c) => c.id)}
          onChange={(ids) => saveConcepts.mutate(ids)}
          {...(poolConceptIds ? { poolConceptIds } : {})}
          {...(disabled ? { disabled } : {})}
        />
        {conceptError ? <ErrorText role="alert">{conceptError}</ErrorText> : null}
      </div>

      <div className="flex items-baseline justify-between border-t border-line pt-3 text-[13px]">
        <span className="text-fg-muted">{t("question.meta.pool")}</span>
        <span className="font-medium">{poolName}</span>
      </div>
    </Card>
  );
}
