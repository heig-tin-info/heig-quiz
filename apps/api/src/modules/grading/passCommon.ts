/**
 * What the three grading passes share (`jobs.ts`): their job payloads, the
 * failed proposal, the guard of every write of theirs (ADR-067) and the
 * validated-cell check.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { LlmGradeRequest, RunnerRequest } from "@quiz/core/server";
import type { PassReason } from "@quiz/contracts";
import { checkAllowed, gradableNow } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { answers, attempts, evaluations, gradings } from "../../db/schema.js";
import type { DbOrTx } from "../evaluation/service.js";
import { pairKey, type PairKey } from "./records.js";
import type { WriteGuard } from "./writer.js";

export type AttemptRecord = typeof attempts.$inferSelect;

/**
 * Every machine reason a pass leaves on a grading it could not settle. They
 * are wire values, closed once in `@quiz/contracts` (`PASS_REASONS`): the
 * web translates each of them, and `progressOf` counts them.
 */
export type ProposalReason = PassReason;

/**
 * A proposal worth zero that says why no grader settled the cell — never a
 * crash and never a silent zero: a teacher decides (§5.4). The reason goes in
 * `details` (what `reasonOf` reads) and in `comment` (what the panel shows).
 */
export const failedProposal = (reason: ProposalReason, source: "auto" | "llm" = "auto") => ({
  points: 0,
  source,
  state: "proposed" as const,
  details: { reason },
  comment: reason,
});

export interface EvaluationGradingJob {
  evaluationId: string;
  /** Restricts the pass to these items; omitted = the whole evaluation. */
  itemIds?: string[];
  /**
   * Restricts the pass to these attempts; omitted = every attempt. One
   * attempt closed by the teacher after the evaluation's own close (#95).
   */
  attemptIds?: string[];
  /** Stamped on every grading this pass writes (F-GRADE-06). */
  regradeNote?: string;
}

export interface RunnerGradingJob {
  evaluationId: string;
  attemptId: string;
  itemId: string;
  answerId: string | null;
  /**
   * The answer's revision the request was built from (ADR-067). Absent on a
   * job queued before ADR-067 was deployed: such a job is taken as current,
   * since nothing would send it again once its evaluation is closed.
   */
  revision?: number;
  request: RunnerRequest;
  /**
   * The pending result's `finalizeState`, carried opaquely to `finalizeRunner`
   * (ADR-096). Absent on a job queued before it existed, or for a type that
   * returns none; the type then reads the outcome as it did before.
   */
  finalizeState?: unknown;
  regradeNote?: string;
}

export interface LlmGradingJob {
  evaluationId: string;
  attemptId: string;
  itemId: string;
  answerId: string;
  /** As the type built it; `runLlmGrading`, the one way to the model, masks it. */
  request: LlmGradeRequest;
  /** The type's own details, kept beside the model's reply. */
  details?: unknown;
  regradeNote?: string;
  /**
   * ADR-122 §6: the attempt is a practice one after the due date — the
   * model's successful reply is then its result, validated. Absent: false.
   */
  practice?: boolean;
}


/**
 * The guard of every grading write of the jobs (ADR-067): locks the attempts
 * of the cells, in id order, re-reads their state and their evaluation's
 * under the lock, and keeps the cells still {@link gradableNow}. A reopen
 * takes the same row lock before it stands the attempt's automatic gradings
 * down (`reopenAttempt`), so a pass that loaded an attempt finished either
 * commits first — and the stand-down supersedes what it wrote — or sees the
 * attempt reopened here and writes nothing on it.
 *
 * `loadedEnd` is each attempt's `closedAt` as the pass loaded it. A reopen
 * clears it and the next hand-in writes a new one, so an attempt reopened
 * AND handed in again between the pass's load and its write — finished
 * again, but on other answers — is dropped too: its own hand-in grades it.
 */
export function passGuard(loadedEnd?: ReadonlyMap<string, number | null>): WriteGuard {
  return async (tx, inputs) => {
    const ids = [...new Set(inputs.map((i) => i.attemptId))];
    if (ids.length === 0) return inputs;
    const rows = await tx
      .select({
        id: attempts.id,
        state: attempts.state,
        afterDue: attempts.afterDue,
        closedAt: attempts.closedAt,
        evaluationState: evaluations.state,
        mode: evaluations.mode,
      })
      .from(attempts)
      .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
      .where(inArray(attempts.id, ids))
      .orderBy(attempts.id)
      .for("update", { of: attempts });
    const loaded = new Map(
      rows
        .filter((r) => loadedEnd === undefined || loadedEnd.get(r.id) === endOf(r.closedAt))
        .map((r) => [r.id, r]),
    );
    // ADR-124 §3: the checked questions among the cells, read under the same
    // lock — a checked cell is gradable while its attempt is still open.
    // Only an exercise is checked: no read for an exam's or a poll's pass.
    const exercises = [...loaded.values()].filter((r) => checkAllowed(r.mode)).map((r) => r.id);
    const checked = await checkedCells(tx, exercises);
    return inputs.filter((i) => {
      const r = loaded.get(i.attemptId);
      return (
        r !== undefined &&
        gradableNow(r.evaluationState, r, { mode: r.mode, checked: checked.has(pairKey(i.attemptId, i.itemId)) })
      );
    });
  };
}

/** The checked cells (ADR-124 §3) of these attempts. */
async function checkedCells(db: DbOrTx, attemptIds: readonly string[]): Promise<Set<PairKey>> {
  if (attemptIds.length === 0) return new Set();
  const rows = await db
    .select({ attemptId: answers.attemptId, itemId: answers.itemId })
    .from(answers)
    .where(and(inArray(answers.attemptId, [...attemptIds]), isNotNull(answers.checkedAt)));
  return new Set(rows.map((r) => pairKey(r.attemptId, r.itemId)));
}

export const endOf = (closedAt: Date | null): number | null => closedAt?.getTime() ?? null;

/** Whether one cell holds a validated grading. */
export async function isValidated(db: Db, attemptId: string, itemId: string): Promise<boolean> {
  const rows = await db
    .select({ id: gradings.id })
    .from(gradings)
    .where(
      and(
        eq(gradings.attemptId, attemptId),
        eq(gradings.itemId, itemId),
        eq(gradings.state, "validated"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
