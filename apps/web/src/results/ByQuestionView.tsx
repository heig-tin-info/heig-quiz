import { ListChecks } from "lucide-react";

import type { ByQuestion } from "@quiz/contracts";
import { displayedRate } from "@quiz/domain";

import { ApiError } from "../api";
import { useI18n, useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { typeLabel, QuestionReviewHost } from "../questionTypes";
import { Badge, Card, EmptyState, NotePanel, percent, SectionHeading } from "../ui";
import {
  CorrectionAnswers,
  CorrectionProgram,
  CorrectionStatement,
  drawsKey,
} from "./CorrectionQuestion";
import { questionAnchor, QuestionSummary } from "./QuestionSummary";

/**
 * The per-question view refused because the evaluation is not over yet
 * (`409 not_over`, ADR-033). Its message is the server's, in English: a
 * screen says `results.notOver` instead.
 */
export const isNotOver = (error: unknown): boolean =>
  error instanceof ApiError && (error.body as { error?: string } | null)?.error === "not_over";

/**
 * F-RES-03: the linear walk through the questions, for the correction in
 * front of the class. Statement, key and distribution, explanation, success
 * rate — one card per question, scrolled from top to bottom, under the
 * class's distribution over all of them (`QuestionSummary`).
 *
 * The pieces are the correction projection's, at the page's density and
 * always revealed: this is the teacher's reading of the projection. An mcq,
 * a cloze and a short answer are drawn by them whole; any other type keeps
 * its own `Review` for the statement and the key — with no answer and no
 * grading details, the question the way it was asked — and gets the
 * projection's answer groups, program and test cases below it.
 */
export function ByQuestionView({ questions }: { questions: ByQuestion[] }) {
  const t = useT();
  const { locale } = useI18n();
  if (questions.length === 0) {
    return (
      <Card>
        <EmptyState icon={ListChecks} title={t("results.byQuestion.empty.title")}>
          {t("results.byQuestion.empty.body")}
        </EmptyState>
      </Card>
    );
  }
  return (
    <div className="space-y-5">
      <QuestionSummary questions={questions} />
      {questions.map((q) => {
        const answered = q.outcomes.correct + q.outcomes.partial + q.outcomes.wrong;
        return (
          <Card key={q.item.id} id={questionAnchor(q.item.id)} className="scroll-mt-6 space-y-4 p-5">
            <SectionHeading
              // `position` is 0-based on the wire; every screen numbers
              // questions from 1.
              title={`${q.item.position + 1}. ${q.item.internalName}`}
              actions={
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="zinc">{typeLabel(t, q.item.type)}</Badge>
                  <Badge tone="zinc">{t("results.byQuestion.answered", { n: answered })}</Badge>
                  <Badge tone={(q.successRate ?? 0) >= 0.5 ? "green" : "amber"}>
                    {t("results.byQuestion.successRate")}{" "}
                    {/* Clamped for display (ADR-026): negative marking can push a mean below 0. */}
                    {q.successRate === null ? "—" : percent(displayedRate(q.successRate), locale)}
                  </Badge>
                </div>
              }
            />

            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-faint">
                {t("results.byQuestion.key")}
              </p>
              {drawsKey(q.item.type) ? (
                <CorrectionStatement q={q} revealed density="page" />
              ) : (
                // Drawn by the type itself. There is no answer here — this is
                // the question in front of the class, not one student's copy —
                // so the type's own "no answer" line is the truth, and the
                // label says whose reading it is.
                <QuestionReviewHost
                  t={t}
                  type={q.item.type}
                  student={q.student}
                  answer={null}
                  solution={q.solution}
                  details={null}
                  points={null}
                  maxPoints={q.item.points}
                  audience="teacher"
                />
              )}
              <CorrectionAnswers q={q} revealed density="page" />
            </div>

            {/* A `code` question keeps its key in `solution.referenceSolution`,
                and the type's review only prints it beside a graded answer —
                which this view has none of. F-RES-03 asks for the answer, so
                the program draws it, with the test cases. */}
            <CorrectionProgram q={q} revealed density="page" />

            {q.explanation ? (
              <NotePanel eyebrow={t("results.byQuestion.explanation")}>
                <MarkdownView size="sm" source={q.explanation} />
              </NotePanel>
            ) : null}

            {answered === 0 ? (
              <p className="text-[13px] text-fg-muted">{t("results.byQuestion.noAnswers")}</p>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
