/**
 * `live` route schemas (PLAN-MVP §4.4 and §4.7): taking an evaluation, and
 * driving it from the teacher's dashboard.
 *
 * Two rules shape this file:
 *   - every response that a countdown depends on carries `serverNow`, because
 *     the server owns the clock (invariant 5);
 *   - the content of a question travels as `unknown` (`student`, `answer`):
 *     its shape belongs to the question type, and the ONLY producer of a
 *     student payload is `studentView()` in the API (invariant 4).
 */
import { z } from "zod";

import {
  announcedConditionsOn,
  ATTEMPT_CLOSERS,
  ATTEMPT_STATES,
  imposedConditions,
  LOCKED_NAVIGATIONS,
  PROGRESS_STATUSES,
  PROVIDED_CALCULATORS,
  RETAKE_REFUSALS,
  TRUSTED_CLIENTS,
  type ConditionsInput,
  type ImposedCondition as DomainImposedCondition,
} from "@quiz/domain";

import {
  ConditionKind,
  EvaluationMode,
  EvaluationSettings,
  EvaluationState,
  FeedbackPolicy,
  Navigation,
  RetakeKeep,
  RetakeScope,
  TrustedClient,
} from "./evaluation.js";
import { StaffItemRef } from "./common.js";
import { Verdict } from "./grading.js";
import { IntegrityIncident } from "./integrity.js";

export const AttemptState = z.enum(ATTEMPT_STATES);
export type AttemptState = z.infer<typeof AttemptState>;

export const ClosedBy = z.enum(ATTEMPT_CLOSERS);
export type ClosedBy = z.infer<typeof ClosedBy>;

/**
 * What a cell of the dashboard grid shows before correction (F-DASH-01):
 * never opened, opened and empty, holding an answer (`in_progress`), left on
 * purpose ("I won't answer", issue #89), validated (`forward_only`, a
 * crossed checkpoint). Derived by `@quiz/domain#progressStatus`.
 */
export const CellStatus = z.enum(PROGRESS_STATUSES);
export type CellStatus = z.infer<typeof CellStatus>;

/**
 * The journal kinds a student's client may write (F-EVAL-13). The others of
 * {@link AttemptEventKind} are the server's own record — an address change,
 * a pause, a `+N min`, a run — and a client that could write them could
 * forge its own history.
 */
export const ClientEventKind = z.enum(["visibility", "focus", "reconnect", "paste"]);
export type ClientEventKind = z.infer<typeof ClientEventKind>;

export const AttemptEventKind = z.enum([
  ...ClientEventKind.options,
  "ip_change",
  "time_added",
  "paused",
  "resumed",
  "run",
]);
export type AttemptEventKind = z.infer<typeof AttemptEventKind>;

/**
 * The integrity journal (ADR-088): the client kinds that say the student
 * left the page or pasted a text copied outside it. THE list, read by
 * three rules: the server stores them only while `logVisibility` is on and
 * the session is not a delegated one (`POST /attempts/:id/events`),
 * and it deletes them at the release of the grades or, for an evaluation
 * never released, six months after it closed. `reconnect` is not one of
 * them: it is the network's record, not the student's behaviour, and the
 * server's kinds (`run` carries the Run rate limit) are never touched.
 */
export const INTEGRITY_EVENT_KINDS = [
  ClientEventKind.enum.visibility,
  ClientEventKind.enum.focus,
  ClientEventKind.enum.paste,
] as const satisfies readonly ClientEventKind[];
export type IntegrityEventKind = (typeof INTEGRITY_EVENT_KINDS)[number];

export const isIntegrityEventKind = (kind: AttemptEventKind): kind is IntegrityEventKind =>
  (INTEGRITY_EVENT_KINDS as readonly AttemptEventKind[]).includes(kind);

// --- Student side ---------------------------------------------------------

/**
 * One question as the student sees it. `student` is the output of
 * `type.toStudent` through `studentView()`; nothing else may produce it.
 */
export const AttemptItem = z.object({
  id: z.uuid(),
  position: z.number().int(),
  points: z.number(),
  type: z.string(),
  milestone: z.boolean(),
  /** ADR-052: shown as "Bonus question"; an item's property, not question content. */
  bonus: z.boolean(),
  /**
   * ADR-084: the teacher's markdown shown as a passage screen before the
   * item; null for none. An item's property, not question content.
   */
  intro: z.string().nullable(),
  student: z.unknown(),
  answer: z.unknown().nullable(),
  revision: z.number().int(),
  /**
   * VALIDATED: "Validate and continue" in `forward_only`, a crossed
   * checkpoint in `milestones` (F-LIVE-08). The name is the column's, which
   * held the "Mark as done" this replaced (issue #89).
   */
  markedDone: z.boolean(),
  /** "I won't answer this question": settled on purpose, left blank (issue #89). */
  skipped: z.boolean(),
  /** The student's own review flag. No effect on grading (issue #89). */
  flagged: z.boolean(),
  /** Navigation already forbids writing to this item (forward_only, milestones). */
  locked: z.boolean(),
  /**
   * ADR-091: acquired in the previous attempt and carried over by a partial
   * retake, answer and grading as they stood. Shown read-only, still
   * reachable; every write to it is `409 item_acquired`.
   */
  acquired: z.boolean(),
});
export type AttemptItem = z.infer<typeof AttemptItem>;

/**
 * One line the platform adds to an evaluation's conditions (ADR-079): a key
 * the screens translate, its kind and its parameters — `@quiz/domain`'s
 * `ImposedCondition`, which `imposedConditions` derives; the two are checked
 * equal below.
 */
export const ImposedCondition = z.discriminatedUnion("key", [
  z.object({ key: z.literal("trusted_client"), kind: z.literal("forbidden"), clients: z.array(TrustedClient) }),
  z.object({
    key: z.literal("calculator"),
    kind: z.literal("provided"),
    calculator: z.enum(PROVIDED_CALCULATORS),
  }),
  z.object({ key: z.literal("notepad"), kind: z.literal("provided") }),
  z.object({ key: z.literal("notepad_no_clipboard"), kind: z.literal("provided") }),
  z.object({
    key: z.literal("duration"),
    kind: z.literal("info"),
    durationS: z.number().int(),
    bonusPercent: z.number().int(),
  }),
  z.object({
    key: z.literal("deadline"),
    kind: z.literal("info"),
    closesAt: z.iso.datetime(),
    bonusPercent: z.number().int(),
  }),
  z.object({ key: z.literal("attempts"), kind: z.literal("info"), maxAttempts: z.number().int().nullable() }),
  z.object({ key: z.literal("partial_retake"), kind: z.literal("info") }),
  z.object({
    key: z.literal("navigation"),
    kind: z.literal("info"),
    navigation: z.enum(LOCKED_NAVIGATIONS),
  }),
  z.object({ key: z.literal("negative_marking"), kind: z.literal("info") }),
  z.object({ key: z.literal("visibility_logged"), kind: z.literal("info") }),
  z.object({ key: z.literal("autosave"), kind: z.literal("info") }),
]);
export type ImposedCondition = z.infer<typeof ImposedCondition>;

// The wire shape and the domain's are the same union, both ways.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _imposedSame: Same<ImposedCondition, DomainImposedCondition> = true;
void _imposedSame;

/**
 * The conditions a student reads (ADR-079, F-EVAL-33): what the teacher
 * announces — kind and text only, never the catalog reference — then what
 * the platform imposes. Built by the server for the waiting room, the ready
 * screen and the attempt, and for a trusted client's card and `/pair` (§7);
 * drawn by one component (`ConditionsList`).
 */
export const EvaluationConditions = z.object({
  announced: z.array(z.object({ kind: ConditionKind, text: z.string() })),
  imposed: z.array(ImposedCondition),
});
export type EvaluationConditions = z.infer<typeof EvaluationConditions>;

/**
 * THE builder of {@link EvaluationConditions}: the server calls it for every
 * student view, the teacher's launch preview on the configuration it holds.
 * The announced ones lose their catalog reference; a poll has none.
 */
export function evaluationConditionsOf(
  input: ConditionsInput & { settings: { conditions?: { kind: ConditionKind; text: string }[] | undefined } },
): EvaluationConditions {
  return {
    announced: announcedConditionsOn(input.mode, input.settings.conditions).map(({ kind, text }) => ({ kind, text })),
    imposed: imposedConditions(input),
  };
}

export const AttemptView = z.object({
  attempt: z.object({
    id: z.uuid(),
    state: AttemptState,
    startedAt: z.iso.datetime().nullable(),
    deadlineAt: z.iso.datetime().nullable(),
    lastItemId: z.uuid().nullable(),
    serverNow: z.iso.datetime(),
    /** True for the teacher preview: nothing is persisted (PLAN-MVP §4.3). */
    preview: z.boolean(),
    /**
     * The attempt no longer accepts writes: it is over, or the evaluation is
     * not running. The player renders the same content in read mode; every
     * write would answer `410 attempt_closed` anyway (§4.7).
     */
    readOnly: z.boolean(),
  }),
  evaluation: z.object({
    id: z.uuid(),
    title: z.string(),
    mode: EvaluationMode,
    state: EvaluationState,
    /** The announced conditions travel in `conditions` only (ADR-079), without their catalog reference. */
    settings: EvaluationSettings.omit({ conditions: true }),
    feedbackPolicy: FeedbackPolicy,
    pausedAt: z.iso.datetime().nullable(),
    totalPoints: z.number(),
  }),
  items: z.array(AttemptItem),
  /**
   * ADR-079: the conditions, reopenable from the player's bar.
   */
  conditions: EvaluationConditions,
});
export type AttemptView = z.infer<typeof AttemptView>;

/**
 * What an evaluation tells a student BEFORE the clock runs, said by the
 * waiting room and by the ready screen alike (§6.3, ADR-076 §1 as amended by
 * ADR-079): its conditions — the student's own extra time is in their
 * duration or deadline line. Rules of the evaluation, not question content.
 */
export const EvaluationRules = z.object({
  conditions: EvaluationConditions,
});
export type EvaluationRules = z.infer<typeof EvaluationRules>;

export const LobbyView = EvaluationRules.extend({
  evaluation: z.object({
    id: z.uuid(),
    title: z.string(),
    state: EvaluationState,
  }),
  present: z.number().int(),
  enrolled: z.number().int(),
  serverNow: z.iso.datetime(),
});
export type LobbyView = z.infer<typeof LobbyView>;

/**
 * The ready screen (ADR-076, issue #525): a `running` evaluation the
 * participant has not started. Nothing was written to reach it — no attempt
 * row, no presence — and the clock has not begun; `POST
 * /evaluations/:id/attempt/start` is the explicit act. It carries the
 * conditions, whose time line is what the Start button announces (ADR-079).
 */
export const ReadyView = EvaluationRules.extend({
  evaluation: z.object({
    id: z.uuid(),
    title: z.string(),
  }),
});
export type ReadyView = z.infer<typeof ReadyView>;

/**
 * `POST /evaluations/:id/attempt` and `GET /attempts/:id` answer one of the
 * two: question content exists only once the evaluation has started, so a
 * `scheduled` or `lobby` evaluation answers the lobby, whichever route asked.
 */
export const AttemptOrLobby = z.union([
  z.object({ kind: z.literal("attempt"), view: AttemptView }),
  z.object({ kind: z.literal("lobby"), view: LobbyView }),
]);
export type AttemptOrLobby = z.infer<typeof AttemptOrLobby>;

/**
 * What the two entry routes answer, `POST /evaluations/:id/attempt` and
 * `POST /evaluations/:id/attempt/start` (ADR-076): a `running` evaluation the
 * participant has not started answers `ready`, nothing written.
 */
export const AttemptEntry = z.union([
  ...AttemptOrLobby.options,
  z.object({ kind: z.literal("ready"), view: ReadyView }),
]);
export type AttemptEntry = z.infer<typeof AttemptEntry>;

/**
 * Empty since the access code was removed (ADR-053); the body of both entry
 * routes (`/attempt`, `/attempt/start`, ADR-076). Not strict: a client
 * from before the change still sends `accessCode`, which is stripped.
 */
export const AttemptStartBody = z.object({});
export type AttemptStartBody = z.infer<typeof AttemptStartBody>;

/**
 * `POST /evaluations/:id/retake` refused (F-EVAL-15): the reason is
 * `retakeRefusal`'s in `@quiz/domain` — or, for a retake of the questions
 * to review, `partialRetakeRefusal`'s (`scope_all`, `nothing_to_review`,
 * ADR-091). A success answers {@link AttemptOrLobby}.
 */
export const RetakeRefusalReason = z.enum(RETAKE_REFUSALS);
export type RetakeRefusalReason = z.infer<typeof RetakeRefusalReason>;

export const RetakeRefused = z.object({
  error: z.literal("retake_refused"),
  reason: RetakeRefusalReason,
  message: z.string().optional(),
});
export type RetakeRefused = z.infer<typeof RetakeRefused>;

/**
 * The body of `POST /evaluations/:id/retake` (ADR-091): redo every question
 * (`all`, the default, what a body-less request from before ADR-091 means),
 * or only those to review — refused unless the teacher chose that scope.
 */
export const RetakeBody = z.object({ scope: RetakeScope.default("all") });
export type RetakeBody = z.infer<typeof RetakeBody>;

// --- Autosave (PLAN-MVP §4.7) --------------------------------------------

export const AutosaveRequest = z.object({
  /** Validated server-side by `type.answerSchema`; never trusted here. */
  payload: z.unknown(),
  /**
   * Client-local monotonic counter; never resets for the life of the attempt.
   * Capped well under `int4`, which is what the column is: a revision the
   * database cannot store would be a 500, and one at the very top of the
   * range would freeze the item for the rest of the exam (the upsert only
   * accepts a STRICTLY greater revision).
   */
  revision: z.number().int().min(1).max(2_000_000_000),
  clientTs: z.iso.datetime(),
});
export type AutosaveRequest = z.infer<typeof AutosaveRequest>;

export const AutosaveResponse = z.object({
  /** The revision now in the database. */
  revision: z.number().int(),
  /** Present ONLY when the write was rejected as stale: the client adopts it. */
  payload: z.unknown().optional(),
  accepted: z.boolean(),
  serverNow: z.iso.datetime(),
});
export type AutosaveResponse = z.infer<typeof AutosaveResponse>;

/** The 410 body. `reason` is what the player shows the student. */
export const AttemptClosed = z.object({
  error: z.literal("attempt_closed"),
  reason: z.enum(["deadline", "submitted", "evaluation_closed", "paused"]),
  deadlineAt: z.iso.datetime().nullable(),
  serverNow: z.iso.datetime(),
});
export type AttemptClosed = z.infer<typeof AttemptClosed>;

/**
 * `POST /attempts/:id/answers/:itemId/done`: VALIDATE the question
 * (F-LIVE-08) — "Validate and continue" in `forward_only`, crossing a
 * checkpoint in `milestones`. Irreversible where it locks.
 */
export const MarkDoneBody = z.object({ done: z.boolean() });
export type MarkDoneBody = z.infer<typeof MarkDoneBody>;

export const MarkDoneResponse = z.object({
  done: z.boolean(),
  nextItemId: z.uuid().nullable(),
  serverNow: z.iso.datetime(),
});
export type MarkDoneResponse = z.infer<typeof MarkDoneResponse>;

/**
 * `POST /attempts/:id/answers/:itemId/skip` (issue #89): "I won't answer this
 * question", or taking it back. Refused with `409 answered` on a question
 * that holds an answer: skipping is not a way to throw one away.
 */
export const SkipBody = z.object({ skipped: z.boolean() });
export type SkipBody = z.infer<typeof SkipBody>;

export const SkipResponse = z.object({ skipped: z.boolean(), serverNow: z.iso.datetime() });
export type SkipResponse = z.infer<typeof SkipResponse>;

/** `POST /attempts/:id/answers/:itemId/flag` (issue #89): the review flag. */
export const FlagBody = z.object({ flagged: z.boolean() });
export type FlagBody = z.infer<typeof FlagBody>;

export const FlagResponse = z.object({ flagged: z.boolean(), serverNow: z.iso.datetime() });
export type FlagResponse = z.infer<typeof FlagResponse>;

/**
 * What is on the student's screen (F-LIVE-06, ADR-039): an item id is the
 * question shown, `null` is no question on screen (the tab hidden, the
 * player left). The server keeps the last item as the reload bookmark and
 * measures the time each question is shown from these reports, on its own
 * clock.
 */
export const PositionBody = z.object({ itemId: z.uuid().nullable() });
export type PositionBody = z.infer<typeof PositionBody>;

export const SubmitBody = z.object({ confirm: z.literal(true) });
export type SubmitBody = z.infer<typeof SubmitBody>;

export const SubmitResponse = z.object({
  state: AttemptState,
  submittedAt: z.iso.datetime(),
  serverNow: z.iso.datetime(),
});
export type SubmitResponse = z.infer<typeof SubmitResponse>;

/**
 * `POST /attempts/:id/events`: a client-writable kind, and for those that
 * carry details exactly what the player sends — nothing a client could grow
 * the journal with. A `paste` carries its length only: never the pasted
 * text, and never `afterFocusLoss`, which the server derives (ADR-088 §4).
 */
const client = ClientEventKind.enum;
/** The longest paste a journal entry counts; a longer one is reported at this length. */
export const PASTE_MAX_LENGTH = 1_000_000;
export const AttemptEventBody = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(client.visibility),
    details: z.strictObject({ state: z.enum(["visible", "hidden"]) }),
  }),
  z.strictObject({
    kind: z.literal(client.focus),
    details: z.strictObject({ focused: z.boolean() }),
  }),
  z.strictObject({ kind: z.literal(client.reconnect) }),
  z.strictObject({
    kind: z.literal(client.paste),
    details: z.strictObject({ length: z.number().int().min(1).max(PASTE_MAX_LENGTH) }),
  }),
]);
// Every client kind has its arm: one added to `ClientEventKind` without one
// is a compile error here.
void (true satisfies [ClientEventKind] extends [AttemptEventBody["kind"]] ? true : never);
export type AttemptEventBody = z.infer<typeof AttemptEventBody>;

/**
 * The student's Run button on a `code` question. The regions are reassembled
 * into a source server-side (invariant 14); the result comes back over SSE as
 * `runner.result`, and the 202 body repeats it — that acknowledgement is
 * `RunAccepted`, declared in `./realtime.ts` next to the frame it copies.
 */
export const RunBody = z.object({
  itemId: z.uuid(),
  regions: z.array(z.string().max(20_000)).max(20),
  stdin: z.string().max(16_000).optional(),
  /**
   * The command line of a MANUAL try, one `argv[1..]` entry per element. It
   * only applies to the free-stdin trial: a visible case runs with the
   * arguments the teacher wrote, which the client never gets to change.
   */
  args: z.array(z.string().max(200)).max(32).optional(),
  /**
   * The Compile button: build the program and run NOTHING. The runner is
   * asked for `action: "check"` with no case, so the result carries the
   * compiler's verdict and an empty case list. It spends a budget of its
   * own, larger than the test runs' (`compilesPerMinute`, ADR-024 addendum).
   */
  compileOnly: z.boolean().optional(),
});
export type RunBody = z.infer<typeof RunBody>;

/**
 * The student's own run button for a question type that builds its OWN
 * request — "Simulate" on a `circuit` (ADR-019), and whatever comes after it.
 *
 * The envelope is all this schema can say: the shape of `answer` belongs to
 * the question type, and the server parses it with that type's own
 * `answerSchema` before anything else happens (`simulateAnswer` in the live
 * service). Invariant 7 is met by the two together — an envelope validated
 * here, a payload validated by the schema the type and the client share.
 *
 * The answer to `POST /app/api/attempts/:id/simulate` is the raw
 * `RunnerOutcome` of `@quiz/core`: the client half of the type reads it, and
 * no SSE frame repeats it — the response IS the delivery.
 */
export const SimulateBody = z.object({
  itemId: z.uuid(),
  answer: z.unknown(),
});
export type SimulateBody = z.infer<typeof SimulateBody>;

// --- Student home ---------------------------------------------------------

/**
 * The score of one attempt as a student may read it between two attempts
 * (F-EVAL-15, ADR-025): the validated points and nothing else — no item, no
 * verdict, no key. `pendingCount` is how many questions still wait for a
 * validated grading (the runner, a hand-graded question): they count
 * nowhere, so the points may still rise.
 */
export const AttemptScore = z.object({
  points: z.number(),
  totalPoints: z.number(),
  pendingCount: z.number().int().nonnegative(),
});
export type AttemptScore = z.infer<typeof AttemptScore>;

/**
 * The student's side of an exercise that allows several attempts (F-EVAL-15).
 * `null` on the card of any other evaluation.
 */
const CardRetakes = z.object({
  keep: RetakeKeep,
  maxAttempts: z.number().int().nullable(),
  /**
   * ADR-091: under `to_review` the card's retake opens the results page of
   * the latest attempt, where the student chooses what to redo.
   */
  scope: RetakeScope,
  /** How many attempts the student has taken, the one in progress included. */
  attemptCount: z.number().int(),
  /** The server's rule (`retakeRefusal`), evaluated now: the Retake button. */
  canRetake: z.boolean(),
  /**
   * The attempt that counts (best or last); `null` before any is finished.
   * `score` is `null` whenever the student may not read it: once the
   * exercise is closed, the feedback policy decides, exactly as on the
   * feedback page (`on_release` waits for the release, `none` never).
   */
  kept: z
    .object({
      attemptId: z.uuid(),
      attemptNumber: z.number().int(),
      score: AttemptScore.nullable(),
    })
    .nullable(),
});
type CardRetakes = z.infer<typeof CardRetakes>;

/**
 * Issue #203: what the feedback page of the attempt that counts (the kept one
 * with retakes) gives the student right now — the server's feedback policy,
 * evaluated for them. `available`: the page shows the results, and the card
 * offers "See my results". `pending`: they are still to come (not released,
 * or the exercise still takes retakes). `none`: nothing will ever be
 * published — no attempt, or the policy `none`.
 */
export const CardResults = z.enum(["available", "pending", "none"]);
export type CardResults = z.infer<typeof CardResults>;

export const EvaluationCard = z.object({
  id: z.uuid(),
  title: z.string(),
  mode: EvaluationMode,
  state: EvaluationState,
  classroomId: z.uuid(),
  classroomName: z.string(),
  courseCode: z.string(),
  opensAt: z.iso.datetime().nullable(),
  closesAt: z.iso.datetime().nullable(),
  durationS: z.number().int().nullable(),
  attemptId: z.uuid().nullable(),
  attemptState: AttemptState.nullable(),
  /**
   * When the student's attempt started (issue #126) — the LATEST one with
   * retakes (F-EVAL-15), like `attemptId`. `null` without an attempt, or for
   * one still in the lobby.
   */
  attemptStartedAt: z.iso.datetime().nullable(),
  deadlineAt: z.iso.datetime().nullable(),
  /**
   * The Swiss grade, once the results are released (WP6). `null` everywhere
   * else: an evaluation still running has no grade to show, and an unreleased
   * one must not leak the one it would have.
   */
  grade: z.number().nullable(),
  /** F-EVAL-15: set only on an exercise that allows several attempts. */
  retakes: CardRetakes.nullable(),
  /** Issue #203: what "See my results" would lead to — see {@link CardResults}. */
  results: CardResults,
  /**
   * ADR-027, ADR-051 §2: the trusted clients this exam is sat through, `seb`
   * first. Empty: the portal opens it. With `seb`, the card downloads the
   * `.seb` instead of opening; with `kiosk` only, it opens nothing and says
   * to sit it on a kiosk station.
   */
  trustedClients: z.array(TrustedClient),
  /**
   * ADR-079 §7: the conditions of an exam sat through a trusted client, read
   * before leaving the portal (the SEB launch dialog), since that client may
   * begin the attempt directly (ADR-076 §4). Set on an open card only;
   * `null` on an upcoming or past one, and without a trusted client (the
   * portal's own waiting room states them).
   */
  conditions: EvaluationConditions.nullable(),
});
export type EvaluationCard = z.infer<typeof EvaluationCard>;

/**
 * A RUNNING poll of one of the student's classrooms (issue #163, ADR-014
 * addendum 2026-09-27, item 9). What its one button needs — the code of
 * `/p/:code` — and where it comes from, nothing more: no title (a poll's is
 * its question's internal name or its statement, invariant 4), no settings,
 * no item. A classroom-less (anonymous) poll never has one.
 */
export const StudentPollCard = z.object({
  id: z.uuid(),
  code: z.string(),
  classroomId: z.uuid(),
  classroomName: z.string(),
  courseCode: z.string(),
});
export type StudentPollCard = z.infer<typeof StudentPollCard>;

// --- Teacher side ---------------------------------------------------------

export const DashboardCell = z.object({
  itemId: z.uuid(),
  status: CellStatus,
  /**
   * The verdict the grid colours the cell with (F-DASH-01). It is the
   * standing grading's when there is one, and otherwise — only when the
   * dashboard was asked with `?results=1` — the verdict this answer WOULD get
   * if the evaluation closed now, for the deterministic types (ADR-020).
   * `provisional` says which of the two it is.
   */
  verdict: Verdict.nullable(),
  /**
   * The verdict is a live preview, computed from the answer as it stands and
   * written nowhere. A validated or proposed grading is never provisional.
   */
  provisional: z.boolean(),
  points: z.number().nullable(),
  revision: z.number().int(),
  /** Only when `?includeAnswers=1` (F-DASH-02). */
  summary: z.string().nullable(),
  /**
   * The student flagged the question for review (issue #89). Staff only, like
   * the whole grid: a question many students flag may be unclear.
   */
  flagged: z.boolean(),
});
export type DashboardCell = z.infer<typeof DashboardCell>;

/**
 * How a student sits the exam (ADR-051 §8), from their live confined session:
 * `portal` when there is none, `seb`, or `kiosk` with the station's label.
 * `alert`: the station's attestation suspends the sitting (refused, silent)
 * or cannot be checked (Google unavailable); null otherwise, and always null
 * off a station. Staff only, like the whole dashboard.
 */
export const DashboardAccess = z.object({
  kind: z.enum(["portal", ...TRUSTED_CLIENTS]),
  station: z.string().nullable(),
  alert: z.enum(["suspended", "unavailable"]).nullable(),
});
export type DashboardAccess = z.infer<typeof DashboardAccess>;

export const DashboardRow = z.object({
  attemptId: z.uuid().nullable(),
  /** The roster entry behind the row: the one key every row has. */
  seatId: z.uuid(),
  /**
   * `null` for a roster entry nobody has claimed yet — a student imported
   * from a list who has never signed in. The row is shown all the same: the
   * class is who is on the roster, not who happens to have an account.
   */
  userId: z.uuid().nullable(),
  displayName: z.string(),
  /**
   * The row belongs to a STAFF seat: a teacher walking their own quiz as a
   * student (ADR-018). It is shown — that is the point of the walk — and it
   * counts in no total: not in the completion of a question, not in its
   * success rate, not in the class statistics.
   */
  staff: z.boolean(),
  /** Stable per-row pseudonym when names are hidden (F-DASH-02, decision D20). */
  pseudonym: z.string(),
  state: AttemptState,
  online: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
  deadlineAt: z.iso.datetime().nullable(),
  timeBonusPercent: z.number().int(),
  /**
   * How many attempts the student has taken (F-EVAL-15). The row always
   * shows the LATEST one; the grading panel reaches every other.
   */
  attemptCount: z.number().int(),
  points: z.number().nullable(),
  maxPoints: z.number(),
  cells: z.array(DashboardCell),
  access: DashboardAccess,
  /**
   * How many integrity incidents the row's attempt has (ADR-088 §7): the
   * badge's count. Derived on each read, so it follows the grid's refetch,
   * not its frames.
   */
  incidents: z.number().int().nonnegative(),
});
export type DashboardRow = z.infer<typeof DashboardRow>;

export const DashboardView = z.object({
  evaluation: z.object({
    id: z.uuid(),
    state: EvaluationState,
    startedAt: z.iso.datetime().nullable(),
    pausedAt: z.iso.datetime().nullable(),
    closesAt: z.iso.datetime().nullable(),
    serverNow: z.iso.datetime(),
    /**
     * Whether a finished attempt may be reopened (the server's
     * `reopenRefusal`): not on an exercise with several attempts, where the
     * student starts a new one instead (F-EVAL-15, ADR-025), nor on one whose
     * correction is published (ADR-050). The grid offers Reopen only then.
     */
    reopenable: z.boolean(),
    /**
     * Whether the evaluation keeps the integrity journal (ADR-088 §2: its
     * `logVisibility`, never a poll). Off, the grid offers no journal list.
     */
    journalOn: z.boolean(),
  }),
  items: z.array(StaffItemRef.extend({ milestone: z.boolean() })),
  rows: z.array(DashboardRow),
  totals: z.array(
    z.object({
      itemId: z.uuid(),
      completion: z.number(),
      /**
       * F-DASH-04. The mean of `points / maxPoints` over the CLASS (a staff
       * test counts in nothing, ADR-018). It is the validated gradings' rate
       * once the evaluation has been graded, and, with `?results=1` before
       * that, the live rate over the answers that can be graded now — which
       * `provisional` flags, so the grid never passes a preview off as a
       * result.
       */
      successRate: z.number().nullable(),
      provisional: z.boolean(),
    }),
  ),
});
export type DashboardView = z.infer<typeof DashboardView>;

/** `?includeAnswers=1`, `?results=1`: the teacher's two toggles, on the wire. */
const flag = z
  .union([z.string(), z.boolean()])
  .default(false)
  .transform((v) => v === true || v === "1" || v === "true");

export const DashboardQuery = z.object({
  includeAnswers: flag,
  /**
   * The "Results" toggle (F-DASH-02). It is a REQUEST flag and not only a
   * display one: the live verdicts of ADR-020 are computed per cell, so they
   * are computed only for the teacher who is looking at them.
   */
  results: flag,
});
export type DashboardQuery = z.infer<typeof DashboardQuery>;

/**
 * `DELETE /evaluations/:id/attempt` — a teacher throws away their OWN staff
 * test attempt so they can walk the quiz again (ADR-018). `deleted` is false
 * when there was nothing to remove, which is a success and not a 404.
 */
export const ResetAttemptResponse = z.object({ deleted: z.boolean() });
export type ResetAttemptResponse = z.infer<typeof ResetAttemptResponse>;

export const StartBody = z.object({ confirm: z.literal(true) });
export type StartBody = z.infer<typeof StartBody>;

/** F-LIVE-11: +1, +5 or +10 minutes, to everybody or to one student. */
export const ExtendBody = z
  .object({
    minutes: z.union([z.literal(1), z.literal(5), z.literal(10)]),
    scope: z.enum(["all", "attempt"]).default("all"),
    attemptId: z.uuid().optional(),
  })
  .refine((b) => b.scope === "all" || b.attemptId !== undefined, {
    message: "attemptId is required when scope is 'attempt'",
  });
export type ExtendBody = z.infer<typeof ExtendBody>;

export const ExtendResponse = z.object({
  updated: z.number().int(),
  serverNow: z.iso.datetime(),
});
export type ExtendResponse = z.infer<typeof ExtendResponse>;

/** `/evaluations/:id/attempts/:attemptId` */
export const AttemptParam = z.object({ id: z.uuid(), attemptId: z.uuid() });
export type AttemptParam = z.infer<typeof AttemptParam>;

/** `/attempts/:id/answers/:itemId` */
export const AnswerParam = z.object({ id: z.uuid(), itemId: z.uuid() });
export type AnswerParam = z.infer<typeof AnswerParam>;

/** F-DASH-05: one cell opened in read mode. */
export const AttemptInspect = z.object({
  attempt: z.object({
    id: z.uuid(),
    userId: z.uuid(),
    displayName: z.string(),
    pseudonym: z.string(),
    state: AttemptState,
    startedAt: z.iso.datetime().nullable(),
    deadlineAt: z.iso.datetime().nullable(),
    submittedAt: z.iso.datetime().nullable(),
  }),
  items: z.array(
    z.object({
      item: StaffItemRef,
      studentConfig: z.unknown(),
      answer: z.unknown().nullable(),
      revision: z.number().int(),
      markedDone: z.boolean(),
      skipped: z.boolean(),
      flagged: z.boolean(),
      solution: z.unknown(),
    }),
  ),
  events: z.array(
    z.object({
      kind: AttemptEventKind,
      at: z.iso.datetime(),
      details: z.unknown().nullable(),
    }),
  ),
  /** The integrity journal read as incidents (ADR-088 §7), in time order. */
  incidents: z.array(IntegrityIncident),
  serverNow: z.iso.datetime(),
});
export type AttemptInspect = z.infer<typeof AttemptInspect>;

/**
 * `GET /evaluations/:id/items/:itemId/answers` (F-DASH-07): one question of
 * the live grid opened for the whole class — every student's answer to it,
 * on the attempt the grid shows (the latest, F-EVAL-15), staff only.
 *
 * No name travels: the dashboard joins each answer to its row by
 * `attemptId` and names it as the grid does (F-DASH-02), so the screen's
 * "names hidden" holds without the server having to know about it.
 * `studentConfig` and `solution` are per attempt, like the inspector's:
 * a parameterized question draws one instance per student (ADR-056).
 */
export const ItemAnswers = z.object({
  item: AttemptInspect.shape.items.element.shape.item,
  answers: z.array(
    z.object({
      attemptId: z.uuid(),
      studentConfig: z.unknown(),
      answer: z.unknown().nullable(),
      revision: z.number().int(),
      skipped: z.boolean(),
      flagged: z.boolean(),
      solution: z.unknown(),
    }),
  ),
  serverNow: z.iso.datetime(),
});
export type ItemAnswers = z.infer<typeof ItemAnswers>;
