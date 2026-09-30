/**
 * The teacher's EXPAND layer (ADR-046 addendum): the app's expand layer
 * (`ui/expand.tsx`) with a simpler bar than the attempt's — the title of what
 * is being edited ("Reference diagram"), the draft's save state where the
 * screen autosaves, and one primary action, "Close". No Alt+←/→: there is no
 * question to move to.
 *
 * Lent as `EditorProps.Expand` by `QuestionEditorHost` (every editor host),
 * and as `PlayerProps.Expand` where a teacher plays a question: by
 * `QuestionPlayerHost` (the Try tab; the grading panel opts out) and by the
 * previews (`PlayedQuestion`, on the student's `QuestionHost`).
 *
 * The save state comes from {@link EditorExpandChrome}, which the question
 * editor provides around its Edit tab with the autosave's state. Elsewhere —
 * the poll launcher, a preview, the Try tab, where nothing is saved as one
 * draws — there is no provider and no badge.
 */
import { createContext, useContext } from "react";

import type { ExpandProps } from "@quiz/core/client";

import { useT } from "../i18n";
import { ExpandPanel, SyncBadge, type SyncState } from "../ui";

export const EditorExpandChrome = createContext<SyncState | null>(null);

export function EditorExpandLayer({ open, onClose, title, children }: ExpandProps) {
  const t = useT();
  const sync = useContext(EditorExpandChrome);
  return (
    <ExpandPanel
      open={open}
      onClose={onClose}
      label={title}
      closeLabel={t("common.close")}
      title={title}
      status={sync === null ? null : <SyncBadge state={sync} />}
    >
      {children}
    </ExpandPanel>
  );
}
