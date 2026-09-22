import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Eye } from "lucide-react";
import { useState } from "react";

import type { PreviewResult } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { PlayerShell } from "../student/PlayerShell";
import { QuestionHost } from "../student/QuestionHost";
import { Alert, Button, Card, Skeleton } from "../ui";
import { emptyAnswerOf } from "../questionTypes";

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
 * sees the student's payload, never the answer key.
 *
 * The four decisions, and they are the player's, on purpose: the point of the
 * screen is that it looks like the exam.
 *   - Type: the statement at reading size, the chrome at 13 px.
 *   - Color: no accent at all. The banner is the calm `neutral` alert; there
 *     is nothing here to click that changes anything.
 *   - Space: the player's 760 px column, the player's spacing.
 *   - Finish: the player's hairline bar over the warm canvas, no shadow.
 *
 * The teacher may type in the fields — a preview one cannot touch does not
 * answer "does this question work?" — and the answer lives in this component
 * and dies with the tab.
 */
export function StudentPreviewPage({ id }: { id: string }) {
  const t = useT();
  const preview = useQuery<PreviewResult>({
    queryKey: ["question", id, "preview", "draft"],
    queryFn: () =>
      api(`/app/api/questions/${id}/preview`, {
        method: "POST",
        body: JSON.stringify({ source: "draft" }),
      }),
    // Seed 0 and nothing stored: the same view on every open.
    staleTime: Infinity,
  });

  return (
    <PlayerShell
      title={t("question.preview.pageTitle")}
      subtitle={t("question.preview.pageSubtitle")}
      deadlineAt={null}
      now={Date.now()}
      banner={
        <Alert icon={Eye} title={t("question.preview.banner")}>
          {t("question.preview.bannerBody")}
        </Alert>
      }
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
        <PreviewedQuestion type={preview.data.type} student={preview.data.student} />
      )}
    </PlayerShell>
  );
}

/**
 * The question itself, in the player's own card and through the player's own
 * host — the SAME `QuestionHost` the student sits behind, which is what lends
 * every type its translated strings and `MarkdownView` (the one renderer of
 * untrusted content). A second mounting path is a second rendering, and a
 * preview that renders differently from the player previews nothing.
 */
function PreviewedQuestion({ type, student }: { type: string; student: unknown }) {
  const t = useT();
  const [answer, setAnswer] = useState<unknown>(() => emptyAnswerOf(type, student));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-[13px] font-semibold uppercase tracking-wide text-fg-muted">
          {t("player.question", { n: 1 })}
        </p>
      </div>
      <Card className="p-5 sm:p-6">
        <QuestionHost
          type={type}
          student={student}
          answer={answer}
          onChange={setAnswer}
          readOnly={false}
        />
      </Card>
    </>
  );
}
