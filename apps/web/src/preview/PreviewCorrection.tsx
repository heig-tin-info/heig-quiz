/**
 * The end of a teacher's evaluation preview: the full correction, whatever
 * the feedback policy of the evaluation says (issue #75). It is the student's
 * feedback page (`student/Feedback.tsx`) with every door open — the answer,
 * the key, the explanation and the grader's own breakdown, through the same
 * `QuestionReviewHost` — so what the teacher reads is what a student would
 * read under the most generous policy.
 *
 * The four decisions follow the feedback page: one reading column, the grade
 * and the points as two `Stat`s, one card per question. The one accent is
 * "Restart the preview" — the thing a teacher checking their quiz does next;
 * the way back to the evaluation is secondary.
 */
import { AlertTriangle, ArrowLeft, Eye, RotateCcw } from "lucide-react";

import type { PreviewCorrection, PreviewItemStatus } from "@quiz/contracts";
import { formatGrade, formatPoints } from "@quiz/domain";

import { useT, type Dict } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { QuestionReviewHost } from "../questionTypes";
import { Alert, Badge, Button, Card, NotePanel, Stat } from "../ui";

/** Why an item carries no points, in the teacher's words. */
const STATUS_LABEL: Record<Exclude<PreviewItemStatus, "graded">, keyof Dict> = {
  runner_unavailable: "preview.status.runner_unavailable",
  llm_unavailable: "preview.status.llm_unavailable",
  answer_invalid: "preview.status.answer_invalid",
  grader_error: "preview.status.grader_error",
  no_key: "preview.status.no_key",
};

export function PreviewCorrectionView({
  title,
  correction,
  restarting,
  onRestart,
  onBack,
}: {
  title: string;
  correction: PreviewCorrection;
  restarting: boolean;
  onRestart: () => void;
  onBack: () => void;
}) {
  const t = useT();
  return (
    <main className="mx-auto w-full max-w-180 space-y-8 px-4 py-8 sm:px-6">
      <header className="space-y-4">
        <div>
          <p className="text-[13px] text-fg-muted">{title}</p>
          <h1 className="mt-1 text-[28px] font-bold leading-tight tracking-[-0.02em]">
            {t("preview.correction.title")}
          </h1>
        </div>
        <Alert icon={Eye}>{t("preview.correction.banner")}</Alert>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={onRestart} disabled={restarting}>
            <RotateCcw /> {t("preview.restart")}
          </Button>
          <Button variant="secondary" onClick={onBack}>
            <ArrowLeft /> {t("preview.backToEvaluation")}
          </Button>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={t("feedback.grade")} value={formatGrade(correction.grade)} />
        <Stat
          label={t("feedback.points")}
          value={`${formatPoints(correction.points)} / ${correction.totalPoints}`}
        />
      </div>

      {correction.ungraded > 0 ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("preview.ungraded.title")}>
          {correction.ungraded === 1
            ? t("preview.ungraded.bodyOne")
            : t("preview.ungraded.body", { n: correction.ungraded })}
        </Alert>
      ) : null}

      <div className="space-y-5">
        {correction.items.map((item) => (
          <Card key={item.itemId} className="space-y-4 p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-base font-bold tracking-tight">
                {t("feedback.question", { n: item.position + 1 })}
              </h2>
              <span className="flex-1" />
              {item.status === "graded" && item.points !== null ? (
                <span className="text-[15px] font-semibold tabular-nums">
                  {formatPoints(item.points)} / {item.maxPoints}
                </span>
              ) : (
                <Badge tone={item.status === "no_key" ? "zinc" : "amber"}>
                  {t(STATUS_LABEL[item.status as Exclude<PreviewItemStatus, "graded">])}
                </Badge>
              )}
            </div>

            <QuestionReviewHost
              t={t}
              type={item.type}
              student={item.student}
              answer={item.answer}
              solution={item.solution}
              details={item.details}
              points={item.points}
              maxPoints={item.maxPoints}
              audience="student"
            />

            {item.explanation ? (
              <NotePanel eyebrow={t("feedback.explanation")}>
                <MarkdownView size="sm" source={item.explanation} />
              </NotePanel>
            ) : null}
          </Card>
        ))}
      </div>
    </main>
  );
}
