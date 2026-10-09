/**
 * The state machine (§5.1): the table of legal moves, the guards, and the
 * compare-and-set that applies a move to the row.
 */
import { and, eq } from "drizzle-orm";

import type { EvaluationState } from "@quiz/contracts";
import {
  evaluationTotal,
  lacksGradedPoints,
  missingTimingFields,
  pastTiming,
  type PastTiming,
} from "@quiz/domain";

import { isUniqueViolation, type Db } from "../../db/client.js";
import { evaluationItems, evaluations } from "../../db/schema.js";
import {
  type EvaluationRecord,
  type DbOrTx,
  EvaluationError,
  IllegalTransition,
  refusePastTiming,
} from "./shared.js";
import { byId, settingsOf, attemptCount } from "./reads.js";
import { announceMove } from "./announce.js";

/**
 * The legal moves. `closed → draft` is the "reopen" arrow of §5.1 and is
 * guarded by "no attempt exists"; `closed → grading → closed → released`
 * belongs to WP6 and is listed so the table stays the one definition.
 */
const TRANSITIONS: Readonly<Record<EvaluationState, readonly EvaluationState[]>> = {
  draft: ["scheduled", "lobby", "running"],
  scheduled: ["draft", "lobby", "running", "closed"],
  lobby: ["draft", "running", "closed"],
  running: ["paused", "closed"],
  paused: ["running", "closed"],
  closed: ["draft", "grading", "released"],
  grading: ["closed", "released"],
  // `released → closed` is the withdrawal of a release (`unreleaseResults`).
  released: ["released", "closed"],
};

export function isLegalTransition(from: EvaluationState, to: EvaluationState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** What readiness reads of the item list: how many, and what counts (ADR-052). */
export type ReadyItems = readonly { points: number; bonus: boolean }[];

interface TransitionContext {
  items: ReadyItems;
  attemptCount: number;
  /** The server's clock: a time already past is refused against it (#178). */
  now: Date;
}

/**
 * Why an otherwise legal move is refused. Separated from
 * {@link isLegalTransition} so the error tells a teacher what to fix.
 */
export function guardTransition(
  row: EvaluationRecord,
  to: EvaluationState,
  ctx: TransitionContext,
): void {
  const from = row.state;
  if (!isLegalTransition(from, to)) throw new IllegalTransition(from, to);
  assertReady(row, to, ctx.items);
  refusePastTiming(from, to, pastTimingOf(row, to, ctx.now));
  if (to === "paused" && row.mode !== "exam") {
    throw new IllegalTransition(from, to, "only an exam can be paused");
  }
  if (to === "draft" && ctx.attemptCount > 0) {
    throw new IllegalTransition(from, to, "an attempt exists: the evaluation cannot be reopened");
  }
}

/**
 * `pastTiming` (#178) for a move of `row` to `to`: what the guard refuses,
 * and what the ticker's own openings leave where they are.
 */
export function pastTimingOf(row: EvaluationRecord, to: EvaluationState, now: Date): PastTiming | null {
  return pastTiming(row, row.state, to, now);
}

/**
 * The half of {@link guardTransition} that says whether the evaluation, as
 * it stands, is READY to be in `to`: questions, a total that is not 0 once
 * the bonus items are left out (ADR-052), a complete timing, and an opening
 * time for `scheduled`. Also what a pull of a template revision
 * re-checks on a scheduled evaluation (F-EVAL-26), whose questions it
 * replaces while it stays scheduled — with the same refusal.
 */
export function assertReady(row: EvaluationRecord, to: EvaluationState, items: ReadyItems): void {
  if (to === "scheduled" || to === "lobby" || to === "running") {
    if (items.length === 0) {
      throw new IllegalTransition(row.state, to, "an evaluation needs at least one question", {
        reason: "no_items",
      });
    }
    if (lacksGradedPoints(row.mode, evaluationTotal(items))) {
      throw new IllegalTransition(
        row.state,
        to,
        "no question counts towards the total: every one is a bonus or worth 0 (ADR-052)",
        { reason: "no_graded_points" },
      );
    }
  }
  assertTimingReady(row, to);
}

/**
 * What a patch of a `scheduled` evaluation must leave behind (#178, #254):
 * one the guard would still schedule — a complete timing, an opening time,
 * nothing already past. Cleared or moved into the past, the ticker would
 * leave it scheduled forever, or open or close it at its next pass.
 */
export function assertStaysScheduled(row: EvaluationRecord, now: Date): void {
  assertTimingReady(row, "scheduled");
  refusePastTiming("scheduled", "scheduled", pastTimingOf(row, "scheduled", now));
}

/** The timing half of {@link assertReady}: complete for `to`, and an opening time for `scheduled`. */
function assertTimingReady(row: EvaluationRecord, to: EvaluationState): void {
  const from = row.state;
  if (to === "scheduled" || to === "lobby" || to === "running") {
    // F-EVAL-04 and decision D8, the same rule the configuration screen
    // applies before it lets the teacher reach the launch step (#76). This
    // check stays as the defence: the screen is not the only client.
    const missing = missingTimingFields({
      mode: row.mode,
      timing: settingsOf(row).timing,
      durationS: row.durationS,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
    });
    if (missing.length > 0) {
      throw new IllegalTransition(
        from,
        to,
        `the timing settings are incomplete (F-EVAL-04): ${missing.join(", ")}`,
        { reason: "timing_incomplete", missing },
      );
    }
  }
  // The ticker opens a scheduled evaluation at `opensAt` and at nothing else:
  // scheduled without one, it would wait forever (#152).
  if (to === "scheduled" && row.opensAt === null) {
    throw new IllegalTransition(from, to, "a scheduled evaluation needs an opening time", {
      reason: "opens_at_missing",
    });
  }
}
/**
 * Applies a state change with its side effects on the row itself, ONLY if the
 * row is still in the state the caller read. `null` means somebody else moved
 * it first — a double-clicked `POST /resume`, or a second ticker process
 * under `WORKER_MODE` — and the caller must then skip its own side effects,
 * because they have already been applied once (a second `pausedFor` would
 * double every deadline).
 *
 * The side effects on the ATTEMPTS (starting them, shifting their deadlines,
 * expiring them) belong to `modules/live/service.ts`, which calls this.
 */
export async function tryApplyState(
  db: DbOrTx,
  row: EvaluationRecord,
  to: EvaluationState,
  now: Date,
  closedBy: "server" | "teacher" = "teacher",
): Promise<EvaluationRecord | null> {
  const next: Partial<typeof evaluations.$inferInsert> = { state: to, updatedAt: now };
  if (to === "running") {
    if (row.startedAt === null) next.startedAt = now;
    next.pausedAt = null;
  }
  if (to === "paused") next.pausedAt = now;
  // The end of the RUN, once: a withdrawn release (`released → closed`)
  // keeps the instant and the hand that closed it.
  if (to === "closed" && row.closedAt === null) {
    next.closedAt = now;
    next.closedBy = closedBy;
  }
  if (to === "draft") {
    // A reopened evaluation forgets that it ever ran; no attempt exists, so
    // there is nothing whose clock those instants would contradict.
    next.startedAt = null;
    next.pausedAt = null;
    next.closedAt = null;
    next.closedBy = null;
    next.gradingReadyAt = null;
    // `closed → draft` needs no attempt: a correction published during that
    // run was nobody's, and the next run starts unpublished (ADR-050).
    next.correctionPublishedAt = null;
  }
  const updated = await db
    .update(evaluations)
    .set(next)
    // The compare-and-set: the row must still be where the caller saw it.
    .where(and(eq(evaluations.id, row.id), eq(evaluations.state, row.state)))
    .returning({ id: evaluations.id })
    .catch((err: unknown) => {
      if (isUniqueViolation(err, "evaluations_running_poll_code_uq")) throw new EvaluationError("code_taken");
      throw err;
    });
  if (updated.length === 0) return null;
  return (await byId(db, row.id))!;
}

/**
 * {@link tryApplyState} for a caller with nothing to undo: it hands back the
 * row as it stands, moved or already moved by somebody else.
 */
export async function applyState(
  db: DbOrTx,
  row: EvaluationRecord,
  to: EvaluationState,
  now: Date,
  closedBy?: "server" | "teacher",
): Promise<EvaluationRecord> {
  return (await tryApplyState(db, row, to, now, closedBy)) ?? (await byId(db, row.id))!;
}

/**
 * The authoring transitions of §4.3; guards included. A move this call made
 * (not one somebody else made first) is announced to the students
 * (`announceMove`), after it has committed.
 */
export async function transition(
  db: Db,
  row: EvaluationRecord,
  to: EvaluationState,
  now: Date,
): Promise<EvaluationRecord> {
  if (row.mode === "poll") throw new EvaluationError("not_implemented");
  const items = await db
    .select({ points: evaluationItems.points, bonus: evaluationItems.bonus })
    .from(evaluationItems)
    .where(eq(evaluationItems.evaluationId, row.id));
  guardTransition(row, to, {
    items,
    attemptCount: await attemptCount(db, row.id),
    now,
  });
  const moved = await tryApplyState(db, row, to, now);
  if (moved === null) return (await byId(db, row.id))!;
  await announceMove(db, moved, now);
  return moved;
}
