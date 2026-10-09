/**
 * What the files of the `evaluation` service share: the row types, the
 * handle type, the failures and the gate of the item list.
 */
import type { EvaluationState } from "@quiz/contracts";
import { itemListLock, type PastTiming } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { evaluationItems, evaluations } from "../../db/schema.js";
import { refusalClass, type Refusal } from "../http.js";

export type EvaluationRecord = typeof evaluations.$inferSelect;

export type ItemRecord = typeof evaluationItems.$inferSelect;
/**
 * A handle or an open transaction: the state change below is also the second
 * half of a withdrawal that must not land alone (`unreleaseResults`).
 */
export type DbOrTx = Db | Tx;
// --- Failures -------------------------------------------------------------

/**
 * Everything this module refuses, by code: its status and, where the
 * refusal reads the same wherever it is thrown, its message. A refusal
 * whose message names something (a mode, a question) is worded where it
 * is raised.
 */
const REFUSALS = {
  illegal_transition: [409],
  locked: [409, "an attempt exists: the structure is frozen"],
  // #86: `running` or `paused` locks the configuration until it closes, all
  // but the title, the access control and the feedback policy; time is
  // added from the live dashboard, not through a patch.
  running_locked: [409, "the evaluation is running: its configuration is locked until it closes"],
  // The settings a mode refuses (`MODE_SETTINGS` of `writes.ts`).
  retakes_not_allowed: [422],
  negative_marking_not_allowed: [422],
  calculator_not_allowed: [422],
  notepad_not_allowed: [422],
  conditions_not_allowed: [422],
  // ADR-091: a retake of the questions to review shows the acquired ones
  // read-only between the others, which only `free` navigation does.
  retake_scope_navigation: [422, "a retake of the questions to review needs free navigation (ADR-091)"],
  // ADR-051 §2: no kiosk path (`KIOSK_ATTESTATION=off`), so an exam only a
  // kiosk station may sit could never be sat.
  kiosk_unavailable: [422, "kiosk stations are not available on this platform (ADR-051)"],
  // F-EVAL-11 (#78): `immediate` feedback in an exam, or in an exercise
  // given a waiting room — both sat in class (`isInClass`).
  feedback_not_allowed: [422],
  // A poll keeps its reveal in two places, moved together by its own reveal
  // route (F-LIVE-13): a generic patch of `feedbackPolicy` would publish the
  // key while the projection still says "not revealed" (#86).
  poll_feedback_locked: [409, "a poll's feedback follows its reveal: use the poll's reveal route"],
  attempts_exist: [409, "versions cannot be updated once an attempt exists"],
  // Opened to students (`lobby` or later): the questions are frozen even
  // while nobody has entered yet (#79).
  items_frozen: [409, "the evaluation has been opened: its questions are frozen"],
  // `questionRefused`.
  no_published_version: [422],
  question_keyless: [422],
  question_not_in_course: [422],
  // A copy would play questions whose pool the target course does not link
  // (F-EVAL-01). The code predates the duplicate's use of it.
  template_pool_unlinked: [422, "some questions are in a pool not linked to the target course"],
  // A poll cannot run again on a session code another running poll holds
  // (`evaluations_running_poll_code_uq`): a 409 instead of a 500.
  code_taken: [409, "another running poll holds this session code"],
  not_implemented: [501, "poll mode is phase 2 (decision D7)"],
  template_poll: [422, "a poll cannot be a template"],
  // `TemplateGone`: answered with the loader's own 404 body.
  not_found: [404],
  // The instance has no template to pull from (none recorded, deleted, or
  // not of its course): a conflict of its state, not a 404.
  no_template: [409, "the evaluation has no template to pull from"],
  template_moved: [409, "the template has a newer revision than the one confirmed"],
  allow_drill_locked: [409],
} satisfies Record<string, Refusal>;

export type EvaluationErrorCode = keyof typeof REFUSALS;

export class EvaluationError extends refusalClass("EvaluationError", REFUSALS) {}

export class IllegalTransition extends EvaluationError {
  constructor(
    readonly from: EvaluationState,
    readonly to: EvaluationState,
    reason?: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super("illegal_transition", reason ?? `${from} -> ${to} is not a legal transition`, details);
  }
}

const QUESTION_REFUSALS = {
  question_not_in_course: "is not in a pool of this course",
  no_published_version: "has no published version",
  // A question kept after an opinion poll (ADR-014): it can run a poll
  // again; an evaluation would grade the whole class against nothing.
  question_keyless: "has no correct answer: polls only",
} satisfies Partial<Record<EvaluationErrorCode, string>>;

/** A question this evaluation cannot play, named in the message. */
export function questionRefused(code: keyof typeof QUESTION_REFUSALS, questionId: string): EvaluationError {
  return new EvaluationError(code, `question ${questionId} ${QUESTION_REFUSALS[code]}`);
}

const PAST_TIMING_MESSAGE: Record<PastTiming, string> = {
  closes_at_past: "the common end has already passed",
  opens_at_past: "the opening time has already passed",
};

/**
 * What `pastTiming` (#178) found, as the refusal of `from → to`, its reason
 * named for the screen to translate. Shared by the guard of a transition and
 * the patch of a scheduled evaluation, which must not slip into the past.
 */
export function refusePastTiming(
  from: EvaluationState,
  to: EvaluationState,
  reason: PastTiming | null,
): void {
  if (reason) throw new IllegalTransition(from, to, PAST_TIMING_MESSAGE[reason], { reason });
}

/**
 * THE gate of every write to the item list — add, remove, reorder, points,
 * milestone, version — as `@quiz/domain/itemList` decides it. An attempt
 * keeps the code it always had (`locked`, or `attempts_exist` for a version
 * update); an opened evaluation nobody has entered answers `items_frozen`.
 */
export function assertItemListEditable(
  row: EvaluationRecord,
  ctx: { attemptCount: number },
  onAttempts: EvaluationErrorCode = "locked",
): void {
  const lock = itemListLock(row.state, ctx.attemptCount);
  if (lock === "attempts") throw new EvaluationError(onAttempts);
  if (lock === "opened") throw new EvaluationError("items_frozen");
}
