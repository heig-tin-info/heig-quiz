/**
 * What the projection DRAWS, out of what the server SENT.
 *
 * The aggregation itself is not here: `pollTally()` in `@quiz/domain` counts
 * the answers server-side and the browser only ever receives the result
 * (`PollTally`). This module is the presentation half — the join between the
 * student view of the question and that tally, the percentages, and which row
 * the key points at — and it is pure so the arithmetic of a screen nobody can
 * unit-test at 68 px is unit-testable here.
 *
 * The join is the part worth writing down. An mcq's tally is indexed by the
 * CANONICAL choice index and the student view carries the choices in the
 * SERVED order with `id` holding that same canonical index (decision D3), so
 * the rows follow the served order — what every participant had on their
 * phone — and read their counts through `id`. The letter is therefore the
 * POSITION on screen, not the canonical index: A is the first row the room
 * saw, whatever it is called in the config.
 */
import { foldPollAnswer } from "@quiz/domain";
// A, B, C… comes from the type that owns the letter, so a row on the wall is
// lettered exactly as the same choice is in the editor and in the review.
import { choiceLetter, type McqSolution, type McqStudent } from "@quiz/qt-mcq/client";
import type { ShortSolution, ShortStudent } from "@quiz/qt-short/client";

import type { PollTally, PollTeacherView } from "@quiz/contracts";

/** One line of the projection: a choice, or a distinct free-text answer. */
export interface PollRow {
  /** React key; stable across two frames of the same poll. */
  key: string;
  /** A, B, C… for an mcq; null for a free-text answer, which has no letter. */
  letter: string | null;
  /** Markdown for an mcq choice, plain text for what a participant typed. */
  label: string;
  /** Whether `label` may be rendered as markdown (never for typed text). */
  markdown: boolean;
  count: number;
  /** 0–100, rounded: the share of the participants who answered. */
  percent: number;
  /** The key points at this row. The screen only shows it once revealed. */
  correct: boolean;
}

/**
 * The denominator of every percentage: the participants who ANSWERED, never
 * the ones who joined. "27 %" on a beamer means "27 % of the answers", which
 * is what a teacher reads out loud, and it is the only figure that still adds
 * up while the room is still voting.
 *
 * A `multiple` mcq can push the sum past 100 % — three people ticking two
 * boxes each is six votes over three answers — and that is correct: each bar
 * is the share of the room that picked THAT choice. The bar width is clamped,
 * the number is not.
 */
export function percentOf(count: number, answered: number): number {
  if (answered <= 0) return 0;
  return Math.round((count / answered) * 100);
}

/** What the rows are drawn from: the teacher's question, or a revealed phone's. */
type QuestionLike = Pick<PollTeacherView["question"], "type" | "student" | "solution">;

/** An mcq choice as the room saw it: its letter, its text, whether it is in the key. */
export interface ChoiceLike {
  /** The canonical index, what a tally is keyed by. */
  id: number;
  letter: string;
  text: string;
  correct: boolean;
}

/** The choices of an mcq in the SERVED order, joined with its key. */
export function choicesOf(question: Pick<QuestionLike, "student" | "solution">): ChoiceLike[] {
  const student = question.student as McqStudent | null;
  const solution = question.solution as McqSolution | null;
  const key = new Set(Array.isArray(solution?.correct) ? solution.correct : []);
  return (Array.isArray(student?.choices) ? student.choices : []).map((choice, position) => ({
    id: choice.id,
    letter: choiceLetter(position),
    text: choice.text,
    correct: key.has(choice.id),
  }));
}

/**
 * Whether the key names any answer at all. An opinion poll's names none
 * (ADR-014, addendum 2026-09-23): its reveal marks nothing right — and
 * therefore nothing wrong — and only shows the distribution.
 */
export function hasKey(question: Pick<QuestionLike, "type" | "solution">): boolean {
  const solution = question.solution as Partial<McqSolution & ShortSolution> | null;
  const key = question.type === "mcq" ? solution?.correct : solution?.expected;
  return Array.isArray(key) && key.length > 0;
}

/** The prompt of the question, whatever its type; `""` for one without (a cloze). */
export function promptOf<Q extends Pick<QuestionLike, "student">>(question: Q): string {
  const student = question.student as Partial<McqStudent & ShortStudent> | null;
  return typeof student?.prompt === "string" ? student.prompt : "";
}

function mcqRows(question: QuestionLike, tally: PollTally): PollRow[] {
  const counts = new Map(tally.choices.map((c) => [c.index, c.count]));
  return choicesOf(question).map((choice) => {
    const count = counts.get(choice.id) ?? 0;
    return {
      key: `c${choice.id}`,
      letter: choice.letter,
      label: choice.text,
      markdown: true,
      count,
      percent: percentOf(count, tally.answered),
      correct: choice.correct,
    };
  });
}

function shortRows(question: QuestionLike, tally: PollTally): PollRow[] {
  const solution = question.solution as ShortSolution | null;
  const expected = new Set(
    (Array.isArray(solution?.expected) ? solution.expected : []).map(foldPollAnswer),
  );
  // The server sends them most frequent first and keeps the first spelling
  // seen; the browser re-sorts nothing, or two equal bars would swap places
  // under the teacher's eyes between two frames.
  return tally.answers.map((answer) => ({
    key: `a${foldPollAnswer(answer.text)}`,
    letter: null,
    label: answer.text,
    // What a participant typed is never markdown: a stray underscore in an
    // answer is an underscore.
    markdown: false,
    count: answer.count,
    percent: percentOf(answer.count, tally.answered),
    correct: expected.has(foldPollAnswer(answer.text)),
  }));
}

/** A brainstorm's ideas, as the server let the room see them (ADR-071). */
function ideaRows(tally: PollTally): PollRow[] {
  return tally.ideas.map((idea) => ({
    key: `i${idea.key}`,
    letter: null,
    label: idea.label,
    markdown: false,
    count: idea.count,
    percent: percentOf(idea.count, tally.answered),
    correct: false,
  }));
}

/** The rows of one poll, in the order the room saw them. */
export function pollRows(question: QuestionLike, tally: PollTally): PollRow[] {
  if (question.type === "brainstorm") return ideaRows(tally);
  return question.type === "mcq" ? mcqRows(question, tally) : shortRows(question, tally);
}

/**
 * How big the question may be drawn.
 *
 * A single `clamp(30px, 4.6vw, 68px)` would assume the question of a poll is
 * one line of a lecture — and most are. A four-line one at that size eats the
 * screen and pushes the last bars off the wall, which is the one thing a
 * projection may not do. So the scale steps down with the LENGTH of the
 * prompt, deterministically: three steps, measured on the question that broke
 * it (a 130-character one in French). Nothing is truncated, ever; a question
 * is read, not summarised.
 */
export function questionScale(prompt: string): string {
  if (prompt.length <= 80) return "text-[clamp(30px,4.6vw,68px)]";
  if (prompt.length <= 110) return "text-[clamp(26px,3.4vw,50px)]";
  return "text-[clamp(22px,2.6vw,38px)]";
}

/**
 * How many rows the wall shows. An mcq has at most twelve choices and they
 * all belong on screen; a free-text tally carries up to `POLL_SHORT_CAP`
 * distinct spellings (sixty), and sixty bars on a beamer is a wall of noise.
 * The rest is counted in one line under them.
 */
export const PROJECTION_ROW_CAP = 8;

/** How many participants have joined but not answered yet, never negative. */
export function waitingOf(tally: PollTally): number {
  return Math.max(0, tally.joined - tally.answered);
}

/**
 * The host a participant types, out of the join URL — "quiz.heig-vd.ch".
 *
 * The page's own origin is the base for a relative URL, and nothing at all
 * outside a browser: this module is pure, and its tests run in `node`.
 */
export function joinHost(joinUrl: string): string {
  const base = typeof window === "undefined" ? undefined : window.location.origin;
  try {
    return new URL(joinUrl, base).host;
  } catch {
    // A URL the server got wrong must not take the beamer down with it.
    return joinUrl;
  }
}
