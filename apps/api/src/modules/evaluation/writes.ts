/**
 * The writes of the `evaluation` module: create, patch, delete, and the
 * narrow writers the other modules call.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import {
  EvaluationSettings,
  FeedbackPolicy,
  defaultFeedbackPolicy,
  defaultGradingScale,
  defaultSettings,
  type EvaluationMode,
  type EvaluationPatch,
  ReleasedGrades,
  negativeMarkingOf,
  conditionsOf,
  retakesOf,
} from "@quiz/contracts";
import {
  allowDrillWritable,
  calculatorAllowedFor,
  notepadAllowedFor,
  conditionsAllowedFor,
  CONFIG_LIVE_STATES,
  configLock,
  isConfigFieldWritable,
  isFeedbackAllowed,
  logVisibilityDefault,
  negativeMarkingAllowedFor,
  retakesAllowedFor,
  retakeScopeFits,
} from "@quiz/domain";

import type { Db } from "../../db/client.js";
import {
  attempts,
  evaluationItems,
  evaluations,
  questionVersions,
  questions,
} from "../../db/schema.js";
import {
  type EvaluationRecord,
  type ItemRecord,
  type DbOrTx,
  EvaluationError,
  type EvaluationErrorCode,
  questionRefused,
} from "./shared.js";
import { assertStaysScheduled } from "./stateMachine.js";
import { byId, settingsOf, feedbackOf, preferredMcqPolicy } from "./reads.js";
import { latestPublished, type CopyHome } from "./items.js";

/**
 * The two presets of §4.3. An exam is timed, forward-only-ish and silent
 * until release; an exercise is open and gives feedback immediately.
 */
function presetSettings(preset: "exam" | "exercise"): {
  settings: EvaluationSettings;
  feedbackPolicy: FeedbackPolicy;
} {
  if (preset === "exercise") {
    return {
      settings: EvaluationSettings.parse({ timing: "manual", lobby: "skip", navigation: "free" }),
      feedbackPolicy: FeedbackPolicy.parse({
        when: "immediate",
        showKey: true,
        showExplanation: true,
      }),
    };
  }
  return { settings: defaultSettings(), feedbackPolicy: defaultFeedbackPolicy() };
}

export async function createEvaluation(
  db: Db,
  input: CopyHome & {
    title: string;
    mode: EvaluationMode;
    preset?: "exam" | "exercise" | undefined;
    /** ADR-041 §2: the teacher's choice at creation; absent is the mode's default. */
    allowDrill?: boolean | undefined;
    createdBy: string;
  },
): Promise<EvaluationRecord> {
  if (input.mode === "poll") throw new EvaluationError("not_implemented");
  const preset = presetSettings(input.preset ?? (input.mode === "exercise" ? "exercise" : "exam"));
  const id = randomUUID();
  // The creator's preference SEEDS the evaluation and is then forgotten:
  // changing the preference later never moves an evaluation that exists.
  const mcqPolicy = await preferredMcqPolicy(db, input.createdBy);
  await db.insert(evaluations).values({
    id,
    // A classroom's draft, or a course's empty template (F-EVAL-24) at revision 1.
    ...("courseId" in input
      ? { courseId: input.courseId, revision: 1 }
      : { classroomId: input.classroomId }),
    title: input.title,
    mode: input.mode,
    state: "draft",
    // Whatever the preset, the integrity journal follows the MODE (ADR-088 §2).
    settings: {
      ...preset.settings,
      logVisibility: logVisibilityDefault(input.mode),
      ...(input.allowDrill === undefined ? {} : { allowDrill: input.allowDrill }),
    },
    gradingScale: defaultGradingScale(),
    feedbackPolicy: preset.feedbackPolicy,
    mcqPolicy,
    createdBy: input.createdBy,
  });
  return (await byId(db, id))!;
}

/**
 * The POLL path (F-LIVE-13, ADR-014): one question, created AND started in
 * the same call, with the session code already on it.
 *
 * It lives here rather than in `modules/poll/` because `evaluations` and
 * `evaluation_items` are this module's tables and no other module writes
 * them (CLAUDE.md, Conventions). {@link createEvaluation} keeps refusing
 * `mode: "poll"`: a poll is never authored item by item, so the generic
 * route has nothing to offer it.
 *
 * Deliberate differences from {@link addItems}: the question is NOT required
 * to sit in a pool of the classroom's course — a poll runs a question of the
 * teacher's personal pool, which is linked to nothing — and the two writes
 * are one transaction, so a poll is never half-created.
 *
 * `classroomId` null is the anonymous poll (ADR-014, addendum 2026-09-27):
 * it belongs to no classroom and `createdBy` owns it — the schema's
 * `evaluations_home_ck` refuses any other evaluation without a classroom.
 */
export async function createPollEvaluation(
  db: Db,
  input: {
    classroomId: string | null;
    title: string;
    createdBy: string;
    questionId: string;
    accessCode: string;
    defaultPoints: (type: string, version: typeof questionVersions.$inferSelect) => number;
    now: Date;
  },
): Promise<{ evaluation: EvaluationRecord; item: ItemRecord }> {
  const [question] = await db
    .select()
    .from(questions)
    .where(eq(questions.id, input.questionId))
    .limit(1);
  if (!question || question.deletedAt !== null) throw questionRefused("question_not_in_course", input.questionId);
  const version = (await latestPublished(db, [input.questionId])).get(input.questionId);
  if (!version) throw questionRefused("no_published_version", input.questionId);

  // The exercise preset, plus the reveal switch. `immediate` feedback with
  // the key HELD BACK: the reveal is the teacher's act, and it moves
  // `settings.poll.revealed` and `feedbackPolicy.showKey` together. Whether
  // the poll is anonymous is not a setting: it is `classroomId` being null.
  const settings: EvaluationSettings = EvaluationSettings.parse({
    ...presetSettings("exercise").settings,
    poll: { revealed: false, votes: false },
  });
  const feedbackPolicy: FeedbackPolicy = FeedbackPolicy.parse({
    when: "immediate",
    showAnswer: true,
    showKey: false,
    showExplanation: false,
  });

  const id = randomUUID();
  const itemId = randomUUID();
  const mcqPolicy = await preferredMcqPolicy(db, input.createdBy);
  await db.transaction(async (tx) => {
    await tx.insert(evaluations).values({
      id,
      classroomId: input.classroomId,
      title: input.title,
      mode: "poll",
      // A poll opens on the spot: there is no lobby, no schedule and no
      // draft to review (glossary §1.4).
      state: "running",
      settings,
      gradingScale: defaultGradingScale(),
      feedbackPolicy,
      mcqPolicy,
      accessCode: input.accessCode,
      startedAt: input.now,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await tx.insert(evaluationItems).values({
      id: itemId,
      evaluationId: id,
      position: 0,
      questionVersionId: version.id,
      points: input.defaultPoints(question.type, version),
      milestone: false,
      createdAt: input.now,
    });
  });
  const [item] = await db
    .select()
    .from(evaluationItems)
    .where(eq(evaluationItems.id, itemId))
    .limit(1);
  return { evaluation: (await byId(db, id))!, item: item! };
}

/**
 * The settings a mode refuses: switching one on where `allowedFor` says no
 * is refused, switching it off always passes. An exam is one sitting
 * (F-EVAL-15); a poll is tallied, not graded (ADR-026), and provides no
 * calculator (ADR-069), no notepad (ADR-090) and no conditions to sit
 * under (ADR-079).
 */
const MODE_SETTINGS: readonly {
  code: EvaluationErrorCode;
  on: (settings: EvaluationSettings) => boolean;
  allowedFor: (mode: EvaluationMode) => boolean;
  why: string;
}[] = [
  { code: "retakes_not_allowed", on: (s) => retakesOf(s).enabled, allowedFor: retakesAllowedFor, why: "takes one attempt (F-EVAL-15)" },
  { code: "negative_marking_not_allowed", on: negativeMarkingOf, allowedFor: negativeMarkingAllowedFor, why: "has no score to penalise (ADR-026)" },
  { code: "calculator_not_allowed", on: (s) => (s.calculator ?? "none") !== "none", allowedFor: calculatorAllowedFor, why: "provides no calculator (ADR-069)" },
  { code: "notepad_not_allowed", on: (s) => (s.notepad ?? "none") !== "none", allowedFor: notepadAllowedFor, why: "provides no notepad (ADR-090)" },
  { code: "conditions_not_allowed", on: (s) => conditionsOf(s).length > 0, allowedFor: conditionsAllowedFor, why: "has no conditions (ADR-079)" },
];

/**
 * What a patch may still touch is `configLock`'s to say (`@quiz/domain`):
 * everything while nothing locks the configuration; the title, the access
 * control and the feedback policy once an attempt exists (F-EVAL-03), and
 * while the evaluation runs (#86) — access must stay fixable mid-exam, for a
 * student the allowlist locks out, and a forgotten answer key hideable. The
 * in-class rule on `immediate` (#78) below applies in every state. A poll's
 * feedback is never patched: it moves with the reveal (`poll_feedback_locked`).
 */
export async function patchEvaluation(
  db: DbOrTx,
  row: EvaluationRecord,
  patch: EvaluationPatch,
  ctx: {
    attemptCount: number;
    now: Date;
    /**
     * ADR-051 §2: the kiosk path exists (`KIOSK_ATTESTATION` is not `off`),
     * as the route knows from the configuration. Absent: it does not.
     */
    kioskAvailable?: boolean;
  },
): Promise<EvaluationRecord> {
  const lock = configLock(row.state, ctx.attemptCount);
  if (Object.keys(patch).some((k) => !isConfigFieldWritable(lock, k))) {
    throw new EvaluationError(lock === "running" ? "running_locked" : "locked");
  }
  if (row.mode === "poll" && patch.feedbackPolicy !== undefined) throw new EvaluationError("poll_feedback_locked");
  const next: Partial<typeof evaluations.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.settings !== undefined) {
    const settings = EvaluationSettings.parse({ ...settingsOf(row), ...patch.settings });
    for (const { code, on, allowedFor, why } of MODE_SETTINGS) {
      if (on(settings) && !allowedFor(row.mode)) throw new EvaluationError(code, `an evaluation of mode "${row.mode}" ${why}`);
    }
    // ADR-091: a partial retake needs free navigation; leaving either half
    // inconsistent is refused, whichever moved.
    if (!retakeScopeFits(row.mode, retakesOf(settings), settings.navigation)) {
      throw new EvaluationError("retake_scope_navigation");
    }
    // No kiosk path, no kiosk exam (ADR-051 §2): switching it on is refused,
    // switching it off — or patching anything else — always passes, so an
    // exam left on after the platform turned the kiosk off can be fixed.
    if (patch.settings.kiosk === true && ctx.kioskAvailable !== true) throw new EvaluationError("kiosk_unavailable");
    next.settings = settings;
  }
  if (patch.gradingScale !== undefined) next.gradingScale = patch.gradingScale;
  if (patch.mcqPolicy !== undefined) next.mcqPolicy = patch.mcqPolicy;
  if (patch.feedbackPolicy !== undefined) {
    next.feedbackPolicy = FeedbackPolicy.parse({ ...feedbackOf(row), ...patch.feedbackPolicy });
  }
  if (patch.opensAt !== undefined) next.opensAt = patch.opensAt === null ? null : new Date(patch.opensAt);
  if (patch.closesAt !== undefined) {
    next.closesAt = patch.closesAt === null ? null : new Date(patch.closesAt);
  }
  // A timing set from the configuration is the announced one again (D8, #253):
  // whatever the live controls had added is now part of it.
  if (patch.opensAt !== undefined || patch.closesAt !== undefined) next.closesAtShiftS = 0;
  if (patch.durationS !== undefined) next.durationS = patch.durationS;
  if (patch.ipAllowlist !== undefined) next.ipAllowlist = patch.ipAllowlist;

  // `immediate` feedback in class would hand the answers to the first
  // students while the others are still working (F-EVAL-11, #78). The pair
  // the patch LEAVES behind is checked, whichever half it moved: adding a
  // waiting room under `immediate` is refused like asking for `immediate`
  // under a waiting room. The screen sends the fallback with the change
  // (`feedbackWhenFor`), so only an inconsistent client meets this 422. A
  // patch that touches neither half passes, so a row stored before the rule
  // can still be renamed.
  if (patch.feedbackPolicy?.when !== undefined || patch.settings?.lobby !== undefined) {
    const when = ((next.feedbackPolicy ?? feedbackOf(row)) as FeedbackPolicy).when;
    const lobby = ((next.settings ?? settingsOf(row)) as EvaluationSettings).lobby;
    if (!isFeedbackAllowed({ mode: row.mode, lobby }, when)) {
      throw new EvaluationError(
        "feedback_not_allowed",
        `feedback "${when}" is not allowed for an evaluation sat in class (F-EVAL-11)`,
      );
    }
  }

  // A scheduled evaluation stays one the guard would schedule (#178, #254):
  // cleared, the ticker would never open it; moved into the past, it would
  // open it, or close it, at its next pass.
  if (
    row.state === "scheduled" &&
    (patch.opensAt !== undefined ||
      patch.closesAt !== undefined ||
      patch.durationS !== undefined ||
      patch.settings?.timing !== undefined)
  ) {
    assertStaysScheduled({ ...row, ...next } as EvaluationRecord, ctx.now);
  }

  await db.update(evaluations).set(next).where(eq(evaluations.id, row.id));
  return (await byId(db, row.id))!;
}

export async function deleteEvaluation(db: Db, row: EvaluationRecord): Promise<void> {
  await db.delete(evaluations).where(eq(evaluations.id, row.id));
}

// --- Narrow writers for the other modules ----------------------------------
//
// `evaluations` and `evaluation_items` belong to this module (CLAUDE.md,
// Conventions). What `live`, `poll`, `results` and `grading` need to change
// on them goes through one of these, each carrying its own `updatedAt` bump,
// rather than through an UPDATE of their own.

/**
 * The shared deadline of a `deadline`-timed evaluation. `live.extendTime` and `live.resumeEvaluation`: `closes_at` moved by
 * `seconds` IN the statement, so two concurrent moves both count, and the row
 * returned as committed — the caller publishes that, never the record it
 * loaded before (a pause or a resume may have landed in between). Null when
 * there was no `closes_at`.
 *
 * `fromNow`, before the start (#178): an end already past is moved from
 * `now`, so "+10 min" on an end gone an hour ago means ten minutes from now.
 *
 * The whole move, the jump to `now` included, is added to `closes_at_shift_s`,
 * so the announced window — the base of the accommodation (D8, #253) — does
 * not grow with it.
 */
export async function extendClosesAt(
  db: DbOrTx,
  id: string,
  seconds: number,
  now: Date,
  fromNow = false,
): Promise<EvaluationRecord | null> {
  const base = fromNow
    ? sql`greatest(${evaluations.closesAt}, ${now.toISOString()}::timestamptz)`
    : sql`${evaluations.closesAt}`;
  const [row] = await db
    .update(evaluations)
    .set({
      closesAt: sql`${base} + make_interval(secs => ${seconds})`,
      // Evaluated on the row as it was: the distance the end moves.
      closesAtShiftS: sql`${evaluations.closesAtShiftS} + round(extract(epoch from ${base} + make_interval(secs => ${seconds}) - ${evaluations.closesAt}))::int`,
      updatedAt: now,
    })
    .where(and(eq(evaluations.id, id), isNotNull(evaluations.closesAt)))
    .returning();
  return row ?? null;
}

/** `poll.setDisplay`: the poll switches and the feedback policy, moved together. */
export async function setPollSettings(
  db: DbOrTx,
  id: string,
  values: Required<Pick<typeof evaluations.$inferInsert, "settings" | "feedbackPolicy">>,
  now: Date,
): Promise<void> {
  await db
    .update(evaluations)
    .set({ ...values, updatedAt: now })
    .where(eq(evaluations.id, id));
}

/** `409 allow_drill_locked`: "Allow drill" is editable until the release, and never on a poll. */
export class AllowDrillLocked extends EvaluationError {
  constructor(reason: "released" | "poll") {
    super("allow_drill_locked", `Allow drill cannot change on this evaluation (${reason})`, { reason });
  }
}

/**
 * `drill`'s switch on an evaluation (ADR-041 §10, item 3): `settings.allowDrill`,
 * writable whatever the configuration lock says — attempts and a run do not
 * freeze it — until the release, whose cards it decides. The one write of
 * the settings outside {@link patchEvaluation}. A poll never has it.
 */
export async function setAllowDrill(
  db: DbOrTx,
  row: EvaluationRecord,
  allowDrill: boolean,
  now: Date,
): Promise<EvaluationRecord> {
  // The one rule (`@quiz/domain`); the conditional update below closes the
  // race with a release landing between the load and the write.
  if (!allowDrillWritable(row.mode, row.state)) {
    throw new AllowDrillLocked(row.mode === "poll" ? "poll" : "released");
  }
  const [updated] = await db
    .update(evaluations)
    .set({
      settings: sql`${evaluations.settings} || jsonb_build_object('allowDrill', ${allowDrill}::boolean)`,
      updatedAt: now,
    })
    .where(and(eq(evaluations.id, row.id), sql`${evaluations.state} <> 'released'`))
    .returning();
  if (!updated) throw new AllowDrillLocked("released");
  return updated;
}

/** `results.releaseResults`: the frozen grades (docs/05 §5.3) and the state they imply. */
export async function setRelease(
  db: DbOrTx,
  id: string,
  release: { releasedAt: Date; releasedGrades: ReleasedGrades },
  now: Date,
): Promise<void> {
  await db
    .update(evaluations)
    .set({ ...release, modifiedAfterRelease: false, state: "released", updatedAt: now })
    .where(eq(evaluations.id, id));
}

/** `results.unreleaseResults`: the release pair, cleared (the state moves separately). */
export async function clearRelease(db: DbOrTx, id: string, now: Date): Promise<void> {
  await db
    .update(evaluations)
    .set({ releasedAt: null, releasedGrades: null, modifiedAfterRelease: false, updatedAt: now })
    .where(eq(evaluations.id, id));
}

/**
 * `results.publishCorrection` (ADR-050): stamps the instant the correction
 * of a running exercise was published. The caller has refused an exam and a
 * poll with a worded reason; the UPDATE says `exercise` again so that no other
 * caller can ever stamp an exam, and its other conditions make a close or a
 * second publication committing in between seen: `true` for
 * exactly the one call that published, `false` otherwise (already published,
 * or not running — the caller re-reads the row to say which).
 */
export async function setCorrectionPublished(db: DbOrTx, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(evaluations)
    .set({ correctionPublishedAt: now, updatedAt: now })
    .where(
      and(
        eq(evaluations.id, id),
        eq(evaluations.mode, "exercise"),
        isNull(evaluations.correctionPublishedAt),
        inArray(evaluations.state, [...CONFIG_LIVE_STATES]),
      ),
    )
    .returning({ id: evaluations.id });
  return rows.length > 0;
}

/** A grade read from the frozen snapshot rather than recomputed. */
export interface CachedGrade {
  points: number;
  totalPoints: number;
  grade: number;
}

/**
 * The grade of `userId`'s attempt as frozen in `released_grades`, while the
 * snapshot is still what the validated gradings say (docs/01 §5: the grade
 * "is cached when the results are released"; audit D-06).
 *
 * `null` means "compute it live": nothing is released, a correction landed
 * after the release (`modified_after_release`, F-GRADE-09 — the students see
 * the NEW grade), or the snapshot has no row for this student and attempt
 * (a seat that joined after the release, a teacher's own test, ADR-018).
 */
export function cachedGrade(
  evaluation: Pick<EvaluationRecord, "releasedAt" | "releasedGrades" | "modifiedAfterRelease">,
  userId: string,
  attemptId: string | null,
): CachedGrade | null {
  return cachedGrades(evaluation)(userId, attemptId);
}

/**
 * {@link cachedGrade} for many students of one evaluation: the snapshot is
 * parsed and indexed ONCE, and each lookup is then a map read.
 */
export function cachedGrades(
  evaluation: Pick<EvaluationRecord, "releasedAt" | "releasedGrades" | "modifiedAfterRelease">,
): (userId: string, attemptId: string | null) => CachedGrade | null {
  const none = () => null;
  if (evaluation.releasedAt === null || evaluation.modifiedAfterRelease) return none;
  const snapshot = ReleasedGrades.safeParse(evaluation.releasedGrades);
  if (!snapshot.success) return none;
  const { totalPoints } = snapshot.data;
  const rows = new Map(
    snapshot.data.rows.map((r) => [`${r.userId}:${r.attemptId}`, r] as const),
  );
  return (userId, attemptId) => {
    const row = rows.get(`${userId}:${attemptId}`);
    return row ? { points: row.points, totalPoints, grade: row.grade } : null;
  };
}

/**
 * F-GRADE-09: a correction landed after the release. Whether the evaluation
 * IS released is read by the UPDATE itself, not from a record the caller
 * loaded earlier: a release or a withdrawal that commits in between is seen
 * (the row lock makes PostgreSQL re-check the predicate). Returns whether the
 * evaluation was released, i.e. whether the flag now stands.
 */
export async function setModifiedAfterRelease(db: DbOrTx, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(evaluations)
    .set({ modifiedAfterRelease: true, updatedAt: now })
    .where(and(eq(evaluations.id, id), isNotNull(evaluations.releasedAt)))
    .returning({ id: evaluations.id });
  return rows.length > 0;
}

/**
 * The same flag, raised by the grading writer for every RELEASED evaluation
 * that owns one of `attemptIds`, in the writer's own transaction (audit D-06
 * review): a validated grading changes a published grade whoever wrote it —
 * a teacher, the automatic pass or the runner job — and the frozen
 * `released_grades` stops being served the moment it does (`cachedGrade`).
 * One conditional UPDATE: nothing released, nothing written.
 */
export async function flagReleasedEvaluationsOf(
  db: DbOrTx,
  attemptIds: readonly string[],
  now: Date,
): Promise<void> {
  if (attemptIds.length === 0) return;
  await db
    .update(evaluations)
    .set({ modifiedAfterRelease: true, updatedAt: now })
    .where(
      and(
        isNotNull(evaluations.releasedAt),
        eq(evaluations.modifiedAfterRelease, false),
        inArray(
          evaluations.id,
          db
            .select({ id: attempts.evaluationId })
            .from(attempts)
            .where(inArray(attempts.id, [...attemptIds])),
        ),
      ),
    );
}

/**
 * The states in which an evaluation's grading can be finished: after its
 * close. Also the states the migration `0033_grading_ready_claim` backfills.
 */
const GRADED_STATES = ["closed", "grading", "released"] as const;

/**
 * The claim of `grading_ready` (#286): true for exactly one caller per
 * completed grid. Refused before the close — a retake graded alone mid-run
 * (ADR-025) completes nothing — and read by the UPDATE
 * itself, so the state and the marker are those of the row NOW, not those
 * of a record the caller loaded when its job started. A closed evaluation
 * never runs again (`closed → draft` needs no attempt, and clears the
 * marker), so a claim taken is always the claim of the current close.
 */
export async function claimGradingReady(db: DbOrTx, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(evaluations)
    .set({ gradingReadyAt: now })
    .where(
      and(
        eq(evaluations.id, id),
        isNull(evaluations.gradingReadyAt),
        inArray(evaluations.state, [...GRADED_STATES]),
      ),
    )
    .returning({ id: evaluations.id });
  return rows.length > 0;
}

/**
 * Gives the evaluation its `grading_ready` again: a re-grade empties an
 * item's cells, and the pass that fills them completes a new grid. Called in
 * the re-grade's own transaction.
 */
export async function clearGradingReady(db: DbOrTx, id: string): Promise<void> {
  await db.update(evaluations).set({ gradingReadyAt: null }).where(eq(evaluations.id, id));
}

/**
 * A regrade onto another published version of the same question (F-GRADE-06).
 * `evaluation_items` has no `updatedAt` of its own.
 */
export async function retargetItemVersion(
  db: DbOrTx,
  itemId: string,
  questionVersionId: string,
): Promise<void> {
  await db
    .update(evaluationItems)
    .set({ questionVersionId })
    .where(eq(evaluationItems.id, itemId));
}
