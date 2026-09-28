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
import { referenceSolution, verdictTone } from "./ByQuestionView";

/**
 * One question of the correction projection (F-RES-03, ADR-033): who got it
 * right, the statement, and what the class answered — the key and the
 * verdicts only once `revealed`.
 *
 * Everything drawn here is the server's (`ByQuestion`): the outcomes and the
 * verdict of every answer group come from the validated gradings, and the
 * screen recomputes no grade. The two joins it does make are an mcq's
 * choices with their ticks (`choicesOf`, the poll projection's), and a cloze
 * text's blanks with the groups that answer each (`part`).
 *
 * The sizes are the projection's own `clamp()` scale (DESIGN.md, "Correction
 * projection").
 */

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

/** An mcq: every choice, its letter, and how the class treated it. */
function Choices({ q, revealed }: { q: ByQuestion; revealed: boolean }) {
  const t = useT();
  const ticks = new Map(q.distribution.map((d) => [d.key, d.count]));
  const n = counted(q);
  const answered = n - q.outcomes.blank;
  return (
    <ul className="flex flex-col">
      {choicesOf(q).map((choice) => {
        const ticked = ticks.get(String(choice.id)) ?? 0;
        // A key: ticked, or missed. A distractor: ticked wrongly, avoided by
        // those who answered, or left with the whole question unanswered.
        const parts: BarPart[] = choice.correct
          ? [
              { tone: "success", label: t("correction.choice.ticked"), value: ticked },
              { tone: "warning", label: t("correction.choice.notTicked"), value: n - ticked },
            ]
          : [
              { tone: "danger", label: t("correction.choice.tickedWrongly"), value: ticked },
              { tone: "success", label: t("correction.choice.avoided"), value: answered - ticked },
              { tone: "warning", label: t("correction.outcome.blank"), value: q.outcomes.blank },
            ];
        return (
          <li
            key={choice.id}
            className="grid grid-cols-[minmax(0,1fr)_minmax(180px,38%)] items-center gap-x-[clamp(16px,2vw,28px)] border-b border-line px-1 py-[clamp(10px,1.4vh,16px)] max-md:grid-cols-1 max-md:gap-y-2"
          >
            <span className="flex items-start gap-3.5">
              <span
                className={cx(
                  "grid size-[clamp(30px,2.4vw,38px)] shrink-0 place-items-center rounded-full text-[clamp(14px,1.2vw,18px)] font-bold",
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
                  "min-w-0 flex-1 pt-px text-[clamp(18px,1.8vw,27px)] font-medium leading-snug",
                  revealed && !choice.correct && "text-fg-muted [&_code]:text-inherit",
                )}
              >
                <MarkdownView source={choice.text} inline />
              </span>
            </span>
            {/* Hidden, the bar drains to its track: its colours ARE the key. */}
            <SegmentedBar parts={revealed ? parts : []} total={Math.max(1, n)} />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What the class wrote, grouped: a short answer's texts, a code image's
 * accuracy buckets — whatever answer groups the type counts. One bar per
 * group, all measured against the largest, and the count beside it (the
 * figure IS the row's content here, not a reading of a bar).
 */
function AnswerRows({ q, revealed }: { q: ByQuestion; revealed: boolean }) {
  const t = useT();
  const blank = q.outcomes.blank;
  const rows = q.distribution.slice(0, PROJECTION_ROW_CAP);
  const overflow = q.distribution.length - rows.length;
  const top = Math.max(1, blank, ...rows.map((r) => r.count));
  const expected = (q.solution as Partial<ShortSolutionLike> | null)?.expected;
  const row = (key: string, text: ReactNode, count: number, tone: BarTone, textTone: string) => (
    <li
      key={key}
      className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_3rem] items-center gap-[clamp(12px,2vw,24px)] border-b border-line px-1 py-2.5 max-md:grid-cols-[1fr_3rem]"
    >
      <span className={cx("truncate text-[clamp(17px,1.6vw,24px)] font-medium", textTone)}>{text}</span>
      <span className="max-md:col-span-2 max-md:row-start-2">
        <SegmentedBar parts={[{ tone: revealed ? tone : "muted", value: count }]} total={top} />
      </span>
      <span className="text-right font-mono text-base tabular-nums text-fg-muted">{count}</span>
    </li>
  );
  return (
    <div className="flex flex-col gap-3">
      {revealed && Array.isArray(expected) && expected.length > 0 ? (
        <p className="text-[clamp(16px,1.4vw,21px)] text-fg-muted">
          {t("correction.expected")}{" "}
          <span className="font-mono font-semibold text-success">{expected.join(" · ")}</span>
        </p>
      ) : null}
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
      {overflow > 0 ? (
        <p className="text-[clamp(13px,1.2vw,17px)] text-fg-faint">
          {t(overflow === 1 ? "poll.moreAnswers.one" : "poll.moreAnswers", { n: overflow })}
        </p>
      ) : null}
    </div>
  );
}

/** A cloze: its text, each blank holding the key and how the class filled it. */
function ClozeText({ q, revealed }: { q: ByQuestion; revealed: boolean }) {
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
    // A blank left empty is an absence like a question left blank. The
    // groups are never capped (ADR-033), so the three add up to `n`.
    const empty = sum((d) => d.label === "") + q.outcomes.blank;
    const right = sum((d) => d.label !== "" && d.correct === true);
    const parts: BarPart[] = [
      { tone: "success", label: t("correction.outcome.correct"), value: right },
      { tone: "danger", label: t("correction.outcome.wrong"), value: n - empty - right },
      { tone: "warning", label: t("correction.outcome.blank"), value: empty },
    ];
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
        <SegmentedBar className="h-1.5" parts={revealed ? parts : []} total={Math.max(1, n)} />
      </span>
    );
  };
  return (
    <div className="max-w-[62ch] text-[clamp(20px,2vw,30px)] font-medium [&_.md-cloze]:text-[1em]! [&_.md-cloze_li]:leading-[2.6]! [&_.md-cloze_p]:leading-[2.6]!">
      <ClozeMarkdownText template={template} renderBlank={hole} />
    </div>
  );
}

/** A program: the reference solution, and how the class fared on each test case. */
function Program({ q, revealed }: { q: ByQuestion; revealed: boolean }) {
  const t = useT();
  const reference = referenceSolution(q.solution);
  const n = counted(q);
  if (reference === null && q.casePassRate.length === 0) return null;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      {reference === null ? null : (
        <pre
          aria-hidden={!revealed}
          className={cx(
            "overflow-x-auto rounded-card border border-line p-5 font-mono text-[clamp(14px,1.25vw,19px)] leading-relaxed",
            revealed
              ? "bg-surface"
              : "select-none bg-[repeating-linear-gradient(135deg,var(--surface-2)_0_8px,var(--surface-3)_8px_16px)] text-transparent",
          )}
        >
          {reference}
        </pre>
      )}
      {q.casePassRate.length > 0 ? (
        <ul className="flex flex-col">
          {q.casePassRate.map((c) => (
            <li key={c.name} className="flex flex-col gap-2 border-b border-line px-1 pb-3 pt-2.5">
              {/* `label`, never `name`: a hidden case reads as a student
                  reads it unless the policy shows hidden names (ADR-033). */}
              <span className="text-[clamp(15px,1.3vw,19px)] font-semibold">{c.label}</span>
              <SegmentedBar
                parts={[
                  { tone: "success", label: t("correction.case.passed"), value: c.passed },
                  { tone: "danger", label: t("correction.case.failed"), value: c.total - c.passed },
                  { tone: "warning", label: t("correction.case.notRun"), value: n - c.total },
                ]}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
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
  const prompt = promptOf(q);
  const cloze = q.item.type === "cloze";
  return (
    <>
      <Head q={q} number={number} />
      {cloze ? (
        <ClozeText q={q} revealed={revealed} />
      ) : prompt ? (
        <div className="max-w-[64ch] text-balance text-[clamp(24px,2.7vw,40px)] font-bold leading-tight tracking-[-0.025em]">
          <MarkdownView source={prompt} inline />
        </div>
      ) : null}
      {explained && q.explanation ? (
        <NotePanel eyebrow={t("correction.explanation")}>
          <MarkdownView source={q.explanation} className="text-[clamp(15px,1.3vw,19px)]" />
        </NotePanel>
      ) : null}
      {q.item.type === "mcq" ? (
        <Choices q={q} revealed={revealed} />
      ) : cloze ? null : (
        <>
          <Program q={q} revealed={revealed} />
          {q.distribution.length > 0 ? <AnswerRows q={q} revealed={revealed} /> : null}
        </>
      )}
    </>
  );
}
