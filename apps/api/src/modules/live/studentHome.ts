/**
 * The student home (F-LIVE-01): the running polls, the evaluation cards in
 * their three groups, and the "Past series" of practice (ADR-122), from the
 * one board the Grades page reads too (`grades.ts`).
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { AttemptScore, EvaluationCard, PracticeCard, StudentPollCard } from "@quiz/contracts";
import { isFinishedAttempt, retakeRefusal, retakeScopeOf } from "@quiz/domain";

import { isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { attempts, evaluations, practiceAttempt } from "../../db/schema.js";
import {
  classroomIdOf,
  countedItemsByEvaluation,
  handoutPrints,
  inPastSeries,
  retakePolicyOf,
  retakesEnabled,
  studentEvaluationRows,
  totalPointsByEvaluation,
  trustedClients,
} from "../evaluation/service.js";
import {
  scoreOf,
  studentAttempts,
  tallyByAttempt,
  type AttemptTally,
  type StudentAttempts,
} from "../grading/service.js";
import {
  countedAttempt,
  countedAttemptId,
  gradeReadable,
  releasedGradesOf,
  resultsState,
  scoreVisible,
  type ReleasedGrade,
} from "../results/service.js";
import type { AttemptRecord } from "./access.js";
import { conditionsFor } from "./views.js";

/**
 * ADR-122, the student home's "Past series", from the rows `studentBoard`
 * already read: the exercises over and open to practice in a classroom that
 * is not archived, newest closed first, each with the student's unfinished
 * practice attempt and the score of their latest finished one — points,
 * never a grade — and whether its blank print is made (`printable`, the ids
 * `handoutPrints` let through).
 */
function practiceCardsOf(
  rows: readonly StudentRow[],
  mine: readonly AttemptRecord[],
  printable: ReadonlySet<string>,
  scores: Scores,
): PracticeCard[] {
  return rows
    .map((row): PracticeCard => {
      const evaluation = row.evaluation;
      const own = mine.filter((a) => a.evaluationId === evaluation.id);
      const finished = own.filter((a) => isFinishedAttempt(a.state));
      const last = finished.at(-1) ?? null;
      return {
        id: evaluation.id,
        title: evaluation.title,
        classroomId: classroomIdOf(evaluation),
        classroomName: row.classroomName,
        courseCode: row.courseCode,
        closedAt: isoOrNull(evaluation.closedAt),
        openAttemptId: own.find((a) => !isFinishedAttempt(a.state))?.id ?? null,
        count: finished.length,
        printable: printable.has(evaluation.id),
        last:
          last === null
            ? null
            : {
                attemptId: last.id,
                finishedAt: isoOrNull(last.submittedAt ?? last.closedAt),
                // An exercise shows its correction, the score included (ADR-124).
                score: scoreFrom(scores, last.id, evaluation.id),
              },
      };
    })
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
}

/** The student's practice attempts on `rows`, oldest first; none to read without a row. */
async function practiceAttemptsOf(db: Db, userId: string, rows: readonly StudentRow[]): Promise<AttemptRecord[]> {
  if (rows.length === 0) return [];
  return db
    .select()
    .from(attempts)
    .where(
      and(eq(attempts.userId, userId), practiceAttempt, inArray(attempts.evaluationId, rows.map((r) => r.evaluation.id))),
    )
    .orderBy(asc(attempts.attemptNumber));
}

/**
 * The evaluations' half of the student's home and classroom page: the
 * running polls and the evaluation cards in their three groups. The
 * `activity` module tags them and lists them with the other kinds
 * (`ActivityKind.studentCards`, M3-09a); the kiosk reads them for the exams
 * a station may start (ADR-051 §7).
 */
export interface EvaluationHome {
  polls: StudentPollCard[];
  open: EvaluationCard[];
  upcoming: EvaluationCard[];
  past: EvaluationCard[];
  /** ADR-122, "Past series": the whole home's, or one classroom's under `classroomId` (its page's Activities tab). */
  practice: PracticeCard[];
}

/**
 * `classroomId` narrows the home to one of the student's classrooms: the
 * Activities tab of their classroom page (M5-01, `ActivityKind.studentCards`),
 * which the caller has loaded through `readableClassroom` first.
 */
export async function studentHome(
  db: Db,
  userId: string,
  now: Date,
  classroomId?: string,
): Promise<EvaluationHome> {
  const { polls, open, upcoming, past, practice } = await studentBoard(db, userId, now, classroomId, { practice: true });
  return { polls, open, upcoming, past: past.map((entry) => entry.card), practice };
}

type StudentRow = Awaited<ReturnType<typeof studentEvaluationRows>>[number];

/**
 * A card of the student's Past, beside the row it was drawn from, the
 * attempt that counts (`countedAttempt`), the released grade, and `early`:
 * the points the feedback page shows for that attempt BEFORE the release
 * (results `available`, not released), with its count of questions still
 * pending, null everywhere else.
 */
export interface PastEntry {
  row: StudentRow;
  card: EvaluationCard;
  counted: { id: string; state: string } | null;
  released: ReleasedGrade | undefined;
  early: AttemptScore | null;
}

/**
 * The student's evaluations sorted into the home's lists (F-LIVE-01): ONE
 * rule for what is open, coming and past, which the home and the Grades page
 * (`grades.ts`) both read. Within the module only.
 */
export async function studentBoard(
  db: Db,
  userId: string,
  now: Date,
  classroomId?: string,
  options: { practice?: boolean } = {},
) {
  const all = await studentEvaluationRows(db, userId, classroomId).orderBy(
    desc(evaluations.createdAt),
  );
  const polls = pollCardsOf(all);
  const rows = all.filter((r) => r.evaluation.mode !== "poll");

  // F-EVAL-15: an exercise with retakes shows the attempt that COUNTS (best
  // or last) and how many were taken; its grade is the kept attempt's. Every
  // other card is its one attempt, as before.
  const withRetakes = rows.filter((r) => retakesEnabled(r.evaluation));
  // ADR-122: the exercises over and open to practice, outside an archived
  // classroom, and the student's practice attempts on them.
  const practiced = options.practice ? rows.filter((r) => inPastSeries(r.evaluation, r.archivedAt)) : [];
  const [perEvaluation, practiceRows] = await Promise.all([
    studentAttempts(
      db,
      userId,
      withRetakes.map((r) => r.evaluation),
    ),
    practiceAttemptsOf(db, userId, practiced),
  ]);

  // The grade of a released evaluation is the results page's (WP6), and the
  // score of a kept attempt what its feedback page would show — so are the
  // points of a row readable before its release (`early`). A fixed number of
  // queries for the whole page, not one per card.
  const readableEarly = readableEarlyOf(rows, perEvaluation);
  const scored = [...new Set([...withRetakes, ...readableEarly])];
  const scoredIds = [...new Set([...scored, ...practiced].map((r) => r.evaluation.id))];
  const [grades, totals, itemCounts, tallies, printable] = await Promise.all([
    releasedGradesOf(db, userId, rows, perEvaluation),
    totalPointsByEvaluation(db, scoredIds),
    countedItemsByEvaluation(db, scoredIds),
    tallyByAttempt(db, [
      ...scored.map((row) => countedAttemptId(perEvaluation, row)).filter((id): id is string => id !== null),
      ...lastFinishedPracticeIds(practiceRows),
    ]),
    handoutPrints(
      db,
      practiced.map((r) => r.evaluation),
    ),
  ]);
  const scores: Scores = { totals, itemCounts, tallies };

  const { open, upcoming, past } = groupCards(rows, { perEvaluation, readableEarly, grades, scores, now });
  const practice = practiceCardsOf(practiced, practiceRows, printable, scores);
  return { polls, open, upcoming, past, practice };
}

/**
 * Issue #163: a poll is answered at `/p/:code`, never through an attempt of
 * the player (`enterEvaluation` refuses one), so it is never an evaluation
 * card. A RUNNING one is listed on its own, with its code and nothing of its
 * question; an ended one is gone, since nothing of a poll is released
 * (ADR-014 §8). The rows come through the student's roster seats, so a
 * classroom-less (anonymous) poll can never be among them.
 */
function pollCardsOf(all: readonly StudentRow[]): StudentPollCard[] {
  return all
    .filter(
      (r) =>
        r.evaluation.mode === "poll" &&
        r.evaluation.state === "running" &&
        r.evaluation.accessCode !== null,
    )
    .map((r) => ({
      id: r.evaluation.id,
      code: r.evaluation.accessCode!,
      classroomId: classroomIdOf(r.evaluation),
      classroomName: r.classroomName,
      courseCode: r.courseCode,
    }));
}

/** The rows whose counted attempt's points are readable before the release (`early`). */
function readableEarlyOf(
  rows: readonly StudentRow[],
  perEvaluation: ReadonlyMap<string, StudentAttempts>,
): StudentRow[] {
  return rows.filter((row) => {
    const kept = countedAttempt(perEvaluation, row);
    return (
      kept !== null &&
      row.evaluation.releasedAt === null &&
      resultsState(row.evaluation, kept.state) === "available"
    );
  });
}

/** The latest finished practice attempt of each evaluation, whose score its card shows. */
function lastFinishedPracticeIds(practiceRows: readonly AttemptRecord[]): string[] {
  return [
    ...new Map(practiceRows.filter((a) => isFinishedAttempt(a.state)).map((a) => [a.evaluationId, a.id])).values(),
  ];
}

/** The points every score of the board is read from, read once for the whole page. */
interface Scores {
  totals: ReadonlyMap<string, number>;
  itemCounts: ReadonlyMap<string, number>;
  tallies: ReadonlyMap<string, AttemptTally>;
}

/** The score of one attempt of one evaluation, as its feedback page shows it. */
function scoreFrom(scores: Scores, attemptId: string, evaluationId: string): AttemptScore {
  return scoreOf(
    scores.tallies.get(attemptId),
    scores.itemCounts.get(evaluationId) ?? 0,
    scores.totals.get(evaluationId) ?? 0,
  );
}

/** What the cards of the board read beside their row. */
interface BoardContext {
  perEvaluation: ReadonlyMap<string, StudentAttempts>;
  readableEarly: readonly StudentRow[];
  grades: ReadonlyMap<string, ReleasedGrade>;
  scores: Scores;
  now: Date;
}

function retakesOf(row: StudentRow, ctx: BoardContext): EvaluationCard["retakes"] {
  const mine = ctx.perEvaluation.get(row.evaluation.id);
  if (!mine) return null;
  const policy = retakePolicyOf(row.evaluation);
  const kept = mine.kept;
  return {
    keep: policy.keep,
    maxAttempts: policy.maxAttempts,
    scope: retakeScopeOf(policy),
    attemptCount: mine.all.length,
    canRetake:
      retakeRefusal({
        mode: row.evaluation.mode,
        retakes: policy,
        evaluationState: row.evaluation.state,
        closesAt: row.evaluation.closesAt,
        now: ctx.now,
        attempts: mine.all,
      }) === null,
    // Only a finished attempt has a score to read (ADR-025).
    kept:
      kept === null || !isFinishedAttempt(kept.state)
        ? null
        : {
            attemptId: kept.id,
            attemptNumber: kept.attemptNumber,
            // What the feedback page would show, and no more.
            score: scoreVisible(row.evaluation, kept.state)
              ? scoreFrom(ctx.scores, kept.id, row.evaluation.id)
              : null,
          },
  };
}

function cardOf(row: StudentRow, counted: string | null, ctx: BoardContext): EvaluationCard {
  return {
    id: row.evaluation.id,
    title: row.evaluation.title,
    mode: row.evaluation.mode,
    state: row.evaluation.state,
    classroomId: classroomIdOf(row.evaluation),
    classroomName: row.classroomName,
    courseCode: row.courseCode,
    opensAt: isoOrNull(row.evaluation.opensAt),
    closesAt: isoOrNull(row.evaluation.closesAt),
    durationS: row.evaluation.durationS,
    attemptId: row.attempt?.id ?? null,
    attemptState: row.attempt?.state ?? null,
    attemptStartedAt: isoOrNull(row.attempt?.startedAt ?? null),
    deadlineAt: isoOrNull(row.attempt?.deadlineAt ?? null),
    // Only a grade the student may read (F-RES-04): never under `none`.
    grade: gradeReadable(row.evaluation, counted)
      ? (ctx.grades.get(row.evaluation.id)?.grade ?? null)
      : null,
    retakes: retakesOf(row, ctx),
    // Issue #203: what "See my results" would lead to, for the attempt
    // that counts — the results service's own rule.
    results: resultsState(row.evaluation, counted),
    trustedClients: trustedClients(row.evaluation),
    // Set on an open card only, below (`withConditions`).
    conditions: null,
  };
}

/**
 * ADR-079 §7: a trusted client may begin the attempt directly, past the
 * waiting room, so an OPEN card carries what that room would have said.
 * Upcoming and past cards carry none, as a plain exam's.
 */
function withConditions(row: StudentRow, c: EvaluationCard): EvaluationCard {
  return c.trustedClients.length > 0 ? { ...c, conditions: conditionsFor(row.evaluation, row.timeBonusPercent) } : c;
}

/**
 * The home's group of a card that is not a draft. Issue #203: "Open now" is
 * what the student can still DO. A finished attempt that cannot be retaken
 * has nothing left to do, whatever the evaluation's state: it is past. A
 * reopened attempt is `in_progress` again, and comes back to Open on its own.
 */
function groupOf(c: EvaluationCard): "open" | "upcoming" | "past" {
  if (c.state === "scheduled") return "upcoming";
  if (c.state !== "lobby" && c.state !== "running" && c.state !== "paused") return "past";
  if (c.attemptState !== null && isFinishedAttempt(c.attemptState) && !c.retakes?.canRetake) return "past";
  return "open";
}

/** The non-poll rows as the home's three lists, drafts left out. */
function groupCards(
  rows: readonly StudentRow[],
  ctx: BoardContext,
): { open: EvaluationCard[]; upcoming: EvaluationCard[]; past: PastEntry[] } {
  const open: EvaluationCard[] = [];
  const upcoming: EvaluationCard[] = [];
  const past: PastEntry[] = [];
  for (const row of rows) {
    if (row.evaluation.state === "draft") continue;
    // The attempt that COUNTS (F-EVAL-15): the server's own, for the card and
    // for the Grades page alike.
    const kept = countedAttempt(ctx.perEvaluation, row);
    const counted = kept ? { id: kept.id, state: kept.state } : null;
    const c = cardOf(row, counted?.state ?? null, ctx);
    const group = groupOf(c);
    if (group === "upcoming") upcoming.push(c);
    else if (group === "open") open.push(withConditions(row, c));
    else {
      const early =
        counted !== null && ctx.readableEarly.includes(row) ? scoreFrom(ctx.scores, counted.id, row.evaluation.id) : null;
      past.push({ row, card: c, counted, released: ctx.grades.get(row.evaluation.id), early });
    }
  }
  return { open, upcoming, past };
}
