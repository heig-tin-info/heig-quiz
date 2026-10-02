import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

import type { PreviewResult } from "@quiz/contracts";

import { apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { PlayedQuestion } from "./PreviewedQuestion";
import { PlayerShell } from "../student/PlayerShell";
import { isWide } from "../student/QuestionHost";
import { Alert, Button, Card, Skeleton } from "../ui";
import { questionPreviewQuery, questionSolutionQuery } from "./previewQuery";

/**
 * "See what the student sees" for ONE question (docs/spec/08 §8.2), in a page
 * of its own — `/questions/:id/preview`, opened by the editor in a new tab.
 *
 * Why a page and not the panel it used to be: the panel lived at the bottom
 * of the editor's right-hand column, under "Properties", on the Edit tab
 * only. A teacher who pressed "Student preview" from the Try tab saw nothing
 * happen at all, and one who pressed it from the Edit tab saw nothing happen
 * either, because the thing it opened was below the fold. A preview that has
 * to be scrolled to is not a preview; a tab that shows the real player is.
 *
 * What it is NOT: an attempt. Nothing is created, nothing is saved, nothing
 * is graded. The server answers `POST /questions/:id/preview` with the view
 * that came out of the question type's `toStudent` (invariant 4) at seed 0
 * and without shuffling, exactly what the panel used to read — so the teacher
 * sees the student's payload. The answer key comes only on "Show answers"
 * (mcq and cloze), from a request of its own made on the click.
 *
 * The four decisions, and they are the player's, on purpose: the point of the
 * screen is that it looks like the exam.
 *   - Type: the statement at reading size, the chrome at 13 px.
 *   - Color: no accent at all, and no banner either: the header's subtitle
 *     says that nothing is kept, so the question is the first thing under
 *     the bar, as in the exam. "Show answers" is secondary: it changes
 *     nothing but this tab.
 *   - Space: the player's column (760 px, or the room a wide type asks
 *     for), the player's spacing.
 *   - Finish: the player's hairline bar over the warm canvas, no shadow.
 *
 * The teacher may type in the fields — a preview one cannot touch does not
 * answer "does this question work?" — and the answer lives in this component
 * and dies with the tab.
 */
export function StudentPreviewPage({ id }: { id: string }) {
  const t = useT();
  const preview = useQuery<PreviewResult>({
    ...questionPreviewQuery(id, "draft"),
    // Seed 0 and nothing stored: the same view on every open.
    staleTime: Infinity,
  });
  return (
    // No deadline, so no countdown: the shell's default clock is stable, and
    // nothing here hands it a new value on every render (FF-26).
    <PlayerShell
      title={t("question.preview.pageTitle")}
      subtitle={t("question.preview.pageSubtitle")}
      deadlineAt={null}
      wide={preview.data !== undefined && isWide(preview.data.type)}
      headerAction={
        // The one thing this page does besides being read. It is secondary:
        // a preview has no primary action (DESIGN.md, one primary action).
        <Button variant="secondary" size="sm" onClick={() => window.close()}>
          {t("common.close")}
        </Button>
      }
    >
      {preview.isLoading ? (
        <Card className="space-y-3 p-5 sm:p-6">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : preview.isError || !preview.data ? (
        /*
         * The expected failure, not an exceptional one: a question created a
         * minute ago has an empty draft, which does not validate (decision
         * D16), and the server answers `422 config_invalid`. Saying "finish
         * the question first" is the honest answer; a red page would not be.
         */
        <Alert tone="warning" icon={AlertTriangle} title={t("question.previewFailed")}>
          {apiErrorMessage(preview.error, t("question.preview.incomplete"))}
        </Alert>
      ) : (
        // The player's own card and host (`QuestionHost`), which lends every
        // type its strings and `MarkdownView`: a second mounting path would be
        // a second rendering, and a preview that renders differently from the
        // player previews nothing.
        <PlayedQuestion
          view={{ type: preview.data.type, student: preview.data.student, points: preview.data.itemPoints }}
          solution={questionSolutionQuery(id, "draft")}
          label={t("player.question", { n: 1 })}
        />
      )}
    </PlayerShell>
  );
}
