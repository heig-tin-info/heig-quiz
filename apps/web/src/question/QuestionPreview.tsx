import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Eye, Pencil, X } from "lucide-react";

import type { PreviewResult, QuestionRow } from "@quiz/contracts";

import { useT, type Dict } from "../i18n";
import { typeLabel } from "../questionTypes";
import { routeToPath } from "../router";
import { Alert, IconButton, LinkButton } from "../ui";
import { PreviewedQuestion, type StudentQuestion } from "./PreviewedQuestion";
import { questionPreviewQuery, questionSolutionQuery } from "./previewQuery";

/**
 * What the two uses say differently: the picker speaks of the version "Add"
 * would freeze, the pool of the version an evaluation would take.
 */
const COPY: Record<"pick" | "browse", { version: keyof Dict; draftBody: keyof Dict }> = {
  pick: { version: "question.preview.versionPick", draftBody: "question.preview.draftBodyPick" },
  browse: {
    version: "question.preview.versionBrowse",
    draftBody: "question.preview.draftBodyBrowse",
  },
};

/**
 * One question of a list as a student will read it — the reading pane of the
 * evaluation's question picker (`pick`) and of the pool screen (`browse`).
 *
 * The version is the latest PUBLISHED one — the one an evaluation would
 * freeze — or the draft of a question never published, said so. A draft that
 * moved since that publication is not what an evaluation would get, so it is
 * not what is shown; one line says it exists. Same request and cache entry as
 * the editor's own preview (`questionPreviewQuery`), through `studentView` on
 * the server (invariant 4).
 *
 * The two uses differ in where the editor opens. The picker opens it in a new
 * tab: leaving would close the sheet and drop the ticks. The pool opens it in
 * the same tab, like the row's pencil — through an anchor all the same, so a
 * middle-click still gets a tab of its own.
 *
 * The heading is a polite live region: walking a list with the arrows swaps
 * the question under a reader's feet, and the name is what they need to
 * hear; the body is not announced, it is read on demand.
 */
export function QuestionPreview(
  props: { row: QuestionRow } & (
    | { mode: "pick" }
    | {
        mode: "browse";
        onOpenEditor: () => void;
        /** The ✕ of a docked pane; absent where a Back button closes it instead. */
        onClose?: () => void;
      }
  ),
) {
  const { row } = props;
  const t = useT();
  const copy = COPY[props.mode];
  const source = row.latestNumber ?? "draft";
  const query = useQuery<PreviewResult, Error, StudentQuestion>({
    ...questionPreviewQuery(row.id, source),
    select: (r) => ({ type: r.type, student: r.student, points: r.itemPoints }),
    // A published version never changes; a draft may, in another tab.
    staleTime: source === "draft" ? 0 : Infinity,
  });
  const href = routeToPath({ view: "question", id: row.id });
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1" aria-live="polite">
          <h3 className="truncate font-semibold">{row.internalName}</h3>
          <p className="mt-0.5 text-sm text-fg-muted">
            {source === "draft"
              ? typeLabel(t, row.type)
              : t(copy.version, { type: typeLabel(t, row.type), n: source })}
          </p>
        </div>
        {props.mode === "pick" ? (
          // An anchor, not a button: middle-click and "open in a new window"
          // must work too, and `noopener` keeps the editor tab detached.
          <LinkButton variant="ghost" size="sm" href={href} target="_blank" rel="noopener">
            {t("question.preview.openEditor")} <ExternalLink />
          </LinkButton>
        ) : (
          <>
            <LinkButton
              variant="ghost"
              size="sm"
              href={href}
              onClick={(e) => {
                // A plain click is the app's navigation; a modified one (a
                // new tab, a new window) is the browser's.
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                props.onOpenEditor();
              }}
            >
              <Pencil /> {t("question.preview.openEditor")}
            </LinkButton>
            {props.onClose ? (
              <IconButton size="sm" label={t("question.preview.close")} onClick={props.onClose}>
                <X />
              </IconButton>
            ) : null}
          </>
        )}
      </div>
      {source === "draft" ? (
        <Alert icon={Eye} title={t("question.preview.draftTitle")}>
          {t(copy.draftBody)}
        </Alert>
      ) : row.hasDraftChanges ? (
        <p className="text-[13px] text-fg-muted">{t("question.preview.newerDraft")}</p>
      ) : null}
      {/* "Show answers" only in the picker, the scope agreed for it. */}
      <PreviewedQuestion
        query={query}
        solution={props.mode === "pick" ? questionSolutionQuery(row.id, source) : undefined}
      />
    </div>
  );
}
