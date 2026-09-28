import type { UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";

import { apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { emptyAnswerOf, QuestionHost } from "../student/QuestionHost";
import { Alert, Card, Skeleton } from "../ui";

/** One question as the server built it for a student (`studentView`, invariant 4). */
export interface StudentQuestion {
  type: string;
  student: unknown;
  points: number;
}

/**
 * The body of a teacher's preview of ONE question: its points, then the
 * student's rendering through the player's own `QuestionHost` — never a
 * second rendering. Shared by the preview of an item of the evaluation
 * (`ItemPreviewSheet`) and by the picker's reading pane (`AddQuestionsSheet`).
 *
 * The teacher may type in the fields — a preview one cannot touch does not
 * answer "does this read right?" — and the answer lives here and dies with
 * the component. Nothing is saved, run or graded.
 */
export function PreviewedQuestion({ query }: { query: UseQueryResult<StudentQuestion> }) {
  const t = useT();
  if (query.isLoading) {
    return (
      <Card className="space-y-3 p-5 sm:p-6">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }
  if (query.isError || !query.data) {
    return (
      <Alert tone="warning" icon={AlertTriangle} title={t("question.previewFailed")}>
        {apiErrorMessage(query.error, t("error.server"))}
      </Alert>
    );
  }
  return <Played view={query.data} />;
}

function Played({ view }: { view: StudentQuestion }) {
  const t = useT();
  const [answer, setAnswer] = useState<unknown>(() => emptyAnswerOf(view.type, view.student));
  useEffect(() => setAnswer(emptyAnswerOf(view.type, view.student)), [view]);
  return (
    <>
      <p className="text-right text-[13px] text-fg-muted">
        {view.points === 1 ? t("player.point") : t("player.points", { n: view.points })}
      </p>
      <Card className="p-5 sm:p-6">
        <QuestionHost
          type={view.type}
          student={view.student}
          answer={answer}
          onChange={setAnswer}
          readOnly={false}
        />
      </Card>
    </>
  );
}
