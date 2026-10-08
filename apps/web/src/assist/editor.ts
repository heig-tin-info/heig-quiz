/**
 * The question editor, as the teacher assistant reaches it (ADR-080, P3
 * amendment, decision 2): ONE slot the mounted editor fills, as a screen
 * fills `screenCommands`, so the dock neither knows the editor's state nor
 * threads it through the shell.
 *
 * - Before a question asked from the editor, the dock FLUSHES the autosave
 *   and sends the draft's config and explanation with it (`draft`): the
 *   teacher's own text, on that screen only.
 * - An editor proposal is applied to the draft it was computed against only
 *   (`apply`): a draft changed since — a keystroke, another tab's edit —
 *   drops it. Applied, it is ONE edit of the draft, which the autosave
 *   stores and never publishes; `restore` puts the draft back as it was,
 *   while nothing else changed it since.
 */
import { useEffect } from "react";

import type { AssistEditorDraft } from "@quiz/contracts";
import { sameDraft } from "@quiz/domain";

import type { Draft } from "../question/useQuestionDraft";

export interface AssistEditor {
  questionId: string;
  /** Sends what is pending; resolves once saved (or failed). */
  flush: () => Promise<boolean>;
  /** The draft as it stands, null while it loads or for a reader. */
  draft: () => AssistEditorDraft | null;
  /**
   * Replaces the config and the explanation of the draft, in ONE edit, if
   * the draft is still `base`; returns the draft as it was (for `restore`),
   * or null when it changed since.
   */
  apply: (base: { config: unknown; explanation: string }, next: { config: unknown; explanation: string }) => Draft | null;
  /** Puts `before` back if the draft is still exactly what `apply` made. */
  restore: (before: Draft, applied: { config: unknown; explanation: string }) => boolean;
}

let current: AssistEditor | null = null;

/** Registers the mounted editor for as long as the calling component is mounted. */
export function useAssistEditor(editor: AssistEditor | null): void {
  // No dependency array, as `useScreenCommands`: the closures read the draft of this render.
  useEffect(() => {
    current = editor;
    return () => {
      current = null;
    };
  });
}

/** The mounted editor of `questionId`, or null: another screen, another question. */
export function assistEditor(questionId?: string): AssistEditor | null {
  if (!current) return null;
  return questionId === undefined || current.questionId === questionId ? current : null;
}

/** The editor's slot over its draft state: what `QuestionEditor` registers. */
export function editorSlot(input: {
  questionId: string;
  draft: Draft | null;
  readOnly: boolean;
  setDraft: (next: Draft) => void;
  flush: () => Promise<boolean>;
}): AssistEditor | null {
  const { questionId, draft, readOnly, setDraft, flush } = input;
  if (readOnly) return null;
  return {
    questionId,
    flush,
    draft: () => (draft ? { questionId, config: draft.config, explanation: draft.explanation } : null),
    apply: (base, next) => {
      if (!draft || !sameDraft(draft, base)) return null;
      setDraft({ ...draft, config: next.config, explanation: next.explanation });
      return draft;
    },
    restore: (before, applied) => {
      if (!draft || !sameDraft(draft, applied)) return false;
      setDraft(before);
      return true;
    },
  };
}
