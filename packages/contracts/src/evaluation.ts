/**
 * `evaluation` route schemas (PLAN-MVP §4.3 and §3.3).
 *
 * An evaluation is a classroom's quiz: an ordered list of items, each frozen
 * on one published question version (F-EVAL-03), plus the settings that
 * decide how it is taken. The operational transitions (start, pause, close,
 * extend) belong to the `live` module and live in `./live.ts`; this file owns
 * the authoring surface and the state column both modules share.
 */
import { z } from "zod";

import {
  CALCULATOR_MODES,
  CONDITION_KINDS,
  MAX_CONDITION_LENGTH,
  MAX_CONDITIONS,
  NOTEPAD_MODES,
  ROUNDINGS,
  TRUSTED_CLIENTS,
} from "@quiz/domain";

import { ConceptRef } from "./concept.js";

/** F-EVAL-01. `poll` is accepted by the column and refused by every route (decision D7). */
export const EvaluationMode = z.enum(["exam", "exercise", "poll"]);
export type EvaluationMode = z.infer<typeof EvaluationMode>;

/**
 * The stored states (decision D6). `graded` is NOT one of them: it is
 * `closed` plus "no proposed grading left", and the UI shows it as a badge.
 */
export const EvaluationState = z.enum([
  "draft",
  "scheduled",
  "lobby",
  "running",
  "paused",
  "closed",
  "grading",
  "released",
]);
export type EvaluationState = z.infer<typeof EvaluationState>;

/** F-EVAL-07. `milestones` locks everything up to a passed milestone item. */
export const Navigation = z.enum(["free", "forward_only", "milestones"]);
export type Navigation = z.infer<typeof Navigation>;

/** F-EVAL-08. `student_choice` is only offered when navigation is `free`. */
export const Presentation = z.enum(["zen", "continuous", "student_choice"]);
export type Presentation = z.infer<typeof Presentation>;

/** F-EVAL-06. */
const LobbyMode = z.enum(["skip", "auto", "manual"]);
type LobbyMode = z.infer<typeof LobbyMode>;

/**
 * F-EVAL-04. `manual`: the teacher closes, or the ticker at `closesAt` when
 * one is set, the optional safety deadline (ADR-086 §2). `duration` with a
 * `closesAt`: each student's minutes are cut at the window's end (§3). The
 * screen asks "who drives the clock?" and derives this with `lobby`
 * (`clockChoiceOf`, `@quiz/domain`).
 */
export const Timing = z.enum(["duration", "deadline", "manual"]);
export type Timing = z.infer<typeof Timing>;

/**
 * How a multiple-answer MCQ is scored (docs/04 §4.4). The five formulas live
 * in `@quiz/domain/mcqScore`, whose `MCQ_SCORE_POLICIES` is the reference
 * list; this enum is the WIRE name of the same five, spelled again because
 * `packages/contracts` depends on no package. `apps/api` checks the two equal,
 * both ways, at compile time (`modules/pool/routes.ts`).
 *
 * It appears at two levels of a three-level hierarchy:
 *   1. the teacher's preference (`Me.mcqPolicy`), which seeds
 *   2. the evaluation's own setting (`Evaluation.mcqPolicy`), which
 *   3. a question configured `inherit` defers to.
 * A question that names a policy overrides both, and a `single` question is
 * always all or nothing.
 */
export const McqPolicy = z.enum([
  "all_or_nothing",
  "true_false",
  "discordance",
  "symmetric",
  "ripkey",
]);
export type McqPolicy = z.infer<typeof McqPolicy>;

/** What an evaluation gets when its creator expressed no preference. */
export const DEFAULT_MCQ_POLICY = "all_or_nothing" satisfies McqPolicy;

/**
 * How a `categorize` question is scored (docs/04 §4.13, ADR-036). The two
 * formulas live in `@quiz/domain/categorizeScore`, whose
 * `CATEGORIZE_SCORE_POLICIES` is the reference list; this is the WIRE name of
 * the same two, spelled again because `packages/contracts` depends on no
 * package. `apps/api` checks the two equal, both ways, at compile time
 * (`modules/pool/routes.ts`), like {@link McqPolicy}.
 *
 * It is a setting of the evaluation (`settings.categorizePolicy`), which a
 * question configured `inherit` defers to; there is no per-teacher
 * preference.
 */
export const CategorizePolicy = z.enum(["per_item", "all_or_nothing"]);
export type CategorizePolicy = z.infer<typeof CategorizePolicy>;

/** What an evaluation without the setting scores `inherit` questions with. */
export const DEFAULT_CATEGORIZE_POLICY = "per_item" satisfies CategorizePolicy;

/** The categorize policy of an evaluation's settings (ADR-036); absent is {@link DEFAULT_CATEGORIZE_POLICY}. */
export const categorizePolicyOf = (settings: {
  categorizePolicy?: CategorizePolicy | undefined;
}): CategorizePolicy => settings.categorizePolicy ?? DEFAULT_CATEGORIZE_POLICY;

/** F-EVAL-15: which attempt is a student's result when an exercise allows several. */
export const RetakeKeep = z.enum(["best", "last"]);
export type RetakeKeep = z.infer<typeof RetakeKeep>;

/** ADR-091: a retake asks every question, or only the questions to review. */
export const RetakeScope = z.enum(["all", "to_review"]);
export type RetakeScope = z.infer<typeof RetakeScope>;

/**
 * F-EVAL-15 (ADR-025, #92): several attempts on an `exercise`. Refused on an
 * exam by the server. `maxAttempts` counts every attempt, the first one
 * included; `null` is unlimited. Structural, like the rest of the settings:
 * frozen once an attempt exists and while the evaluation runs.
 */
export const RetakeSettings = z.object({
  enabled: z.boolean().default(false),
  keep: RetakeKeep.default("best"),
  maxAttempts: z.number().int().min(2).max(100).nullable().default(null),
  /**
   * ADR-091: what a retake asks again. Absent on every rule stored before
   * it, and absent is `all`: read it through `retakeScopeOf`. `to_review`
   * needs `free` navigation (`422 retake_scope_navigation`).
   */
  scope: RetakeScope.optional(),
});
export type RetakeSettings = z.infer<typeof RetakeSettings>;

/** The negative-marking switch of an evaluation's settings (ADR-026); absent is off. */
export const negativeMarkingOf = (settings: { negativeMarking?: boolean | undefined }): boolean =>
  settings.negativeMarking === true;

/** The Safe Exam Browser switch of an evaluation's settings (ADR-027); absent is off. */
export const safeExamBrowserOf = (settings: { safeExamBrowser?: boolean | undefined }): boolean =>
  settings.safeExamBrowser === true;

/**
 * A confined client an exam may require (ADR-051 §2), on the wire. The list
 * is `@quiz/domain`'s `TRUSTED_CLIENTS`, re-exported here; `trustedClientsOf`
 * computes an evaluation's.
 */
export const TrustedClient = z.enum(TRUSTED_CLIENTS);
export type TrustedClient = z.infer<typeof TrustedClient>;
export { TRUSTED_CLIENTS };

/**
 * The calculator an evaluation provides on the student's screen (ADR-069).
 * The list is `@quiz/domain`'s `CALCULATOR_MODES`; `calculatorOn` computes an
 * evaluation's, a poll's being `none`.
 */
export const CalculatorMode = z.enum(CALCULATOR_MODES);
export type CalculatorMode = z.infer<typeof CalculatorMode>;

/**
 * The notepad an evaluation provides on the student's screen (ADR-090). The
 * list is `@quiz/domain`'s `NOTEPAD_MODES`; `notepadOn` computes an
 * evaluation's, a poll's being `none`.
 */
export const NotepadMode = z.enum(NOTEPAD_MODES);
export type NotepadMode = z.infer<typeof NotepadMode>;

/** What a condition says about the thing it names (ADR-079): `@quiz/domain`'s `CONDITION_KINDS`. */
export const ConditionKind = z.enum(CONDITION_KINDS);
export type ConditionKind = z.infer<typeof ConditionKind>;

/**
 * One condition the teacher announces (ADR-079, F-EVAL-33): a SNAPSHOT of
 * plain text, never translated, never rendered as markdown or HTML.
 * `catalogId` names the entry of the course's catalog it was copied from
 * (`course_conditions`, ADR-079 §5); the text stays the snapshot whatever the catalog
 * does after. Staff only: the student views carry the kind and the text.
 */
export const EvaluationCondition = z.object({
  kind: ConditionKind,
  text: z.string().trim().min(1).max(MAX_CONDITION_LENGTH),
  catalogId: z.uuid().optional(),
});
export type EvaluationCondition = z.infer<typeof EvaluationCondition>;

/** At most {@link MAX_CONDITIONS} conditions, in the teacher's order. */
export const EvaluationConditionList = z.array(EvaluationCondition).max(MAX_CONDITIONS);

/** The announced conditions of an evaluation's settings (ADR-079); absent is none. */
export const conditionsOf = (settings: {
  conditions?: EvaluationCondition[] | undefined;
}): EvaluationCondition[] => settings.conditions ?? [];

/** The kiosk-station switch of an evaluation's settings (ADR-051); absent is off. */
export const kioskOf = (settings: { kiosk?: boolean | undefined }): boolean => settings.kiosk === true;

/** A stored evaluation without the field: one attempt, as before #92. */
const defaultRetakes = (): RetakeSettings => ({
  enabled: false,
  keep: "best",
  maxAttempts: null,
});

/** The retake rule of an evaluation's settings; absent is {@link defaultRetakes}. */
export const retakesOf = (settings: { retakes?: RetakeSettings | undefined }): RetakeSettings =>
  settings.retakes ?? defaultRetakes();

export const EvaluationSettings = z.object({
  navigation: Navigation.default("free"),
  presentation: Presentation.default("zen"),
  lobby: LobbyMode.default("manual"),
  /** F-EVAL-09: question order, derived from the attempt seed (decision D19). */
  shuffleItems: z.boolean().default(false),
  /** Choice order, for the types that declare themselves shuffleable. */
  shuffleChoices: z.boolean().default(true),
  timing: Timing.default("duration"),
  showProgressBar: z.boolean().default(true),
  /**
   * F-EVAL-13, ADR-088: the integrity journal (`INTEGRITY_EVENT_KINDS`
   * of `live.ts`) is kept, never blocking. A creation sets
   * it by mode (`logVisibilityDefault`, `@quiz/domain`); this default only
   * fills a stored row that predates the field.
   */
  logVisibility: z.boolean().default(true),
  requireFullscreen: z.boolean().default(false),
  /**
   * F-EVAL-15. Absent on every evaluation that never set it, and absent
   * means one attempt: read it through {@link retakesOf}, never raw.
   */
  retakes: RetakeSettings.optional(),
  /**
   * ADR-026 (#130): every choice question of the evaluation — `mcq` and
   * `categorize` (ADR-036) — is scored with negative marking: a wrong answer
   * costs points, no answer costs nothing, and the total is floored at 0.
   * Refused on a `poll`. Absent means off: read it through
   * {@link negativeMarkingOf}, never raw.
   */
  negativeMarking: z.boolean().optional(),
  /**
   * ADR-036: what a `categorize` question configured `inherit` is scored
   * with. Absent means `per_item`: read it through
   * {@link categorizePolicyOf}, never raw. Kept in the JSON column rather than
   * beside `mcqPolicy`, so it needed no migration.
   */
  categorizePolicy: CategorizePolicy.optional(),
  /**
   * ADR-027 (#139): the evaluation is sat in Safe Exam Browser only. A
   * student launches it from the portal with a one-time `.seb` file; a
   * portal session cannot sit it. Absent means off: read it through
   * {@link safeExamBrowserOf}, never raw. Whether it is IN FORCE is
   * `trustedClientsOf` (`@quiz/domain`), with {@link EvaluationSettings.kiosk}.
   */
  safeExamBrowser: z.boolean().optional(),
  /**
   * ADR-051 §2: the evaluation may be sat on one of the school's attested
   * kiosk stations, paired from the student's phone. With
   * {@link EvaluationSettings.safeExamBrowser} it forms the exam's trusted
   * clients (`trustedClientsOf`, `@quiz/domain`): either or both. An exam's
   * switch, inert on any other mode. Absent means off: read it through
   * {@link kioskOf}, never raw.
   */
  kiosk: z.boolean().optional(),
  /**
   * ADR-069: the calculator the student's screen provides — none, standard
   * or scientific. It provides one; it forbids none other, which only a
   * trusted client can. Refused on a poll. Absent means `none`: read it
   * through `calculatorOn` (`@quiz/domain`), never raw.
   */
  calculator: CalculatorMode.optional(),
  /**
   * ADR-090: the notepad the student's screen provides — none, provided, or
   * provided with copy and paste blocked inside it. Kept on the student's
   * device only, never sent. Refused on a poll. Absent means `none`: read it
   * through `notepadOn` (`@quiz/domain`), never raw.
   */
  notepad: NotepadMode.optional(),
  /**
   * ADR-079 (F-EVAL-33): the conditions the teacher announces — allowed,
   * forbidden, provided, or plain information — in their order. Refused on a
   * poll, and frozen with the rest of the settings (`configLock`). Absent
   * means none: read it through {@link conditionsOf}, never raw. The lines
   * the platform adds are derived (`imposedConditions`, `@quiz/domain`),
   * never stored.
   */
  conditions: EvaluationConditionList.optional(),
  /**
   * ADR-041 §2 (#317): the questions of this evaluation become drill cards —
   * at the release of an exam, at the hand-in of an exercise — when its
   * classroom has the drill on. Absent means the mode's default, ON for an
   * exercise and OFF for an exam, never on a poll: read it through
   * `drillAllowedOn` (`@quiz/domain`), never raw — `Evaluation.allowDrill`
   * carries the effective value. Unlike the rest of the settings it is NOT in
   * {@link EvaluationSettingsPatch}: its one writer is `PUT
   * /evaluations/:id/drill`, editable until the release.
   */
  allowDrill: z.boolean().optional(),
  /**
   * Only on a `poll` evaluation (`./poll.ts`); absent everywhere else. Whether
   * the poll is anonymous is NOT stored here: it is the absence of a
   * classroom (`PollAudience`, ADR-014 addendum 2026-09-27). A row written
   * before that carries an `anonymous` key, which parsing drops.
   */
  poll: z
    .object({
      revealed: z.boolean().default(false),
      votes: z.boolean().default(false),
      /** ADR-071: absent means the audience's default, read through `pollSettingsOf`. */
      moderation: z.boolean().optional(),
      /** ADR-072: a model judges a brainstorm's ideas. Absent means off. */
      ai: z.boolean().optional(),
    })
    .optional(),
});
export type EvaluationSettings = z.infer<typeof EvaluationSettings>;

/** The settings of a freshly created evaluation, all defaults applied. */
export const defaultSettings = (): EvaluationSettings => EvaluationSettings.parse({});

/** How a grade is rounded to the tenth (`roundToTenth` of `@quiz/domain`), every scale alike. */
export const Rounding = z.enum(ROUNDINGS);
export type Rounding = z.infer<typeof Rounding>;

/**
 * F-EVAL-10: grade = 1 + 5 × points / total, capped at 6, rounded to the
 * tenth. Linear only: the `threshold` kind is gone (ADR-052), and the bonus
 * items (`ItemRow.bonus`) are how points past the total are given. The
 * object keeps its `kind` so the jsonb column keeps its shape.
 */
export const GradingScale = z.object({
  kind: z.literal("linear"),
  rounding: Rounding.default("nearest"),
});
export type GradingScale = z.infer<typeof GradingScale>;

export const defaultGradingScale = (): GradingScale =>
  GradingScale.parse({ kind: "linear", rounding: "nearest" });

/** F-EVAL-11. `immediate` is refused for `exam`. */
export const FeedbackPolicy = z.object({
  when: z.enum(["none", "on_release", "immediate"]).default("on_release"),
  /** The student's own answer. */
  showAnswer: z.boolean().default(true),
  /** The solution. */
  showKey: z.boolean().default(false),
  showExplanation: z.boolean().default(false),
  /** docs/06 Q8: the names of the hidden test cases of a `code` question. */
  showHiddenCaseNames: z.boolean().default(true),
  showTeacherComment: z.boolean().default(true),
});
export type FeedbackPolicy = z.infer<typeof FeedbackPolicy>;

export const defaultFeedbackPolicy = (): FeedbackPolicy => FeedbackPolicy.parse({});

// --- Entities -------------------------------------------------------------

export const Evaluation = z.object({
  id: z.uuid(),
  classroomId: z.uuid(),
  title: z.string(),
  mode: EvaluationMode,
  state: EvaluationState,
  settings: EvaluationSettings,
  /** ADR-041 §2: the effective "Allow drill" (`settings.allowDrill` or the mode's default). */
  allowDrill: z.boolean(),
  gradingScale: GradingScale,
  feedbackPolicy: FeedbackPolicy,
  /** Seeded at creation from the creator's preference; an `inherit` question takes it. */
  mcqPolicy: McqPolicy,
  opensAt: z.iso.datetime().nullable(),
  closesAt: z.iso.datetime().nullable(),
  durationS: z.number().int().nullable(),
  /**
   * The session code of a POLL (ADR-014), null for an exam or an exercise:
   * those have no access code since ADR-053 (the database refuses one).
   */
  accessCode: z.string().nullable(),
  ipAllowlist: z.array(z.string()),
  startedAt: z.iso.datetime().nullable(),
  pausedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  releasedAt: z.iso.datetime().nullable(),
  modifiedAfterRelease: z.boolean(),
  /**
   * When the correction of this exercise was published while it ran
   * (ADR-050, `POST /evaluations/:id/publish-correction`); null otherwise.
   */
  correctionPublishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /**
   * The template revision this evaluation's questions were last copied at
   * (ADR-031) — null for an evaluation not made from a template; it stays,
   * as a record, when the template is deleted. A teacher's shape: no student
   * view carries it.
   */
  originRevision: z.number().int().nullable(),
});
export type Evaluation = z.infer<typeof Evaluation>;

/**
 * The CURRENT revision of an evaluation's template, when it still has one
 * in its own course (ADR-031, F-EVAL-26); null otherwise. With the origin
 * revision, it says whether the template moved since (`templateBehind`).
 */
const TemplateRevision = z.number().int().nullable();

export const EvaluationSummary = z.object({
  id: z.uuid(),
  classroomId: z.uuid(),
  title: z.string(),
  mode: EvaluationMode,
  state: EvaluationState,
  itemCount: z.number().int(),
  totalPoints: z.number(),
  attemptCount: z.number().int(),
  opensAt: z.iso.datetime().nullable(),
  closesAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** As {@link Evaluation}: the template revision the questions came from. */
  originRevision: z.number().int().nullable(),
  templateRevision: TemplateRevision,
});
export type EvaluationSummary = z.infer<typeof EvaluationSummary>;

/**
 * One row of the item table. `versionNumber` is the FROZEN version; when
 * `latestVersionNumber` is greater, the item is "stale" and the teacher is
 * offered the one-click update (F-EVAL-03).
 */
export const ItemRow = z.object({
  id: z.uuid(),
  position: z.number().int(),
  points: z.number(),
  milestone: z.boolean(),
  /**
   * ADR-052: a bonus item's points are left out of the evaluation's total, so
   * they can only lift a student; its score is floored at 0.
   */
  bonus: z.boolean(),
  /** ADR-084: the text shown to the student before this item; null for none. */
  intro: z.string().nullable(),
  questionId: z.uuid(),
  questionVersionId: z.uuid(),
  type: z.string(),
  internalName: z.string(),
  versionNumber: z.number().int(),
  latestVersionNumber: z.number().int().nullable(),
  deprecated: z.boolean(),
  /** The question's difficulty, 1 to 5 — the question's, not the version's. */
  difficulty: z.number().int().min(1).max(5),
});
export type ItemRow = z.infer<typeof ItemRow>;

/**
 * What the teacher reading this page is, seen from the evaluation: the seat
 * they hold in its classroom and the test attempt they took with it.
 *
 * It is what "View as student" needs before it can do anything (ADR-018): no
 * seat means offering to take one, a staff seat means the walk is one click
 * away, and an attempt already submitted means the only way back into the
 * flow is to reset it.
 */
export const EvaluationSelf = z.object({
  /** A CLAIMED seat in the classroom, of any kind. */
  seat: z.boolean(),
  /** That seat is a staff one — the teacher joined their own classroom. */
  staffSeat: z.boolean(),
  /** Their own attempt on this evaluation, when they have taken it. */
  attemptId: z.uuid().nullable(),
});
export type EvaluationSelf = z.infer<typeof EvaluationSelf>;

/**
 * The concepts of each item's question, by question id, labelled in the
 * reader's language: a column of the item list beside the difficulty.
 */
export const ItemConcepts = z.record(z.string(), z.array(ConceptRef));
export type ItemConcepts = z.infer<typeof ItemConcepts>;

export const EvaluationDetail = z.object({
  evaluation: Evaluation,
  items: z.array(ItemRow),
  concepts: ItemConcepts,
  totalPoints: z.number(),
  /** Item ids whose frozen version is not the latest published one. */
  staleItems: z.array(z.uuid()),
  attemptCount: z.number().int(),
  /** False once an attempt exists: the structure is frozen (F-EVAL-03). */
  editable: z.boolean(),
  /** The reader's own seat and test attempt (ADR-018). */
  self: EvaluationSelf,
  /**
   * The questions of the items the reader may open in the question editor
   * (issue #127): those whose pool they hold at least `contributor` in. A
   * colleague on the course's staff always PREVIEWS every item; editing is
   * the pool's decision, and a question left out here offers no Edit.
   */
  editableQuestionIds: z.array(z.uuid()),
  /**
   * Who is about to take it, for the launch step's checklist (#152); `null`
   * for an anonymous poll, which has no classroom. `enrolled` is the lobby
   * ring's denominator (`enrolledCount`), so both screens say the same number;
   * `unlinked` and `conflicts` count the class seats (never staff) still
   * without an account, and flagged by the roster import.
   */
  roster: z
    .object({
      enrolled: z.number().int(),
      unlinked: z.number().int(),
      conflicts: z.number().int(),
    })
    .nullable(),
  /** The template's current revision, for the launch checklist's pull (F-EVAL-26). */
  templateRevision: TemplateRevision,
  /**
   * The evaluation's course: what the screens read the reader's role from,
   * in the course list (`CourseSummary.myRole`, ADR-068) — a classroom's
   * course cannot be found there once the classroom is archived.
   */
  courseId: z.uuid(),
});
export type EvaluationDetail = z.infer<typeof EvaluationDetail>;

// --- Requests -------------------------------------------------------------

export const EvaluationCreate = z.object({
  title: z.string().trim().min(1).max(200),
  mode: EvaluationMode.default("exam"),
  /** Named preset of settings; `exam` and `exercise` for now. */
  preset: z.enum(["exam", "exercise"]).optional(),
  /** ADR-041 §2: the teacher's choice at creation; absent is the mode's default. */
  allowDrill: z.boolean().optional(),
});
export type EvaluationCreate = z.infer<typeof EvaluationCreate>;

/*
 * The two PARTIAL bodies of a patch, spelled out field by field and WITHOUT
 * a single `.default()`. `EvaluationSettings.partial()` is not one: under
 * zod 4 a field that is optional AND defaulted still receives its default
 * when absent, so `{ shuffleItems: true }` parsed into the whole settings
 * object with every other field at its default — and the service's merge
 * then wrote `timing: "duration"` and `lobby: "manual"` over what the
 * teacher had chosen (#71). A patch carries what the caller sent, nothing
 * else; the defaults belong to creation only.
 */

/** `PATCH` of the settings: only the fields sent, merged over the stored ones. */
export const EvaluationSettingsPatch = z.object({
  navigation: Navigation.optional(),
  presentation: Presentation.optional(),
  lobby: LobbyMode.optional(),
  shuffleItems: z.boolean().optional(),
  shuffleChoices: z.boolean().optional(),
  timing: Timing.optional(),
  showProgressBar: z.boolean().optional(),
  logVisibility: z.boolean().optional(),
  requireFullscreen: z.boolean().optional(),
  /** Replaced whole: the three fields of the retake rule travel together. */
  retakes: RetakeSettings.optional(),
  negativeMarking: z.boolean().optional(),
  categorizePolicy: CategorizePolicy.optional(),
  safeExamBrowser: z.boolean().optional(),
  kiosk: z.boolean().optional(),
  calculator: CalculatorMode.optional(),
  notepad: NotepadMode.optional(),
  /** Replaced whole, like `retakes`: the list travels in its order. */
  conditions: EvaluationConditionList.optional(),
  poll: EvaluationSettings.shape.poll,
});
export type EvaluationSettingsPatch = z.infer<typeof EvaluationSettingsPatch>;

/** `PATCH` of the feedback policy: only the fields sent. */
const FeedbackPolicyPatch = z.object({
  when: FeedbackPolicy.shape.when.unwrap().optional(),
  showAnswer: z.boolean().optional(),
  showKey: z.boolean().optional(),
  showExplanation: z.boolean().optional(),
  showHiddenCaseNames: z.boolean().optional(),
  showTeacherComment: z.boolean().optional(),
});
type FeedbackPolicyPatch = z.infer<typeof FeedbackPolicyPatch>;

// A field added to the full body and forgotten here would be silently
// stripped from every patch: the two key sets must stay equal, both ways —
// save `allowDrill`, which has a writer of its own (ADR-041 §10, item 3).
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
const _settingsPatchKeys: SameKeys<
  Omit<EvaluationSettings, "allowDrill">,
  Required<EvaluationSettingsPatch>
> = true;
const _feedbackPatchKeys: SameKeys<FeedbackPolicy, Required<FeedbackPolicyPatch>> = true;
void [_settingsPatchKeys, _feedbackPatchKeys];

/**
 * The fields of an evaluation patch, before the "something to update" rule:
 * the one list {@link EvaluationPatch} and {@link TemplatePatch} are cut from.
 */
const EvaluationPatchFields = z.object({
  // No `accessCode` since ADR-053: an exam or an exercise has none. The
  // object is not strict, so a stale client that still sends one has it
  // stripped (a patch with nothing else is the usual "Nothing to update").
  title: z.string().trim().min(1).max(200).optional(),
  settings: EvaluationSettingsPatch.optional(),
  gradingScale: GradingScale.optional(),
  feedbackPolicy: FeedbackPolicyPatch.optional(),
  mcqPolicy: McqPolicy.optional(),
  opensAt: z.iso.datetime().nullable().optional(),
  closesAt: z.iso.datetime().nullable().optional(),
  durationS: z.number().int().min(30).max(24 * 3600).nullable().optional(),
  ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
});

const somethingToUpdate = (b: object) => Object.keys(b).length > 0;

export const EvaluationPatch = EvaluationPatchFields.refine(somethingToUpdate, {
  message: "Nothing to update",
});
export type EvaluationPatch = z.infer<typeof EvaluationPatch>;

/** A deletion names the evaluation it removes, exactly like a classroom's. */
export const EvaluationDelete = z.object({ confirmTitle: z.string() });
export type EvaluationDelete = z.infer<typeof EvaluationDelete>;

export const ItemsAdd = z.object({ questionIds: z.array(z.uuid()).min(1).max(200) });
export type ItemsAdd = z.infer<typeof ItemsAdd>;

/** ADR-084: the longest intro an item may carry, in characters. */
export const ITEM_INTRO_MAX = 10_000;

export const ItemPatch = z
  .object({
    points: z.number().min(0).max(1000).optional(),
    milestone: z.boolean().optional(),
    /** ADR-052; locked with the points (`assertItemListEditable`). */
    bonus: z.boolean().optional(),
    /**
     * ADR-084: the passage before the item, markdown; `null` or a blank
     * text removes it. Locked with the points.
     */
    intro: z
      .string()
      .max(ITEM_INTRO_MAX)
      .nullable()
      .transform((v) => (v === null || v.trim() === "" ? null : v))
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type ItemPatch = z.infer<typeof ItemPatch>;

export const ItemsOrder = z.object({ itemIds: z.array(z.uuid()).min(1).max(200) });
export type ItemsOrder = z.infer<typeof ItemsOrder>;

/** Omitting `itemIds` updates every stale item at once. */
export const UpdateVersions = z.object({ itemIds: z.array(z.uuid()).max(200).optional() });
export type UpdateVersions = z.infer<typeof UpdateVersions>;

export const EvaluationDuplicate = z.object({
  classroomId: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
});
export type EvaluationDuplicate = z.infer<typeof EvaluationDuplicate>;

// --- Templates (ADR-031) --------------------------------------------------

/**
 * An evaluation TEMPLATE of a course: kept at the course level, never run.
 * Its own shape, so `Evaluation.classroomId` stays non-null. It has no
 * dates, no access code and no IP list — the database refuses them — and is
 * never a poll.
 */
export const EvaluationTemplate = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  title: z.string(),
  mode: EvaluationMode.exclude(["poll"]),
  /** 1 at creation; every committed change to the content moves it (F-EVAL-25). */
  revision: z.number().int().min(1),
  itemCount: z.number().int(),
  totalPoints: z.number(),
});
export type EvaluationTemplate = z.infer<typeof EvaluationTemplate>;

/**
 * `POST /courses/:id/templates` — a new, EMPTY template of the course
 * (F-EVAL-24): the fields of an evaluation's creation, in the course rather
 * than in a classroom. `poll` parses and is refused `422 template_poll`, like
 * *Save as template* on a poll.
 */
export const TemplateNew = EvaluationCreate;
export type TemplateNew = z.infer<typeof TemplateNew>;

/**
 * `PATCH /templates/:id` (F-EVAL-25): the evaluation patch without anything
 * of a run. STRICT at the top level: `opensAt`, `closesAt` or `ipAllowlist`
 * — or any unknown top-level key, the `accessCode` an evaluation no longer
 * has (ADR-053) included — is a `400`, never silently stripped (ADR-031,
 * addendum c). The nested `settings` and `feedbackPolicy`
 * patches are the evaluation's, which strip an unknown key as they always
 * have. The title is patchable and does not move the revision.
 */
export const TemplatePatch = EvaluationPatchFields.omit({
  opensAt: true,
  closesAt: true,
  ipAllowlist: true,
})
  .strict()
  .refine(somethingToUpdate, { message: "Nothing to update" });
export type TemplatePatch = z.infer<typeof TemplatePatch>;

/**
 * One row of a template's item table: an {@link ItemRow} (whose
 * `latestVersionNumber` says "stale" and `deprecated` says the frozen version
 * was withdrawn), plus `poolUnlinked` — the question's pool is no longer
 * linked to the course. These are what *Instantiate* warns about
 * (`deprecated`) and refuses on (`poolUnlinked`), shown before it is tried.
 */
export const TemplateItemRow = ItemRow.extend({ poolUnlinked: z.boolean() });
export type TemplateItemRow = z.infer<typeof TemplateItemRow>;

/**
 * `GET /templates/:id`, and the answer of every write under it: what the
 * editor of a template reads. The template carries its whole configuration
 * but nothing of a run (no dates, code, IP list, state or attempts); it is
 * always editable, having neither attempts nor a state beyond `draft`.
 */
export const TemplateDetail = z.object({
  template: EvaluationTemplate.extend({
    settings: EvaluationSettings,
    gradingScale: GradingScale,
    feedbackPolicy: FeedbackPolicy,
    mcqPolicy: McqPolicy,
    durationS: z.number().int().nullable(),
  }),
  items: z.array(TemplateItemRow),
  concepts: ItemConcepts,
  totalPoints: z.number(),
  /** Item ids whose frozen version is not the latest published one. */
  staleItems: z.array(z.uuid()),
  /** As {@link EvaluationDetail.shape.editableQuestionIds}: whom the question editor lets in. */
  editableQuestionIds: z.array(z.uuid()),
});
export type TemplateDetail = z.infer<typeof TemplateDetail>;

/** `POST /evaluations/:id/template` — "Save as template". */
export const TemplateCreate = z.object({
  title: z.string().trim().min(1).max(200),
});
export type TemplateCreate = z.infer<typeof TemplateCreate>;

/** `POST /templates/:id/instances` — "Instantiate" into a classroom of the course. */
export const TemplateInstantiate = z.object({
  classroomId: z.uuid(),
  /** The template's title when absent. */
  title: z.string().trim().min(1).max(200).optional(),
});
export type TemplateInstantiate = z.infer<typeof TemplateInstantiate>;

/** One item of a template, named by where it stands and which question it plays. */
export const TemplateItemRef = z.object({
  position: z.number().int(),
  questionId: z.uuid(),
  internalName: z.string(),
});
export type TemplateItemRef = z.infer<typeof TemplateItemRef>;

/**
 * The answer of "Instantiate": the new draft, and the items frozen on a
 * version since marked deprecated — a warning, never a refusal.
 */
export const TemplateInstance = z.object({
  evaluation: Evaluation,
  deprecatedItems: z.array(TemplateItemRef),
});
export type TemplateInstance = z.infer<typeof TemplateInstance>;

/**
 * The body of `422 template_pool_unlinked`: the items whose question sits in
 * a pool no longer linked to the course (F-EVAL-01) — the instance could not
 * have been authored with them either.
 */
export const TemplatePoolUnlinked = z.object({
  error: z.literal("template_pool_unlinked"),
  items: z.array(TemplateItemRef),
});
export type TemplatePoolUnlinked = z.infer<typeof TemplatePoolUnlinked>;

// --- Pulling a template revision (F-EVAL-26) ----------------------------------

/** One item, as the summary of a pull names it: which question, where, and how. */
export const TemplatePullItem = TemplateItemRef.extend({
  versionNumber: z.number().int(),
  points: z.number(),
  milestone: z.boolean(),
  bonus: z.boolean(),
  /** ADR-084: a different intro makes the item `changed`. */
  intro: z.string().nullable(),
});
export type TemplatePullItem = z.infer<typeof TemplatePullItem>;

/**
 * `GET /evaluations/:id/pull-template` — what pulling the template's current
 * revision would do to the evaluation's QUESTIONS, the only thing a pull
 * replaces: items `added` (in the template only), `removed` (in the
 * evaluation only), `changed` (another version, points, milestone, bonus or intro),
 * whether the order moves, and "rev. `from` → `to`". `unlinkedItems` would
 * refuse the pull (`422 template_pool_unlinked`); `deprecatedItems` only warn.
 */
export const TemplatePullPreview = z.object({
  templateId: z.uuid(),
  templateTitle: z.string(),
  from: z.number().int().nullable(),
  to: z.number().int(),
  added: z.array(TemplatePullItem),
  removed: z.array(TemplatePullItem),
  changed: z.array(z.object({ from: TemplatePullItem, to: TemplatePullItem })),
  reordered: z.boolean(),
  deprecatedItems: z.array(TemplateItemRef),
  unlinkedItems: z.array(TemplateItemRef),
});
export type TemplatePullPreview = z.infer<typeof TemplatePullPreview>;

/**
 * `POST /evaluations/:id/pull-template` — the revision the teacher confirmed.
 * A template that moved again since the preview is `409 template_moved`:
 * the pull never copies a revision nobody looked at.
 */
export const TemplatePull = z.object({ revision: z.number().int().min(1) });
export type TemplatePull = z.infer<typeof TemplatePull>;

/** The answer of a pull: the evaluation as it now stands, and the deprecated versions it took. */
export const TemplatePullResult = z.object({
  detail: EvaluationDetail,
  deprecatedItems: z.array(TemplateItemRef),
});
export type TemplatePullResult = z.infer<typeof TemplatePullResult>;

/** The authoring transitions. `running`, `paused` and `closed` are `live` routes. */
export const EvaluationStateBody = z.object({
  to: z.enum(["draft", "scheduled", "lobby"]),
});
export type EvaluationStateBody = z.infer<typeof EvaluationStateBody>;

/**
 * The body of a `409 illegal_transition` on `POST /evaluations/:id/state`
 * (and on the live `start`). `reason` is set when the move is legal but the
 * evaluation is not ready for it, and `missing` then names the timing fields
 * to fill (F-EVAL-04, decision D8) — the screen translates these rather than
 * printing `message`, which is for logs and API clients (#76).
 * `opens_at_missing` refuses `→ scheduled` without an opening time: the
 * ticker opens a scheduled evaluation at `opensAt`, and without one it would
 * stay scheduled forever (#152). `closes_at_past` refuses to schedule or open
 * an evaluation whose `closesAt` has passed, whatever its timing (ADR-086),
 * and `opens_at_past` a schedule for a time already past, both against the
 * server's clock (#178). `no_graded_points` refuses to open an exam or an
 * exercise whose total — bonus items left out — is 0 (ADR-052).
 */
export const TransitionRefusal = z.object({
  error: z.literal("illegal_transition"),
  message: z.string(),
  reason: z
    .enum([
      "no_items",
      "no_graded_points",
      "timing_incomplete",
      "opens_at_missing",
      "closes_at_past",
      "opens_at_past",
    ])
    .optional(),
  missing: z.array(z.enum(["durationS", "opensAt", "closesAt"])).optional(),
});
export type TransitionRefusal = z.infer<typeof TransitionRefusal>;

/** `/evaluations/:id/items/:itemId` */
export const ItemParam = z.object({ id: z.uuid(), itemId: z.uuid() });
export type ItemParam = z.infer<typeof ItemParam>;
