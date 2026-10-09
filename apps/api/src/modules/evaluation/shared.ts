/**
 * What the files of the `evaluation` service share: the row types, the
 * handle type, the failures and the gate of the item list.
 */
import type { EvaluationState, TemplateItemRef } from "@quiz/contracts";
import { EVALUATION_STATES, itemListLock, type EvaluationStateName, type PastTiming } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { evaluationItems, evaluations } from "../../db/schema.js";
import { DomainError } from "../http.js";

export type EvaluationRecord = typeof evaluations.$inferSelect;

/**
 * `@quiz/domain` spells the state union again (it depends on no contract);
 * the two must stay the same set, both ways, at compile time.
 */
const _statesAgree: readonly EvaluationState[] = EVALUATION_STATES;
const _statesAgreeBack: readonly EvaluationStateName[] = [] as EvaluationState[];
void [_statesAgree, _statesAgreeBack];
export type ItemRecord = typeof evaluationItems.$inferSelect;
/**
 * A handle or an open transaction: the state change below is also the second
 * half of a withdrawal that must not land alone (`unreleaseResults`).
 */
export type DbOrTx = Db | Tx;
// --- Failures -------------------------------------------------------------

/** Base of everything this module refuses (`DomainError`, sent by `sendFailure`). */
export class EvaluationError extends DomainError {
  override name = "EvaluationError";
}

export class IllegalTransition extends EvaluationError {
  constructor(
    readonly from: EvaluationState,
    readonly to: EvaluationState,
    reason?: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super("illegal_transition", 409, reason ?? `${from} -> ${to} is not a legal transition`, details);
  }
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

export class Locked extends EvaluationError {
  constructor(message = "an attempt exists: the structure is frozen") {
    super("locked", 409, message);
  }
}

/**
 * The evaluation is `running` or `paused` (#86): its configuration is locked
 * until it closes, whether or not anybody has entered — all but the title,
 * the access control and the feedback policy. Time is added from the live
 * dashboard, not through a patch.
 */
export class RunningLocked extends EvaluationError {
  constructor() {
    super("running_locked", 409, "the evaluation is running: its configuration is locked until it closes");
  }
}

/** F-EVAL-15 (ADR-025): several attempts are an exercise's, never an exam's. */
export class RetakesNotAllowed extends EvaluationError {
  constructor(mode: string) {
    super("retakes_not_allowed", 422, `an evaluation of mode "${mode}" takes one attempt (F-EVAL-15)`);
  }
}

/**
 * ADR-091: a retake of the questions to review shows the acquired ones
 * read-only between the others, which only `free` navigation does.
 */
export class RetakeScopeNavigation extends EvaluationError {
  constructor() {
    super(
      "retake_scope_navigation",
      422,
      "a retake of the questions to review needs free navigation (ADR-091)",
    );
  }
}

/** ADR-026: a poll has no score, so nothing to penalise. */
export class NegativeMarkingNotAllowed extends EvaluationError {
  constructor(mode: string) {
    super(
      "negative_marking_not_allowed",
      422,
      `an evaluation of mode "${mode}" has no score to penalise (ADR-026)`,
    );
  }
}

/** ADR-069: a poll has nothing to compute. */
export class CalculatorNotAllowed extends EvaluationError {
  constructor(mode: string) {
    super("calculator_not_allowed", 422, `an evaluation of mode "${mode}" provides no calculator (ADR-069)`);
  }
}

/** ADR-090: nor anything to work out on a notepad. */
export class NotepadNotAllowed extends EvaluationError {
  constructor(mode: string) {
    super("notepad_not_allowed", 422, `an evaluation of mode "${mode}" provides no notepad (ADR-090)`);
  }
}

/** ADR-079: a poll has no conditions to sit under. */
export class ConditionsNotAllowed extends EvaluationError {
  constructor(mode: string) {
    super("conditions_not_allowed", 422, `an evaluation of mode "${mode}" has no conditions (ADR-079)`);
  }
}

/**
 * ADR-051 §2: the platform has no kiosk path (`KIOSK_ATTESTATION=off`), so an
 * exam that only a kiosk station may sit could never be sat.
 */
export class KioskUnavailable extends EvaluationError {
  constructor() {
    super("kiosk_unavailable", 422, "kiosk stations are not available on this platform (ADR-051)");
  }
}

/**
 * F-EVAL-11 (#78): `immediate` feedback in an exam, or in an exercise given a
 * waiting room — both sat in class (`isInClass` in `@quiz/domain`).
 */
export class FeedbackNotAllowed extends EvaluationError {
  constructor(when: string) {
    super(
      "feedback_not_allowed",
      422,
      `feedback "${when}" is not allowed for an evaluation sat in class (F-EVAL-11)`,
    );
  }
}

/**
 * A poll keeps its reveal in two places, moved together by the poll's own
 * reveal route (`poll.setDisplay`, F-LIVE-13): `settings.poll.revealed`,
 * which the projection reads, and `feedbackPolicy.showKey`/`showExplanation`,
 * which the feedback route obeys. A generic patch of the second half would
 * publish the key while the projection still says "not revealed" (#86).
 */
export class PollFeedbackLocked extends EvaluationError {
  constructor() {
    super(
      "poll_feedback_locked",
      409,
      "a poll's feedback follows its reveal: use the poll's reveal route",
    );
  }
}

export class AttemptsExist extends EvaluationError {
  constructor() {
    super("attempts_exist", 409, "versions cannot be updated once an attempt exists");
  }
}

/**
 * The evaluation has been opened to students (`lobby` or later): its list of
 * questions is frozen even while nobody has entered yet (issue #79).
 */
class ItemsFrozen extends EvaluationError {
  constructor() {
    super("items_frozen", 409, "the evaluation has been opened: its questions are frozen");
  }
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
  onAttempts: () => EvaluationError = () => new Locked(),
): void {
  const lock = itemListLock(row.state, ctx.attemptCount);
  if (lock === "attempts") throw onAttempts();
  if (lock === "opened") throw new ItemsFrozen();
}

export class NoPublishedVersion extends EvaluationError {
  constructor(readonly questionId: string) {
    super("no_published_version", 422, `question ${questionId} has no published version`);
  }
}

/**
 * The question's published version holds no answer key: a question kept
 * after an opinion poll (ADR-014, addenda 2026-09-23). It can run a poll
 * again; an evaluation would grade the whole class against nothing.
 */
export class QuestionKeyless extends EvaluationError {
  constructor(readonly questionId: string) {
    super("question_keyless", 422, `question ${questionId} has no correct answer: polls only`);
  }
}

export class QuestionNotInCourse extends EvaluationError {
  constructor(readonly questionId: string) {
    super("question_not_in_course", 422, `question ${questionId} is not in a pool of this course`);
  }
}

/**
 * A copy into a classroom would play questions whose pool that classroom's
 * course does not link (F-EVAL-01): the draft could not have been authored
 * with them, so the copy is refused and names them. The code predates the
 * duplicate's use of it — an instance of a template was the first copy.
 */
export class PoolUnlinked extends EvaluationError {
  constructor(items: TemplateItemRef[]) {
    super(
      "template_pool_unlinked",
      422,
      "some questions are in a pool not linked to the target course",
      { items },
    );
  }
}

/**
 * A poll cannot run again on a session code another running poll now holds
 * (`evaluations_running_poll_code_uq`). No route leads a poll back to
 * `running` today (it cannot pause, and the authoring transitions refuse
 * it); should one appear, it answers this 409 instead of a 500.
 */
export class CodeTaken extends EvaluationError {
  constructor() {
    super("code_taken", 409, "another running poll holds this session code");
  }
}

export class PollNotImplemented extends EvaluationError {
  constructor() {
    super("not_implemented", 501, "poll mode is phase 2 (decision D7)");
  }
}
