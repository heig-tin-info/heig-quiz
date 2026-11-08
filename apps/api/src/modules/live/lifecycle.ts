/**
 * An attempt from its creation to its start: the first attempt, a retake
 * (ADR-025, ADR-091), the start that fixes the deadline, and entering an
 * evaluation (F-LIVE-01, ADR-076).
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";

import type { AttemptView, LobbyView, ReadyView } from "@quiz/contracts";
import {
  acquiredItems,
  isEvaluationOpen,
  isFinishedAttempt,
  latestAttempt,
  partialRetakeRefusal,
  retakeRefusal,
  type RetakeScope,
} from "@quiz/domain";

import type { StoredInstance } from "../../db/columns.js";
import type { Db } from "../../db/client.js";
import { answers, attempts, evaluations } from "../../db/schema.js";
import {
  joinedItems,
  parameterizedItems,
  retakePolicyOf,
  type DbOrTx,
  type EvaluationRecord,
} from "../evaluation/service.js";
import {
  copyGradings,
  standingsOf,
  validatedOfAttempt,
  type GradingRecord,
} from "../grading/service.js";
import { instanceOf } from "../pool/service.js";
import {
  attemptById,
  attemptOf,
  ownerOf,
  seatOf,
  type AttemptRecord,
  type Participant,
} from "./access.js";
import { deadlineFor } from "./deadline.js";
import * as events from "./events.js";
import { LiveError, RetakeRefused } from "./failures.js";
import { attemptOrLobbyView, readyView } from "./views.js";

/**
 * A 32-bit seed, drawn once per attempt and never stored per permutation
 * (D19) — and once per drill review (ADR-041 §10, (i)).
 */
export function drawSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * The values of every parameterized item of a new attempt (ADR-056 §5),
 * drawn ONCE, here, from the attempt's seed and stored with it: the paper is
 * rendered from the seed alone before any answer exists, so the values
 * cannot wait for one. `{}` when no item declares variables — the common
 * case, which costs one indexed read.
 */
export async function drawInstances(
  db: DbOrTx,
  evaluation: EvaluationRecord,
  seed: number,
): Promise<Record<string, StoredInstance>> {
  // A poll never holds a parameterized question (ADR-056 §10): nothing to read.
  if (evaluation.mode === "poll") return {};
  const items = await parameterizedItems(db, evaluation.id);
  const out: Record<string, StoredInstance> = {};
  for (const item of items) {
    const { stored } = instanceOf(item.question.type, item.version, { seed, itemId: item.item.id });
    if (stored !== null) out[item.item.id] = stored;
  }
  return out;
}

/**
 * Idempotent creation of the FIRST attempt. The unique index
 * `(evaluation_id, user_id, attempt_number)` is the mechanism: a second call
 * inserts number 1 again, is refused, and reads the row that is already
 * there, so two tabs opened at the same second share one seed, one start and
 * one deadline. A retake is {@link retakeAttempt}, never this.
 *
 * It is called only once the participant is admitted (ADR-076): by the lobby
 * or paused entry, by a trusted client's entry, or by the explicit Start
 * (`enterEvaluation` with `start`) — never by a mere look at a running evaluation,
 * which answers the ready screen and writes nothing.
 */
export async function ensureAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  participant: Participant,
  now: Date,
): Promise<AttemptRecord> {
  // `returning()` is what tells the two apart: an empty array means the
  // unique index refused the insert, so this call created nothing and must
  // not announce a new row to the dashboard.
  const seed = drawSeed();
  const created = await db
    .insert(attempts)
    .values({
      id: randomUUID(),
      evaluationId: evaluation.id,
      ...ownerOf(participant),
      state: "not_started",
      seed,
      instances: await drawInstances(db, evaluation, seed),
      presentAt: now,
      createdAt: now,
      updatedAt: now,
    })
    // A guest is keyed on `(evaluation_id, guest_id)`, an account on
    // `(evaluation_id, user_id, attempt_number)` and on its one unfinished
    // attempt: whichever index refuses, the same idempotency. No target, so
    // the partial index of the unfinished attempt counts too.
    .onConflictDoNothing()
    .returning({ id: attempts.id });
  const row = await attemptOf(db, evaluation.id, participant);
  if (!row) throw new LiveError("internal_error", "attempt vanished after insert");
  // F-DASH-03: the teacher's grid learns the row exists the moment it does,
  // not at the next refetch. A guest has no roster row to light up.
  if (created.length > 0 && row.userId !== null) {
    events.attemptRowChanged(evaluation.id, row);
    // A STAFF seat has no row in the grid until it holds an attempt (ADR-018,
    // decision 3), so the frame above has nothing to land on: the grid is one
    // ROW short, not one cell stale. There is no typed frame for a row that
    // came into existence, so the dashboards re-read — the same answer
    // `attemptRemoved` gives for a row that ceased to exist.
    const seat = await seatOf(db, evaluation, row.userId);
    if (seat?.staff) events.rosterChanged(evaluation.id);
  }
  return row;
}

/**
 * Inserts an attempt already STARTED, number `number`, on its own seed,
 * values and deadline: a retake (ADR-025) and a practice attempt (ADR-122)
 * alike, inside the caller's transaction. `null` when the unique index
 * `(evaluation, user, number)` or the one unfinished attempt per student
 * refused it: a concurrent click won, and the caller resumes its attempt.
 */
export async function insertAttempt(
  tx: DbOrTx,
  input: {
    evaluation: EvaluationRecord;
    participant: Participant;
    number: number;
    seed: number;
    instances: Record<string, StoredInstance>;
    deadlineAt: Date | null;
    bonusS: number;
    afterDue: boolean;
    acquiredItemIds?: string[];
    now: Date;
  },
): Promise<AttemptRecord | null> {
  const { now } = input;
  const created = await tx
    .insert(attempts)
    .values({
      id: randomUUID(),
      evaluationId: input.evaluation.id,
      ...ownerOf(input.participant),
      attemptNumber: input.number,
      state: "in_progress",
      seed: input.seed,
      instances: input.instances,
      acquiredItemIds: input.acquiredItemIds ?? [],
      startedAt: now,
      deadlineAt: input.deadlineAt,
      bonusS: input.bonusS,
      afterDue: input.afterDue,
      presentAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  return created[0] ?? null;
}

/** What a partial retake carries over: the items, and their validated gradings as read. */
interface Carried {
  itemIds: string[];
  gradings: GradingRecord[];
}

/**
 * ADR-091 §3: what a partial retake carries over from `latest` — the
 * acquired items in the evaluation's order, and their validated gradings,
 * read ONCE here and copied as read — refused (`409 retake_refused`,
 * `scope_all` or `nothing_to_review`) unless the teacher chose that scope
 * and something is left to review.
 */
async function carriedFrom(
  tx: DbOrTx,
  evaluation: EvaluationRecord,
  latest: AttemptRecord,
): Promise<Carried> {
  const validated = await validatedOfAttempt(tx, latest.id);
  const standings = standingsOf(await joinedItems(tx, evaluation.id), validated);
  const refusal = partialRetakeRefusal({
    mode: evaluation.mode,
    retakes: retakePolicyOf(evaluation),
    items: standings,
  });
  if (refusal !== null) throw new RetakeRefused(refusal);
  const itemIds = acquiredItems(standings);
  return { itemIds, gradings: validated.filter((g) => itemIds.includes(g.itemId)) };
}

/**
 * ADR-091 §3: copies onto the new attempt `to` the answer of each carried
 * item from `from`, then the validated gradings `carried` read — new ids, the
 * same payload. The copy was shown when the original was (`firstShownAt`),
 * and has spent no time on screen in this attempt (dwell 0, ADR-039); a flag
 * or a validation of attempt n is not carried, they were notes on another
 * paper, and so is a check.
 */
async function carryAcquired(
  tx: DbOrTx,
  from: AttemptRecord,
  to: AttemptRecord,
  carried: Carried,
  now: Date,
): Promise<void> {
  if (carried.itemIds.length === 0) return;
  const originals = await tx
    .select()
    .from(answers)
    .where(and(eq(answers.attemptId, from.id), inArray(answers.itemId, carried.itemIds)));
  const copies = originals.map((answer) => ({
    ...answer,
    id: randomUUID(),
    attemptId: to.id,
    markedDone: false,
    flagged: false,
    // A check of attempt n (ADR-124 §3) locked attempt n's question; the
    // copy is read-only as acquired, and shows no correction of its own.
    checkedAt: null,
    dwellMs: 0,
    updatedAt: now,
  }));
  if (copies.length > 0) await tx.insert(answers).values(copies);
  const answerIds = new Map(copies.map((copy) => [copy.itemId, copy.id]));
  await copyGradings(tx, { rows: carried.gradings, toAttemptId: to.id, answerIds, now });
}

/**
 * F-EVAL-15 (ADR-025): a NEW attempt on an exercise that allows several —
 * number n + 1, a new seed (so a new item order and newly shuffled choices
 * on the same frozen versions), blank, and started at once: the rule only
 * allows it on a running evaluation.
 *
 * The server decides (`@quiz/domain#retakeRefusal`); the network allowlist
 * is checked, like every entry.
 *
 * Two clicks racing: both compute n + 1, the unique index lets one row in,
 * and the loser enters the attempt the winner opened (or, if it read after
 * the winner committed, is told `unfinished`). The partial index on the
 * unfinished attempt says the same thing a second time, in the schema.
 *
 * A retake racing the teacher's Close (review of #116): the rule is read
 * again INSIDE a transaction that holds the evaluation row `FOR SHARE`, and
 * the attempt is inserted already started in that same transaction.
 * `closeEvaluation` flips the state to `closed` BEFORE it expires the open
 * attempts, and that UPDATE needs the row lock: either it waits for the
 * retake to commit and then expires the new attempt with the others, or the
 * retake waits for the flip and reads `closed`. A blank attempt can never
 * be left open on a closed evaluation, graded 0, and kept as the "last".
 *
 * ADR-091: with `scope: "to_review"`, the questions acquired in the latest
 * attempt are carried over in the same transaction ({@link carriedFrom},
 * {@link carryAcquired}):
 * the new attempt is still a whole one — its own number, seed and deadline,
 * counted against the maximum — whose acquired questions hold attempt n's
 * values, answer and validated grading, read-only.
 */
export async function retakeAttempt(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    participant: Participant;
    /** ADR-091: every question (ADR-025's blank retake), or only those to review. */
    scope?: RetakeScope;
    now: Date;
  },
): Promise<AttemptRecord> {
  const { participant, now } = input;
  if (participant.userId === null) throw new RetakeRefused("not_allowed");
  const userId = participant.userId;

  const outcome = await db.transaction(async (tx) => {
    // The evaluation as it is NOW, locked against a concurrent state change;
    // the record the route loaded at the start of the request may be stale.
    const [evaluation] = await tx
      .select()
      .from(evaluations)
      .where(eq(evaluations.id, input.evaluation.id))
      .for("share");
    if (!evaluation) throw new RetakeRefused("not_open");
    const previous = await tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.userId, userId)))
      .orderBy(asc(attempts.attemptNumber));
    const refusal = retakeRefusal({
      mode: evaluation.mode,
      retakes: retakePolicyOf(evaluation),
      evaluationState: evaluation.state,
      closesAt: evaluation.closesAt,
      now,
      attempts: previous,
    });
    if (refusal !== null) throw new RetakeRefused(refusal);
    // The rule passed, so the latest attempt exists and is finished.
    const latest = latestAttempt(previous);
    if (latest === null) throw new RetakeRefused("no_attempt");
    const carried: Carried =
      input.scope === "to_review"
        ? await carriedFrom(tx, evaluation, latest)
        : { itemIds: [], gradings: [] };

    // Started at once: `running` is the only state the rule allows, so there
    // is no lobby to wait in, and no `not_started` row a close would miss.
    const { deadlineAt, bonusS } = deadlineFor(evaluation, participant, now, 0);
    const seed = drawSeed();
    const drawn = await drawInstances(tx, evaluation, seed);
    // ADR-091: an acquired question keeps the numbers it was acquired with;
    // the others are drawn anew, like every retake's.
    for (const itemId of carried.itemIds) {
      const kept = latest.instances[itemId];
      if (kept !== undefined) drawn[itemId] = kept;
    }
    const row = await insertAttempt(tx, {
      evaluation,
      participant,
      number: latest.attemptNumber + 1,
      seed,
      instances: drawn,
      deadlineAt,
      bonusS,
      afterDue: false,
      acquiredItemIds: carried.itemIds,
      now,
    });
    if (row !== null) await carryAcquired(tx, latest, row, carried, now);
    return { evaluation, row };
  });

  if (outcome.row === null) {
    // Lost the race: enter the attempt the winner opened, if it is still open.
    const row = await attemptOf(db, outcome.evaluation.id, participant);
    if (!row || isFinishedAttempt(row.state)) throw new RetakeRefused("unfinished");
    return row;
  }
  events.attemptStarted(outcome.evaluation, outcome.row, now);
  // The grid shows each student's latest attempt: the row now stands on
  // another attempt, with blank cells. No typed frame moves a whole row.
  events.rosterChanged(outcome.evaluation.id);
  return outcome.row;
}

/** `not_started → in_progress`, with the deadline computed once (§5.2). */
export async function beginAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  participant: Participant,
  now: Date,
): Promise<AttemptRecord> {
  if (attempt.state !== "not_started") return attempt;
  const { deadlineAt, bonusS } = deadlineFor(evaluation, participant, now, attempt.extraS);
  // Conditional: two requests racing to start the same attempt produce one
  // start, and therefore one deadline.
  await db
    .update(attempts)
    .set({ state: "in_progress", startedAt: now, deadlineAt, bonusS, updatedAt: now })
    .where(and(eq(attempts.id, attempt.id), eq(attempts.state, "not_started")));
  const row = (await attemptById(db, attempt.id))!;
  events.attemptStarted(evaluation, row, now);
  return row;
}

export async function markPresent(db: Db, attemptId: string, now: Date): Promise<void> {
  await db.update(attempts).set({ presentAt: now }).where(eq(attempts.id, attemptId));
}

// --- Entering an evaluation ----------------------------------------------

type EnterResult =
  | { kind: "attempt"; view: AttemptView; attempt: AttemptRecord }
  | { kind: "lobby"; view: LobbyView; attempt: AttemptRecord }
  // Nothing was written: there is no attempt row (ADR-076).
  | { kind: "ready"; view: ReadyView; attempt: null };

/**
 * `POST /evaluations/:id/attempt` and `…/attempt/start` (F-LIVE-01,
 * ADR-076). Idempotent end to end: the row, the seed and the start instant
 * are created at most once.
 *
 * Entering is not starting. On a `running` evaluation a participant with NO
 * attempt row, who did not ask to `start`, gets the ready screen and NOTHING
 * is written — no row, no presence, no clock — so a look at a link never
 * consumes an attempt. `start` is true for the explicit Start and for a
 * trusted client (`seb`, `kiosk`), whose pairing already is the explicit act.
 * A participant whose row exists begins directly, and in `lobby` and
 * `paused` the row and the presence are still created here: the waiting room
 * counts them (F-LIVE-02/03, `beginWaitingAttempts`). A retake is
 * {@link retakeAttempt}, started by its own click.
 */
export async function enterEvaluation(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    participant: Participant;
    now: Date;
    start: boolean;
  },
): Promise<EnterResult> {
  const { evaluation, participant, now, start } = input;
  // A guest (no user) only ever joins a poll, which is not entered here.
  if (evaluation.mode === "poll" || participant.userId === null) {
    throw new LiveError("not_implemented", "poll is phase 2");
  }
  // The room restriction (F-EVAL-12) is already settled: `sitRefusal`, in
  // the route's loader, refused an off-site request.

  const open = isEvaluationOpen(evaluation.state);
  const existing = await attemptOf(db, evaluation.id, participant);
  // A closed evaluation still hands back a finished attempt: the student
  // must be able to reopen the page and see what they submitted.
  if (!open && existing === null) throw new LiveError("not_open");
  if (existing === null && evaluation.state === "running" && !start) {
    return { kind: "ready", view: readyView(evaluation, participant), attempt: null };
  }

  let attempt = existing ?? (await ensureAttempt(db, evaluation, participant, now));
  await markPresent(db, attempt.id, now);

  if (evaluation.state === "running") {
    attempt = await beginAttempt(db, evaluation, attempt, participant, now);
  }
  const view = await attemptOrLobbyView(db, evaluation, attempt, now, participant);
  return view.kind === "lobby"
    ? { kind: "lobby", view: view.view, attempt }
    : { kind: "attempt", view: view.view, attempt };
}
