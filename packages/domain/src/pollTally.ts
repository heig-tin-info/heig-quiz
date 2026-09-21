/**
 * The aggregate of a live poll (F-LIVE-13, ADR-014): what the projection
 * draws while the answers arrive, and what the `poll.tally` event carries.
 *
 * Pure, like everything in this package (invariant 8): it takes the item's
 * type, what the question is made of, and the answer payloads as they are
 * stored, and returns counts. No database, no clock, no truncation policy
 * decided elsewhere.
 *
 * Two rules the projection depends on:
 *   - an `mcq` tally has ONE entry per CANONICAL choice, in canonical order,
 *     including the choices nobody picked. A bar that appears only once
 *     somebody picks it makes the beamer jump, and the canonical index is
 *     what the teacher's screen labels A, B, C — never the per-attempt
 *     shuffle (decision D19);
 *   - a `short` tally folds the spellings (trim, whitespace collapse, case)
 *     but DISPLAYS the first one seen: "Paris", "paris " and "PARIS" are one
 *     line of three, written the way the first participant wrote it.
 */
import { applyTextOptions, foldCase, normalizeInput } from "./short.js";

/** The two question types a poll may run (mirrors `PollQuestionType`). */
export type PollType = "mcq" | "short";

export interface PollChoiceCount {
  /** Canonical index into `config.choices`. */
  index: number;
  count: number;
}

export interface PollAnswerCount {
  /** The first spelling seen for this folded answer. */
  text: string;
  count: number;
}

export interface PollTallyResult {
  joined: number;
  answered: number;
  choices: PollChoiceCount[];
  answers: PollAnswerCount[];
}

export interface PollTallyInput {
  type: PollType;
  /** `config.choices.length`; ignored for `short`. */
  choiceCount: number;
  /** One entry per stored answer payload, in any order. */
  payloads: readonly unknown[];
  /** Attempts opened on the poll (accounts and guests together). */
  joined: number;
  /**
   * How many distinct short answers the result carries. Mirrors
   * `POLL_SHORT_CAP` of `@quiz/contracts`, which is what the API passes; the
   * default is here so the rule is testable on its own.
   */
  shortCap?: number | undefined;
}

export const POLL_SHORT_CAP_DEFAULT = 60;

/** The folding key of a short answer: NFC, collapsed, trimmed, case-folded. */
export function foldPollAnswer(raw: string): string {
  return foldCase(applyTextOptions(normalizeInput(raw)));
}

/** The canonical indices a stored `mcq` payload selected, deduplicated. */
function selectedOf(payload: unknown, choiceCount: number): number[] {
  if (payload === null || typeof payload !== "object") return [];
  const selected = (payload as { selected?: unknown }).selected;
  if (!Array.isArray(selected)) return [];
  const seen = new Set<number>();
  for (const value of selected) {
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (value < 0 || value >= choiceCount) continue;
    seen.add(value);
  }
  return [...seen];
}

/** The stored text of a `short` payload, or null when there is nothing to count. */
function textOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const text = (payload as { text?: unknown }).text;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : text;
}

/**
 * THE tally. `answered` counts the payloads that carry something — an empty
 * short answer is an attempt that has not answered yet, not a blank vote.
 */
export function pollTally(input: PollTallyInput): PollTallyResult {
  const cap = input.shortCap ?? POLL_SHORT_CAP_DEFAULT;
  const choiceCount = Math.max(0, Math.trunc(input.choiceCount));

  if (input.type === "mcq") {
    const counts = new Array<number>(choiceCount).fill(0);
    let answered = 0;
    for (const payload of input.payloads) {
      const selected = selectedOf(payload, choiceCount);
      if (selected.length === 0) continue;
      answered += 1;
      for (const index of selected) counts[index] = (counts[index] ?? 0) + 1;
    }
    return {
      joined: input.joined,
      answered,
      choices: counts.map((count, index) => ({ index, count })),
      answers: [],
    };
  }

  // `short`: fold, count, keep the first spelling, most frequent first.
  const folded = new Map<string, { text: string; count: number; rank: number }>();
  let answered = 0;
  for (const payload of input.payloads) {
    const text = textOf(payload);
    if (text === null) continue;
    answered += 1;
    const key = foldPollAnswer(text);
    const entry = folded.get(key);
    if (entry) entry.count += 1;
    else folded.set(key, { text: text.trim(), count: 1, rank: folded.size });
  }
  const answers = [...folded.values()]
    // Ties keep the order they were first seen in, so a redraw never swaps
    // two lines of equal height under the teacher's eyes.
    .sort((a, b) => b.count - a.count || a.rank - b.rank)
    .slice(0, cap)
    .map(({ text, count }) => ({ text, count }));

  return { joined: input.joined, answered, choices: [], answers };
}
