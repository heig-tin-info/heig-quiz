/**
 * The grading panel (F-GRADE-03): the queue, its steps and a cell's
 * history. A student payload is still only ever produced by
 * `modules/live/studentView.ts` (invariant 4), including here.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type {
  GradingEntry,
  GradingHistoryEntry,
  GradingQuery,
  GradingQueue,
  GradingSteps,
} from "@quiz/contracts";
import { countsForStudent } from "@quiz/domain";
import { formattedValues } from "@quiz/domain/parameters";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { answers, attempts, gradings, officialAttempt, users } from "../../db/schema.js";
import {
  joinedItems,
  staffAttemptIds,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { solutionViewOf, staffViews, studentViewOf } from "../live/studentView.js";
import { typeOf } from "../pool/config.js";
import {
  explanationOrNull,
  isParameterized,
  parametersOf,
  readingPerAttempt,
  writtenConfig,
  type Reading,
} from "../pool/service.js";
import { keptAttempts } from "./kept.js";
import {
  criteriaOf,
  gradingsIn,
  pointsRangeOf,
  standingGradings,
  toGrading,
  type CellScope,
} from "./reads.js";
import { NEWEST_FIRST, pairKey, type AttemptRecord, type GradingRecord, type PairKey } from "./records.js";

/**
 * Whether an item's answers export as Markdown (F-EXP-01, ADR-121 §2): its
 * type renders a statement and an answer, and the question is not
 * parameterized — each attempt would have its own statement and key.
 */
export function exportsText(type: string, version: { variables: { rows: readonly unknown[] } | null }): boolean {
  const t = typeOf(type);
  return t.statementDoc !== undefined && t.answerDoc !== undefined && !isParameterized(version);
}

interface Roster {
  /** The name the panel shows when the teacher asks for names; null for a guest. */
  displayName: string | null;
  /** A guest's number among the evaluation's guests (ADR-014); null for an account. */
  guest: number | null;
  /** Which of the student's attempts this is; null for a student with one. */
  attemptNumber: number | null;
}

/**
 * The name and the attempt number of each attempt. `attemptRows` is EVERY
 * attempt of the evaluation, oldest first, as the caller already loaded
 * them: the guests' numbers and whether a student retook the exercise depend
 * on all of them, whatever the panel shows.
 *
 * No pseudonym any more (ADR-044): an anonymous panel carries no label at
 * all, and the retake number travels on its own (`GradingEntry.attemptNumber`)
 * instead of as a " · #2" suffix of a name it would outlive.
 */
async function rosterOf(
  db: Db,
  attemptRows: readonly Pick<AttemptRecord, "id" | "userId" | "attemptNumber">[],
): Promise<Map<string, Roster>> {
  const userIds = [
    ...new Set(attemptRows.map((r) => r.userId).filter((id): id is string => id !== null)),
  ];
  const people =
    userIds.length === 0
      ? []
      : await db
          .select({
            id: users.id,
            givenName: users.givenName,
            familyName: users.familyName,
            email: users.email,
          })
          .from(users)
          .where(inArray(users.id, userIds));
  const person = new Map(people.map((p) => [p.id, p]));
  const attemptsOf = new Map<string, number>();
  for (const r of attemptRows) {
    if (r.userId) attemptsOf.set(r.userId, (attemptsOf.get(r.userId) ?? 0) + 1);
  }
  // An attempt of a poll may belong to a GUEST, whose `user_id` is null
  // (ADR-014): it keeps its row, numbered among the guests, rather than
  // leave the panel a graded answer with no owner at all. The number, not a
  // name: the web words it in the reader's language.
  let guests = 0;
  return new Map(
    attemptRows.map((r): [string, Roster] => {
      if (r.userId === null) {
        guests += 1;
        return [r.id, { displayName: null, guest: guests, attemptNumber: null }];
      }
      const who = person.get(r.userId);
      return [
        r.id,
        {
          displayName:
            `${who?.givenName ?? ""} ${who?.familyName ?? ""}`.trim() || (who?.email ?? r.userId),
          guest: null,
          attemptNumber: (attemptsOf.get(r.userId) ?? 0) > 1 ? r.attemptNumber : null,
        },
      ];
    }),
  );
}

/** One line of a cell's history: the panel's and the cell route's, the same DTO. */
const historyEntry = (grading: GradingRecord): GradingHistoryEntry => ({
  id: grading.id,
  points: grading.points,
  maxPoints: grading.maxPoints,
  source: grading.source,
  state: grading.state,
  gradedAt: iso(grading.gradedAt),
  comment: grading.comment,
  regradeNote: grading.regradeNote,
});

async function historyOf(
  db: Db,
  evaluationId: string,
  scope: CellScope,
): Promise<Map<PairKey, GradingHistoryEntry[]>> {
  const rows = await db
    .select({ grading: gradings })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(gradingsIn(evaluationId, scope))
    .orderBy(...NEWEST_FIRST);
  const map = new Map<PairKey, GradingHistoryEntry[]>();
  for (const { grading } of rows) {
    const key = pairKey(grading.attemptId, grading.itemId);
    const list = map.get(key) ?? [];
    list.push(historyEntry(grading));
    map.set(key, list);
  }
  return map;
}

/** Everything the panel reads besides the items and the attempts, keyed by cell. */
interface QueueContext {
  answers: Map<PairKey, typeof answers.$inferSelect>;
  standing: Map<PairKey, GradingRecord>;
  history: Map<PairKey, GradingHistoryEntry[]>;
  roster: Map<string, Roster>;
  /** The teacher's own test walks (ADR-018). */
  staffAttempts: ReadonlySet<string>;
  /** The attempt that counts for each student who retook (ADR-025). */
  kept: ReadonlySet<string>;
  /**
   * Each item's config, parsed once for every attempt that shows it — per
   * attempt for a parameterized question, whose every attempt has its own
   * key and its own values (ADR-056, `readingPerAttempt`).
   */
  readings: Map<string, (attempt: AttemptRecord) => Reading>;
}

/**
 * The reads of the panel: one query each, never one per cell, and only for
 * the selected cells — a panel narrowed to one item does not load the
 * answers and the history of the whole evaluation.
 */
async function loadQueueContext(
  db: Db,
  evaluation: EvaluationRecord,
  attemptRows: readonly AttemptRecord[],
  selection: { items: readonly JoinedItem[]; scope: CellScope },
): Promise<QueueContext> {
  const { scope } = selection;
  const [answerRows, standing, history, roster, staffAttempts, kept] = await Promise.all([
    attemptRows.length === 0 || selection.items.length === 0
      ? []
      : db
          .select()
          .from(answers)
          .where(
            and(
              inArray(
                answers.attemptId,
                attemptRows.map((a) => a.id),
              ),
              scope.itemId ? eq(answers.itemId, scope.itemId) : undefined,
            ),
          ),
    standingGradings(db, evaluation.id, scope),
    historyOf(db, evaluation.id, scope),
    rosterOf(db, attemptRows),
    // The teacher's own test walk is corrected like any other — they asked
    // for it — but the panel says whose it is (ADR-018).
    staffAttemptIds(db, evaluation),
    // Only worth a read when somebody retook: otherwise every attempt counts.
    attemptRows.some((a) => a.attemptNumber > 1) ? keptAttempts(db, evaluation) : null,
  ]);
  return {
    answers: new Map(answerRows.map((a) => [pairKey(a.attemptId, a.itemId), a])),
    standing,
    history,
    roster,
    staffAttempts,
    kept: new Set(
      kept === null ? attemptRows.map((a) => a.id) : [...kept.values()].map((a) => a.id),
    ),
    // Only when some cell will show them: an empty panel never parsed a
    // config, and must not start failing on one that no longer loads.
    readings: new Map(
      (attemptRows.length === 0 ? [] : selection.items).map((i) => [
        i.item.id,
        readingPerAttempt(i),
      ]),
    ),
  };
}

/**
 * One cell of the panel. The views still come from `studentViewOf`/`solutionViewOf` (invariant 4).
 *
 * Anonymous (the default), nothing in it names the student: no label, no
 * user id. The attempt id stays — it names an attempt, and it is what every
 * write of the panel addresses.
 */
function entryOf(
  { attempt, item }: { attempt: AttemptRecord; item: JoinedItem },
  grading: GradingRecord | null,
  context: QueueContext,
  anonymous: boolean,
): GradingEntry {
  const key = pairKey(attempt.id, item.item.id);
  const answer = context.answers.get(key) ?? null;
  const who = context.roster.get(attempt.id);
  const reading = context.readings.get(item.item.id)?.(attempt);
  const config = reading?.config;
  const view = { seed: attempt.seed, itemId: item.item.id, shuffle: false };
  return {
    answerId: answer?.id ?? null,
    attemptId: attempt.id,
    itemId: item.item.id,
    label: anonymous ? null : (who?.displayName ?? null),
    guest: anonymous ? null : (who?.guest ?? null),
    staff: context.staffAttempts.has(attempt.id),
    attemptNumber: who?.attemptNumber ?? null,
    kept: context.kept.has(attempt.id),
    answer: answer?.payload ?? null,
    ...(reading?.values
      ? {
          values: formattedValues(parametersOf(item.version)!, reading.values),
          explanation: explanationOrNull(reading.explanation),
        }
      : {}),
    student: studentViewOf(item.question.type, config, view),
    solution: solutionViewOf(item.question.type, config, view),
    grading: grading ? toGrading(grading) : null,
    history: context.history.get(key) ?? [],
  };
}

/**
 * `GET /evaluations/:id/grading` (§4.5): every student's answer to one
 * question — which is how a teacher actually corrects, and the only way
 * through the panel since ADR-044 — or to every question, item after item.
 *
 * The counts are those of the SELECTION (the item): every state is sent,
 * and the panel filters in the browser.
 */
export async function gradingQueue(
  db: Db,
  evaluation: EvaluationRecord,
  query: GradingQuery,
): Promise<GradingQueue> {
  const [allItems, attemptRows] = await Promise.all([
    joinedItems(db, evaluation.id),
    db
      .select()
      .from(attempts)
      // Never a practice attempt after the due date (ADR-122): no teacher grades it.
      .where(and(eq(attempts.evaluationId, evaluation.id), officialAttempt))
      .orderBy(asc(attempts.createdAt)),
  ]);
  const items = query.itemId ? allItems.filter((i) => i.item.id === query.itemId) : allItems;
  const context = await loadQueueContext(db, evaluation, attemptRows, {
    items,
    scope: { itemId: query.itemId },
  });

  const entries: GradingEntry[] = [];
  let validated = 0;
  let proposed = 0;
  for (const item of items) {
    // A neutralized item's answers stay on the panel, out of the counts (ADR-108).
    const counts = countsForStudent(item.item.counting);
    for (const attempt of attemptRows) {
      const grading = context.standing.get(pairKey(attempt.id, item.item.id)) ?? null;
      if (counts && grading?.state === "validated") validated += 1;
      else if (counts && grading?.state === "proposed") proposed += 1;
      entries.push(entryOf({ attempt, item }, grading, context, query.anonymous));
    }
  }

  const total = items.filter((i) => countsForStudent(i.item.counting)).length * attemptRows.length;
  return {
    items: items.map((i) => ({
      id: i.item.id,
      position: i.item.position,
      internalName: i.question.internalName,
      type: i.question.type,
      points: i.item.points,
      minPoints: pointsRangeOf(evaluation, i, i.item.points).min,
      // The declared fields only: a criterion's prompt stays in the key.
      criteria: criteriaOf(i).map(({ id, title, weight }) => ({ id, title, weight })),
      explanation: explanationOrNull(i.version.explanation),
      exportable: exportsText(i.question.type, i.version),
      ...(isParameterized(i.version) ? { parameters: writtenOf(i) } : {}),
    })),
    entries,
    counts: { total, validated, proposed, missing: total - validated - proposed },
  };
}

/**
 * The panel's expected row: the question as written, through the type's own
 * views, seed 0 and no shuffle, like every view of the panel (ADR-056 §9 for
 * a parameterized one, `example` when only an instance could be drawn).
 * Staff-only, like the queue and the answers export (F-EXP-01).
 */
export function expectedViews(item: JoinedItem): { student: unknown; solution: unknown; example: boolean } {
  const { config, example } = writtenConfig(item.question.type, item.version);
  return { ...staffViews(item.question.type, config, item.item.id), example };
}

/** A parameterized item's expected row (ADR-056 §9): its variables, and the question as written. */
function writtenOf(item: JoinedItem): NonNullable<GradingQueue["items"][number]["parameters"]> {
  return { variables: parametersOf(item.version)!, template: expectedViews(item) };
}

/**
 * `GET /evaluations/:id/grading/steps` (#107). One step per question, in the
 * evaluation's order, with the state of its cells, for the question selector.
 *
 * Counted from the same validated gradings as the queue's `counts`, so a
 * step reads "2 to validate" here exactly when its queue would say so. No
 * answer, no view and no history is loaded: this is two counters per step.
 */
export async function gradingSteps(db: Db, evaluation: EvaluationRecord): Promise<GradingSteps> {
  const items = await joinedItems(db, evaluation.id);
  const attemptRows = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.evaluationId, evaluation.id), officialAttempt));
  // The validated cells and nothing else — not the details, the comment or
  // the history `standingGradings` carries for the queue: a question is done
  // when each of its cells holds a validated grading.
  const rows = await db
    .select({ attemptId: gradings.attemptId, itemId: gradings.itemId })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(and(eq(attempts.evaluationId, evaluation.id), officialAttempt, eq(gradings.state, "validated")));
  const validated = new Set(rows.map((row) => pairKey(row.attemptId, row.itemId)));

  return {
    steps: items.map((item) => ({
      key: item.item.id,
      total: attemptRows.length,
      validated: attemptRows.filter((a) => validated.has(pairKey(a.id, item.item.id))).length,
    })),
  };
}

/** The full history of one cell, newest first (F-GRADE-05, F-GRADE-06). */
export async function historyOfCell(
  db: Db,
  attemptId: string,
  itemId: string,
): Promise<GradingHistoryEntry[]> {
  const rows = await db
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemId)))
    .orderBy(...NEWEST_FIRST);
  return rows.map(historyEntry);
}
