/**
 * The single writer of gradings (§5.4): every grading, whoever produced it,
 * goes through {@link writeGradings}.
 */
import { randomUUID } from "node:crypto";

import { and, eq, ne, or, sql } from "drizzle-orm";

import type { GradingConfidence, GradingSource, GradingState } from "@quiz/contracts";
import { round2 } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { gradings } from "../../db/schema.js";
import { flagReleasedEvaluationsOf } from "../evaluation/service.js";
import { watchReleasedGrades } from "../results/service.js";
import { pairKey, type GradingRecord, type PairKey } from "./records.js";

// --- The single writer ----------------------------------------------------

export interface WriteGradingInput {
  attemptId: string;
  itemId: string;
  /** Null when the student never answered (F-GRADE-01). */
  answerId: string | null;
  points: number;
  maxPoints: number;
  source: GradingSource;
  state: Exclude<GradingState, "superseded">;
  details?: unknown;
  confidence?: GradingConfidence | undefined;
  comment?: string | undefined;
  gradedBy?: string | undefined;
  regradeNote?: string | undefined;
  now: Date;
}

/**
 * THE write (§5.4), for one cell: {@link writeGradings} with a batch of one.
 */
export async function writeGrading(db: Db, input: WriteGradingInput): Promise<GradingRecord> {
  const [row] = await writeGradings(db, [input]);
  return row!;
}

/** Cells per transaction: well under PostgreSQL's 65 535 bind parameters (16 per row). */
const WRITE_CHUNK = 500;

/**
 * THE write (§5.4), for many cells. Per chunk of {@link WRITE_CHUNK}, in one
 * transaction and two statements:
 *
 * ```sql
 * UPDATE gradings SET state='superseded'
 *  WHERE state <> 'superseded' AND (attempt_id, item_id) IN (<cells>) …
 *  RETURNING id, attempt_id, item_id;
 * INSERT INTO gradings (…, supersedes_id = <what that cell just lost>) VALUES (…), (…);
 * ```
 *
 * A new `validated` grading supersedes everything still standing on its
 * cell. A new `proposed` one only supersedes a previous PROPOSAL: a proposal
 * must never quietly unseat a grade a teacher already validated, and the
 * callers that produce proposals skip a validated cell anyway (idempotency).
 * A cell appears at most once per batch — the supersede chain of a cell is
 * built from ONE row per cell, so a duplicate throws before anything is
 * written; `gradings_pair_validated_uq` still refuses a second validated
 * grading on one cell.
 *
 * The rows come back in the order of `inputs`.
 *
 * `guard`, when given, runs first inside each chunk's transaction and returns
 * the inputs to write: it may drop an input or amend its `details`, never its
 * cell, state or points (`results_updated` is read before it). The grading
 * jobs lock the attempts there and drop the cells of one reopened meanwhile
 * (ADR-067); an override keeps the proposal it replaces there (ADR-118 §6).
 * The rows of the dropped inputs are simply not returned.
 */
export async function writeGradings(
  db: Db,
  inputs: readonly WriteGradingInput[],
  guard?: WriteGuard,
): Promise<GradingRecord[]> {
  const seen = new Set<PairKey>();
  for (const input of inputs) {
    const key = pairKey(input.attemptId, input.itemId);
    if (seen.has(key)) {
      throw new Error(`writeGradings: cell ${key} appears twice in one batch`);
    }
    seen.add(key);
  }
  // `results_updated` (ADR-030 §h.4): the grade each student is shown on a
  // RELEASED evaluation, read before the write and compared after the
  // commit — once per write, not per cell, and never inside the transaction
  // (§1). Only a validated grading counts towards a grade.
  const watch = await watchReleasedGrades(
    db,
    inputs.filter((i) => i.state === "validated"),
  );
  const out: GradingRecord[] = [];
  for (let start = 0; start < inputs.length; start += WRITE_CHUNK) {
    out.push(...(await writeChunk(db, inputs.slice(start, start + WRITE_CHUNK), guard)));
  }
  await watch.announce();
  return out;
}

/**
 * The inputs to write, decided inside the write's transaction: it may drop
 * an input or amend its `details`, never its cell, state or points
 * (`results_updated` is read before it; see {@link writeGradings}).
 */
export type WriteGuard = (
  tx: Tx,
  inputs: readonly WriteGradingInput[],
) => Promise<readonly WriteGradingInput[]>;

async function writeChunk(
  db: Db,
  chunk: readonly WriteGradingInput[],
  guard: WriteGuard | undefined,
): Promise<GradingRecord[]> {
  return db.transaction(async (tx) => {
    const inputs = guard ? await guard(tx, chunk) : chunk;
    if (inputs.length === 0) return [];
    const cells = (state: WriteGradingInput["state"]) => {
      const pairs = inputs
        .filter((i) => i.state === state)
        .map((i) => sql`(${i.attemptId}::uuid, ${i.itemId}::uuid)`);
      return pairs.length === 0
        ? sql`false`
        : sql`(${gradings.attemptId}, ${gradings.itemId}) in (${sql.join(pairs, sql`, `)})`;
    };
    const superseded = await tx
      .update(gradings)
      .set({ state: "superseded" })
      .where(
        and(
          ne(gradings.state, "superseded"),
          or(cells("validated"), and(cells("proposed"), eq(gradings.state, "proposed"))),
        ),
      )
      .returning({
        id: gradings.id,
        attemptId: gradings.attemptId,
        itemId: gradings.itemId,
        gradedAt: gradings.gradedAt,
      });
    // The chain points at the grading this one REPLACES; when several were
    // still standing on a cell (a proposal next to nothing else), the newest
    // wins.
    const previous = new Map<PairKey, { id: string; gradedAt: Date }>();
    for (const row of superseded) {
      const key = pairKey(row.attemptId, row.itemId);
      const held = previous.get(key);
      if (!held || row.gradedAt >= held.gradedAt) previous.set(key, row);
    }
    const values = inputs.map((input) => ({
      id: randomUUID(),
      answerId: input.answerId,
      attemptId: input.attemptId,
      itemId: input.itemId,
      points: round2(input.points),
      maxPoints: round2(input.maxPoints),
      source: input.source,
      state: input.state,
      details: input.details ?? null,
      confidence: input.confidence ?? null,
      comment: input.comment ?? null,
      gradedBy: input.gradedBy ?? null,
      gradedAt: input.now,
      supersedesId: previous.get(pairKey(input.attemptId, input.itemId))?.id ?? null,
      regradeNote: input.regradeNote ?? null,
      createdAt: input.now,
    }));
    const rows = await tx.insert(gradings).values(values).returning();
    // A validated grading on a released evaluation changes a published
    // grade: F-GRADE-09's flag goes up here, in the same transaction, for
    // every caller at once (the panel, the automatic pass, the runner job).
    const validated = inputs.filter((i) => i.state === "validated");
    if (validated.length > 0) {
      await flagReleasedEvaluationsOf(
        tx,
        [...new Set(validated.map((i) => i.attemptId))],
        validated[0]!.now,
      );
    }
    // RETURNING order is not promised by SQL: put the rows back in input order.
    const byId = new Map(rows.map((r) => [r.id, r]));
    return values.map((v) => byId.get(v.id)!);
  });
}
