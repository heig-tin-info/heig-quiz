/*
 * What a full preview walks: an evaluation of a classroom (issue #75), or a
 * template of a course (F-EVAL-25). The two are the same row in the database
 * and the same walk on the screen, under parallel routes that are never
 * shared (ADR-031, addendum c): `/evaluations/:id/preview/...` for one,
 * `/templates/:id/preview/...` for the other.
 *
 * So the preview page, its session and its question tools are parametrized
 * by DATA — where the paper lives (`PaperHome`, shared with the editor's
 * `editTarget.ts`), which page to go back to, how to read its detail — and
 * never ask "is this a template?" at a site of their own.
 */
import type { ItemRow } from "@quiz/contracts";
import { itemListLock, type ItemListLock } from "@quiz/domain";

import { useEvaluation, useTemplate } from "../evaluation/api";
import { evaluationHome, templateHome, type PaperHome } from "../evaluation/editTarget";
import type { Dict } from "../i18n";
import type { QuestionOrigin, Route } from "../router";

export type PreviewKind = "evaluation" | "template";

/** What the walk's tools read of the paper's detail, whichever kind it is. */
export interface Paper {
  items: readonly ItemRow[];
  editableQuestionIds: readonly string[];
  /** Why its item list is frozen, or null: a template never is (no attempt, never opened). */
  lock: ItemListLock | null;
  /** Its course: the staff routes its documents are read from in the walk (ADR-144 §7). */
  courseId: string;
}

export interface PreviewSubject extends PaperHome {
  /** `<base>/preview`: the start, and `/run`, `/simulate`, `/grade` under it. */
  readonly preview: string;
  /** Where the walk leads back to: the evaluation's configuration, the template's editor. */
  readonly back: Route;
  /** How the question editor opened from the walk names it, to close its tab on the way back. */
  readonly questionFrom: Pick<QuestionOrigin, "fromPreview" | "fromTemplatePreview">;
  /** The two strings that name the paper; every other one of the preview is shared. */
  readonly copy: { readonly back: keyof Dict; readonly notFound: keyof Dict };
  /** The paper's detail, from the query its editor reads (a hook). */
  readonly usePaper: () => Paper | undefined;
}

const withPreview = (home: PaperHome) => ({ ...home, preview: `${home.base}/preview` });

const SUBJECTS: Record<PreviewKind, (id: string) => PreviewSubject> = {
  evaluation: (id) => ({
    ...withPreview(evaluationHome(id)),
    back: { view: "evaluation", id },
    questionFrom: { fromPreview: id },
    copy: { back: "preview.backToEvaluation", notFound: "preview.notFound" },
    usePaper: () => {
      const data = useEvaluation(id).data;
      return data && { ...data, lock: itemListLock(data.evaluation.state, data.attemptCount), courseId: data.courseId };
    },
  }),
  template: (id) => ({
    ...withPreview(templateHome(id)),
    back: { view: "template", id },
    questionFrom: { fromTemplatePreview: id },
    copy: { back: "preview.backToTemplate", notFound: "templates.notFound" },
    usePaper: () => {
      const data = useTemplate(id).data;
      return data && { ...data, lock: null, courseId: data.template.courseId };
    },
  }),
};

export const previewSubject = (kind: PreviewKind, id: string): PreviewSubject => SUBJECTS[kind](id);
