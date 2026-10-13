import { Dices } from "lucide-react";
import { Suspense, type ComponentType, type ReactNode } from "react";

import type { AnswerDistributionEntry, ByQuestion } from "@quiz/contracts";
import type { KeyProps } from "@quiz/core/client";
import { displayedRate } from "@quiz/domain";
import type { ClozeTextRenderer } from "@quiz/qt-cloze/client";
import { answeredCount, CORRECTION_SCALE, CorrectionCount, type Density } from "@quiz/ui";

import { useT, type TFunction } from "../i18n";
import { ClozeMarkdownText } from "../markdown/ClozeMarkdownText";
import { MarkdownView } from "../markdown/MarkdownView";
import { promptOf, PROJECTION_ROW_CAP } from "../poll/pollTally";
import { keyStrings, questionType, typeLabel } from "../questionTypes";
import { BAR_TONES, cx, NotePanel, SegmentedBar, type BarPart, type BarTone } from "../ui";

/**
 * One question of the correction projection (F-RES-03, ADR-033): who got it
 * right, the statement, and what the class answered — the key and the
 * verdicts only once `revealed`, the class's ticks before it.
 *
 * Everything drawn here is the server's (`ByQuestion`): the outcomes and the
 * verdict of every answer group come from the validated gradings, and the
 * screen recomputes no grade.
 *
 * The answer key is the type's own when it has one (`QuestionTypeClient.Key`,
 * ADR-109): an mcq's choices, a cloze's blanks in its text, a short or math
 * answer's expected answers, a categorize board, a program, an essay's model
 * answer. This host draws the rest — the head, and the generic statement,
 * test cases and answer groups it lends the key.
 *
 * The sizes come from `SCALE`: `wall` is the projection's own `clamp()` scale
 * (DESIGN.md, "Correction projection"), `page` the same pieces at the scale
 * of the Results "Questions" tab, which draws them too.
 */

/**
 * The sizes of the pieces this host draws, per density: the shared ones
 * (`CORRECTION_SCALE`, `@quiz/ui`) and those only the host draws. A size
 * only one type's key draws lives in that type's package.
 */
const SCALE = {
  wall: {
    ...CORRECTION_SCALE.wall,
    prompt: "max-w-[64ch] text-balance text-[clamp(24px,2.7vw,40px)] font-bold leading-tight tracking-[-0.025em]",
    answerRow: "grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_3rem] gap-[clamp(12px,2vw,24px)] py-2.5",
    caseRow: "grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 pb-3 pt-2.5",
    caseLabel: "text-[clamp(15px,1.3vw,19px)]",
  },
  page: {
    ...CORRECTION_SCALE.page,
    prompt: "text-[15px] font-medium",
    answerRow: "grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_2.5rem] gap-4 py-2",
    caseRow: "grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 py-2",
    caseLabel: "text-[13px]",
  },
} as const satisfies Record<Density, Record<string, string>>;

/** A group's verdict as a tone: right, wrong, or both at once. */
const verdictTone = (entry: Pick<AnswerDistributionEntry, "correct">): BarTone =>
  entry.correct === true ? "success" : entry.correct === false ? "danger" : "muted";

/** The head of a question: its number, the class in one bar, the success rate. */
function Head({ q, number }: { q: ByQuestion; number: number }) {
  const t = useT();
  const parts: BarPart[] = [
    { tone: "success", value: q.outcomes.correct, label: t("correction.outcome.correct") },
    { tone: "partial", value: q.outcomes.partial, label: t("correction.outcome.partial") },
    { tone: "danger", value: q.outcomes.wrong, label: t("correction.outcome.wrong") },
    { tone: "warning", value: q.outcomes.blank, label: t("correction.outcome.blank") },
  ];
  const n = answeredCount(q);
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-[clamp(16px,2vw,28px)] max-md:grid-cols-[1fr_auto]">
      <p className="flex flex-col whitespace-nowrap text-[clamp(13px,1.1vw,16px)] font-semibold text-fg-muted">
        <span className="text-[clamp(22px,2vw,30px)] font-extrabold tracking-[-0.02em] text-fg">
          {t("correction.question", { n: number })}
        </span>
        {/* The type and the weight — never the internal name (invariant 4). */}
        {typeLabel(t, q.item.type)} ·{" "}
        {q.item.points === 1 ? t("correction.points.one") : t("correction.points", { n: q.item.points })}
      </p>
      <div className="flex flex-col gap-2.5 max-md:col-span-2 max-md:row-start-2">
        <SegmentedBar className="h-2.5" parts={parts} />
        {/* The same list as the bar; partial only when someone earned it. */}
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fg-muted" aria-hidden>
          {parts
            .filter((p) => p.tone !== "partial" || p.value > 0)
            .map((p) => (
              <span key={p.tone} className="inline-flex items-center gap-1.5">
                <span className={cx("size-2.5 rounded-full", BAR_TONES[p.tone])} />
                {p.label}
              </span>
            ))}
        </p>
      </div>
      <p className="text-right leading-none">
        <span className="font-mono text-[clamp(34px,4vw,60px)] font-semibold tracking-[-0.03em] tabular-nums">
          {q.successRate === null ? (
            "—"
          ) : (
            <>
              {/* Clamped for display (ADR-026): a mean can fall below 0. */}
              {Math.round(displayedRate(q.successRate) * 100)}
              <span className="ml-[0.08em] text-[0.5em] text-fg-muted">%</span>
            </>
          )}
        </span>
        <span className="mt-1.5 block text-[13px] font-medium text-fg-muted">
          {t("correction.success")}
        </span>
        <span className="mt-0.5 block text-xs text-fg-faint">
          {n === 1 ? t("correction.copies.one") : t("correction.copies", { n })}
        </span>
      </p>
    </div>
  );
}

/**
 * What the class wrote, grouped: a short answer's texts, a code image's
 * accuracy buckets — whatever answer groups the type counts. One bar per
 * group, all measured against the largest, and the count beside it (the
 * figure IS the row's content here, not a reading of a bar). Nothing when
 * there is nothing to list; whether a row of blanks alone is worth listing is
 * the caller's (with no key beside it, it is not).
 */
export function AnswerRows({ q, revealed, density }: { q: ByQuestion; revealed: boolean; density: Density }) {
  const t = useT();
  const s = SCALE[density];
  const blank = q.outcomes.blank;
  const rows = q.distribution.slice(0, PROJECTION_ROW_CAP);
  // A parameterized question groups nothing by what was written (ADR-056
  // §9), and its verdicts — the blanks among them — are the head's bar: a
  // list under it would say the same thing twice.
  const listed = !q.parameterized && (rows.length > 0 || blank > 0);
  const overflow = q.distribution.length - rows.length;
  const top = Math.max(1, blank, ...rows.map((r) => r.count));
  if (!listed && overflow <= 0) return null;
  const row = (key: string, text: ReactNode, count: number, tone: BarTone, textTone: string) => (
    <li key={key} className={cx("grid items-center border-b border-line px-1 max-md:grid-cols-[1fr_3rem]", s.answerRow)}>
      <span className={cx("truncate font-medium", s.answer, textTone)}>{text}</span>
      <span className="max-md:col-span-2 max-md:row-start-2">
        <SegmentedBar parts={[{ tone: revealed ? tone : "muted", value: count }]} total={top} />
      </span>
      <CorrectionCount density={density}>{count}</CorrectionCount>
    </li>
  );
  return (
    <div className="flex flex-col gap-3">
      {listed ? (
        <ul className="flex flex-col">
          {rows.map((entry) =>
            row(
              entry.key,
              entry.label === "" ? t("correction.outcome.blank") : entry.label,
              entry.count,
              verdictTone(entry),
              cx(
                "font-mono",
                revealed && entry.correct === true && "text-success",
                revealed && entry.correct === false && "text-danger",
              ),
            ),
          )}
          {blank > 0
            ? row("blank", t("correction.outcome.blank"), blank, "warning", "italic text-fg-faint")
            : null}
        </ul>
      ) : null}
      {overflow > 0 ? (
        <p className={cx("text-fg-faint", s.caption)}>
          {t(overflow === 1 ? "poll.moreAnswers.one" : "poll.moreAnswers", { n: overflow })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * How the class fared on each test case of a program (`casePassRate`, filled
 * by `code` and `blocks`): its passes out of its runs beside the bar, the
 * papers it never ran on as "not run". `null` when the type counts no case.
 * A program's key sets it beside its code (`KeyProps.cases`).
 */
function caseBars(q: ByQuestion, density: Density, t: TFunction): ReactNode {
  if (q.casePassRate.length === 0) return null;
  const s = SCALE[density];
  const n = answeredCount(q);
  return (
    <ul className="flex flex-col" aria-label={t("results.byQuestion.cases")}>
      {q.casePassRate.map((c) => (
        <li key={c.name} className={cx("grid items-center border-b border-line px-1", s.caseRow)}>
          {/* `label`, never `name`: a hidden case reads as a student
              reads it unless the policy shows hidden names (ADR-033). */}
          <span className={cx("font-semibold", s.caseLabel)}>{c.label}</span>
          <CorrectionCount density={density}>
            {t("results.byQuestion.casePass", { passed: c.passed, total: c.total })}
          </CorrectionCount>
          <span className="col-span-2">
            <SegmentedBar
              parts={[
                { tone: "success", label: t("correction.case.passed"), value: c.passed },
                { tone: "danger", label: t("correction.case.failed"), value: c.total - c.passed },
                { tone: "warning", label: t("correction.case.notRun"), value: n - c.total },
              ]}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The test cases of a type that draws no key of its own (`blocks`): in the
 * program's columns, where a key would set its code beside them.
 */
export function CorrectionCases({ q, density }: { q: ByQuestion; density: Density }) {
  const t = useT();
  const cases = caseBars(q, density, t);
  return cases === null ? null : <div className={SCALE[density].program}>{cases}</div>;
}

/**
 * Every prop a type's `Key` accepts: the contract's, and what a concrete key
 * adds (its `strings`, a cloze's `renderText`), which the registry's erased
 * type cannot show — the cast `QuestionReviewHost` makes for `Review`.
 */
type KeyHostProps = KeyProps<unknown, unknown> & {
  strings?: unknown;
  /** `cloze`: its text with the blanks in place (`ClozeMarkdownText`). */
  renderText?: ClozeTextRenderer;
};

/** The type's answer key, or `undefined` for a type that has none. */
const keyOf = (type: string) => questionType(type)?.Key as ComponentType<KeyHostProps> | undefined;

/** The type draws its own answer key (`QuestionTypeClient.Key`). */
export const drawsKey = (type: string): boolean => keyOf(type) !== undefined;

/** The app's sanitised markdown, inline: what a key's choice, card or formula is set in. */
const renderInline = (source: string) => <MarkdownView source={source} inline />;

/** The app's sanitised markdown as blocks, per density: an explanation, an essay's model answer. */
const RENDER_BLOCK = {
  wall: (source: string) => <MarkdownView source={source} className="text-[clamp(15px,1.3vw,19px)]" />,
  page: (source: string) => <MarkdownView size="sm" source={source} />,
} as const satisfies Record<Density, (source: string) => ReactNode>;

/**
 * The statement and the key of a question: the type's `Key`, given the
 * prompt, the test cases and the answer groups to place, replace or omit —
 * or, for a type without one, the prompt, the test cases and the answer
 * groups.
 *
 * A parameterized question's statement is the instance of its example
 * values, and says so above it: no student read these very numbers (ADR-056
 * §9). `after` follows the statement — on the wall, the explanation.
 */
export function CorrectionKey({
  q,
  revealed,
  density,
  after = null,
}: {
  q: ByQuestion;
  revealed: boolean;
  density: Density;
  after?: ReactNode;
}) {
  const t = useT();
  const s = SCALE[density];
  const Key = keyOf(q.item.type);
  const strings = keyStrings[q.item.type as keyof typeof keyStrings];
  const statement = (body: ReactNode) => (
    <>
      {body === null || !q.parameterized ? (
        body
      ) : (
        <div className="flex flex-col gap-2">
          <p className={cx("flex items-center gap-1.5 font-medium text-fg-muted", s.caption)}>
            <Dices className="size-[1.1em] shrink-0" aria-hidden />
            {t("correction.param.example")}
          </p>
          {body}
        </div>
      )}
      {after}
    </>
  );
  const text = promptOf(q);
  const prompt = statement(
    text ? (
      <div className={s.prompt}>
        <MarkdownView source={text} inline />
      </div>
    ) : null,
  );
  const rows = <AnswerRows q={q} revealed={revealed} density={density} />;
  if (Key === undefined) {
    return (
      <>
        {prompt}
        <CorrectionCases q={q} density={density} />
        {/* The blanks alone say nothing the head does not: with no key beside
            them, a row of them needs groups. */}
        {q.distribution.length > 0 ? rows : null}
      </>
    );
  }
  return (
    // The statement stands while the key's chunk arrives: what is above
    // never moves, the key appears below it.
    <Suspense fallback={prompt}>
      <Key
        student={q.student}
        solution={q.solution}
        revealed={revealed}
        density={density}
        // `ByQuestion` is a `KeyStats`: a change of the contract that a key
        // would not survive fails to compile here.
        stats={q}
        prompt={prompt}
        rows={rows}
        cases={caseBars(q, density, t)}
        statement={statement}
        Bar={SegmentedBar}
        renderMarkdown={renderInline}
        renderBlock={RENDER_BLOCK[density]}
        strings={strings?.(t)}
        renderText={ClozeMarkdownText}
      />
    </Suspense>
  );
}

export function CorrectionQuestion({
  q,
  number,
  revealed,
  explained,
}: {
  q: ByQuestion;
  /** From 1, as the stepper counts. */
  number: number;
  revealed: boolean;
  /** The explanation is on the wall (E), when the question has one. */
  explained: boolean;
}) {
  const t = useT();
  return (
    <>
      <Head q={q} number={number} />
      <CorrectionKey
        q={q}
        revealed={revealed}
        density="wall"
        after={
          explained && q.explanation ? (
            <NotePanel eyebrow={t("correction.explanation")}>{RENDER_BLOCK.wall(q.explanation)}</NotePanel>
          ) : null
        }
      />
    </>
  );
}
