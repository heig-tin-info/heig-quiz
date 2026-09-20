import { ListChecks } from "lucide-react";

import type { ByQuestion } from "@quiz/contracts";

import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { typeLabel, QuestionReviewHost } from "../questionTypes";
import { Badge, Card, cx, EmptyState, SectionHeading } from "../ui";

const percent = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

/** The `code` key, when the payload carries one and the policy let it out. */
function referenceSolution(solution: unknown): string | null {
  const value = (solution as { referenceSolution?: unknown } | null)?.referenceSolution;
  return typeof value === "string" && value.trim() !== "" ? value : null;
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
        const top = Math.max(1, ...q.distribution.map((d) => d.count));
        return (
          <Card key={q.item.id} className="space-y-4 p-5">
            <SectionHeading
              // `position` is 0-based on the wire; every screen numbers
              // questions from 1.
              title={`${q.item.position + 1}. ${q.item.internalName}`}
              actions={
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="zinc">{typeLabel(t, q.item.type)}</Badge>
                  <Badge tone="zinc">{t("results.byQuestion.answered", { n: q.answered })}</Badge>
                  <Badge tone={(q.successRate ?? 0) >= 0.5 ? "green" : "amber"}>
                    {t("results.byQuestion.successRate")} {percent(q.successRate)}
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
              <div className="rounded-field border border-line bg-surface-2 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-faint">
                  {t("results.byQuestion.reference")}
                </p>
                <pre className="mt-1.5 overflow-x-auto font-mono text-xs leading-relaxed">
                  {referenceSolution(q.solution)}
                </pre>
              </div>
            ) : null}

            {q.explanation ? (
              <div className="rounded-field bg-surface-2 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-faint">
                  {t("results.byQuestion.explanation")}
                </p>
                <MarkdownView size="sm" className="mt-1" source={q.explanation} />
              </div>
            ) : null}

            {q.distribution.length > 0 ? (
              <div>
                <p className="text-[13px] font-medium">{t("results.byQuestion.distribution")}</p>
                <ul className="mt-2 space-y-1.5">
                  {q.distribution.map((d) => (
                    <li key={d.key} className="flex items-center gap-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate">{d.label}</span>
                      {d.correct === true ? (
                        <Badge tone="green">{t("results.byQuestion.correct")}</Badge>
                      ) : null}
                      <span className="h-2 w-32 shrink-0 overflow-hidden rounded-full bg-surface-3">
                        <span
                          className={cx(
                            "block h-full rounded-full",
                            d.correct === true ? "bg-success" : "bg-fg-muted",
                          )}
                          style={{ width: `${Math.round((d.count / top) * 100)}%` }}
                        />
                      </span>
                      <span className="w-8 shrink-0 text-right tabular-nums text-fg-muted">
                        {d.count}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : q.answered === 0 ? (
              <p className="text-[13px] text-fg-muted">{t("results.byQuestion.noAnswers")}</p>
            ) : null}

            {q.casePassRate.length > 0 ? (
              <div>
                <p className="text-[13px] font-medium">{t("results.byQuestion.cases")}</p>
                <ul className="mt-2 space-y-1.5">
                  {q.casePassRate.map((c) => (
                    <li key={c.name} className="flex items-center gap-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.name}</span>
                      <span className="h-2 w-32 shrink-0 overflow-hidden rounded-full bg-surface-3">
                        <span
                          className="block h-full rounded-full bg-fg-muted"
                          style={{
                            width: `${c.total === 0 ? 0 : Math.round((c.passed / c.total) * 100)}%`,
                          }}
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
