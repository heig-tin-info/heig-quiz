/**
 * The agreement figures of an evaluation's grading: ADR-139 §15 defines
 * them and how each path of the grading history counts. Pure: the caller
 * produces the rows — one per compared cell (the cell's latest proposal,
 * none when that one is a failed call, beside the validated grading in
 * force) and one per contestation — and {@link evaluationFigures} assembles
 * each question's figures and the whole evaluation's. A figure with
 * nothing to count is `null`: no "0 %" on an empty set.
 */
import { LLM_CONFIDENCES, type LlmConfidence } from "@quiz/core/llm";

import { GRADING_SOURCES } from "./batchable.js";
import type { ContestationState } from "./contestation.js";
import { round2 } from "./round.js";

type GradingSource = (typeof GRADING_SOURCES)[number];

/** One compared cell of an item: the model's proposal and the validated grading in force. */
export interface AgreementRow {
  itemId: string;
  proposal: number;
  inForce: number;
  confidence: LlmConfidence;
}

/** How a set of compared cells came out. */
export interface AgreementTally {
  /** Cells compared: `unchanged + changed`. */
  compared: number;
  unchanged: number;
  changed: number;
  /** Mean of |in force − proposal| over the changed cells, two decimals; `null` when none changed. */
  meanAbsDelta: number | null;
}

/** {@link AgreementTally} over every compared cell, and per confidence (`null`: no cell of it). */
export interface AiAgreement extends AgreementTally {
  byConfidence: Record<LlmConfidence, AgreementTally | null>;
}

/**
 * One contestation of an item: where it stands, and the source of the
 * grading in force when it was filed (`null`: that grading is gone, it
 * counts in no source).
 */
export interface ContestationRow {
  itemId: string;
  state: ContestationState;
  source: GradingSource | null;
}

/** Contestations filed, and how many of them the owner accepted. */
export interface ContestedCount {
  filed: number;
  accepted: number;
}

export interface ContestationTally extends ContestedCount {
  /** The denominator: the graded cells of the class (a validated grading in force). */
  graded: number;
  open: number;
  refused: number;
  /** Per source of the contested grading (automatic, the AI's, a teacher's): filed and accepted. */
  bySource: Record<GradingSource, ContestedCount>;
}

/** One question's figures, or the whole evaluation's. */
export interface GradingFigures {
  agreement: AiAgreement | null;
  contestations: ContestationTally | null;
}

function tally(rows: readonly AgreementRow[]): AgreementTally {
  let changed = 0;
  let sum = 0;
  for (const row of rows) {
    // Both sides are stored to the cent (`numeric(6,2)`): compared as such.
    const delta = Math.abs(round2(row.inForce) - round2(row.proposal));
    if (delta === 0) continue;
    changed += 1;
    sum += delta;
  }
  return {
    compared: rows.length,
    unchanged: rows.length - changed,
    changed,
    meanAbsDelta: changed === 0 ? null : round2(sum / changed),
  };
}

/** The agreement of `rows`; `null` when no cell is compared. */
function aiAgreement(rows: readonly AgreementRow[]): AiAgreement | null {
  if (rows.length === 0) return null;
  const byConfidence = Object.fromEntries(
    LLM_CONFIDENCES.map((level) => {
      const own = rows.filter((row) => row.confidence === level);
      return [level, own.length === 0 ? null : tally(own)];
    }),
  ) as Record<LlmConfidence, AgreementTally | null>;
  return { ...tally(rows), byConfidence };
}

const contested = (rows: readonly ContestationRow[]): ContestedCount => ({
  filed: rows.length,
  accepted: rows.filter((row) => row.state === "accepted").length,
});

/** The contestations of `rows` over `graded` cells; `null` when none was filed. */
function contestationTally(rows: readonly ContestationRow[], graded: number): ContestationTally | null {
  if (rows.length === 0) return null;
  return {
    ...contested(rows),
    graded,
    open: rows.filter((row) => row.state === "open").length,
    refused: rows.filter((row) => row.state === "refused").length,
    bySource: Object.fromEntries(
      GRADING_SOURCES.map((source) => [source, contested(rows.filter((row) => row.source === source))]),
    ) as Record<GradingSource, ContestedCount>,
  };
}

function groupByItem<R extends { itemId: string }>(rows: readonly R[]): Map<string, R[]> {
  const out = new Map<string, R[]>();
  for (const row of rows) {
    const list = out.get(row.itemId);
    if (list) list.push(row);
    else out.set(row.itemId, [row]);
  }
  return out;
}

/**
 * Each question's figures and the whole evaluation's, from the same rows:
 * `itemIds` are the questions read (the total covers them alone), `graded`
 * the graded cells per item, the contestations' denominator.
 */
export function evaluationFigures(
  itemIds: readonly string[],
  compared: readonly AgreementRow[],
  filed: readonly ContestationRow[],
  graded: ReadonlyMap<string, number>,
): { byItem: Map<string, GradingFigures>; total: GradingFigures } {
  const items = new Set(itemIds);
  const ownCompared = compared.filter((row) => items.has(row.itemId));
  const ownFiled = filed.filter((row) => items.has(row.itemId));
  const comparedBy = groupByItem(ownCompared);
  const filedBy = groupByItem(ownFiled);
  const gradedOf = (id: string) => graded.get(id) ?? 0;
  return {
    byItem: new Map(
      itemIds.map((id) => [
        id,
        {
          agreement: aiAgreement(comparedBy.get(id) ?? []),
          contestations: contestationTally(filedBy.get(id) ?? [], gradedOf(id)),
        },
      ]),
    ),
    total: {
      agreement: aiAgreement(ownCompared),
      contestations: contestationTally(
        ownFiled,
        itemIds.reduce((sum, id) => sum + gradedOf(id), 0),
      ),
    },
  };
}
