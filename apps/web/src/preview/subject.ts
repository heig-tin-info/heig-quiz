/*
 * What a full preview walks: an evaluation of a classroom (issue #75), or a
 * template of a course (F-EVAL-25). The two are the same row in the database
 * and the same walk on the screen, under parallel routes that are never
 * shared (ADR-031, addendum c): `/evaluations/:id/preview/...` for one,
 * `/templates/:id/preview/...` for the other.
 *
 * So the preview page, its session and its question tools are parametrized
 * by DATA — which base URL, which page to go back to, which words name the
 * paper — like the editor's blocks by `editTarget.ts`, and never ask "is
 * this a template?" at a site of their own.
 */
import type { Dict } from "../i18n";
import type { QuestionOrigin, Route } from "../router";

export type PreviewKind = "evaluation" | "template";

/** The strings that name the paper; every other one of the preview is shared. */
interface PreviewCopy {
  readonly back: keyof Dict;
  readonly notFound: keyof Dict;
  readonly changedTitle: keyof Dict;
  readonly changedBody: keyof Dict;
  readonly newVersionBody: keyof Dict;
  readonly emptyTitle: keyof Dict;
  readonly emptyBody: keyof Dict;
}

export interface PreviewSubject {
  readonly kind: PreviewKind;
  readonly id: string;
  /** The API path of the paper: its detail, its item versions, its `/preview` routes. */
  readonly api: string;
  /** Where the walk leads back to: the evaluation's configuration, the template's editor. */
  readonly back: Route;
  /** How the question editor opened from the walk names it, to close its tab on the way back. */
  readonly questionFrom: Pick<QuestionOrigin, "fromPreview" | "fromTemplatePreview">;
  readonly copy: PreviewCopy;
}

export function previewSubject(kind: PreviewKind, id: string): PreviewSubject {
  return kind === "evaluation"
    ? {
        kind,
        id,
        api: `/app/api/evaluations/${id}`,
        back: { view: "evaluation", id },
        questionFrom: { fromPreview: id },
        copy: {
          back: "preview.backToEvaluation",
          notFound: "preview.notFound",
          changedTitle: "preview.changed.title",
          changedBody: "preview.changed.body",
          newVersionBody: "preview.newVersion.body",
          emptyTitle: "preview.empty.title",
          emptyBody: "preview.empty.body",
        },
      }
    : {
        kind,
        id,
        api: `/app/api/templates/${id}`,
        back: { view: "template", id },
        questionFrom: { fromTemplatePreview: id },
        copy: {
          back: "preview.template.back",
          notFound: "templates.notFound",
          changedTitle: "preview.template.changed.title",
          changedBody: "preview.template.changed.body",
          newVersionBody: "preview.template.newVersion.body",
          emptyTitle: "preview.template.empty.title",
          emptyBody: "preview.template.empty.body",
        },
      };
}
