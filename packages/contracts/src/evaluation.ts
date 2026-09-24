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
export const LobbyMode = z.enum(["skip", "auto", "manual"]);
export type LobbyMode = z.infer<typeof LobbyMode>;

/** F-EVAL-04. `manual` has no deadline at all: only the teacher closes. */
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
  /** F-EVAL-13: tab visibility changes are journalled, never blocked. */
  logVisibility: z.boolean().default(true),
  requireFullscreen: z.boolean().default(false),
  /** Only on a `poll` evaluation (`./poll.ts`); absent everywhere else. */
  poll: z
    .object({ anonymous: z.boolean().default(false), revealed: z.boolean().default(false) })
    .optional(),
});
export type EvaluationSettings = z.infer<typeof EvaluationSettings>;

/** The settings of a freshly created evaluation, all defaults applied. */
export const defaultSettings = (): EvaluationSettings => EvaluationSettings.parse({});

/** F-EVAL-10. */
export const GradingScale = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("linear"),
    rounding: z.enum(["nearest", "up", "down"]).default("nearest"),
  }),
  z.object({
    kind: z.literal("threshold"),
    threshold: z.number().positive(),
    rounding: z.enum(["nearest", "up", "down"]).default("nearest"),
  }),
]);
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
  gradingScale: GradingScale,
  feedbackPolicy: FeedbackPolicy,
  /** Seeded at creation from the creator's preference; an `inherit` question takes it. */
  mcqPolicy: McqPolicy,
  opensAt: z.iso.datetime().nullable(),
  closesAt: z.iso.datetime().nullable(),
  durationS: z.number().int().nullable(),
  /** Never echoed to a student; the teacher sees their own code. */
  accessCode: z.string().nullable(),
  ipAllowlist: z.array(z.string()),
  startedAt: z.iso.datetime().nullable(),
  pausedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  releasedAt: z.iso.datetime().nullable(),
  modifiedAfterRelease: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Evaluation = z.infer<typeof Evaluation>;

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
  questionId: z.uuid(),
  questionVersionId: z.uuid(),
  type: z.string(),
  internalName: z.string(),
  versionNumber: z.number().int(),
  latestVersionNumber: z.number().int().nullable(),
  deprecated: z.boolean(),
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

export const EvaluationDetail = z.object({
  evaluation: Evaluation,
  items: z.array(ItemRow),
  totalPoints: z.number(),
  /** Item ids whose frozen version is not the latest published one. */
  staleItems: z.array(z.uuid()),
  attemptCount: z.number().int(),
  /** False once an attempt exists: the structure is frozen (F-EVAL-03). */
  editable: z.boolean(),
  /** The reader's own seat and test attempt (ADR-018). */
  self: EvaluationSelf,
});
export type EvaluationDetail = z.infer<typeof EvaluationDetail>;

// --- Requests -------------------------------------------------------------

export const EvaluationCreate = z.object({
  title: z.string().trim().min(1).max(200),
  mode: EvaluationMode.default("exam"),
  /** Named preset of settings; `exam` and `exercise` for now. */
  preset: z.enum(["exam", "exercise"]).optional(),
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
  poll: EvaluationSettings.shape.poll,
});
export type EvaluationSettingsPatch = z.infer<typeof EvaluationSettingsPatch>;

/** `PATCH` of the feedback policy: only the fields sent. */
export const FeedbackPolicyPatch = z.object({
  when: FeedbackPolicy.shape.when.unwrap().optional(),
  showAnswer: z.boolean().optional(),
  showKey: z.boolean().optional(),
  showExplanation: z.boolean().optional(),
  showHiddenCaseNames: z.boolean().optional(),
  showTeacherComment: z.boolean().optional(),
});
export type FeedbackPolicyPatch = z.infer<typeof FeedbackPolicyPatch>;

export const EvaluationPatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    settings: EvaluationSettingsPatch.optional(),
    gradingScale: GradingScale.optional(),
    feedbackPolicy: FeedbackPolicyPatch.optional(),
    mcqPolicy: McqPolicy.optional(),
    opensAt: z.iso.datetime().nullable().optional(),
    closesAt: z.iso.datetime().nullable().optional(),
    durationS: z.number().int().min(30).max(24 * 3600).nullable().optional(),
    accessCode: z.string().trim().min(3).max(32).nullable().optional(),
    ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });
export type EvaluationPatch = z.infer<typeof EvaluationPatch>;

/** A deletion names the evaluation it removes, exactly like a classroom's. */
export const EvaluationDelete = z.object({ confirmTitle: z.string() });
export type EvaluationDelete = z.infer<typeof EvaluationDelete>;

export const ItemsAdd = z.object({ questionIds: z.array(z.uuid()).min(1).max(200) });
export type ItemsAdd = z.infer<typeof ItemsAdd>;

export const ItemPatch = z
  .object({
    points: z.number().min(0).max(1000).optional(),
    milestone: z.boolean().optional(),
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
 */
export const TransitionRefusal = z.object({
  error: z.literal("illegal_transition"),
  message: z.string(),
  reason: z.enum(["no_items", "timing_incomplete"]).optional(),
  missing: z.array(z.enum(["durationS", "opensAt", "closesAt", "timing"])).optional(),
});
export type TransitionRefusal = z.infer<typeof TransitionRefusal>;

/** `/evaluations/:id/items/:itemId` */
export const ItemParam = z.object({ id: z.uuid(), itemId: z.uuid() });
export type ItemParam = z.infer<typeof ItemParam>;
