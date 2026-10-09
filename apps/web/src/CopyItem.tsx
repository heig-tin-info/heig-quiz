import type { ReactNode } from "react";

import type { StudentResultItem } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { BonusLabel } from "./BonusLabel";
import { useT } from "./i18n";
import { MarkdownView } from "./markdown/MarkdownView";
import { QuestionReviewHost } from "./questionTypes";
import { Badge, Card, NotePanel } from "./ui";

/**
 * One question of a graded copy: its number and points, the type's own
 * `Review` of the answer, then the explanation and the teacher's comment
 * when the payload holds them. The student's feedback page draws its copy
 * with it, and the teacher reads the same copy from the results — what each
 * one sees is the server's call, never this card's.
 */
export function CopyItem({
  item,
  audience,
  subtitle,
  actions,
}: {
  item: StudentResultItem;
  audience: "student" | "teacher";
  /** Beside the number: the question's internal name, for the teacher. */
  subtitle?: ReactNode;
  /** After the points: what the reader may do with this question. */
  actions?: ReactNode;
}) {
  const t = useT();
  return (
    <Card className="space-y-4 p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-bold tracking-tight">
          {/* 0-based on the wire; the player and the panel both count from 1. */}
          {t("feedback.question", { n: item.position + 1 })}
        </h2>
        {subtitle ? <span className="min-w-0 truncate text-[13px] text-fg-muted">{subtitle}</span> : null}
        {item.bonus ? <BonusLabel /> : null}
        <span className="flex-1" />
        {item.points === null ? (
          <Badge tone="zinc">{t("feedback.notGraded")}</Badge>
        ) : (
          <span className="shrink-0 text-[15px] font-semibold tabular-nums">
            {formatPoints(item.points)} / {item.maxPoints}
          </span>
        )}
        {actions}
      </div>

      <QuestionReviewHost
        type={item.type}
        student={item.student}
        answer={item.answer}
        solution={item.solution}
        details={item.details}
        points={item.points}
        maxPoints={item.maxPoints}
        audience={audience}
      />

      {item.explanation ? (
        <NotePanel eyebrow={t("feedback.explanation")}>
          <MarkdownView size="sm" source={item.explanation} />
        </NotePanel>
      ) : null}

      {item.comment ? (
        <NotePanel eyebrow={t(audience === "teacher" ? "results.copy.comment" : "feedback.comment")} tone="outlined">
          <p className="text-sm">{item.comment}</p>
        </NotePanel>
      ) : null}
    </Card>
  );
}
