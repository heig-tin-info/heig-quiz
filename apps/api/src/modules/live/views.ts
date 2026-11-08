/**
 * The views of an attempt a student may hold: the attempt itself, the
 * teacher's preview, the waiting room and the ready screen, with the
 * conditions they state (ADR-076, ADR-079). Every item leaves through
 * `./studentView.ts` (invariant 4).
 */
import {
  evaluationConditionsOf,
  type AttemptItem,
  type AttemptOrLobby,
  type AttemptView,
  type EvaluationConditions,
  type EvaluationRules,
  type LobbyView,
  type ReadyView,
} from "@quiz/contracts";
import {
  checkAllowed,
  evaluationTotal,
  isEvaluationOver,
  isFinishedAttempt,
  isLiveState,
  practiceDurationS,
  practiceOwnLimit,
} from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { StoredInstance } from "../../db/columns.js";
import type { Db } from "../../db/client.js";
import {
  feedbackOf,
  joinedItems,
  settingsOf,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { validatedOfAttempt, type GradingRecord } from "../grading/service.js";
import type { InstanceAttempt } from "../pool/service.js";
import { presence } from "../realtime/presence.js";
import { studentItemCorrection } from "../results/service.js";
import {
  answersOf,
  enrolledCount,
  participantOfAttempt,
  type AnswerRecord,
  type AttemptRecord,
  type Participant,
} from "./access.js";
import { attemptItemView } from "./itemView.js";
import { lockedItemIds, orderItems, type OrderedItem } from "./order.js";
import { answerToStudent, studentViewOf } from "./studentView.js";

/** The teacher preview borrows a fixed attempt id: nothing is ever stored on it. */
export const PREVIEW_ATTEMPT_ID = "00000000-0000-4000-8000-000000000000";

function attemptItems(
  evaluation: EvaluationRecord,
  ordered: readonly OrderedItem[],
  answered: ReadonlyMap<string, AnswerRecord>,
  locked: ReadonlySet<string>,
  /** ADR-091: the items a partial retake carried over. */
  acquired: ReadonlySet<string>,
  attempt: InstanceAttempt & {
    /** The attempt's state, which the correction's rule reads (ADR-124). */
    state: string;
    /** Its validated gradings, by item: the verdict of a checked question. */
    graded: ReadonlyMap<string, GradingRecord>;
  },
): AttemptItem[] {
  return ordered.map((entry) => {
    const answer = answered.get(entry.item.id) ?? null;
    // The student's own numbers (ADR-056): stored at the attempt's creation,
    // drawn from the same seed for a preview that stores nothing. The ONE
    // view of the item (ADR-097): the question leaves in it, and so does the
    // stored answer — a carried-over one (ADR-091) under this attempt's seed.
    const itemView = attemptItemView(evaluation, entry, attempt);
    const { type, config, view } = itemView;
    const checked = answer?.checkedAt != null;
    return {
      id: entry.item.id,
      position: entry.item.position,
      points: entry.item.points,
      type: entry.question.type,
      milestone: entry.item.milestone,
      counting: entry.item.counting,
      // ADR-084: the teacher's passage before the item — an item property,
      // like the two flags above, carried by the one builder of the attempt.
      intro: entry.item.intro,
      student: studentViewOf(type, config, view),
      answer: answerToStudent(type, config, view, answer?.payload),
      revision: answer?.revision ?? 0,
      markedDone: answer?.markedDone ?? false,
      skipped: answer?.skipped ?? false,
      flagged: answer?.flagged ?? false,
      locked: locked.has(entry.item.id),
      acquired: acquired.has(entry.item.id),
      checked,
      // ADR-124 §3: a checked question's correction comes back on a resume
      // or a reload — through the one exit, which decides per question.
      correction: studentItemCorrection({
        evaluation,
        attemptState: attempt.state,
        checked,
        item: entry.item,
        itemView,
        grading: attempt.graded.get(entry.item.id) ?? null,
      }),
    };
  });
}

/**
 * Whether question content may travel to the student at all right now.
 *
 * Before the start the lobby is the WHOLE answer: an attempt row already
 * exists during the lobby (`enterEvaluation` creates it), and serving its
 * items would publish the exam before the teacher pressed Start. Once the
 * evaluation is over the items come back — the student payload carries no
 * key, and `readOnly` says the writes are done.
 */
function contentVisible(evaluation: EvaluationRecord, attempt: AttemptRecord): boolean {
  const { state } = evaluation;
  // A live evaluation shows its questions to a STARTED attempt only: one that
  // entered during a pause waits in the lobby until the resume begins it,
  // or it would read the whole exam on a clock that has not started.
  if (isLiveState(state)) return attempt.state !== "not_started";
  return isEvaluationOver(state);
}

/**
 * A write is only ever accepted on a running evaluation and a live attempt —
 * or on a live practice attempt, which follows its own deadline (ADR-122).
 */
function readOnlyFor(evaluation: EvaluationRecord, attempt: AttemptRecord): boolean {
  if (attempt.afterDue) return attempt.state !== "in_progress";
  return !(attempt.state === "in_progress" && evaluation.state === "running");
}

/**
 * The ONE view of an attempt a student may hold: the lobby until the
 * evaluation starts, the attempt itself afterwards. Every student-facing
 * caller goes through it — `POST /evaluations/:id/attempt`,
 * `GET /attempts/:id` and the `watch=attempt:<id>` snapshot — so there is a
 * single place where "may this student see the questions yet" is decided.
 */
export async function attemptOrLobbyView(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  /** Who holds the attempt, when the caller already loaded them; read once here otherwise. */
  holder?: Participant,
): Promise<AttemptOrLobby> {
  const participant = holder ?? (await participantOfAttempt(db, evaluation, attempt));
  if (!contentVisible(evaluation, attempt)) {
    return { kind: "lobby", view: await lobbyView(db, evaluation, participant, now) };
  }
  return { kind: "attempt", view: await attemptView(db, evaluation, attempt, now, participant) };
}

/**
 * The attempt itself. `holder` is who holds it, whose extra time the
 * conditions state (ADR-079): passed by a caller that already loaded them,
 * read here otherwise.
 */
export async function attemptView(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  holder?: Participant,
): Promise<AttemptView> {
  const participant = holder ?? (await participantOfAttempt(db, evaluation, attempt));
  const answered = await answersOf(db, attempt.id);
  // The verdicts a correction may carry (ADR-124), read only where one may
  // show: an exercise with a checked question, or handed in.
  const corrected =
    checkAllowed(evaluation.mode) &&
    (isFinishedAttempt(attempt.state) || [...answered.values()].some((a) => a.checkedAt !== null));
  return viewOf(db, evaluation, {
    seed: attempt.seed,
    timeBonusPercent: participant.timeBonusPercent,
    practice: attempt.afterDue,
    instances: attempt.instances,
    acquired: attempt.acquiredItemIds,
    answered,
    state: attempt.state,
    graded: corrected ? new Map((await validatedOfAttempt(db, attempt.id)).map((g) => [g.itemId, g])) : new Map(),
    header: {
      id: attempt.id,
      state: attempt.state,
      startedAt: isoOrNull(attempt.startedAt),
      deadlineAt: isoOrNull(attempt.deadlineAt),
      lastItemId: attempt.lastItemId,
      serverNow: iso(now),
      preview: false,
      readOnly: readOnlyFor(evaluation, attempt),
      ...(attempt.afterDue ? { practice: true as const } : {}),
    },
  });
}

/**
 * The teacher's "see it as a student" (§4.3): a real student view, and NO
 * attempt row anywhere. Seed 0 by default, so it is stable between reloads;
 * the stateless preview of issue #75 passes the seed it drew instead, and
 * gets exactly the order and the shuffles an attempt of that seed would.
 */
export async function previewView(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
  seed = 0,
  /** The evaluation's items when the caller already read them, not read twice. */
  items?: readonly JoinedItem[],
): Promise<AttemptView> {
  return viewOf(db, evaluation, {
    seed,
    timeBonusPercent: 0,
    practice: false,
    instances: {},
    acquired: [],
    items,
    answered: new Map(),
    state: "in_progress",
    graded: new Map(),
    header: {
      id: PREVIEW_ATTEMPT_ID,
      state: "in_progress",
      startedAt: iso(now),
      deadlineAt: null,
      lastItemId: null,
      serverNow: iso(now),
      preview: true,
      readOnly: false,
    },
  });
}

/**
 * The one builder behind {@link attemptView} and {@link previewView}: the two
 * differ only by the seed, the stored answers and the `attempt` header, so
 * both go through `attemptItems` -> `studentView` (invariant 4) by
 * construction.
 */
async function viewOf(
  db: Db,
  evaluation: EvaluationRecord,
  input: {
    seed: number;
    /** The participant's extra time, for the conditions' duration line (ADR-079); 0 in a preview. */
    timeBonusPercent: number;
    /** ADR-122: a practice attempt, whose conditions are the practice's. */
    practice: boolean;
    /** The attempt's stored values (ADR-056); `{}` for a preview, which draws them from `seed`. */
    instances: Readonly<Record<string, StoredInstance>>;
    /** ADR-091: the items a partial retake carried over; none in a preview. */
    acquired: readonly string[];
    items?: readonly JoinedItem[] | undefined;
    answered: ReadonlyMap<string, AnswerRecord>;
    /** The attempt's state; a preview's is `in_progress`, and it has nothing checked. */
    state: string;
    /** The attempt's validated gradings, by item (ADR-124); none in a preview. */
    graded: ReadonlyMap<string, GradingRecord>;
    header: AttemptView["attempt"];
  },
): Promise<AttemptView> {
  const { seed, answered } = input;
  const settings = settingsOf(evaluation);
  const items = input.items ?? (await joinedItems(db, evaluation.id));
  const ordered = orderItems(items, settings, seed, evaluation.id);
  const locked = lockedItemIds(settings, ordered, answered);
  // `AttemptView` types the settings without `conditions` (ADR-079); a
  // variable is not checked for excess keys, so they are taken out here.
  const { conditions: _announced, ...studentSettings } = settings;
  return {
    attempt: input.header,
    conditions: input.practice
      ? practiceConditions(evaluation, input.timeBonusPercent)
      : conditionsFor(evaluation, input.timeBonusPercent),
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
      mode: evaluation.mode,
      state: evaluation.state,
      settings: studentSettings,
      feedbackPolicy: feedbackOf(evaluation),
      pausedAt: isoOrNull(evaluation.pausedAt),
      totalPoints: evaluationTotal(items.map((i) => i.item)),
    },
    items: attemptItems(evaluation, ordered, answered, locked, new Set(input.acquired), {
      seed,
      instances: input.instances,
      state: input.state,
      graded: input.graded,
    }),
  };
}

/**
 * The conditions a student reads (ADR-079): the announced ones and the lines
 * the platform derives from the settings, with this participant's extra time.
 */
export function conditionsFor(evaluation: EvaluationRecord, timeBonusPercent: number): EvaluationConditions {
  return evaluationConditionsOf({
    mode: evaluation.mode,
    settings: settingsOf(evaluation),
    durationS: evaluation.durationS,
    closesAt: isoOrNull(evaluation.closesAt),
    timeBonusPercent,
  });
}

/**
 * The conditions of a practice attempt (ADR-122): the exercise's own, with
 * the practice's clock — its time limit, or eight hours, never its passed
 * closing — unlimited attempts, and no integrity journal.
 */
export function practiceConditions(evaluation: EvaluationRecord, timeBonusPercent: number): EvaluationConditions {
  const settings = settingsOf(evaluation);
  const limit = { timing: settings.timing, durationS: evaluation.durationS };
  return evaluationConditionsOf({
    mode: evaluation.mode,
    settings: {
      ...settings,
      timing: "duration",
      logVisibility: false,
      retakes: { enabled: true, keep: "best", maxAttempts: null },
    },
    durationS: practiceDurationS(limit),
    closesAt: null,
    // The accommodation stretches the exercise's own limit, not the eight hours.
    timeBonusPercent: practiceOwnLimit(limit) ? timeBonusPercent : 0,
  });
}

/** What both the waiting room and the ready screen state (`EvaluationRules`). */
function rulesOf(evaluation: EvaluationRecord, participant: Participant): EvaluationRules {
  return { conditions: conditionsFor(evaluation, participant.timeBonusPercent) };
}

/**
 * What the waiting room shows a student. Mirrored on the teacher's launch
 * step by `lobbyPreviewView` (`apps/web/src/evaluation/LobbyPreview.tsx`,
 * #152), and sharing its rules with the ready screen (`readyView`): a field
 * added to `EvaluationRules` belongs to all three.
 */
export async function lobbyView(
  db: Db,
  evaluation: EvaluationRecord,
  participant: Participant,
  now: Date,
): Promise<LobbyView> {
  return {
    ...rulesOf(evaluation, participant),
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
      state: evaluation.state,
    },
    present: presence.count(evaluation.id),
    enrolled: await enrolledCount(db, evaluation),
    serverNow: iso(now),
  };
}

/** What the ready screen says (ADR-076): the rules and what Start announces, no content. */
export function readyView(evaluation: EvaluationRecord, participant: Participant): ReadyView {
  return {
    ...rulesOf(evaluation, participant),
    evaluation: {
      id: evaluation.id,
      title: evaluation.title,
    },
  };
}
