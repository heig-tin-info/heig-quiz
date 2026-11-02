import type { ItemCorrection } from "@quiz/contracts";

import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { QuestionReviewHost } from "../questionTypes";
import { Badge, NotePanel } from "../ui";
import { VERDICT_BADGE } from "../verdictBadge";

/**
 * A checked question of an exercise (ADR-124 §3), in place of its player:
 * the verdict, then the type's own `Review` — the statement, the student's
 * answer marked against the key, the points — and the explanation. The same
 * `Review` the feedback page draws a question with (`CopyItem`), and the
 * drill a card it checked (`PracticeCard`); what it may show is the server's
 * `correction`, never rebuilt here.
 *
 * A verdict still `pending` (a runner's, or an essay's at the hand-in) shows
 * the key and the explanation already, and says where the points will be.
 */
export function CheckedCorrection({
  type,
  student,
  answer,
  correction,
}: {
  type: string;
  student: unknown;
  answer: unknown;
  correction: ItemCorrection;
}) {
  const t = useT();
  const verdict = VERDICT_BADGE[correction.verdict];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={verdict.tone} icon={verdict.icon}>
          {t(verdict.label)}
        </Badge>
        {correction.verdict === "pending" ? (
          <p className="text-sm text-fg-muted">{t("player.check.pending")}</p>
        ) : null}
      </div>
      <QuestionReviewHost
        type={type}
        student={student}
        answer={answer}
        solution={correction.solution}
        details={correction.details}
        points={correction.points}
        maxPoints={correction.maxPoints}
        audience="student"
      />
      {correction.explanation ? (
        <NotePanel eyebrow={t("feedback.explanation")}>
          <MarkdownView size="sm" source={correction.explanation} />
        </NotePanel>
      ) : null}
    </div>
  );
}
