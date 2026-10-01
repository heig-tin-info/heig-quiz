/*
 * The rows of the grading table (ADR-044), as pure functions: what each
 * answer's verdict glyph says, the order the rows stand in, the filters, the
 * sort and the one primary action they leave. The components only draw what
 * these decide, so each rule is tested once, here.
 */
import type { GradingConfidence, GradingEntry, GradingSource } from "@quiz/contracts";
import { isRetryableReason, reasonOf } from "@quiz/contracts";
import { isBatchable, outcomeOf } from "@quiz/domain";

/** Stable identity of a cell: one grading per (attempt, item). The panel is keyed on it. */
export const entryKey = (e: Pick<GradingEntry, "attemptId" | "itemId">) =>
  `${e.attemptId}:${e.itemId}`;

/** The pinned first row, the key of the question. Selected as index −1. */
export const EXPECTED = "expected";

/** The "no filter" value of the source and confidence controls. */
export const ANY = "any";
export type Any = typeof ANY;

export type StateFilter = "all" | "todo";

export interface RowFilters {
  state: StateFilter;
  source: GradingSource | Any;
  /** Read only while `source` is `llm`: the control exists only then. */
  confidence: GradingConfidence | Any;
}

/** The student gave nothing: graded zero (F-GRADE-01), shown as wrong. */
export const isMissing = (e: Pick<GradingEntry, "answerId" | "answer">) =>
  e.answerId === null && e.answer === null;

export const isValidated = (e: GradingEntry) => e.grading?.state === "validated";
export const isProposed = (e: GradingEntry) => e.grading?.state === "proposed";

/** The batch's own rule (`isBatchable`): a placeholder is validated one by one, after it is read. */
export const canBatch = (e: GradingEntry) => e.grading !== null && isBatchable(e.grading);

/**
 * What the verdict glyph of a row says. `pending` is an answer nothing has
 * judged yet: not graded (the runner, a failed pass) or a 0-point
 * placeholder that waits for a person (an essay). A negative score is
 * wrong, like zero; a missing answer is wrong whatever its grading says.
 */
export type RowVerdict = "correct" | "partial" | "wrong" | "pending";

/** Why a row is pending, for its tooltip. */
export type PendingReason = "ungraded" | "byHand";

export function pendingReason(entry: GradingEntry): PendingReason | null {
  if (isMissing(entry)) return null;
  // A proposal the runner never settled waits for a new pass, not for a
  // person: its remedy is the question's Run grading, not a Grade button.
  if (entry.grading === null || needsPass(entry)) return "ungraded";
  return isProposed(entry) && !canBatch(entry) ? "byHand" : null;
}

/**
 * What a row offers besides opening it: `validate` a proposal the batch
 * could take as it stands, `grade` a 0-point placeholder that waits for a
 * person (an essay) — never validated at zero without being read — or
 * nothing (a validated or ungraded answer; Adjust stays in the panel).
 */
export type RowAction = "validate" | "grade";

export function rowAction(entry: GradingEntry): RowAction | null {
  if (canBatch(entry)) return "validate";
  return pendingReason(entry) === "byHand" ? "grade" : null;
}

export function rowVerdict(entry: GradingEntry): RowVerdict {
  if (isMissing(entry)) return "wrong";
  if (pendingReason(entry) !== null) return "pending";
  // The server's own rule (`verdictOf`): full marks, some, or none — a
  // negative mark (ADR-026) is wrong.
  return outcomeOf(entry.grading!.points, entry.grading!.maxPoints);
}

/**
 * The automatic pass still has something to do on this answer: nothing
 * graded it yet, or a machine left a proposal a new pass may clear (the
 * runner was away, a grader failed). An essay's 0-point proposal is not one
 * of them — a person grades it — and neither is a question's own fault (a
 * failing reference), which a pass would only repeat.
 */
export const needsPass = (e: GradingEntry) =>
  e.grading === null || (isProposed(e) && isRetryableReason(reasonOf(e.grading.details)));

const VERDICT_RANK: Record<RowVerdict, number> = { wrong: 0, partial: 1, pending: 2, correct: 3 };
export const verdictRank = (entry: GradingEntry) => VERDICT_RANK[rowVerdict(entry)];

// --- Order -------------------------------------------------------------------

/** FNV-1a: a string to 32 bits, the same on every browser. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The anonymised order: each row's place is a hash of the visit's seed, the
 * item and the attempt — of the ROW, never of its position in a list. A
 * validation, a refetch or a filter changes the list and moves no row: the
 * order is the same for the whole visit, and another one on the next visit
 * (ADR-044). The names never decide it, so the order cannot give them away.
 */
export function shuffled(entries: readonly GradingEntry[], seed: number): GradingEntry[] {
  const rank = new Map(entries.map((e) => [e, hash(`${seed}:${entryKey(e)}`)]));
  return [...entries].sort(
    (a, b) => rank.get(a)! - rank.get(b)! || (entryKey(a) < entryKey(b) ? -1 : 1),
  );
}

/**
 * Names shown: by name, the order a teacher looks a student up in; the
 * guests (who have a number, not a name) after them, in their order.
 */
export function byName(entries: readonly GradingEntry[]): GradingEntry[] {
  return [...entries].sort(
    (a, b) =>
      (a.guest ?? 0) - (b.guest ?? 0) ||
      (a.label ?? "").localeCompare(b.label ?? "") ||
      (a.attemptNumber ?? 0) - (b.attemptNumber ?? 0),
  );
}

export function filterRows(entries: readonly GradingEntry[], f: RowFilters): GradingEntry[] {
  return entries.filter(
    (e) =>
      (f.state === "all" || !isValidated(e)) &&
      (f.source === ANY || e.grading?.source === f.source) &&
      (f.source !== "llm" || f.confidence === ANY || e.grading?.confidence === f.confidence),
  );
}

// --- Sort --------------------------------------------------------------------

export interface Sort {
  key: string;
  dir: 1 | -1;
}

/** A header clicked: ascending, then descending, then back to the base order. */
export function nextSort(sort: Sort | null, key: string): Sort | null {
  if (sort?.key !== key) return { key, dir: 1 };
  return sort.dir === 1 ? { key, dir: -1 } : null;
}

/**
 * The rows sorted by `valueOf`, STABLE over the order they came in: two rows
 * with the same value keep their base order in both directions, so sorting
 * by a column never reshuffles the answers that are alike.
 */
export function sortRows<T>(
  rows: readonly T[],
  sort: Sort | null,
  valueOf: (row: T, key: string) => string | number,
): T[] {
  if (sort === null) return [...rows];
  const compare = (x: string | number, y: string | number) =>
    typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
  return rows
    .map((row, i) => ({ row, i, v: valueOf(row, sort.key) }))
    .sort((a, b) => compare(a.v, b.v) * sort.dir || a.i - b.i)
    .map((x) => x.row);
}

// --- Selection ---------------------------------------------------------------

/**
 * The row `delta` places from the selection, the expected row being −1.
 * `lastIndex` is where the selection stood the last time it was visible: a
 * row validated under "To validate" leaves the table, and ↓ must then land
 * on the row that took its place, not jump back to the top.
 */
export function moveSelection(
  rows: readonly GradingEntry[],
  selected: string | null,
  lastIndex: number,
  delta: number,
): string {
  const keys = [EXPECTED, ...rows.map(entryKey)];
  const at = keys.indexOf(selected ?? "");
  // Positions in `keys` are the table index + 1 (the expected row is 0).
  const from =
    at >= 0 ? at : selected === null ? (delta > 0 ? 0 : 1) : lastIndex + 1 - (delta > 0 ? 1 : 0);
  return keys[Math.min(keys.length - 1, Math.max(0, from + delta))]!;
}

// --- The one primary action --------------------------------------------------

export type PrimaryAction =
  | { kind: "validate"; count: number }
  /** Something is left but nothing shown can go in a batch. */
  | { kind: "blocked"; reason: "hidden" | "byHand" }
  | { kind: "next" }
  | { kind: "results" };

/**
 * The single accent action of the screen, decided from the answers of the
 * question (`all`) and those the filters leave on screen (`visible`):
 * validate what is shown; else, once nothing is left, go on to the next
 * question, or to the results after the last one. In between — answers left
 * that no batch may validate — the button stays, disabled, saying why.
 */
export function primaryAction(
  all: readonly GradingEntry[],
  visible: readonly GradingEntry[],
  isLast: boolean,
): PrimaryAction {
  const count = visible.filter(canBatch).length;
  if (count > 0) return { kind: "validate", count };
  const left = all.filter((e) => !isValidated(e));
  if (left.length > 0)
    return { kind: "blocked", reason: left.some(canBatch) ? "hidden" : "byHand" };
  return isLast ? { kind: "results" } : { kind: "next" };
}

// --- The answer panel ------------------------------------------------------

/** What the panel shows: one answer, or the question's key (the expected row). */
export type PanelTarget =
  | { kind: "entry"; entry: GradingEntry; adjust: boolean }
  | { kind: "expected" };

/**
 * The panel's content from its KEY, never from a row index: the entry is
 * looked up among every answer of the question, filtered or not, so an
 * answer that left the table (validated under "To validate") stays open.
 * `null` while the key names nothing (the answers are loading).
 */
export function panelTarget(
  panel: { key: string; adjust: boolean } | null,
  entries: readonly GradingEntry[],
): PanelTarget | null {
  if (panel === null) return null;
  if (panel.key === EXPECTED) return { kind: "expected" };
  const entry = entries.find((e) => entryKey(e) === panel.key);
  return entry ? { kind: "entry", entry, adjust: panel.adjust } : null;
}
