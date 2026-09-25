/**
 * The dashboard read model (F-DASH-01..04) and the inspector of one
 * attempt. Imported through `./service.ts`.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { AttemptInspect, AttemptState, DashboardView, Verdict } from "@quiz/contracts";
import { shuffle } from "@quiz/core/rng";
import { countsAsCompleted, round2, uniquePseudonyms } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { answers, attemptEvents, attempts, enrollments, users } from "../../db/schema.js";
import {
  settingsOf,
  staffRosterWithAttempt,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { joinedItems, totalPointsOf } from "../evaluation/service.js";
import * as events from "./events.js";
import {
  pairKey,
  standingGradings,
  verdictOf,
  type GradingRecord,
  type PairKey,
} from "../grading/service.js";
import { presence } from "../realtime/presence.js";
import { solutionView, studentView } from "./studentView.js";
import { type AttemptRecord, type AnswerRecord, answersOf } from "./attempt.js";
import { answerSummarizer, answeredBy, liveGrader, cellStatus } from "./autosave.js";

// --- Dashboard read model (F-DASH-01..04) ---------------------------------

export async function dashboardView(
  db: Db,
  evaluation: EvaluationRecord,
  input: { now: Date; includeAnswers: boolean; includeResults: boolean },
): Promise<DashboardView> {
  const items = await joinedItems(db, evaluation.id);
  const roster = await db
    .select({
      seatId: enrollments.id,
      userId: enrollments.userId,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      timeBonusPercent: enrollments.timeBonusPercent,
    })
    .from(enrollments)
    .where(
      and(eq(enrollments.classroomId, evaluation.classroomId), eq(enrollments.staff, false)),
    )
    .orderBy(asc(enrollments.nom), asc(enrollments.prenom));
  /*
   * The teacher's own test walk, under the class and never among it
   * (ADR-018). It is here because a teacher who is testing wants to watch
   * their own row light up like anybody else's; it is LAST and flagged
   * because everything this grid totals is about the class.
   */
  const staffRoster = await staffRosterWithAttempt(db, evaluation);
  const seats = [
    ...roster.map((entry) => ({ ...entry, staff: false })),
    ...staffRoster.map((entry) => ({ ...entry, staff: true })),
  ];

  const attemptRows = await db
    .select()
    .from(attempts)
    .where(eq(attempts.evaluationId, evaluation.id));
  const byUser = new Map(attemptRows.map((a) => [a.userId, a]));

  const answerRows =
    attemptRows.length === 0
      ? []
      : await db
          .select()
          .from(answers)
          .where(inArray(answers.attemptId, attemptRows.map((a) => a.id)));
  const byAttempt = new Map<string, Map<string, AnswerRecord>>();
  for (const row of answerRows) {
    let map = byAttempt.get(row.attemptId);
    if (!map) {
      map = new Map();
      byAttempt.set(row.attemptId, map);
    }
    map.set(row.itemId, row);
  }

  // The grades of the grid (F-DASH-01): every grading still standing, in one
  // query. A proposal shows as `pending`, a validated one as its verdict.
  const standing: ReadonlyMap<PairKey, GradingRecord> = await standingGradings(db, evaluation.id);

  // A claimed seat is named after its account, as it always was; an unclaimed
  // one after its roster entry, until the student signs in.
  const pseudonyms = uniquePseudonyms(
    evaluation.id,
    roster.map((r) => r.userId ?? r.seatId),
  );
  const online = presence.online(evaluation.id);
  const maxPoints = totalPointsOf(items.map((i) => i.item));

  // One summarizer per QUESTION (see `answerSummarizer`), built only when the
  // teacher actually asked for the answers.
  const summarize = new Map<string, (payload: unknown) => string>(
    input.includeAnswers ? items.map((item) => [item.item.id, answerSummarizer(item)]) : [],
  );
  // "Does it hold an answer?", once per QUESTION too (issue #89).
  const holds = new Map(items.map((item) => [item.item.id, answeredBy(item)]));

  /*
   * One live grader per QUESTION (ADR-020), built only when the teacher asked
   * for the results — the type and its configuration are parsed once per
   * column and reused down it, exactly like the summarizer above. A column
   * whose type is graded by the runner has no entry at all, so its cells cost
   * nothing.
   */
  const preview = new Map<string, NonNullable<ReturnType<typeof liveGrader>>>();
  if (input.includeResults) {
    for (const item of items) {
      const grader = liveGrader(item, evaluation, input.now);
      if (grader) preview.set(item.item.id, grader);
    }
  }
  /** The live rate of each item, over the CLASS rows only (ADR-018). */
  const liveRates = new Map<string, number[]>();

  /*
   * EVERY seat is a row, claimed or not. A roster imported from a list is a
   * class of unclaimed entries until each student signs in once; leaving them
   * out read "Nobody on the roster" in front of twenty students who simply
   * had not logged in yet.
   */
  const rows: DashboardView["rows"] = await Promise.all(
    seats.map(async (entry) => {
      const userId = entry.userId;
      const attempt = userId === null ? null : (byUser.get(userId) ?? null);
      const answered = attempt ? (byAttempt.get(attempt.id) ?? new Map()) : new Map();
      return {
        attemptId: attempt?.id ?? null,
        seatId: entry.seatId,
        userId,
        staff: entry.staff,
        displayName: `${entry.prenom} ${entry.nom}`.trim() || entry.email,
        pseudonym: pseudonyms.get(userId ?? entry.seatId) ?? "—",
        state: (attempt?.state ?? "not_started") as AttemptState,
        online: userId !== null && online.has(userId),
        lastSeenAt: isoOrNull(
          (userId === null ? null : presence.lastSeenAt(evaluation.id, userId)) ??
            attempt?.presentAt ??
            null,
        ),
        deadlineAt: isoOrNull(attempt?.deadlineAt ?? null),
        timeBonusPercent: entry.timeBonusPercent,
        points: attempt ? pointsOf(standing, attempt.id, items) : null,
        maxPoints,
        cells: await Promise.all(
          items.map(async (item) => {
            const answer: AnswerRecord | null = answered.get(item.item.id) ?? null;
            const grading = attempt
              ? (standing.get(pairKey(attempt.id, item.item.id)) ?? null)
              : null;
            // A grading on record always wins: a preview never overwrites a
            // teacher's validated verdict, nor a proposal awaiting their eyes.
            let verdict: Verdict | null = grading ? verdictOf(grading) : null;
            let provisional = false;
            if (grading === null && attempt !== null && answer !== null && answer.payload !== null) {
              const graded = await preview.get(item.item.id)?.(attempt, answer.payload);
              if (graded) {
                verdict = graded.verdict;
                provisional = true;
                if (!entry.staff && graded.rate !== null) {
                  const rates = liveRates.get(item.item.id) ?? [];
                  rates.push(graded.rate);
                  liveRates.set(item.item.id, rates);
                }
              }
            }
            return {
              itemId: item.item.id,
              status: cellStatus(
                answer,
                answer !== null && (holds.get(item.item.id)?.(answer.payload) ?? false),
              ),
              verdict,
              provisional,
              points: grading && grading.state === "validated" ? grading.points : null,
              revision: answer?.revision ?? 0,
              summary:
                answer ? (summarize.get(item.item.id)?.(answer.payload) ?? null) : null,
              flagged: answer?.flagged ?? false,
            };
          }),
        ),
      };
    }),
  );

  // Every denominator below is the CLASS: a teacher testing their own quiz
  // must not move the completion of a question or its success rate.
  const classRows = rows.filter((r) => !r.staff);
  const started = classRows.filter((r) => r.attemptId !== null).length;
  const staffAttempts = new Set(
    rows.filter((r) => r.staff && r.attemptId !== null).map((r) => r.attemptId!),
  );
  return {
    evaluation: {
      id: evaluation.id,
      state: evaluation.state,
      startedAt: isoOrNull(evaluation.startedAt),
      pausedAt: isoOrNull(evaluation.pausedAt),
      closesAt: isoOrNull(evaluation.closesAt),
      serverNow: iso(input.now),
    },
    items: items.map((i) => ({
      id: i.item.id,
      position: i.item.position,
      points: i.item.points,
      type: i.question.type,
      internalName: i.question.internalName,
      milestone: i.item.milestone,
    })),
    rows,
    totals: items.map((item) => {
      // Completion counts the questions the student has DEALT with —
      // answered, skipped on purpose or validated (issue #89) — by the rule
      // the grid applies to its own frames (`@quiz/domain`).
      const done = classRows.filter((r) => {
        const status = r.cells.find((c) => c.itemId === item.item.id)?.status;
        return status !== undefined && countsAsCompleted(status);
      }).length;
      const graded = successRateOf(standing, item.item.id, staffAttempts);
      // Before anything is graded, the live rate of the answers that CAN be
      // graded now (ADR-020) — flagged, so the footer says which it is.
      const live = liveRates.get(item.item.id) ?? [];
      const provisional = graded === null && live.length > 0;
      return {
        itemId: item.item.id,
        completion: started === 0 ? 0 : round2(done / started),
        successRate: provisional
          ? round2(live.reduce((a, b) => a + b, 0) / live.length)
          : graded,
        provisional,
      };
    }),
  };
}

/** The validated points of one attempt; `null` while nothing is graded yet. */
function pointsOf(
  standing: ReadonlyMap<PairKey, GradingRecord>,
  attemptId: string,
  items: readonly JoinedItem[],
): number | null {
  let total = 0;
  let seen = 0;
  for (const item of items) {
    const grading = standing.get(pairKey(attemptId, item.item.id));
    if (grading?.state !== "validated") continue;
    total += grading.points;
    seen += 1;
  }
  return seen === 0 ? null : round2(total);
}

/**
 * The mean of `points / maxPoints` over the validated gradings of one item,
 * excluding the attempts of `skip` — the staff tests of ADR-018.
 */
function successRateOf(
  standing: ReadonlyMap<PairKey, GradingRecord>,
  itemId: string,
  skip: ReadonlySet<string>,
): number | null {
  let sum = 0;
  let n = 0;
  for (const grading of standing.values()) {
    if (grading.itemId !== itemId || grading.state !== "validated") continue;
    if (skip.has(grading.attemptId)) continue;
    if (grading.maxPoints <= 0) continue;
    sum += grading.points / grading.maxPoints;
    n += 1;
  }
  return n === 0 ? null : round2(sum / n);
}

/** F-DASH-05: one attempt opened in read mode, key included (teacher only). */
export async function attemptInspect(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): Promise<AttemptInspect> {
  const items = await joinedItems(db, evaluation.id);
  const answered = await answersOf(db, attempt.id);
  // A teacher only ever inspects an attempt of THEIR evaluation, and a poll
  // has no inspector; the guest branch is here so the type is honest.
  const [student] = attempt.userId === null
    ? []
    : await db
        .select({ givenName: users.givenName, familyName: users.familyName, email: users.email })
        .from(users)
        .where(eq(users.id, attempt.userId))
        .limit(1);
  const ownerId = attempt.userId ?? attempt.id;
  const journal = await db
    .select()
    .from(attemptEvents)
    .where(eq(attemptEvents.attemptId, attempt.id))
    .orderBy(desc(attemptEvents.at))
    .limit(200);
  return {
    attempt: {
      id: attempt.id,
      userId: ownerId,
      displayName: student
        ? `${student.givenName ?? ""} ${student.familyName ?? ""}`.trim() || student.email
        : "Guest",
      pseudonym: uniquePseudonyms(evaluation.id, [ownerId]).get(ownerId) ?? "—",
      state: attempt.state,
      startedAt: isoOrNull(attempt.startedAt),
      deadlineAt: isoOrNull(attempt.deadlineAt),
      submittedAt: isoOrNull(attempt.submittedAt),
    },
    items: items.map((entry) => {
      const version = {
        config: entry.version.config,
        configVersion: entry.version.configVersion,
      };
      const answer = answered.get(entry.item.id) ?? null;
      return {
        item: {
          id: entry.item.id,
          position: entry.item.position,
          points: entry.item.points,
          type: entry.question.type,
          internalName: entry.question.internalName,
        },
        // The teacher sees exactly what the student saw, shuffle included.
        studentConfig: studentView({
          type: entry.question.type,
          version,
          seed: attempt.seed,
          itemId: entry.item.id,
          shuffle: settingsOf(evaluation).shuffleChoices && entry.question.shuffleable,
        }),
        answer: answer?.payload ?? null,
        revision: answer?.revision ?? 0,
        markedDone: answer?.markedDone ?? false,
        skipped: answer?.skipped ?? false,
        flagged: answer?.flagged ?? false,
        solution: solutionView({
          type: entry.question.type,
          version,
          seed: attempt.seed,
          itemId: entry.item.id,
        }),
      };
    }),
    events: journal.map((e) => ({ kind: e.kind, at: iso(e.at), details: e.details })),
    serverNow: iso(now),
  };
}
