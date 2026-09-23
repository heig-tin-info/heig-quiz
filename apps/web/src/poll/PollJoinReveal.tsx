/**
 * The key of a poll, on the participant's phone (F-LIVE-13).
 *
 * It REPLACES the answer control rather than sitting under it: once the
 * teacher has revealed, an answer field is a trap — it still accepts a tap
 * that changes nothing about what the room just read on the beamer.
 *
 * Why not `QuestionReviewHost` and the type's own `Review`: that component is
 * a GRADED surface. It always prints a `Score — / N` line, and `short` derives
 * its verdict from the grading `details` (`fraction`, `matchedIndex`). A poll
 * is not graded and produces none of that, so reusing it would mean inventing
 * a score to show a key. What a poll reveals is the two facts it actually
 * has: which answer is right, and which one this browser sent.
 *
 * Color: `success` for the key and `danger` for a wrong own pick — semantic,
 * the only two tones on the screen, and both carry a WORD beside the tint (a
 * lecture-hall projector and a red-green reader both lose the tint alone).
 *
 * An opinion poll has NO key (ADR-014, addendum 2026-09-23), so there is
 * nothing right and nothing wrong to show: the reveal is the distribution the
 * wall shows, with this browser's own answer marked by a word, in no tone.
 */
import { Check, X } from "lucide-react";

import type { PollTally } from "@quiz/contracts";
import { foldPollAnswer } from "@quiz/domain";
import type { McqSolution, McqStudent } from "@quiz/qt-mcq/client";
import type { ShortSolution, ShortStudent } from "@quiz/qt-short/client";

import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { cx } from "../ui";
import { hasKey, pollRows, PROJECTION_ROW_CAP } from "./pollTally";

/** The canonical indices an `mcq` payload holds, whatever the server sent. */
function selectedOf(answer: unknown): number[] {
  const raw = (answer as { selected?: unknown } | null)?.selected;
  return Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number") : [];
}

/** The text a `short` payload holds. */
function textOf(answer: unknown): string {
  const raw = (answer as { text?: unknown } | null)?.text;
  return typeof raw === "string" ? raw : "";
}

/**
 * Does the participant's text stand among the accepted spellings?
 *
 * The fold is `@quiz/domain`'s own `foldPollAnswer` — the very one the tally
 * buckets answers with — so this line and the teacher's projection can never
 * disagree about two spellings being the same answer. It is a spelling
 * comparison and nothing more: `solution.expected` is the HUMAN rendering of
 * the key (`≈ 3.14 ± 1 %`), so a tolerance or a regex matcher does not fold
 * into anything, and the negative case says exactly what was computed —
 * "not among the answers below" — never "wrong".
 */
export function matchesExpected(text: string, expected: readonly string[]): boolean {
  if (text.trim() === "") return false;
  const folded = foldPollAnswer(text);
  return expected.some((e) => foldPollAnswer(e) === folded);
}

const rowClass = "flex items-start justify-between gap-3 rounded-card border px-3 py-2.5 text-sm";
const tagClass = "inline-flex shrink-0 items-center gap-1 text-[12px] font-medium [&_svg]:size-3.5";

function McqReveal({
  student,
  solution,
  answer,
}: {
  student: McqStudent;
  solution: McqSolution;
  answer: unknown;
}) {
  const t = useT();
  const selected = new Set(selectedOf(answer));
  const key = new Set(solution.correct);
  return (
    <ul className="flex flex-col gap-2">
      {student.choices.map((choice) => {
        const correct = key.has(choice.id);
        const chosen = selected.has(choice.id);
        const tag = correct
          ? {
              tone: "text-success",
              icon: <Check aria-hidden />,
              label: chosen ? t("join.reveal.yoursCorrect") : t("join.reveal.correct"),
            }
          : chosen
            ? { tone: "text-danger", icon: <X aria-hidden />, label: t("join.reveal.yoursWrong") }
            : null;
        return (
          <li
            key={choice.id}
            className={cx(
              rowClass,
              correct
                ? "border-success/40 bg-success-soft"
                : chosen
                  ? "border-danger/40 bg-danger-soft"
                  : "border-line bg-surface",
            )}
          >
            <MarkdownView as="span" source={choice.text} inline className="min-w-0" />
            {tag ? (
              <span className={cx(tagClass, tag.tone)}>
                {tag.icon}
                {tag.label}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ShortReveal({
  solution,
  answer,
}: {
  solution: ShortSolution;
  answer: unknown;
}) {
  const t = useT();
  const text = textOf(answer);
  const matched = matchesExpected(text, solution.expected);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-fg">{t("join.reveal.yours")}</span>
        {text.trim() === "" ? (
          <span className="text-[13px] text-fg-muted">{t("join.reveal.noAnswer")}</span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <code
              className={cx(
                "rounded-field border px-2 py-1 font-mono text-[13px]",
                matched ? "border-success/40 bg-success-soft" : "border-line bg-surface-2",
              )}
            >
              {text}
            </code>
            <span className={cx(tagClass, matched ? "text-success" : "text-fg-muted")}>
              {matched ? <Check aria-hidden /> : null}
              {matched ? t("join.reveal.matched") : t("join.reveal.notMatched")}
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-fg">{t("join.reveal.accepted")}</span>
        <ul className="flex flex-wrap gap-1.5">
          {solution.expected.map((expected, i) => (
            <li
              key={`${expected}-${i}`}
              className="rounded-full border border-success/40 bg-success-soft px-2.5 py-1 font-mono text-[13px] text-fg"
            >
              {expected}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The reveal of a poll without a key: the share of the room behind each
 * answer, in the order the wall draws them, and which one was this
 * browser's. The bars wear the wall's accent; the rows no tone at all —
 * nobody is being marked.
 */
function ResultsReveal({
  type,
  student,
  solution,
  tally,
  answer,
}: {
  type: "mcq" | "short";
  student: unknown;
  solution: unknown;
  tally: PollTally;
  answer: unknown;
}) {
  const t = useT();
  const rows = pollRows({ type, student, solution }, tally).slice(0, PROJECTION_ROW_CAP);
  const selected = new Set(selectedOf(answer).map((i) => `c${i}`));
  const text = textOf(answer);
  const mine = (key: string) =>
    type === "mcq" ? selected.has(key) : text.trim() !== "" && key === `a${foldPollAnswer(text)}`;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-fg-muted">{t("join.reveal.noKey")}</p>
      {rows.length === 0 ? (
        <p className="text-[13px] text-fg-muted">{t("poll.noAnswersYet")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const own = mine(row.key);
            return (
              <li
                key={row.key}
                className={cx(
                  "flex flex-col gap-2 rounded-card border px-3 py-2.5 text-sm",
                  // Neutral, never the accent: on this page red already
                  // means "wrong", and nothing here is.
                  own ? "border-line-strong bg-surface-2" : "border-line bg-surface",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  {row.markdown ? (
                    <MarkdownView as="span" source={row.label} inline className="min-w-0" />
                  ) : (
                    <span className="min-w-0 break-words">{row.label}</span>
                  )}
                  <span className="flex shrink-0 items-center gap-2">
                    {own ? (
                      <span className={cx(tagClass, "font-semibold text-fg")}>{t("join.reveal.yours")}</span>
                    ) : null}
                    <span className="font-mono text-[13px] font-semibold tabular-nums">
                      {t("poll.percent", { n: row.percent })}
                    </span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${Math.min(100, row.percent)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The prompt, then the key. `solution` arrives as `unknown` (the contract
 * cannot name a type's shape), so each branch narrows it structurally: a
 * payload that is not the shape this type publishes renders nothing rather
 * than throwing on a phone in the middle of a lecture.
 */
export function PollJoinReveal({
  type,
  student,
  solution,
  tally = null,
  answer,
}: {
  type: "mcq" | "short";
  student: unknown;
  solution: unknown;
  /** The distribution: what an opinion poll, which has no key, reveals. */
  tally?: PollTally | null;
  answer: unknown;
}) {
  const t = useT();
  const prompt = (student as { prompt?: unknown } | null)?.prompt;
  const keyed = hasKey({ type, solution });
  const body = !keyed ? (
    tally ? (
      <ResultsReveal type={type} student={student} solution={solution} tally={tally} answer={answer} />
    ) : null
  ) : type === "mcq" && Array.isArray((solution as McqSolution | null)?.correct) ? (
      <McqReveal
        student={student as McqStudent}
        solution={solution as McqSolution}
        answer={answer}
      />
    ) : type === "short" && Array.isArray((solution as ShortSolution | null)?.expected) ? (
      <ShortReveal solution={solution as ShortSolution} answer={answer} />
    ) : null;
  return (
    <div className="flex flex-col gap-4">
      {typeof prompt === "string" ? (
        <MarkdownView source={prompt} className="text-lg leading-relaxed text-fg" />
      ) : null}
      <p className="text-[13px] font-medium text-fg-muted">
        {t(keyed ? "join.reveal.title" : "join.reveal.results")}
      </p>
      {body}
    </div>
  );
}
