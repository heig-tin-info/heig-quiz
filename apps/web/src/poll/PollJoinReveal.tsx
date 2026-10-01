/**
 * What the teacher shows of a poll, on the participant's phone (F-LIVE-13):
 * the key once revealed, the distribution while the votes are shown.
 *
 * Neither closes the vote — only End does (ADR-014, addendum 2026-09-29, after
 * the incident of poll KUFE5R where a reveal read as "you may not answer").
 * So while the poll RUNS, this sits UNDER the still-editable question and
 * names no verdict (`ended` false): no "your answer — wrong" beside a field
 * the reader may still change. Once the poll has ENDED it replaces the
 * question, and the verdict joins it.
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
 * nothing right and nothing wrong to show and no reveal to press: what the
 * phone gets is the distribution, while the votes are shown, with this
 * browser's own answer marked by a word, in no tone, once the poll is over.
 */
import type { ReactNode } from "react";
import { Check, X } from "lucide-react";

import type { PollQuestionType, PollTally } from "@quiz/contracts";
import { foldPollAnswer } from "@quiz/domain";
import { choiceLetter, LetteredChoice, type McqSolution, type McqStudent } from "@quiz/qt-mcq/client";
import type { ChoiceMarkState } from "@quiz/ui";
import type { ShortSolution, ShortStudent } from "@quiz/qt-short/client";

import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { cx } from "../ui";
import { pollRows, PROJECTION_ROW_CAP } from "./pollTally";

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
  verdict,
}: {
  student: McqStudent;
  solution: McqSolution;
  answer: unknown;
  verdict: boolean;
}) {
  const t = useT();
  const selected = new Set(verdict ? selectedOf(answer) : []);
  const key = new Set(solution.correct);
  return (
    <ul className="flex flex-col gap-2">
      {student.choices.map((choice, index) => {
        const look = ROW_LOOK[rowState(selected.has(choice.id), true, key.has(choice.id))];
        return (
          <li key={choice.id} className={cx(rowClass, look.row)}>
            <LetteredChoice letter={choiceLetter(index)} mark={look.letter}>
              <MarkdownView as="span" source={choice.text} inline />
            </LetteredChoice>
            {look.label ? (
              <span className={cx(tagClass, look.tone)}>
                {look.icon}
                {t(look.label)}
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
  verdict,
}: {
  solution: ShortSolution;
  answer: unknown;
  verdict: boolean;
}) {
  const t = useT();
  const text = textOf(answer);
  const matched = matchesExpected(text, solution.expected);
  return (
    <div className="flex flex-col gap-4">
      {verdict ? (
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
      ) : null}
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

/** How one row of the distribution stands: the key's, this browser's, both, or neither. */
type RowState = "yoursRight" | "right" | "wrong" | "yours" | "none";

/** What each state wears: a tag (tone, icon, words), the row's tint, an mcq letter's state. */
const ROW_LOOK: Record<
  RowState,
  { tone: string; icon: ReactNode; label: "join.reveal.yoursCorrect" | "join.reveal.correct" | "join.reveal.yoursWrong" | "join.reveal.yours" | null; row: string; letter: ChoiceMarkState }
> = {
  yoursRight: { tone: "text-success", icon: <Check aria-hidden />, label: "join.reveal.yoursCorrect", row: "border-success/40 bg-success-soft", letter: "good" },
  right: { tone: "text-success", icon: <Check aria-hidden />, label: "join.reveal.correct", row: "border-success/40 bg-success-soft", letter: "expected" },
  wrong: { tone: "text-danger", icon: <X aria-hidden />, label: "join.reveal.yoursWrong", row: "border-danger/40 bg-danger-soft", letter: "bad" },
  // Neutral, never the accent: red already means "wrong".
  yours: { tone: "font-semibold text-fg", icon: null, label: "join.reveal.yours", row: "border-line-strong bg-surface-2", letter: "on" },
  none: { tone: "", icon: null, label: null, row: "border-line bg-surface", letter: "off" },
};

function rowState(own: boolean, keyShown: boolean, correct: boolean): RowState {
  if (keyShown && correct) return own ? "yoursRight" : "right";
  if (!own) return "none";
  return keyShown ? "wrong" : "yours";
}

/**
 * The distribution, in the order the wall draws it. A revealed key ticks its
 * rows (`success`, with the word); once the poll has ended, this browser's
 * own answer is named too — right, wrong, or simply "yours" when the key is
 * not shown. The bars are neutral (`info`), never the accent red that
 * reads as "wrong"; an untouched row wears no tone at all.
 */
function ResultsReveal({
  type,
  student,
  solution,
  tally,
  answer,
  keyShown,
  ended,
}: {
  type: PollQuestionType;
  student: unknown;
  solution: unknown;
  tally: PollTally;
  answer: unknown;
  keyShown: boolean;
  ended: boolean;
}) {
  const t = useT();
  const rows = pollRows({ type, student, solution }, tally).slice(0, PROJECTION_ROW_CAP);
  const selected = new Set(selectedOf(answer).map((i) => `c${i}`));
  const text = textOf(answer);
  const mine = (key: string) =>
    ended &&
    (type === "mcq" ? selected.has(key) : text.trim() !== "" && key === `a${foldPollAnswer(text)}`);
  if (rows.length === 0) return <p className="text-[13px] text-fg-muted">{t("poll.noAnswersYet")}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const look = ROW_LOOK[rowState(mine(row.key), keyShown, row.correct)];
        const label = row.markdown ? (
          <MarkdownView as="span" source={row.label} inline className="min-w-0" />
        ) : (
          <span className="min-w-0 break-words">{row.label}</span>
        );
        return (
          <li
            key={row.key}
            className={cx("flex flex-col gap-2 rounded-card border px-3 py-2.5 text-sm", look.row)}
          >
            <div className="flex items-start justify-between gap-3">
              {row.letter === null ? (
                label
              ) : (
                <LetteredChoice letter={row.letter} mark={look.letter}>
                  {label}
                </LetteredChoice>
              )}
              <span className="flex shrink-0 items-center gap-2">
                {look.label ? (
                  <span className={cx(tagClass, look.tone)}>
                    {look.icon}
                    {t(look.label)}
                  </span>
                ) : null}
                <span className="font-mono text-[13px] font-semibold tabular-nums">
                  {t("poll.percent", { n: row.percent })}
                </span>
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <span
                className="block h-full rounded-full bg-info"
                style={{ width: `${Math.min(100, row.percent)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A heading and what it heads: one block of what the teacher shows. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-medium text-fg-muted">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The key and the distribution, each only when the server sent it: the
 * `solution` while the key is revealed, the `tally` while the votes are
 * shown. `solution` arrives as `unknown` (the contract cannot name a type's
 * shape), so each branch narrows it structurally: a payload that is not the
 * shape this type publishes renders nothing rather than throwing on a phone
 * in the middle of a lecture.
 *
 * An mcq whose key AND votes are both shown draws one list, the distribution
 * with the key ticked in it — never the same choices twice.
 */
export function PollJoinReveal({
  type,
  student,
  solution,
  tally = null,
  answer,
  ended,
}: {
  type: PollQuestionType;
  student: unknown;
  /** The key, while the teacher reveals it (never for a poll without one). */
  solution: unknown;
  /** The distribution, while the teacher shows the votes. */
  tally?: PollTally | null;
  answer: unknown;
  /**
   * The poll has ended: this block replaces the question (so it draws the
   * prompt) and names this browser's answer, right or wrong.
   */
  ended: boolean;
}) {
  const t = useT();
  const prompt = (student as { prompt?: unknown } | null)?.prompt;
  const keyShown = solution !== null;
  const mcqKey =
    keyShown && type === "mcq" && Array.isArray((solution as McqSolution | null)?.correct);
  const shortKey =
    keyShown && type === "short" && Array.isArray((solution as ShortSolution | null)?.expected);
  return (
    <div className="flex flex-col gap-5">
      {ended && typeof prompt === "string" ? (
        <MarkdownView source={prompt} className="text-lg leading-relaxed text-fg" />
      ) : null}
      {mcqKey && !tally ? (
        <Section title={t("join.reveal.title")}>
          <McqReveal
            student={student as McqStudent}
            solution={solution as McqSolution}
            answer={answer}
            verdict={ended}
          />
        </Section>
      ) : null}
      {shortKey ? (
        <Section title={t("join.reveal.title")}>
          <ShortReveal solution={solution as ShortSolution} answer={answer} verdict={ended} />
        </Section>
      ) : null}
      {tally ? (
        <Section title={t(mcqKey ? "join.reveal.title" : "join.reveal.results")}>
          <ResultsReveal
            type={type}
            student={student}
            solution={solution}
            tally={tally}
            answer={answer}
            keyShown={keyShown}
            ended={ended}
          />
        </Section>
      ) : null}
    </div>
  );
}
