/**
 * The question-type contract (PLAN-MVP §1.2 and §1.3).
 *
 * Adding a question type means implementing {@link QuestionTypeServer} here and
 * {@link QuestionTypeClient} in `./client`, then registering both in
 * `packages/registry`. `packages/core` must never import a `qt-*` package
 * (decision D1).
 */
import type { z } from "zod";
import type { LlmGradeRequest, LlmService } from "./llm.js";
import type { RunnerOutcome, RunnerRequest, RunnerService } from "./runner.js";

/**
 * How many characters of `summarizeAnswer` a dashboard cell can hold.
 *
 * Measured, not picked: a question column of the live grid is 64 px wide and
 * the cell keeps an icon beside the text, which leaves about two dozen
 * characters at 12 px before the truncation makes the preview useless. The
 * types aim under it; the caller enforces it.
 */
export const ANSWER_SUMMARY_MAX = 24;

/**
 * The four types of the MVP (PLAN-MVP §0), plus `circuit` — the two-port
 * schematic of docs/spec/04 §4.11, brought forward from phase 3 with a
 * simulation path (`packages/qt-circuit`) — and `codeimage`, the variant of
 * `code` judged by the picture its program prints (§4.9, ADR-021), which
 * lives inside `packages/qt-code`, and `rich` — the essay of §4.8, graded
 * by hand in v1 (`packages/qt-rich`, issue #192), and `categorize` — cards
 * sorted into columns, §4.13 (`packages/qt-categorize`, ADR-036), and
 * `diagram` — a diagram of a chosen notation, graded by hand in v1, §4.14
 * (`packages/qt-diagram`, ADR-046).
 */
export const QUESTION_TYPE_IDS = [
  "mcq",
  "short",
  "cloze",
  "code",
  "circuit",
  "codeimage",
  "rich",
  "categorize",
  "diagram",
] as const;
export type QuestionTypeId = (typeof QUESTION_TYPE_IDS)[number];

// ---------------------------------------------------------------------------
// GradeResult
// ---------------------------------------------------------------------------

/** Points are on the item scale already (0 … maxPoints), rounded to 2 decimals. */
export interface GradedResult<D = unknown> {
  kind: "graded";
  points: number;
  maxPoints: number;
  /** Type-specific breakdown, stored verbatim in `gradings.details`. */
  details: D;
  /** Grading born validated (deterministic) or proposed (needs teacher eyes). */
  state?: "validated" | "proposed";
  /** Optional machine comment shown to the teacher, e.g. "runner unavailable". */
  comment?: string;
}

export interface PendingRunnerResult {
  kind: "pending";
  via: "runner";
  /** Fully assembled, server-side. Never contains student-supplied file names. */
  request: RunnerRequest;
  /** Partial details already known (e.g. assembled source hash). */
  details?: unknown;
}

export interface PendingLlmResult {
  kind: "pending";
  via: "llm";
  /**
   * Handed to `app.llm` by the grading pass; with no service configured the
   * pass writes a proposal with reason `llm_not_configured` instead.
   */
  request: LlmGradeRequest;
  /** The type's own details, stored beside the model's points (as a runner result's). */
  details?: unknown;
}

export type GradeResult<D = unknown> = GradedResult<D> | PendingRunnerResult | PendingLlmResult;

export const isGraded = <D>(r: GradeResult<D>): r is GradedResult<D> => r.kind === "graded";

export const isPendingRunner = <D>(r: GradeResult<D>): r is PendingRunnerResult =>
  r.kind === "pending" && r.via === "runner";

export const isPendingLlm = <D>(r: GradeResult<D>): r is PendingLlmResult =>
  r.kind === "pending" && r.via === "llm";

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/** What the student is allowed to see right now. */
export interface StudentView {
  /** Attempt seed; 0 for the teacher preview (stable preview). */
  seed: number;
  itemId: string;
  /** Evaluation-level shuffle switch AND question-level shuffleable flag, ANDed by the caller. */
  shuffle: boolean;
  /**
   * The same per-type settings of the evaluation as `GradeContext.defaults`,
   * when the view is built for one. A type may publish the part of its entry
   * a student must know BEFORE answering — `mcq` tells whether wrong answers
   * cost points (ADR-026) — and never the rest. Absent: no evaluation.
   */
  defaults?: Readonly<Record<string, unknown>>;
}

/**
 * The FLOOR of the forbidden-key blacklists of invariant 4 (docs/05 §5.7).
 *
 * Every leak test — the registry's contract test over each type's full
 * fixture (`@quiz/core/testing`, `findStudentLeaks`), the per-type
 * `toStudent.test.ts` and the API's `studentView.leak.test.ts` — starts from
 * this list and adds its own extras.
 * Before it existed, six hand-maintained lists disagreed with one another in
 * both directions, so a key one type thought about was missed by the next
 * (audit 2026-09-22, finding P-06).
 *
 * The rule for a member: the key names the ANSWER KEY or the teacher's own
 * metadata, in every type, so no `toStudent` may ever publish it. A key one
 * type legitimately publishes therefore stays out of the floor and is checked
 * per type instead — `mode` is a member of `McqStudent`, and `code` publishes
 * the `expected` output of its VISIBLE cases on purpose (docs/04 §4.7,
 * deviation W3-4). Adding a key here makes every list stricter at once: if a
 * type's leak test goes red because of it, that type has a leak.
 *
 * This list only grows — with one recorded exception. `compare` was a member
 * (added with the floor, #27) and left it for audit R-06: `code` publishes
 * its comparison options on purpose, because they say HOW an output is
 * compared (trailing whitespace, case, a numeric tolerance), never WHAT the
 * answer is, and without them the player judged a visible case by a
 * different rule than the grade. The other four types keep `compare`
 * forbidden in their own leak tests; `code`'s test pins the exact shape.
 */
export const COMMON_FORBIDDEN_STUDENT_KEYS: readonly string[] = [
  "answers",
  "changeNote",
  "compileArgs",
  "correct",
  "deprecationNote",
  "difficulty",
  "explanation",
  "internalName",
  "matchers",
  "pattern",
  "penalty",
  "referenceSolution",
  "rubric",
  "tags",
];

export interface GradeContext {
  seed: number;
  itemId: string;
  attemptId: string;
  /** `evaluation_items.points` — the scale the grader must produce points on. */
  itemPoints: number;
  now: Date;
  /** Always present; may be the unavailable stub (throws `RunnerUnavailable`). */
  runner: RunnerService;
  /**
   * The LLM grading service, when the process has one (`LLM_PROVIDER`; only
   * the development stub exists yet). A type that can grade without it — the
   * essay, by hand — returns `pending: "llm"` only when it is present.
   */
  llm?: LlmService;
  /**
   * Per-type settings of the EVALUATION being graded, keyed by type id — what
   * a config that says "inherit" defers to (an mcq's scoring policy). The
   * core does not know their shape: each type reads and parses its own entry
   * and falls back to its built-in default when it is absent.
   */
  defaults?: Readonly<Record<string, unknown>>;
}

/** The context of the second half of a runner grading: no service is reachable from there. */
export type FinalizeContext = Omit<GradeContext, "runner" | "llm">;

/**
 * What the feedback policy allows inside a grading `details` payload.
 *
 * It is the subset of `FeedbackPolicy` (`@quiz/contracts`) a question type
 * needs to redact its own breakdown; `packages/core` does not import the
 * contracts, and a type never sees the rest of the policy.
 */
export interface StudentDetailsPolicy {
  /** The teacher publishes the answer key: the details may travel whole. */
  showKey: boolean;
  /** docs/06 Q8: the names of a `code` question's hidden cases. */
  showHiddenCaseNames: boolean;
}

/**
 * One answer group of {@link ItemAggregate.distribution}: the answers that
 * share a key, and what the class debrief needs to draw them (F-RES-03).
 */
export interface TallyEntry {
  /**
   * What groups the answers, unique within the item: a canonical choice
   * index, `"1: Galilee"` for a blank, the text of a short answer.
   */
  key: string;
  count: number;
  /** What the teacher reads, when it is not the key itself: a blank's text without its index. */
  label?: string;
  /** The part of the question the key answers: a cloze blank's index. */
  part?: number;
  /**
   * The type's own verdict on the key, when it can judge the key alone — a
   * choice is in the key or not, a blank was right or wrong. Absent, the
   * caller takes the validated grading of the attempt the key came from
   * (ADR-033).
   */
  correct?: boolean;
}

/**
 * What {@link QuestionTypeServer.aggregate} hands the class debrief of one
 * item (F-RES-03). Both fields are optional: a type fills the statistics that
 * mean something for it and leaves the rest out.
 */
export interface ItemAggregate {
  /**
   * How often each answer was given, in the order the keys were first met.
   * The caller sorts and merges.
   */
  distribution?: readonly TallyEntry[];
  /**
   * How many graded attempts passed each named test case. `label` is the
   * name the class may read (a hidden case under a policy that closes the
   * names reads as a student reads it); absent, it is `name`.
   */
  casePassRate?: ReadonlyArray<{ name: string; label?: string; passed: number; total: number }>;
}

/**
 * The entries of {@link ItemAggregate.distribution}: every key counted, in
 * first-seen order, a key's label, part and verdict as first seen.
 */
export function tallyKeys(keys: Iterable<string | Omit<TallyEntry, "count">>): TallyEntry[] {
  const counts = new Map<string, TallyEntry>();
  for (const given of keys) {
    const entry = typeof given === "string" ? { key: given } : given;
    const seen = counts.get(entry.key);
    if (seen) seen.count += 1;
    else counts.set(entry.key, { ...entry, count: 1 });
  }
  return [...counts.values()];
}

/**
 * One problem {@link QuestionTypeServer.publicationIssues} found: a zod-like
 * path into the config and a translatable message key.
 */
export interface PublicationIssue {
  path: (string | number)[];
  message: string;
}

// ---------------------------------------------------------------------------
// QuestionTypeServer
// ---------------------------------------------------------------------------

export interface QuestionTypeServer<
  TConfig = unknown,
  TAnswer = unknown,
  TStudent = unknown,
  TSolution = unknown,
  TDetails = unknown,
> {
  readonly id: QuestionTypeId;
  /** Bumped when `configSchema` changes shape; stored in `question_versions.config_version`. */
  readonly configVersion: number;

  readonly configSchema: z.ZodType<TConfig>;
  /**
   * `configSchema` with the answer key made OPTIONAL, and nothing else
   * relaxed: the configuration of an opinion poll, which asks the room
   * without anything being right (ADR-014, addendum 2026-09-23).
   *
   * Only the poll launcher writes through it (`saveConfig(…, { keyOptional:
   * true })`); a pool question and every evaluation keep `configSchema`, the
   * gate that demands a key. A type that omits it has no keyless form.
   */
  readonly keylessConfigSchema?: z.ZodType<TConfig>;
  readonly answerSchema: z.ZodType<TAnswer>;
  readonly studentSchema: z.ZodType<TStudent>;
  readonly solutionSchema: z.ZodType<TSolution>;
  readonly detailsSchema: z.ZodType<TDetails>;

  /**
   * Config of a freshly created draft: the shape of `configSchema` with its
   * defaults, and EMPTY content — an empty prompt, empty choices, an empty
   * matcher. It therefore does NOT have to satisfy `configSchema`.
   *
   * Decision D16 is what makes that safe: a draft is stored whatever it
   * holds, and publication is the gate that parses. Pre-filling a new
   * question with placeholder text instead would hand the teacher content
   * to delete before writing their own, and a question that looks authored
   * when nothing has been written yet.
   */
  emptyDraft(): TConfig;

  /**
   * What PUBLICATION requires beyond `configSchema` (decision D16).
   *
   * `configSchema` is the gate of USE: a config that passes it can be
   * previewed, tried, graded and rendered. Some requirements only matter to
   * a question handed to students, and enforcing them in the schema would
   * forbid the very step that fulfils them — a `codeimage` draft has no
   * target until its reference is TRIED, and `POST /questions/:id/try`
   * parses with `configSchema`. Those checks live here: the API runs them
   * on publication (refusing with the same issues as a failed parse) and
   * reports them with the draft's own issues, never on a read.
   *
   * `config` has passed `configSchema`. An empty list, or no hook, means
   * "publishable". The message is a key the editor translates
   * (`codeimage.target_missing`), exactly like a schema message.
   */
  publicationIssues?(config: TConfig): PublicationIssue[];

  /**
   * Parameterized questions (ADR-056): what a TEMPLATE may not do even
   * though each of its instances is publishable — a `short` whose text key
   * is computed (`[[…]]` in an `exact` value), which string equality could
   * never match once formatted (§10). Called at publication on the
   * template of a question that declares variables, as RAW json (a template
   * need not satisfy the schema: its instances do). Omitting it means
   * "nothing more".
   */
  parameterIssues?(template: unknown): PublicationIssue[];

  /**
   * The texts that must stay distinct in every instance of a parameterized
   * question (ADR-056 §7): `mcq`'s choices. A draw whose texts render equal,
   * or numerically within 1 %, is drawn again. `config` is an instance, as
   * raw json at the type's current shape. Omitting it means no such rule.
   */
  distinctTexts?(config: unknown): string[];

  /** Raise an old stored config to `configVersion`. Pure, total, never throws on a config it emitted before. */
  migrate(config: unknown, fromVersion: number): TConfig;

  /** F-EVAL-02 default item points. */
  defaultPoints(config: TConfig): number;

  /** Whether shuffling is meaningful for this config (mcq with `shuffleChoices`, cloze with selects). */
  shuffleable(config: TConfig): boolean;

  /**
   * THE single content exit toward a student (docs/05 §5.7).
   * Must never return the answer key, explanation, hidden test bodies, matchers,
   * regexes, tolerances, internal name, tags or difficulty. Pure and tested by
   * key-blacklist + key-value search on the serialized output.
   */
  toStudent(config: TConfig, view: StudentView): TStudent;

  /**
   * Key + rationale, whole: what the TEACHER surfaces show (grading panel,
   * dashboard inspector, results by question, the editor's try). A student
   * gets it only when the feedback policy shows the key, and then through
   * {@link studentSolution}, never as-is.
   */
  toSolution(config: TConfig, view: StudentView): TSolution;

  /**
   * The part of the solution a STUDENT may read once the key is shown
   * (docs/05 §5.7, ADR-037). Some material in a solution is the teacher's
   * alone whatever the policy says — the grading criteria of an essay, the
   * rubric of a short answer's `llm` matcher — and this hook is where it
   * comes back out. `solution` is what {@link toSolution} returned for
   * `config`; the result is served as the student's key, `null` meaning
   * "nothing left to show". Pure. Omitting it means the whole solution is
   * fit for a student.
   */
  studentSolution?(solution: TSolution, config: TConfig): TSolution | null;

  /**
   * Whether this config holds an answer key at all. Only a config accepted
   * by {@link keylessConfigSchema} can say no; omitting the hook means
   * "always". A config without a key is not graded: the grading pass skips
   * its item rather than mark every answer wrong.
   */
  hasKey?(config: TConfig): boolean;

  /**
   * The grading breakdown as a STUDENT may read it (docs/05 §5.7).
   *
   * `details` is written by `grade` for the teacher, so it holds whatever the
   * type needs to justify a score — the correct choices, the expected blanks,
   * a hidden test's output. This hook is where the answer key comes back out
   * of it when `policy.showKey` is false. Omitting it means "the breakdown
   * holds no key"; the `results` module strips the forbidden keys either way.
   */
  studentDetails?(details: TDetails, policy: StudentDetailsPolicy): unknown;

  /**
   * One cell of the live dashboard: what the student answered, in a glyph or
   * two (F-DASH-02).
   *
   * The grid puts this INSIDE the cell, beside the status icon, so it has
   * room for about {@link ANSWER_SUMMARY_MAX} characters and the teacher
   * reads thirty of them at once, from the back of a lecture hall. "A, C",
   * "42", "int · malloc" — never a sentence, never JSON. It is a preview and
   * never a grading: it says nothing about whether the answer is right.
   *
   * `answer` has already been parsed by {@link answerSchema}; the caller
   * handles "not answered" and truncates whatever comes back, so an
   * implementation may stay naive about length. Omitting the hook leaves the
   * caller its own generic fallback.
   */
  summarizeAnswer?(config: TConfig, answer: TAnswer): string;

  /**
   * Whether this answer holds SOMETHING (F-LIVE-08, issue #89): a question
   * counts as answered as soon as it does, with no click. The server reads it
   * to build the dashboard's progress and to clear an "I won't answer" when
   * an answer is written; the client registry carries the same predicate
   * (`QuestionTypeClient.isAnswered`) for the student's question list, and a
   * package implements both from ONE function so the two never disagree.
   *
   * It never says whether the answer is right, and reads nothing of the key.
   * `answer` has already been parsed by {@link answerSchema}.
   */
  isAnswered(answer: TAnswer): boolean;

  /**
   * The shape rules of an answer that depend on the CONFIG, which
   * `answerSchema` cannot see: `null` when the answer fits the question, or
   * the reason it does not (an `mcq` in `single` mode answered with several
   * choices). The answer write refuses a misfit with `422 answer_invalid`;
   * the grader still defends itself. Omitting the hook means "always fits".
   */
  answerMisfit?(config: TConfig, answer: TAnswer): string | null;

  /**
   * The per-type statistics of one item over the class (F-RES-03, audit
   * B-15): the answer distribution, a test-case pass rate.
   *
   * `answers` are the stored payloads of the class's answers to the item and
   * `details` the `details` of their validated gradings, both RAW — they are
   * not re-parsed, because a payload stored under an older schema must still
   * be counted, so an implementation skips what it does not recognise.
   * `answers[i]` and `details[i]` belong to the same attempt: the results
   * module calls the hook once per attempt and merges (ADR-033). The
   * result is teacher-facing only. Omitting the hook means "no per-type
   * statistics": the item shows its success rate and nothing more.
   */
  aggregate?(input: {
    answers: readonly unknown[];
    details: readonly unknown[];
    /** The evaluation's feedback policy on hidden case names; absent, closed. */
    showHiddenCaseNames?: boolean;
  }): ItemAggregate;

  /** `answer === null` means "not answered": graders must return 0 points (F-GRADE-01). */
  grade(
    config: TConfig,
    answer: TAnswer | null,
    ctx: GradeContext,
  ): GradeResult<TDetails> | Promise<GradeResult<TDetails>>;

  /**
   * The request behind the student's OWN button — "Run" for `code`,
   * "Simulate" for `circuit` — assembled server-side from the stored config
   * and the student's answer (invariant 14), and holding only what the
   * student may already see: the visible cases, never a hidden one, never the
   * reference solution's output unless the config publishes it. `null` when
   * there is nothing to run for this answer (an empty schematic).
   *
   * `POST /attempts/:id/simulate` runs it with `priority: "interactive"` and
   * hands the `RunnerOutcome` back untouched; the client half of the type
   * reads it. `POST /attempts/:id/run` takes its cases from it too, so which
   * case is visible is the type's to say, never guessed from a case name.
   * A type without this hook has no interactive run of its own.
   */
  interactiveRequest?(
    config: TConfig,
    answer: TAnswer,
    ctx: FinalizeContext,
  ): RunnerRequest | null;

  /** Second half of a `pending: runner` grading. Pure, so it is unit-testable without a runner. */
  finalizeRunner?(
    config: TConfig,
    answer: TAnswer | null,
    ctx: FinalizeContext,
    outcome: RunnerOutcome,
  ): GradedResult<TDetails>;

  /** Text fed to the tsvector of `question_versions.search`. */
  searchText(config: TConfig): string;

  /** Canonical YAML mapping; identity when omitted. */
  toCanonical?(config: TConfig): unknown;
  /** Back from the canonical mapping; `configSchema.parse` when omitted (`fromCanonicalOf`). */
  fromCanonical?(raw: unknown): TConfig;
}
