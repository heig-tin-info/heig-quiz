import { useMutation } from "@tanstack/react-query";
import { WandSparkles } from "lucide-react";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { GenerateRequest, GenerateResult } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { useLlmAvailability } from "../llmAvailability";
import { Alert, Button } from "../ui";
import type { Draft } from "./useQuestionDraft";

/**
 * "Generate answers" (ADR-059): the model completes the draft through the
 * type's generator, the result lands in the form like a teacher's edit — the
 * autosave stores it — and Undo puts back the draft as it was, until the
 * teacher's next edit. Nothing is ever published by the model.
 */
export function useGenerate({
  questionId,
  type,
  draft,
  setDraft,
  readOnly,
}: {
  questionId: string;
  type: string;
  draft: Draft | null;
  setDraft: Dispatch<SetStateAction<Draft | null>>;
  readOnly: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const availability = useLlmAvailability();
  const enabled =
    !readOnly && draft !== null && availability.data?.available === true && availability.data.types.includes(type);

  // The draft as it stands now, for the reply to compare with the draft it was asked about.
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  }, [draft]);
  const [undo, setUndo] = useState<{ before: Draft; config: unknown; incomplete?: GenerateResult["incomplete"] } | null>(
    null,
  );

  const ask = (body: GenerateRequest) =>
    api<GenerateResult>(`/app/api/questions/${questionId}/generate`, { method: "POST", body: JSON.stringify(body) });

  /**
   * The reply applied to the draft it was asked about, with its Undo — or
   * dropped when the teacher changed the draft meanwhile: merging it then
   * would undo their edit with a proposal built on what they replaced.
   */
  const apply = (before: Draft, result: GenerateResult) => {
    if (latest.current !== before) {
      toast(t("question.generate.stale"), "error");
      return;
    }
    setDraft({ ...before, config: result.config, explanation: result.explanation });
    setUndo({ before, config: result.config, ...(result.incomplete ? { incomplete: result.incomplete } : {}) });
  };

  const whole = useMutation({
    mutationFn: (before: Draft) => ask({ config: before.config, explanation: before.explanation }),
    onSuccess: (result, before) => apply(before, result),
    onError: (error) => toast(apiErrorMessage(error, t("question.generate.failed")), "error"),
  });

  const item = async (index: number): Promise<void> => {
    const before = latest.current;
    if (!before) return;
    try {
      apply(before, await ask({ config: before.config, explanation: before.explanation, item: index }));
    } catch (error) {
      toast(apiErrorMessage(error, t("question.generate.failed")), "error");
      throw error;
    }
  };

  // The last proposal, while the draft is still what it made.
  const current = undo && draft?.config === undo.config ? undo : null;

  return {
    enabled,
    pending: whole.isPending,
    run: () => (draft ? whole.mutate(draft) : undefined),
    /** The wand of one element, for the type's editor; undefined when the wand is off. */
    item: enabled ? item : undefined,
    /** What running could not settle (a code question's outputs, a picture's target), while Undo stands. */
    incomplete: current?.incomplete,
    /** Undo is offered until the teacher's next edit of the config. */
    undo: current
      ? () => {
          setDraft(current.before);
          setUndo(null);
        }
      : null,
  };
}

/** The wand's row above the type's form, and the notice that carries Undo. */
export function GenerateBar({ wand }: { wand: ReturnType<typeof useGenerate> }) {
  const t = useT();
  if (!wand.enabled) return null;
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="secondary" loading={wand.pending} onClick={wand.run} title={t("question.generate.hint")}>
          <WandSparkles /> {t("question.generate")}
        </Button>
      </div>
      {wand.undo ? (
        <Alert
          icon={WandSparkles}
          title={t("question.generate.done.title")}
          action={
            <Button variant="ghost" size="sm" onClick={wand.undo}>
              {t("question.generate.undo")}
            </Button>
          }
        >
          {t("question.generate.done.body")}
          {wand.incomplete ? <span className="mt-1 block">{t(`question.generate.incomplete.${wand.incomplete}`)}</span> : null}
        </Alert>
      ) : null}
    </div>
  );
}
