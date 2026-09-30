import { ListChecks } from "lucide-react";

import type { AnswerDistributionEntry, ByQuestion } from "@quiz/contracts";
import { displayedRate } from "@quiz/domain";

import { ApiError } from "../api";
import { useI18n, useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { choicesOf } from "../poll/pollTally";
import { typeLabel, QuestionReviewHost } from "../questionTypes";
import { Badge, Card, EmptyState, NotePanel, percent, SectionHeading, SegmentedBar, type BarTone } from "../ui";


/** The `code` key, when the payload carries one and the policy let it out. */
export function referenceSolution(solution: unknown): string | null {
  const value = (solution as { referenceSolution?: unknown } | null)?.referenceSolution;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The per-question view refused because the evaluation is not over yet
 * (`409 not_over`, ADR-033). Its message is the server's, in English: a
 * screen says `results.notOver` instead.
 */
export const isNotOver = (error: unknown): boolean =>
  error instanceof ApiError && (error.body as { error?: string } | null)?.error === "not_over";

/** A group's verdict as a tone: right, wrong, or both at once. */
export const verdictTone = (entry: Pick<AnswerDistributionEntry, "correct">): BarTone =>
  entry.correct === true ? "success" : entry.correct === false ? "danger" : "muted";

/** The groups as rows: an mcq's choices by their letter and text, the rest as written. */
function distributionRows(q: ByQuestion, blank: string) {
  if (q.item.type === "mcq") {
    const counts = new Map(q.distribution.map((d) => [d.key, d.count]));
    return choicesOf(q).map((c) => ({
      key: String(c.id),
      label: `${c.letter}. ${c.text}`,
      count: counts.get(String(c.id)) ?? 0,
      tone: (c.correct ? "success" : "muted") as BarTone,
      correct: c.correct,
    }));
  }
  return q.distribution.map((d) => ({
    key: d.key,
    // A cloze group says which blank it answers, counted from 1.
    label: `${d.part === null ? "" : `${d.part + 1}: `}${d.label === "" ? blank : d.label}`,
    count: d.count,
    tone: verdictTone(d),
    correct: d.correct === true,
  }));
}

/**
 * F-RES-03: the linear walk through the questions, for the correction in
 * front of the class. Statement, key, explanation, distribution, success
 * rate — in that order, one card per question, scrolled from top to bottom.
 *
 * The statement and the key are drawn by the question type's own `Review`,
 * with no answer and no grading details: it is the same component the
 * student will read, which is the point — the class sees the question the
 * way it was asked.
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
      {questions.map((q) => {
        const rows = distributionRows(q, t("results.byQuestion.blank"));
        const top = Math.max(1, ...rows.map((d) => d.count));
        const answered = q.outcomes.correct + q.outcomes.partial + q.outcomes.wrong;
        return (
          <Card key={q.item.id} className="space-y-4 p-5">
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

            {/* The statement and the key, drawn by the type itself. There is
                no answer here — this is the question in front of the class,
                not one student's copy — so the type's own "no answer" line
                is the truth, and the label says whose reading it is. */}
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-faint">
                {t("results.byQuestion.key")}
              </p>
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
            </div>

            {/* A `code` question keeps its key in `solution.referenceSolution`,
                and the type's review only prints it beside a graded answer —
                which this view has none of. F-RES-03 asks for the answer, so
                the one documented field is read straight off the payload. */}
            {referenceSolution(q.solution) ? (
              <NotePanel eyebrow={t("results.byQuestion.reference")}>
                {/* A focusable scroll region: this block runs past the
                    screen edge on a phone and a keyboard cannot reach into a
                    container that holds nothing focusable (W10). */}
                <pre
                  tabIndex={0}
                  role="region"
                  aria-label={t("results.byQuestion.reference")}
                  className="overflow-x-auto font-mono text-xs leading-relaxed"
                >
                  {referenceSolution(q.solution)}
                </pre>
              </NotePanel>
            ) : null}

            {q.explanation ? (
              <NotePanel eyebrow={t("results.byQuestion.explanation")}>
                <MarkdownView size="sm" source={q.explanation} />
              </NotePanel>
            ) : null}

            {rows.length > 0 ? (
              <div>
                <p className="text-[13px] font-medium">{t("results.byQuestion.distribution")}</p>
                <ul className="mt-2 space-y-1.5">
                  {rows.map((d) => (
                    <li key={d.key} className="flex items-center gap-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate">{d.label}</span>
                      {d.correct ? <Badge tone="green">{t("results.byQuestion.correct")}</Badge> : null}
                      <span className="w-32 shrink-0">
                        <SegmentedBar parts={[{ tone: d.tone, value: d.count }]} total={top} />
                      </span>
                      <span className="w-8 shrink-0 text-right tabular-nums text-fg-muted">
                        {d.count}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : answered === 0 ? (
              <p className="text-[13px] text-fg-muted">{t("results.byQuestion.noAnswers")}</p>
            ) : null}

            {q.casePassRate.length > 0 ? (
              <div>
                <p className="text-[13px] font-medium">{t("results.byQuestion.cases")}</p>
                <ul className="mt-2 space-y-1.5">
                  {q.casePassRate.map((c) => (
                    <li key={c.name} className="flex items-center gap-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.name}</span>
                      <span className="w-32 shrink-0">
                        <SegmentedBar
                          parts={[{ tone: "muted", value: c.passed }]}
                          total={Math.max(1, c.total)}
                        />
                      </span>
                      <span className="shrink-0 tabular-nums text-fg-muted">
                        {t("results.byQuestion.casePass", { passed: c.passed, total: c.total })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
