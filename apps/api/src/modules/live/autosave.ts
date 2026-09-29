/**
 * The autosave path (PLAN-MVP §4.7): the answer summaries a cell shows, the
 * live grader, `saveAnswer`, `markDone` (validate), `setSkipped` and
 * `setFlagged` (issue #89), `reportShown` (the position and the dwell,
 * ADR-039), and the attempt journal. Imported
 * through `./service.ts`.
 */
import { randomUUID } from "node:crypto";

import { and, count, eq, gte, isNull, sql } from "drizzle-orm";

import type { AutosaveResponse, CellStatus, Verdict } from "@quiz/contracts";
import { ANSWER_SUMMARY_MAX, isGraded, type AnyQuestionTypeServer } from "@quiz/core/server";
import { mayValidate, progressStatus, round2 } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { answers, attemptEvents, attempts, evaluations } from "../../db/schema.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { settingsOf, type EvaluationRecord, type JoinedItem } from "../evaluation/service.js";
import { gradeDefaults, joinedItem, joinedItems } from "../evaluation/service.js";
import { closeShown } from "./dwell.js";
import * as events from "./events.js";
import { verdictOf } from "../grading/service.js";
import { UnavailableRunner } from "../runner/unavailable.js";
import {
  type AttemptRecord,
  type AnswerRecord,
  LiveError,
  AnswerInvalid,
  AlreadyAnswered,
  Irreversible,
  ItemLocked,
  NotValidatable,
  orderItems,
  lockedItemIds,
  answersOf,
  assertWritable,
} from "./attempt.js";

/** One line, and never wider than a cell (`ANSWER_SUMMARY_MAX`). */
function truncate(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= ANSWER_SUMMARY_MAX ? one : `${one.slice(0, ANSWER_SUMMARY_MAX - 1)}…`;
}

/**
 * The preview of a type that does not write its own — `qt-code` today, whose
 * answer is a set of editable regions: "12 L" is what a 64 px column can hold
 * and what a teacher reads across thirty rows, with the source itself one
 * click away in the inspect modal. Anything else falls back to its own short text form; the raw JSON
 * never reaches a cell.
 */
function genericSummary(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return truncate(payload);
  if (typeof payload === "number" || typeof payload === "boolean") return String(payload);
  if (Array.isArray(payload)) return truncate(payload.map((v) => String(v)).join(" · "));
  const record = payload as Record<string, unknown>;
  const source = record["regions"] ?? record["source"] ?? record["files"];
  if (Array.isArray(source)) {
    const lines = source.reduce(
      (sum: number, part) => sum + (typeof part === "string" ? part.split("\n").length : 0),
      0,
    );
    return `${lines} L`;
  }
  if (typeof record["text"] === "string") return truncate(record["text"]);
  return "";
}

/**
 * A cell preview for the dashboard (F-DASH-02): what the student answered, in
 * a glyph or two.
 *
 * It used to be `JSON.stringify`, which put `{"text":"4"}` in the teacher's
 * column and made the "Answers" toggle worth nothing. The shape of an answer
 * belongs to the question type, so the type writes the preview:
 * `type.summarizeAnswer(config, answer)` (`@quiz/core`). This function is the
 * part that is NOT the type's — finding the type, parsing the stored payload
 * with the type's own `answerSchema`, and holding the result to the width of
 * a cell.
 *
 * Everything here is defensive on purpose: it runs on every autosave of every
 * student, and a preview is never worth a 500. A type with no hook (and a
 * payload the hook refused) falls back to {@link genericSummary}.
 *
 * It is a CLOSURE over one item because the dashboard summarises a whole
 * grid: the type and its configuration are resolved once per question and
 * reused down the column, instead of once per cell — twenty-four students
 * times ten questions is 240 config parses of ten distinct configs.
 */
export function answerSummarizer(item: JoinedItem): (payload: unknown) => string {
  let hook: ((payload: unknown) => string) | null = null;
  try {
    const type = typeOf(item.question.type);
    const write = type.summarizeAnswer?.bind(type);
    if (write) {
      const config = loadConfig(item.question.type, {
        config: item.version.config,
        configVersion: item.version.configVersion,
      });
      hook = (payload) => {
        const answer = type.answerSchema.safeParse(payload);
        return answer.success ? truncate(write(config, answer.data)) : genericSummary(payload);
      };
    }
  } catch {
    /* an unknown type or an unreadable config: the generic form still says something */
  }
  const write = hook;
  return (payload) => {
    if (payload === null || payload === undefined) return "";
    try {
      return write ? write(payload) : genericSummary(payload);
    } catch {
      return genericSummary(payload);
    }
  };
}

/** {@link answerSummarizer} for one cell. */
export function summarizeAnswer(item: JoinedItem, payload: unknown): string {
  return answerSummarizer(item)(payload);
}

/**
 * ADR-020 — the verdict a cell WOULD get if the evaluation closed now.
 *
 * The "Results" toggle of the live dashboard used to mean "show the gradings
 * there are", and before closing there are none: the teacher watched a wall
 * of blue "done" cells and a class row reading "after closing", on the one
 * screen whose job is to say whether the class has understood. So the server
 * grades the answer it already holds, with the type's OWN `grade` — the same
 * function the grading pass calls, on the same config, so a preview and the
 * final grading can never disagree by construction.
 *
 * Four properties make that safe rather than clever:
 *   - it is READ-ONLY. Nothing is written to `gradings`, nothing is queued,
 *     no job is enqueued, and the grading pass at closing runs exactly as it
 *     did. A preview is a number computed and thrown away;
 *   - it never reaches a student. It travels on `DashboardView` and on the
 *     staff-only `dashboard.cell` frame, neither of which goes through
 *     `toStudent`, and the student payloads are untouched (invariant 4);
 *   - it is only ever asked for by the teacher who turned the toggle on
 *     (`?results=1`), so a projected grid costs nothing when the switch is
 *     off;
 *   - a type that needs the RUNNER gets no preview. `finalizeRunner` is the
 *     declaration of "graded in two halves"; building the request and running
 *     nothing would cost the assembly of every source file of every student
 *     on every refresh, to answer `null`. `code` and `circuit` therefore
 *     colour when their real grading lands, exactly as before.
 *
 * Returns `null` for a question this cannot preview, which the caller reads
 * as "no live verdict for this column".
 */
export function liveGrader(
  item: JoinedItem,
  evaluation: EvaluationRecord,
  now: Date,
): ((attempt: AttemptRecord, payload: unknown) => Promise<GradedCell | null>) | null {
  let type: AnyQuestionTypeServer;
  let config: unknown;
  try {
    type = typeOf(item.question.type);
    if (type.finalizeRunner) return null;
    config = loadConfig(item.question.type, {
      config: item.version.config,
      configVersion: item.version.configVersion,
    });
  } catch {
    // An unknown type or a config this build cannot read: no preview, and
    // certainly not a 500 on the teacher's dashboard.
    return null;
  }
  const runner = new UnavailableRunner("live_preview");
  const defaults = gradeDefaults(evaluation);
  return async (attempt, payload) => {
    try {
      const parsed = type.answerSchema.safeParse(payload);
      if (!parsed.success) return null;
      const result = await type.grade(config, parsed.data, {
        seed: attempt.seed,
        itemId: item.item.id,
        attemptId: attempt.id,
        itemPoints: item.item.points,
        now,
        runner,
        defaults,
      });
      // A proposal is a placeholder for a person's grade (an essay, a
      // manual circuit): shown as a verdict it would paint every written
      // answer red. No preview, the cell keeps its progress colour.
      if (!isGraded(result) || result.state === "proposed") return null;
      const points = round2(result.points);
      const maxPoints = result.maxPoints;
      return {
        verdict: verdictOf({ points, maxPoints, state: "validated" }),
        rate: maxPoints > 0 ? points / maxPoints : null,
      };
    } catch {
      // A grader that throws on a half-typed answer is expected while the
      // student is still typing; the cell simply keeps its progress colour.
      return null;
    }
  };
}

/** What {@link liveGrader} answers: a colour, and the share it counts for. */
interface GradedCell {
  verdict: Verdict;
  rate: number | null;
}

/** {@link liveGrader} for ONE cell, which is what an autosave moves. */
async function previewVerdict(
  evaluation: EvaluationRecord,
  item: JoinedItem,
  attempt: AttemptRecord,
  payload: unknown,
  now: Date,
): Promise<Verdict | null> {
  if (payload === null || payload === undefined) return null;
  const grade = liveGrader(item, evaluation, now);
  if (!grade) return null;
  return (await grade(attempt, payload))?.verdict ?? null;
}

/**
 * "Does this payload hold something?" — the question TYPE's call
 * (`isAnswered` of the contract, issue #89), resolved once per item like
 * {@link answerSummarizer}. Defensive for the same reason: it runs on every
 * autosave and on every cell of the grid, and an unknown type or a payload
 * stored under an older schema falls back to "anything at all".
 */
export function answeredBy(item: JoinedItem): (payload: unknown) => boolean {
  let type: AnyQuestionTypeServer | null = null;
  try {
    type = typeOf(item.question.type);
  } catch {
    /* an unknown type: the fallback below */
  }
  const known = type;
  return (payload) => {
    if (payload === null || payload === undefined) return false;
    if (!known) return true;
    try {
      const parsed = known.answerSchema.safeParse(payload);
      return parsed.success ? known.isAnswered(parsed.data) : true;
    } catch {
      return true;
    }
  };
}

/** One cell's progress (F-DASH-01), by the rule of `@quiz/domain`. */
export function cellStatus(answer: AnswerRecord | null, answered: boolean): CellStatus {
  return progressStatus({
    row: answer !== null,
    answered,
    skipped: answer?.skipped ?? false,
    validated: answer?.markedDone ?? false,
  });
}

/**
 * The `dashboard.cell` frame of one stored row: every write of the student's
 * (an answer, a validation, a skip, a flag) moves the cell through here, so
 * the grid always receives the WHOLE state of the cell and never a fragment
 * of it.
 */
async function publishCell(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  item: JoinedItem | null,
  row: AnswerRecord,
  now: Date,
): Promise<void> {
  const answered = item ? answeredBy(item)(row.payload) : row.payload !== null;
  events.cellChanged({
    evaluationId: evaluation.id,
    attemptId: attempt.id,
    itemId: row.itemId,
    status: cellStatus(row, answered),
    revision: row.revision,
    flagged: row.flagged,
    summary: item && row.payload !== null ? summarizeAnswer(item, row.payload) : null,
    verdict: item ? await previewVerdict(evaluation, item, attempt, row.payload, now) : null,
  });
}

/**
 * ONE statement, no read-modify-write (§4.7). `WHERE answers.revision <
 * excluded.revision` is what makes two concurrent writes deterministic: the
 * higher revision wins, and the loser is told which payload to adopt.
 */
export async function saveAnswer(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    payload: unknown;
    revision: number;
    now: Date;
  },
): Promise<AutosaveResponse> {
  const { evaluation, attempt, itemId, revision, now } = input;
  const { joined, current } = await stateTarget(db, evaluation, attempt, itemId, now);

  // Never persist garbage: the type's own schema is the gate (§4.7 step 6).
  const type = typeOf(joined.question.type);
  const parsed = type.answerSchema.safeParse(input.payload);
  if (!parsed.success) throw new AnswerInvalid(parsed.error.issues);
  const payload = parsed.data;
  // The rules that need the config (an mcq in `single` mode takes one
  // choice, ADR-026): the same 422 as a malformed payload.
  const misfit = type.answerMisfit?.(
    loadConfig(joined.question.type, {
      config: joined.version.config,
      configVersion: joined.version.configVersion,
    }),
    payload,
  );
  if (misfit) throw new AnswerInvalid([{ message: misfit }]);
  // Issue #89: writing an answer that holds something takes back an "I won't
  // answer". An EMPTY write leaves it alone — a cleared field is not an
  // answer, and the student may have said "won't answer" just before it.
  const answered = type.isAnswered(payload);

  const written = await db
    .insert(answers)
    .values({
      id: randomUUID(),
      attemptId: attempt.id,
      itemId,
      payload,
      revision,
      firstSeenAt: now,
      firstShownAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [answers.attemptId, answers.itemId],
      set: {
        payload: sql`excluded.payload`,
        revision: sql`excluded.revision`,
        ...(answered ? { skipped: false } : {}),
        // Written, therefore shown (ADR-039), whatever the player reported.
        firstShownAt: sql`coalesce(${answers.firstShownAt}, excluded.first_shown_at)`,
        updatedAt: now,
      },
      setWhere: sql`${answers.revision} < excluded.revision`,
    })
    .returning();

  if (written.length === 0) {
    // Stale: the row in the database is newer. Hand it back so the client
    // adopts it (last-writer-wins by revision).
    return {
      accepted: false,
      revision: current?.revision ?? 0,
      payload: current?.payload ?? null,
      serverNow: iso(now),
    };
  }

  const row = written[0]!;
  await publishCell(evaluation, attempt, joined, row, now);
  return { accepted: true, revision: row.revision, serverNow: iso(now) };
}

/**
 * F-LIVE-08: VALIDATE a question — "Validate and continue" in
 * `forward_only`, crossing a checkpoint in `milestones` (issue #89 replaced
 * the "Mark as done" that used this route). In `forward_only` the flag only
 * ever goes up.
 */
export async function markDone(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    done: boolean;
    now: Date;
  },
): Promise<{ done: boolean; nextItemId: string | null }> {
  const { evaluation, attempt, itemId, now } = input;
  assertWritable(evaluation, attempt, now);
  const settings = settingsOf(evaluation);
  const stored = await answersOf(db, attempt.id);
  const current = stored.get(itemId) ?? null;
  const ordered = orderItems(
    await joinedItems(db, evaluation.id),
    settings,
    attempt.seed,
    evaluation.id,
  );
  const ownItem = ordered.find((o) => o.item.id === itemId) ?? null;
  if (!ownItem) throw new LiveError("not_found", 404);
  const locked = lockedItemIds(settings, ordered, stored).has(itemId);
  if (input.done) {
    // Validation exists only where the navigation locks: every question in
    // `forward_only`, a checkpoint in `milestones` (issue #89). Anywhere else
    // a `true` would read "Validated" for a question nothing closed.
    if (!mayValidate(settings.navigation, { milestone: ownItem.item.milestone })) {
      throw new NotValidatable();
    }
    // Behind a crossed checkpoint, a question is closed for every write.
    if (locked && !current?.markedDone) throw new ItemLocked();
  } else if (settings.navigation !== "free") {
    // Irreversible in every locking mode: un-validating a crossed checkpoint
    // would re-open every question before it.
    if (current?.markedDone) throw new Irreversible();
    if (locked) throw new ItemLocked();
  }

  const row = await writeState(db, attempt, itemId, current, { markedDone: input.done }, now);

  const rank = ownItem.rank;
  const next = ordered.find((o) => o.rank === rank + 1)?.item.id ?? null;
  if (next !== null) await db.update(attempts).set({ lastItemId: next, updatedAt: now }).where(eq(attempts.id, attempt.id));

  await publishCell(evaluation, attempt, ownItem, row, now);
  return { done: input.done, nextItemId: next };
}

/**
 * The state columns of one answer row, written whether or not the row exists
 * yet. "Seen, nothing typed": the row has to exist for a flag to, and
 * `payload` is NOT NULL, so it holds the JSON value `null` — which is what a
 * type's `grade(config, null, …)` already means (F-GRADE-01).
 */
async function writeState(
  db: Db,
  attempt: AttemptRecord,
  itemId: string,
  current: AnswerRecord | null,
  set: Partial<Pick<AnswerRecord, "markedDone" | "skipped" | "flagged">>,
  now: Date,
): Promise<AnswerRecord> {
  // Written, therefore shown (ADR-039), whatever the player reported.
  const shown = { firstShownAt: sql`coalesce(${answers.firstShownAt}, ${now.toISOString()}::timestamptz)` };
  if (current) {
    const [row] = await db
      .update(answers)
      .set({ ...set, ...shown, updatedAt: now })
      .where(eq(answers.id, current.id))
      .returning();
    return row!;
  }
  const [row] = await db
    .insert(answers)
    .values({
      id: randomUUID(),
      attemptId: attempt.id,
      itemId,
      payload: sql`'null'::jsonb`,
      revision: 0,
      ...set,
      firstSeenAt: now,
      firstShownAt: now,
      updatedAt: now,
    })
    // Two tabs racing on a never-opened question: the second one updates.
    .onConflictDoUpdate({
      target: [answers.attemptId, answers.itemId],
      set: { ...set, ...shown, updatedAt: now },
    })
    .returning();
  return row!;
}

/**
 * What every write of a student to one item shares — an answer, and the two
 * state writes of issue #89: the write gate (a `410` past the deadline plus
 * grace, on the server's clock), the item, the lock of the locking
 * navigations — a validated question takes no write of any kind — and the
 * row as it stands.
 *
 * Free navigation needs this one item and this one row only. A locking mode
 * needs the whole ordered list and every answer anyway (the lock depends on
 * them), so the item and the row are taken from those rather than read twice.
 */
async function stateTarget(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  itemId: string,
  now: Date,
): Promise<{ joined: JoinedItem; current: AnswerRecord | null }> {
  assertWritable(evaluation, attempt, now);
  const settings = settingsOf(evaluation);
  if (settings.navigation === "free") {
    const joined = await joinedItem(db, evaluation.id, itemId);
    if (!joined) throw new LiveError("not_found", 404);
    const [current] = await db
      .select()
      .from(answers)
      .where(and(eq(answers.attemptId, attempt.id), eq(answers.itemId, itemId)))
      .limit(1);
    return { joined, current: current ?? null };
  }
  const ordered = orderItems(
    await joinedItems(db, evaluation.id),
    settings,
    attempt.seed,
    evaluation.id,
  );
  const joined = ordered.find((o) => o.item.id === itemId) ?? null;
  if (!joined) throw new LiveError("not_found", 404);
  const stored = await answersOf(db, attempt.id);
  if (lockedItemIds(settings, ordered, stored).has(itemId)) throw new ItemLocked();
  return { joined, current: stored.get(itemId) ?? null };
}

/**
 * "I won't answer this question" (issue #89), or taking it back. Refused on a
 * question that holds an answer: that would be a way to erase one, and the
 * player never offers it there. Grading does not read it.
 */
export async function setSkipped(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    skipped: boolean;
    now: Date;
  },
): Promise<{ skipped: boolean }> {
  const { evaluation, attempt, itemId, now } = input;
  const { joined, current } = await stateTarget(db, evaluation, attempt, itemId, now);
  if (input.skipped && current && answeredBy(joined)(current.payload)) throw new AlreadyAnswered();
  const row = await writeState(db, attempt, itemId, current, { skipped: input.skipped }, now);
  await publishCell(evaluation, attempt, joined, row, now);
  return { skipped: row.skipped };
}

/**
 * The review flag (issue #89). It is not an answer, yet it takes the ANSWER
 * gate, pause included: a pause covers the paper (decision D17, the
 * student's screen shows nothing but the overlay), so there is nothing to
 * flag, and a flag is a note ABOUT the content the student is reading —
 * unlike the position or the journal, which the client sends by itself while
 * the student waits. One gate for every write the student makes on a
 * question keeps the rule one sentence long.
 */
export async function setFlagged(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string;
    flagged: boolean;
    now: Date;
  },
): Promise<{ flagged: boolean }> {
  const { evaluation, attempt, itemId, now } = input;
  const { joined, current } = await stateTarget(db, evaluation, attempt, itemId, now);
  const row = await writeState(db, attempt, itemId, current, { flagged: input.flagged }, now);
  await publishCell(evaluation, attempt, joined, row, now);
  return { flagged: row.flagged };
}

/**
 * F-LIVE-06 and ADR-039: what is on the student's screen — an item, or
 * `null` for nothing — reported by the player on every move, on hiding the
 * tab and on leaving. Two uses of one signal:
 *   - the BOOKMARK: an item becomes `last_item_id`, so a reload lands on the
 *     same question; `null` keeps the last one;
 *   - the DWELL: the report ends the open interval ({@link closeShown}) and,
 *     for an item of a running evaluation, opens the next one at `now`. A
 *     report of the item already open changes nothing, so a re-sent position
 *     never cuts an interval in two.
 *
 * `track` is false for a delegated session (ADR-034): somebody acting as the
 * student moves the bookmark and nothing else — no interval, no sign of
 * life. One transaction, the attempt row locked first, like every flush.
 */
export async function reportShown(
  db: Db,
  input: {
    evaluation: EvaluationRecord;
    attempt: AttemptRecord;
    itemId: string | null;
    now: Date;
    track: boolean;
  },
): Promise<void> {
  const { evaluation, attempt, itemId, now, track } = input;
  // An item of ANOTHER evaluation would pass the foreign key of `answers`;
  // it must not become a bookmark nor a row.
  const item = itemId === null ? null : await joinedItem(db, evaluation.id, itemId);
  if (itemId !== null && !item) throw new LiveError("not_found", 404);

  const created = await db.transaction(async (tx) => {
    // The states read WITH the lock, not from the request's scope: a pause or
    // a close that committed since then flushed this attempt, and must not
    // find an interval opened behind it.
    const [locked] = await tx
      .select({
        shownItemId: attempts.shownItemId,
        state: attempts.state,
        running: sql<boolean>`${evaluations.state} = 'running'`,
      })
      .from(attempts)
      .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
      .where(eq(attempts.id, attempt.id))
      .for("update", { of: attempts });
    if (!locked) throw new LiveError("not_found", 404);
    const shows = track && itemId !== null && locked.running && locked.state === "in_progress";
    // The item already open: the interval goes on.
    const opens = shows && locked.shownItemId !== itemId;
    if (track && (opens || !shows)) await closeShown(tx, eq(attempts.id, attempt.id), now);
    let row: AnswerRecord | null = null;
    if (opens) {
      [row = null] = await tx
        .insert(answers)
        .values({
          id: randomUUID(),
          attemptId: attempt.id,
          itemId,
          payload: sql`'null'::jsonb`,
          revision: 0,
          firstSeenAt: now,
          firstShownAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [answers.attemptId, answers.itemId] })
        .returning();
      // A row written before migration 0033: displayed from now on.
      if (!row) {
        await tx
          .update(answers)
          .set({ firstShownAt: now })
          .where(
            and(eq(answers.attemptId, attempt.id), eq(answers.itemId, itemId), isNull(answers.firstShownAt)),
          );
      }
    }
    await tx
      .update(attempts)
      .set({
        ...(itemId !== null ? { lastItemId: itemId } : {}),
        ...(opens ? { shownItemId: itemId, shownSince: now } : {}),
        ...(track ? { presentAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(attempts.id, attempt.id));
    return row;
  });
  // The grid's "seen" is now true to its word: the question was on screen.
  if (created) await publishCell(evaluation, attempt, item, created, now);
}

/** F-EVAL-13. Journalled, never blocking. */
export async function logAttemptEvent(
  db: Db,
  attemptId: string,
  kind: typeof attemptEvents.$inferInsert["kind"],
  details: unknown,
  now: Date,
): Promise<void> {
  await logAttemptEvents(db, [attemptId], kind, details, now);
}

/** {@link logAttemptEvent} for many attempts at once: one multi-row insert. */
export async function logAttemptEvents(
  db: Db,
  attemptIds: readonly string[],
  kind: typeof attemptEvents.$inferInsert["kind"],
  details: unknown,
  now: Date,
): Promise<void> {
  if (attemptIds.length === 0) return;
  await db.insert(attemptEvents).values(
    attemptIds.map((attemptId) => ({
      id: randomUUID(),
      attemptId,
      kind,
      at: now,
      details: details ?? null,
    })),
  );
}

/**
 * Rate limit of a journalled kind, counted in the database (no extra table).
 *
 * `compileOnly` splits the `run` events in two (ADR-024, addendum of
 * 2026-09-25): `true` counts only the Compile button's runs (journalled
 * `compileOnly: true`), `false` every other run; absent, all of them.
 */
export async function countRecentEvents(
  db: Db,
  attemptId: string,
  kind: typeof attemptEvents.$inferInsert["kind"],
  since: Date,
  options: { compileOnly?: boolean | undefined } = {},
): Promise<number> {
  const compiled = sql`coalesce(${attemptEvents.details}->>'compileOnly', 'false') = 'true'`;
  const [row] = await db
    .select({ n: count() })
    .from(attemptEvents)
    .where(
      and(
        eq(attemptEvents.attemptId, attemptId),
        eq(attemptEvents.kind, kind),
        gte(attemptEvents.at, since),
        options.compileOnly === undefined
          ? undefined
          : options.compileOnly
            ? compiled
            : sql`not (${compiled})`,
      ),
    );
  return row?.n ?? 0;
}
