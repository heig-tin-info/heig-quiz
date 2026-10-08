import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { GenerateRequest, GenerateResult } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { useLlmAvailability } from "../llmAvailability";
import type { Draft } from "./useQuestionDraft";

/**
 * The draft's statement as the server reads it before it calls the model
 * (`apps/api/src/modules/pool/generate.ts`, `statement_empty`): every type
 * with a generator reads `config.prompt` — `packages/registry/src/server.test.ts`
 * ("every generator reads its statement from config.prompt") pins it for each
 * one. A draft is unvalidated (D16), so a missing or non-string prompt counts
 * as empty. Trimmed, as the server trims it.
 */
function draftStatement(config: unknown): string {
  const prompt = typeof config === "object" && config !== null ? (config as { prompt?: unknown }).prompt : undefined;
  return typeof prompt === "string" ? prompt.trim() : "";
}

/**
 * "Generate answers" (ADR-059): the model completes the draft through the
 * type's generator, the result lands in the form like a teacher's edit — the
 * autosave stores it — and Undo puts back the draft as it was, until the
 * teacher's next edit. Nothing is ever published by the model. The button,
 * its Undo and its notice live in the editor's AI card (ADR-082).
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

  /** The statement is written: the server refuses the wand, whole or per element, while it is empty. */
  const ready = draft !== null && draftStatement(draft.config) !== "";

  return {
    /** Offered: a model, a type with a generator, a writer, a loaded draft. */
    enabled,
    ready,
    pending: whole.isPending,
    run: () => (draft ? whole.mutate(draft) : undefined),
    /** The wand of one element, for the type's editor; undefined while it would be refused. */
    item: enabled && ready ? item : undefined,
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

export type Wand = ReturnType<typeof useGenerate>;
