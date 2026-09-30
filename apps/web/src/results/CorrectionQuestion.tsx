import type { ReactNode } from "react";

import type { AnswerDistributionEntry, ByQuestion } from "@quiz/contracts";
import { displayedRate } from "@quiz/domain";
import type { ClozeSolution, ClozeStudent } from "@quiz/qt-cloze/client";

import { useT } from "../i18n";
import { ClozeMarkdownText } from "../markdown/ClozeMarkdownText";
import { MarkdownView } from "../markdown/MarkdownView";
import {
  choicesOf,
  promptOf,
  PROJECTION_ROW_CAP,
  type ShortSolutionLike,
} from "../poll/pollTally";
import { typeLabel } from "../questionTypes";
import { BAR_TONES, cx, NotePanel, SegmentedBar, type BarPart, type BarTone } from "../ui";

/**
 * One question of the correction projection (F-RES-03, ADR-033): who got it
 * right, the statement, and what the class answered — the key and the
 * verdicts only once `revealed`, the class's ticks before it.
 *
 * Everything drawn here is the server's (`ByQuestion`): the outcomes and the
 * verdict of every answer group come from the validated gradings, and the
 * screen recomputes no grade. The two joins it does make are an mcq's
 * choices with their ticks (`choicesOf`, the poll projection's), and a cloze
 * text's blanks with the groups that answer each (`part`).
 *
 * The sizes come from `SCALE`: `wall` is the projection's own `clamp()` scale
 * (DESIGN.md, "Correction projection"), `page` the same pieces at the scale
 * of the Results "Questions" tab, which draws them too.
 */

/** Every size of the pieces below, per density: the one place they differ. */
const SCALE = {
  wall: {
    prompt: "max-w-[64ch] text-balance text-[clamp(24px,2.7vw,40px)] font-bold leading-tight tracking-[-0.025em]",
    choiceRow:
      "grid-cols-[minmax(0,1fr)_minmax(180px,38%)_3rem] gap-x-[clamp(16px,2vw,28px)] py-[clamp(10px,1.4vh,16px)]",
    choiceGap: "gap-3.5",
    letter: "size-[clamp(30px,2.4vw,38px)] text-[clamp(14px,1.2vw,18px)]",
    choice: "text-[clamp(18px,1.8vw,27px)]",
    count: "font-mono text-base",
    answerRow: "grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_3rem] gap-[clamp(12px,2vw,24px)] py-2.5",
    answer: "text-[clamp(17px,1.6vw,24px)]",
    note: "text-[clamp(16px,1.4vw,21px)]",
    caption: "text-[clamp(13px,1.2vw,17px)]",
    cloze: "text-[clamp(20px,2vw,30px)]",
    program: "gap-6",
    code: "p-5 text-[clamp(14px,1.25vw,19px)]",
    caseRow: "grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 pb-3 pt-2.5",
    caseLabel: "text-[clamp(15px,1.3vw,19px)]",
  },
  page: {
    prompt: "text-[15px] font-medium",
    choiceRow: "grid-cols-[minmax(0,1fr)_minmax(120px,30%)_2.5rem] gap-x-4 py-2",
    choiceGap: "gap-2.5",
    letter: "size-6 text-xs",
    choice: "text-sm",
    count: "text-[13px]",
    answerRow: "grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_2.5rem] gap-4 py-2",
    answer: "text-sm",
    note: "text-sm",
    caption: "text-xs",
    cloze: "text-[15px]",
    program: "gap-4",
    code: "p-4 text-xs",
    caseRow: "grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 py-2",
    caseLabel: "text-[13px]",
  },
} as const;

export type Density = keyof typeof SCALE;

/** The `code` key, when the payload carries one and the policy let it out. */
export function referenceSolution(solution: unknown): string | null {
  const value = (solution as { referenceSolution?: unknown } | null)?.referenceSolution;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A group's verdict as a tone: right, wrong, or both at once. */
const verdictTone = (entry: Pick<AnswerDistributionEntry, "correct">): BarTone =>
  entry.correct === true ? "success" : entry.correct === false ? "danger" : "muted";

/** The attempts every figure of the question is over. */
const counted = (q: ByQuestion) =>
  q.outcomes.correct + q.outcomes.partial + q.outcomes.wrong + q.outcomes.blank;

/** The head of a question: its number, the class in one bar, the success rate. */
function Head({ q, number }: { q: ByQuestion; number: number }) {
  const t = useT();
  const parts: BarPart[] = [
    { tone: "success", value: q.outcomes.correct, label: t("correction.outcome.correct") },
    { tone: "partial", value: q.outcomes.partial, label: t("correction.outcome.partial") },
    { tone: "danger", value: q.outcomes.wrong, label: t("correction.outcome.wrong") },
    { tone: "warning", value: q.outcomes.blank, label: t("correction.outcome.blank") },
  ];
  const n = counted(q);
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
 * An mcq: every choice, its letter, and the share of the papers that ticked
 * it, the count beside. Revealed, a key's bar is green and a distractor's red,
 * and its name says which; hidden, every bar is muted and says "ticked" only —
 * how the class voted, which the ticks alone do not tell the key from.
 */
function Choices({ q, revealed, density }: { q: ByQuestion; revealed: boolean; density: Density }) {
  const t = useT();
  const s = SCALE[density];
  const ticks = new Map(q.distribution.map((d) => [d.key, d.count]));
  const n = counted(q);
  return (
    <ul className="flex flex-col">
      {choicesOf(q).map((choice) => {
        const ticked = ticks.get(String(choice.id)) ?? 0;
        const part: BarPart = !revealed
          ? { tone: "muted", label: t("correction.choice.ticked"), value: ticked }
          : choice.correct
            ? { tone: "success", label: t("correction.choice.key"), value: ticked }
            : { tone: "danger", label: t("correction.choice.distractor"), value: ticked };
        return (
          <li
            key={choice.id}
            className={cx(
              "grid items-center border-b border-line px-1 max-md:grid-cols-[minmax(0,1fr)_3rem] max-md:gap-y-2",
              s.choiceRow,
            )}
          >
            <span className={cx("flex items-start max-md:col-span-2", s.choiceGap)}>
              <span
                className={cx(
                  "grid shrink-0 place-items-center rounded-full font-bold",
                  s.letter,
                  !revealed
                    ? "bg-surface-3 text-fg-muted"
                    : choice.correct
                      ? "bg-success text-on-fill"
                      : "bg-danger-soft text-danger",
                )}
              >
                {choice.letter}
              </span>
              <span
                className={cx(
                  "min-w-0 flex-1 pt-px font-medium leading-snug",
                  s.choice,
                  revealed && !choice.correct && "text-fg-muted [&_code]:text-inherit",
                )}
              >
                <MarkdownView source={choice.text} inline />
              </span>
            </span>
            <SegmentedBar parts={[part]} total={Math.max(1, n)} />
            <Count density={density}>{ticked}</Count>
          </li>
        );
      })}
    </ul>
  );
}

/** The figure at the end of a row: a count of papers. */
function Count({ density, children }: { density: Density; children: ReactNode }) {
  return <span className={cx("text-right tabular-nums text-fg-muted", SCALE[density].count)}>{children}</span>;
}

/**
 * What the class wrote, grouped: a short answer's texts, a code image's
 * accuracy buckets — whatever answer groups the type counts — under the
 * expected answer when the key names one. One bar per group, all measured
 * against the largest, and the count beside it (the figure IS the row's
 * content here, not a reading of a bar).
 */
function AnswerRows({ q, revealed, density }: { q: ByQuestion; revealed: boolean; density: Density }) {
  const t = useT();
  const s = SCALE[density];
  const blank = q.outcomes.blank;
  const rows = q.distribution.slice(0, PROJECTION_ROW_CAP);
  const overflow = q.distribution.length - rows.length;
  const top = Math.max(1, blank, ...rows.map((r) => r.count));
  const expected = (q.solution as Partial<ShortSolutionLike> | null)?.expected;
  const hasExpected = Array.isArray(expected) && expected.length > 0;
  // The blanks alone say nothing the head does not: a row of them needs
  // groups or a key beside it.
  if (rows.length === 0 && !hasExpected) return null;
  const row = (key: string, text: ReactNode, count: number, tone: BarTone, textTone: string) => (
    <li key={key} className={cx("grid items-center border-b border-line px-1 max-md:grid-cols-[1fr_3rem]", s.answerRow)}>
      <span className={cx("truncate font-medium", s.answer, textTone)}>{text}</span>
      <span className="max-md:col-span-2 max-md:row-start-2">
        <SegmentedBar parts={[{ tone: revealed ? tone : "muted", value: count }]} total={top} />
      </span>
      <Count density={density}>{count}</Count>
    </li>
  );
  return (
    <div className="flex flex-col gap-3">
      {revealed && hasExpected ? (
        <p className={cx("text-fg-muted", s.note)}>
          {t("correction.expected")}{" "}
          <span className="font-mono font-semibold text-success">{expected.join(" · ")}</span>
        </p>
      ) : null}
      {rows.length > 0 || blank > 0 ? (
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

/** A cloze: its text, each blank holding the key and how the class filled it. */
function ClozeText({ q, revealed, density }: { q: ByQuestion; revealed: boolean; density: Density }) {
  const t = useT();
  const template = (q.student as ClozeStudent | null)?.template ?? "";
  const keys = new Map(
    ((q.solution as ClozeSolution | null)?.blanks ?? []).map((b) => [b.index, b.expected]),
  );
  const n = counted(q);
  const hole = (index: number) => {
    const groups = q.distribution.filter((d) => d.part === index);
    const sum = (keep: (d: AnswerDistributionEntry) => boolean) =>
      groups.filter(keep).reduce((s, d) => s + d.count, 0);
    // A blank left empty is an absence like a question left blank, and
    // stays the track. The groups are never capped (ADR-033), so the filled
    // ones are `n` less the empty. Hidden, the bar is that one muted length:
    // how far the class got, since the right / wrong split IS the key.
    const filled = n - sum((d) => d.label === "") - q.outcomes.blank;
    const right = sum((d) => d.label !== "" && d.correct === true);
    const parts: BarPart[] = revealed
      ? [
          { tone: "success", label: t("correction.outcome.correct"), value: right },
          { tone: "danger", label: t("correction.outcome.wrong"), value: filled - right },
        ]
      : [{ tone: "muted", label: t("correction.blank.filled"), value: filled }];
    return (
      <span className="mx-1 inline-flex min-w-[8ch] flex-col gap-1 align-middle leading-tight">
        <span
          className={cx(
            "border-b-2 px-2.5 text-center font-mono font-semibold",
            revealed ? "border-success text-success" : "border-dashed border-line-strong text-transparent",
          )}
          aria-hidden={!revealed}
        >
          {keys.get(index) ?? "…"}
        </span>
        <SegmentedBar className="h-1.5" parts={parts} total={Math.max(1, n)} />
      </span>
    );
  };
  return (
    <div
      className={cx(
        "max-w-[62ch] font-medium [&_.md-cloze]:text-[1em]! [&_.md-cloze_li]:leading-[2.6]! [&_.md-cloze_p]:leading-[2.6]!",
        SCALE[density].cloze,
      )}
    >
      <ClozeMarkdownText template={template} renderBlank={hole} />
    </div>
  );
}

/**
 * A program: the reference solution, and how the class fared on each test
 * case, its passes out of its runs beside the bar.
 */
export function CorrectionProgram({
  q,
  revealed,
  density = "wall",
}: {
  q: ByQuestion;
  revealed: boolean;
  density?: Density;
}) {
  const t = useT();
  const s = SCALE[density];
  const reference = referenceSolution(q.solution);
  const n = counted(q);
  if (reference === null && q.casePassRate.length === 0) return null;
  return (
    <div className={cx("grid items-start lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]", s.program)}>
      {reference === null ? null : (
        <pre
          // Revealed, a focusable scroll region: it runs past the screen edge
          // on a phone, and a keyboard cannot reach into a container that
          // holds nothing focusable (W10). Hidden, it is not there at all.
          {...(revealed
            ? { tabIndex: 0, role: "region", "aria-label": t("results.byQuestion.reference") }
            : { "aria-hidden": true })}
          className={cx(
            "overflow-x-auto rounded-card border border-line font-mono leading-relaxed",
            s.code,
            revealed
              ? "bg-surface"
              : "select-none bg-[repeating-linear-gradient(135deg,var(--surface-2)_0_8px,var(--surface-3)_8px_16px)] text-transparent",
          )}
        >
          {reference}
        </pre>
      )}
      {q.casePassRate.length > 0 ? (
        <ul className="flex flex-col" aria-label={t("results.byQuestion.cases")}>
          {q.casePassRate.map((c) => (
            <li key={c.name} className={cx("grid items-center border-b border-line px-1", s.caseRow)}>
              {/* `label`, never `name`: a hidden case reads as a student
                  reads it unless the policy shows hidden names (ADR-033). */}
              <span className={cx("font-semibold", s.caseLabel)}>{c.label}</span>
              <Count density={density}>
                {t("results.byQuestion.casePass", { passed: c.passed, total: c.total })}
              </Count>
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
      ) : null}
    </div>
  );
}

/**
 * The types whose key the correction draws itself: an mcq's letters, a
 * cloze's blanks, a short answer's expected answer. The Results tab leaves any
 * other type's statement and key to the type's own review.
 */
export const drawsKey = (type: string): boolean => type === "mcq" || type === "cloze" || type === "short";

/** The statement: the prompt, or a cloze's text with its blanks in place. */
export function CorrectionStatement({
  q,
  revealed,
  density = "wall",
}: {
  q: ByQuestion;
  revealed: boolean;
  density?: Density;
}) {
  const prompt = promptOf(q);
  if (q.item.type === "cloze") return <ClozeText q={q} revealed={revealed} density={density} />;
  if (!prompt) return null;
  return (
    <div className={SCALE[density].prompt}>
      <MarkdownView source={prompt} inline />
    </div>
  );
}

/**
 * What the class answered, after the statement: an mcq's choices, or the
 * answer groups the type counts. Nothing for a cloze (its blanks are IN the
 * statement), nor for a type that counts none.
 */
export function CorrectionAnswers({
  q,
  revealed,
  density = "wall",
}: {
  q: ByQuestion;
  revealed: boolean;
  density?: Density;
}) {
  if (q.item.type === "mcq") return <Choices q={q} revealed={revealed} density={density} />;
  if (q.item.type === "cloze") return null;
  return <AnswerRows q={q} revealed={revealed} density={density} />;
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
      <CorrectionStatement q={q} revealed={revealed} />
      {explained && q.explanation ? (
        <NotePanel eyebrow={t("correction.explanation")}>
          <MarkdownView source={q.explanation} className="text-[clamp(15px,1.3vw,19px)]" />
        </NotePanel>
      ) : null}
      <CorrectionProgram q={q} revealed={revealed} />
      <CorrectionAnswers q={q} revealed={revealed} />
    </>
  );
}
