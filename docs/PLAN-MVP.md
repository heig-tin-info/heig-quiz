# PLAN-MVP — Phase 1 implementation plan

Authored by the planning agent on 2026-09-20 from `docs/spec/*`, reviewed by the supervising session.

**Supervisor overrides (binding):**

- **D18 rejected.** The SPA API stays under `/app/api/*` (heig-classroom routing, Vite proxy on `/app`, session cookies). The bearer-token `/api/v1` surface is later work and will alias the same handlers.
- Section 3 must be reconciled with what the bootstrap already created in `apps/api/src/db/schema.ts` (`courses`, `course_staff`, `classrooms`, `enrollments` exist). Add tables in a new migration; never edit `0000_init.sql`.
- `RUNNER_MODE=stub` is the default everywhere until a machine with Podman exists.

Sources read in full: `docs/01`, `02`, `04`, `05`, `08`; skimmed `00`, `03`, `06`, `07`; mockup headers + DOM structure of
`01`–`10`; heig-classroom `ui.tsx`, `contracts/`, `db/schema.ts`, `events.ts`, `modules/events.ts`, `modules/guards.ts`,
`ticker.ts`, `jobs.ts`, `api.ts`, `router.ts`, `live.ts`, `domain/`.

Everything in code and comments is **English**; only UI strings are translated (`fr`/`en`).
Package scope: `@quiz/*`. Node 22, TS strict, ESM, `.js` import suffixes (heig-classroom convention).

---

## 0. MVP scope lock

In (docs/00 §0.5 Phase 1, M only unless noted):

| Area | In MVP |
|---|---|
| Auth | edu-ID OIDC, roles student/teacher/admin — **inherited from heig-classroom, not re-implemented** |
| Org | courses, course_staff, course_pools, classrooms, roster CSV, join code (S), time bonus |
| Pool | private pools, categories, tags, draft→publish versions, search, soft delete, copy (S) |
| Types | `mcq`, `short`, `cloze`, `code` only |
| Evaluation | mode `exam` + `exercise`; `poll` is **P2, out** |
| Live | lobby, running/paused, autosave, SSE, server clock, +1/+5/+10, close |
| Grading | auto for the 4 types, manual override, regrade, release |
| Results | Swiss 1..6 at 0.1, CSV export, per-question view, student feedback |
| Dashboard | student × question grid, name/answer/result toggles |
| Admin | user list + role promotion, runner health, audit log |

Out of MVP, explicitly: LLM (all of F-LLM, `rich` type, `llm` matcher), drill, stats/item analysis, poll mode,
projection view, guest participants, canonical YAML export (S — WP is defined but last), GIFT import, CLI, MCP,
command palette (S — thin version only), Tiptap WYSIWYG (see §6.7), random variables (`{{R1}}`), `tap` test mode,
multi-attempt exercises, shared/public pools, api_tokens.

---

## 1. `packages/core` — the question-type contract

```
packages/core/
  package.json          exports: "." (contract + utils, no React), "./client" (React-typed props)
  src/index.ts          re-export of everything server-safe
  src/contract.ts       QuestionTypeServer, GradeResult, GradeContext, StudentView
  src/client.ts         QuestionTypeClient, EditorProps, PlayerProps, ReviewProps (imports `react` types only)
  src/registry.ts       defineServerRegistry / defineClientRegistry + lookup helpers
  src/rng.ts            seeded RNG: hashSeed, mulberry32, shuffle, pick
  src/errors.ts         UnknownQuestionType, ConfigMigrationError, RunnerUnavailable
  src/runner.ts         RunnerService interface + RunnerRequest/RunnerOutcome zod schemas
  src/*.test.ts
```

`packages/core` **must not** import any `qt-*` package (cycle). The static wiring lives in a separate
`packages/registry` (`./server` and `./client` entry points) that depends on core + the four qt packages.
See open decision D1.

### 1.1 Seeded RNG (`src/rng.ts`)

Chosen: **xmur3 string hash → mulberry32**. 30 lines, no dependency, deterministic across Node and browsers,
uniform enough for shuffling ≤ 12 items. `attempts.seed` is a random `int4` (0 … 2^31-1) drawn at attempt creation.

```ts
/** 32-bit string hash (xmur3), used to derive one stream per purpose. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 1779033703 ^ parts.join("\u0001").length;
  const s = parts.join("\u0001");
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 PRNG: returns a [0,1) generator. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, pure: returns a new array. Same seed ⇒ same permutation, forever. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The one and only seed derivation used by the platform. */
export function streamSeed(attemptSeed: number, itemId: string, purpose: string): number {
  return hashSeed(attemptSeed, itemId, purpose);
}
```

Purposes in use: `"items"` (question order, seeded on `attemptSeed + evaluationId`), `"choices"` (mcq),
`"options:<blankIndex>"` (cloze selects). **Rule: a permutation is never stored, always recomputed from
`(attempt.seed, item.id, purpose)`.** This makes reload, teacher preview and regrade identical.

### 1.2 `GradeResult` union

```ts
/** Points are on the item scale already (0 … maxPoints), rounded to 2 decimals. */
export interface GradedResult<D = unknown> {
  kind: "graded";
  points: number;
  maxPoints: number;
  /** Type-specific breakdown, stored verbatim in gradings.details. */
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
  /** Phase 2. The MVP grading worker rejects this with `llm_unavailable`. */
  request: LlmGradeRequest;
}

export type GradeResult<D = unknown> = GradedResult<D> | PendingRunnerResult | PendingLlmResult;

export const isGraded = <D>(r: GradeResult<D>): r is GradedResult<D> => r.kind === "graded";
```

### 1.3 `QuestionTypeServer`

```ts
export type QuestionTypeId = "mcq" | "short" | "cloze" | "code";

/** What the student is allowed to see right now. */
export interface StudentView {
  /** Attempt seed; 0 for the teacher preview (stable preview). */
  seed: number;
  itemId: string;
  /** Evaluation-level shuffle switch AND question-level shuffleable flag, ANDed by the caller. */
  shuffle: boolean;
}

export interface GradeContext {
  seed: number;
  itemId: string;
  attemptId: string;
  /** evaluation_items.points — the scale the grader must produce points on. */
  itemPoints: number;
  now: Date;
  /** Always present; may be the unavailable stub (throws RunnerUnavailable). */
  runner: RunnerService;
  /** Phase 2; undefined in MVP. */
  llm?: LlmService;
}

export interface QuestionTypeServer<
  TConfig = unknown,
  TAnswer = unknown,
  TStudent = unknown,
  TSolution = unknown,
  TDetails = unknown,
> {
  readonly id: QuestionTypeId;
  /** Bumped when configSchema changes shape; stored in question_versions.config_version. */
  readonly configVersion: number;

  readonly configSchema: z.ZodType<TConfig>;
  readonly answerSchema: z.ZodType<TAnswer>;
  readonly studentSchema: z.ZodType<TStudent>;
  readonly solutionSchema: z.ZodType<TSolution>;
  readonly detailsSchema: z.ZodType<TDetails>;

  /** Config of a freshly created draft, valid against configSchema. */
  emptyDraft(): TConfig;

  /** Raise an old stored config to configVersion. Pure, total, never throws on a config it emitted before. */
  migrate(config: unknown, fromVersion: number): TConfig;

  /** F-EVAL-02 default item points. */
  defaultPoints(config: TConfig): number;

  /** Whether shuffling is meaningful for this config (mcq with shuffleChoices, cloze with selects). */
  shuffleable(config: TConfig): boolean;

  /**
   * THE single content exit toward a student (docs/05 §5.7).
   * Must never return the answer key, explanation, hidden test bodies, matchers,
   * regexes, tolerances, internal name, tags or difficulty. Pure and tested by
   * key-blacklist + key-value search on the serialized output.
   */
  toStudent(config: TConfig, view: StudentView): TStudent;

  /** Key + rationale for review, served ONLY when the feedback policy allows it. */
  toSolution(config: TConfig, view: StudentView): TSolution;

  /** Phase 2 random values; absent in MVP packages. */
  randomize?(config: TConfig, seed: number): TConfig;

  /** `answer === null` means "not answered": graders must return 0 points (F-GRADE-01). */
  grade(config: TConfig, answer: TAnswer | null, ctx: GradeContext): GradeResult<TDetails> | Promise<GradeResult<TDetails>>;

  /** Second half of a `pending: runner` grading. Pure, so it is unit-testable without a runner. */
  finalizeRunner?(
    config: TConfig,
    answer: TAnswer | null,
    ctx: Omit<GradeContext, "runner" | "llm">,
    outcome: RunnerOutcome,
  ): GradedResult<TDetails>;

  /** Text fed to the tsvector of question_versions.search. */
  searchText(config: TConfig): string;

  /** Canonical YAML mapping; identity when omitted. */
  toCanonical?(config: TConfig): unknown;
  fromCanonical?(raw: unknown): TConfig;
}
```

### 1.4 `QuestionTypeClient` (`@quiz/core/client`)

```ts
export interface EditorProps<TConfig> {
  config: TConfig;
  /** Partial patch; the host merges, validates lazily and autosaves the draft. */
  onChange: (next: TConfig) => void;
  /** Uploads an image and returns `asset:<uuid>` for the markdown. */
  uploadAsset: (file: File) => Promise<string>;
  disabled?: boolean;
}

export interface PlayerProps<TStudent, TAnswer> {
  student: TStudent;
  answer: TAnswer | null;
  onChange: (next: TAnswer) => void;
  /** Read-only when the attempt is submitted / paused / expired. */
  readOnly: boolean;
  /** Code type only: interactive run through POST /attempts/:id/run. */
  run?: (payload: unknown) => Promise<unknown>;
}

export interface ReviewProps<TStudent, TAnswer, TSolution, TDetails> {
  student: TStudent;
  answer: TAnswer | null;
  /** null when the feedback policy hides the key. */
  solution: TSolution | null;
  details: TDetails | null;
  points: number | null;
  maxPoints: number;
  /** "teacher" shows everything; "student" respects the already-applied filtering. */
  audience: "teacher" | "student";
}

export interface QuestionTypeClient<TConfig = unknown, TAnswer = unknown, TStudent = unknown, TSolution = unknown, TDetails = unknown> {
  readonly id: QuestionTypeId;
  /** i18n keys, not literals: "qt.mcq.label", "qt.mcq.hint". */
  readonly labelKey: string;
  readonly hintKey: string;
  readonly Icon: ComponentType<{ className?: string }>;

  /** React.lazy, so qt-code (Monaco) never enters the initial bundle (N-PERF-05). */
  readonly Editor: LazyExoticComponent<ComponentType<EditorProps<TConfig>>>;
  readonly Player: LazyExoticComponent<ComponentType<PlayerProps<TStudent, TAnswer>>>;
  readonly Review: LazyExoticComponent<ComponentType<ReviewProps<TStudent, TAnswer, TSolution, TDetails>>>;
  readonly Stats?: LazyExoticComponent<ComponentType<{ student: TStudent; answers: TAnswer[] }>>;

  /** Empty answer for a fresh item (e.g. { selected: [] }). */
  emptyAnswer(student: TStudent): TAnswer;
  /** Drives the "empty / seen / done" progress segments (F-LIVE-09). */
  isAnswered(answer: TAnswer | null): boolean;
  /** One-line rendering for the dashboard inspection panel and the cell tooltip. */
  summarize(answer: TAnswer | null, student: TStudent): string;
}
```

### 1.5 Registries

```ts
// packages/core/src/registry.ts
export function defineServerRegistry<T extends Record<string, QuestionTypeServer<any, any, any, any, any>>>(m: T): T { return m; }
export function makeLookup<T extends { id: string }>(m: Record<string, T>) {
  return (id: string): T => {
    const t = m[id];
    if (!t) throw new UnknownQuestionType(id);
    return t;
  };
}

// packages/registry/src/server.ts   (depends on core + qt-*)
import { mcqServer } from "@quiz/qt-mcq/server"; /* … */
export const serverRegistry = defineServerRegistry({ mcq: mcqServer, short: shortServer, cloze: clozeServer, code: codeServer });
export const questionType = makeLookup(serverRegistry);
export const QUESTION_TYPE_IDS = ["mcq", "short", "cloze", "code"] as const;

// packages/registry/src/client.ts
export const clientRegistry = { mcq: mcqClient, short: shortClient, cloze: clozeClient, code: codeClient };
export const questionTypeClient = makeLookup(clientRegistry);
```

### 1.6 Read/write pipeline in the API (single place, `apps/api/src/modules/pool/service.ts`)

```ts
/** Every read of a stored config goes through this. Never parse a raw jsonb elsewhere. */
export function loadConfig(type: string, raw: unknown, storedVersion: number) {
  const t = questionType(type);
  const migrated = storedVersion === t.configVersion ? raw : t.migrate(raw, storedVersion);
  return t.configSchema.parse(migrated);              // throws 422 config_invalid
}
/** Every write. Drafts are always rewritten at the current configVersion (docs/05 §5.2). */
export function saveConfig(type: string, config: unknown) {
  const t = questionType(type);
  return { config: t.configSchema.parse(config), configVersion: t.configVersion };
}
```

### 1.7 Runner interface (`packages/core/src/runner.ts`) — HTTP service behind an interface

```ts
export const RunnerLanguage = z.enum(["c", "cpp", "python", "js", "rust"]);

export const RunnerRequest = z.object({
  language: RunnerLanguage,
  files: z.array(z.object({ name: z.string().max(64), content: z.string().max(200_000) })).min(1).max(8),
  compileArgs: z.string().max(400).default(""),
  action: z.enum(["check", "run"]),
  limits: z.object({ timeMs: z.number().int().min(100).max(20_000), memoryMb: z.number().int().min(16).max(512), outputKb: z.number().int().min(1).max(256) }),
  cases: z.array(z.object({ name: z.string(), stdin: z.string().max(64_000) })).max(50),
  /** "interactive" (student clicked Run) or "grading" (background). Maps to the runner's two queues. */
  priority: z.enum(["interactive", "grading"]).default("grading"),
});

export const RunnerOutcome = z.object({
  compile: z.object({ ok: z.boolean(), stdout: z.string(), stderr: z.string(), ms: z.number() }),
  cases: z.array(z.object({
    exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(),
    ms: z.number(), timedOut: z.boolean(), oom: z.boolean(), truncated: z.boolean(),
  })),
});

export interface RunnerService {
  /** Throws RunnerUnavailable when no engine is configured/healthy; throws RunnerBusy on 429. */
  run(req: RunnerRequest): Promise<RunnerOutcome>;
  health(): Promise<{ ok: boolean; languages: string[]; queued: number; avgMs: number | null; reason?: string }>;
}
```

Three implementations, selected by `RUNNER_MODE` env (`stub` | `http` | `fake`):

| Impl | File | Behaviour |
|---|---|---|
| `UnavailableRunner` (**default in dev**) | `apps/api/src/modules/runner/unavailable.ts` | `run()` throws `RunnerUnavailable`; `health()` returns `{ ok:false, languages:[], reason:"not_configured" }` |
| `HttpRunner` | `apps/api/src/modules/runner/http.ts` | `POST ${RUNNER_URL}/run`, 30 s timeout, one retry on 502/503, no retry on 429 (surfaces `RunnerBusy`) |
| `FakeRunner` | `apps/api/src/modules/runner/fake.test.ts` + `apps/web/src/mock/` | Scripted outcomes for tests and `dev:mock` |

**No container engine is required to develop or test anything except WP3's `apps/runner` itself.**

---

## 2. The four question types

Common conventions: every config carries `configVersion: 1`; `prompt`/`text` are markdown with `asset:<uuid>` image
references; all points produced by graders are `round2(fraction × ctx.itemPoints)`.

### 2.1 `mcq` (docs/04 §4.4)

```ts
// packages/qt-mcq/src/schema.ts
export const McqChoice = z.object({
  text: z.string().min(1).max(2000),
  correct: z.boolean().default(false),
});

export const McqConfig = z.object({
  configVersion: z.literal(1),
  prompt: z.string().min(1).max(20_000),
  choices: z.array(McqChoice).min(2).max(12),
  mode: z.enum(["single", "multiple"]).default("single"),
  maxSelections: z.number().int().min(1).max(12).optional(),
  policy: z.enum(["all_or_nothing", "partial", "penalized"]).default("all_or_nothing"),
  penalty: z.number().min(0).max(1).default(1),
  allowNegative: z.boolean().default(false),
  shuffleChoices: z.boolean().default(true),
})
  .refine((c) => c.choices.some((x) => x.correct), { message: "mcq.no_correct_choice" })
  .refine((c) => c.mode !== "single" || c.choices.filter((x) => x.correct).length === 1, { message: "mcq.single_needs_one" })
  .refine((c) => c.policy !== "all_or_nothing" || true)
  .refine((c) => c.mode !== "single" || c.policy === "all_or_nothing", { message: "mcq.single_policy" });

export const McqAnswer = z.object({
  /** Canonical indices into config.choices, ascending, unique. */
  selected: z.array(z.number().int().min(0).max(11)).max(12),
});

export const McqStudent = z.object({
  prompt: z.string(),
  /** `id` is the canonical index; the ARRAY ORDER is the shuffled display order. */
  choices: z.array(z.object({ id: z.number().int(), text: z.string() })),
  mode: z.enum(["single", "multiple"]),
  maxSelections: z.number().int().optional(),
});

export const McqSolution = z.object({ correct: z.array(z.number().int()) });

export const McqDetails = z.object({
  policy: z.enum(["all_or_nothing", "partial", "penalized"]),
  correct: z.array(z.number().int()),   // C set
  selected: z.array(z.number().int()),
  c: z.number().int(), w: z.number().int(), C: z.number().int(), W: z.number().int(),
  fraction: z.number(),
});
```

Stripping rule (`toStudent`): keep `prompt`, `choices[].text`, `mode`, `maxSelections`. **Drop** `correct`,
`policy`, `penalty`, `allowNegative`. Shuffle with `shuffle(indexed, streamSeed(seed, itemId, "choices"))` when
`view.shuffle && config.shuffleChoices`.

Grading (`answer === null` ⇒ `selected = []`):

```
C = #correct, W = #incorrect, c = |selected ∩ correct|, w = |selected \ correct|
all_or_nothing : f = (c === C && w === 0) ? 1 : 0
partial        : f = (c - w) / C
penalized      : f = c / C - penalty * (W > 0 ? w / W : 0)
f = clamp(f, allowNegative ? -1 : 0, 1)
points = round2(f * itemPoints)
```
`maxSelections` is a **player-side** guard only; a payload exceeding it is truncated to the first `maxSelections`
entries server-side and logged in `details` (never a hard reject — never lose an answer). State: `validated`.

Example config:
```yaml
configVersion: 1
prompt: |
  Soit `int *p` pointant sur l'adresse `0x1000`. Que vaut `p + 1` ?
choices:
  - { text: "`0x1001`", correct: false }
  - { text: "`0x1004`", correct: true }
  - { text: "`0x1008`", correct: false }
mode: single
policy: all_or_nothing
shuffleChoices: true
```
```yaml
configVersion: 1
prompt: "Lesquelles de ces déclarations sont valides en C17 ?"
choices:
  - { text: "`int a[] = {1,2,3};`", correct: true }
  - { text: "`int a[3] = {};`", correct: true }
  - { text: "`int a[] ;`", correct: false }
  - { text: "`int a[-1];`", correct: false }
mode: multiple
policy: penalized
penalty: 0.5
allowNegative: false
```

### 2.2 `short` (docs/04 §4.5)

```ts
const Base = { points: z.number().min(0).max(1).default(1) };

export const ShortMatcher = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), value: z.string().min(1).max(500),
             caseSensitive: z.boolean().default(false), trim: z.boolean().default(true),
             collapseSpaces: z.boolean().default(true), ...Base }),
  z.object({ kind: z.literal("regex"), pattern: z.string().min(1).max(300),
             flags: z.string().regex(/^[imsu]*$/).default("i"), ...Base }),
  z.object({ kind: z.literal("number"), value: z.number(), tolerance: z.number().min(0).default(0),
             toleranceMode: z.enum(["abs", "rel"]).default("abs"),
             unit: z.string().max(16).optional(), unitRequired: z.boolean().default(false), ...Base }),
  z.object({ kind: z.literal("date"), value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
             toleranceDays: z.number().int().min(0).default(0), ...Base }),
  z.object({ kind: z.literal("time"), value: z.string().regex(/^\d{2}:\d{2}$/),
             toleranceMinutes: z.number().int().min(0).default(0), ...Base }),
  // phase 2, accepted by the schema but rejected at publication in MVP:
  z.object({ kind: z.literal("llm"), rubric: z.string(), reference: z.string().optional(), ...Base }),
]);

export const ShortConfig = z.object({
  configVersion: z.literal(1),
  prompt: z.string().min(1).max(20_000),
  kind: z.enum(["text", "number", "date", "time"]).default("text"),
  placeholder: z.string().max(80).optional(),
  matchers: z.array(ShortMatcher).min(1).max(20),
});

export const ShortAnswer  = z.object({ text: z.string().max(500) });
export const ShortStudent = z.object({ prompt: z.string(), kind: z.enum(["text","number","date","time"]), placeholder: z.string().optional() });
export const ShortSolution = z.object({ /** human rendering, e.g. "0x1004" or "≈ 3.14 ± 1 %" */ expected: z.array(z.string()) });
export const ShortDetails = z.object({
  matchedIndex: z.number().int().nullable(),
  matchedKind: z.string().nullable(),
  normalized: z.string(),
  fraction: z.number(),
});
```

Normalisation pipeline (`packages/domain/src/short.ts`, shared by all matchers):
1. NFC-normalise, replace NBSP/thin space by space, CRLF→LF.
2. `trim` if set; `collapseSpaces` if set (`/\s+/g → " "`).
3. For `exact`: `caseSensitive === false` ⇒ compare with `localeCompare(…, { sensitivity: "base" })`? **No** — use
   `toLocaleLowerCase("fr")` on both sides; accents stay significant. (Decision D9.)
4. For `number`: strip the unit suffix (case-insensitive, optional space; if `unitRequired` and absent ⇒ no match),
   strip space/apostrophe thousand separators, `,` → `.`; parse with `Number()`; reject NaN.
   Match iff `|x − value| ≤ tolerance` (abs) or `≤ |value| × tolerance` (rel).
5. For `date`/`time`: accept `dd.mm.yyyy`, `dd/mm/yyyy`, `yyyy-mm-dd`, `hh:mm`, `hhhmm`, `hh h mm`; normalise to
   ISO; compare with the tolerance in days / minutes.
6. For `regex`: compile `new RegExp("^(?:" + pattern + ")$", flags)` — **full match** per spec. Guards: pattern ≤ 300 chars,
   input ≤ 500 chars, compilation wrapped in try/catch at publication time (invalid regex = publication error).

Matchers are evaluated **in order**; the **first** match wins and yields `fraction = matcher.points`.
No match ⇒ `fraction = 0`, `matchedIndex = null`. Empty/absent answer ⇒ 0 without running matchers.
State: `validated`. A config containing an `llm` matcher is rejected at publication in MVP with `llm_not_available`.

Stripping (`toStudent`): keep `prompt`, `kind`, `placeholder`. **Drop the whole `matchers` array.**

Example:
```yaml
configVersion: 1
prompt: "Quelle est la taille en octets d'un `int` sur une cible 32 bits ?"
kind: number
matchers:
  - { kind: number, value: 4, tolerance: 0, toleranceMode: abs, unit: "octets", points: 1 }
```
```yaml
configVersion: 1
prompt: "Donnez la directive qui inclut l'en-tête d'entrées-sorties standard."
kind: text
matchers:
  - { kind: exact, value: "#include <stdio.h>", collapseSpaces: true, points: 1 }
  - { kind: regex, pattern: "#\\s*include\\s*[<\"]stdio\\.h[>\"]", flags: "i", points: 1 }
  - { kind: exact, value: "include <stdio.h>", points: 0.5 }
```

### 2.3 `cloze` (docs/04 §4.6)

```ts
export const ClozeConfig = z.object({
  configVersion: z.literal(1),
  /** Markdown with {{…}} holes. */
  text: z.string().min(1).max(20_000),
  caseSensitive: z.boolean().default(false),
  shuffleOptions: z.boolean().default(true),
}).superRefine((c, ctx) => { /* parseCloze must succeed and yield ≥ 1 blank */ });

export const ClozeAnswer = z.object({
  /** One entry per blank, in order of appearance. `null` = untouched. */
  blanks: z.array(z.string().max(200).nullable()).max(50),
});
```

**Parser** (`packages/domain/src/cloze.ts`, the single source of truth, used by editor preview, `toStudent` and grader):

```ts
export type ClozeBlank =
  | { index: number; weight: number; kind: "text";   answers: string[] }
  | { index: number; weight: number; kind: "select"; options: string[]; correct: number[] }
  | { index: number; weight: number; kind: "number"; value: number; tolerance: number; mode: "abs" | "rel" }
  | { index: number; weight: number; kind: "regex";  pattern: string; flags: string };

export interface ClozeParse {
  /** Markdown with each blank replaced by the sentinel `⸢{index}⸣`. */
  template: string;
  blanks: ClozeBlank[];
  errors: { at: number; message: string }[];
}
export function parseCloze(text: string): ClozeParse;
```

Grammar, applied to the content between `{{` and the matching `}}`:

| Step | Rule |
|---|---|
| Escape | `\{{` produces a literal `{{` and is not a blank. `\|`, `\}`, `\*`, `\\` are literal inside a blank. |
| Weight | Optional leading `\d+(\.\d+)?\*` ⇒ `weight`, default `1`. `{{2*Newton}}` |
| `#` | `#<number>:<tol>` ⇒ `number`; a trailing `%` on `<tol>` ⇒ `mode:"rel"` (`tol/100`), else `abs`. `{{#3.14:1%}}` |
| `/` … `/flags` | `regex`, flags restricted to `imsu`, full-match anchored like `short`. `{{/^[0-9a-f]+$/i}}` |
| contains `=` at the start of ≥ 1 alternative | `select`: split on unescaped `\|`; an alternative starting with `=` is correct (the `=` is stripped); `options` keeps the authoring order as canonical. `{{=Newton\|Maxwell\|Faraday}}` |
| otherwise | `text`: split on unescaped `\|` ⇒ `answers[]`, all accepted. `{{Newton\|Isaac Newton}}` |
| Unterminated `{{` | recorded in `errors`, rendered literally |

Blanks inside fenced code blocks stay active: the sentinel is a plain string and the code-block renderer splits on it.

Answer encoding: `text`/`number`/`regex` blanks store the typed string; **`select` blanks store the canonical option
index as a decimal string** (`"2"`), so shuffling never affects stored answers (D4).

Student view:
```ts
export const ClozeStudent = z.object({
  template: z.string(),   // sentinel-bearing markdown, no answers anywhere
  blanks: z.array(z.discriminatedUnion("kind", [
    z.object({ index: z.number().int(), weight: z.number(), kind: z.literal("input"), numeric: z.boolean() }),
    z.object({ index: z.number().int(), weight: z.number(), kind: z.literal("select"),
               options: z.array(z.object({ id: z.number().int(), label: z.string() })) }),
  ])),
});
```
`text`, `number` and `regex` blanks all collapse to `kind:"input"` (`numeric` only drives `inputmode="decimal"`) —
so a student cannot tell a regex blank from a plain one, and no pattern/tolerance/answer leaks. `select` options are
shuffled with `streamSeed(seed, itemId, "options:" + index)` when `view.shuffle && config.shuffleOptions`; `id` is
the canonical index.

Grading (`packages/domain/src/cloze.ts#gradeCloze`):
```
for each blank b:  ok(b) = match(given[b.index], b)   // reuses the short.ts normalisation for text/number/regex
earned  = Σ weight(b) where ok(b)
total   = Σ weight(b)
fraction = total > 0 ? earned / total : 0
points   = round2(fraction * itemPoints)
```
`select`: `ok` iff `Number(given)` ∈ `b.correct`. `text`: normalised equality against any of `answers`, case folded
unless `config.caseSensitive`. State: `validated`.

Details: `{ perBlank: [{ index, weight, kind, ok, given, expected }], earned, total, fraction }` —
`expected` is present only in the teacher-facing details (the student results endpoint strips it unless the
feedback policy reveals the key, see §4.6).

Example:
```yaml
configVersion: 1
caseSensitive: false
text: |
  La loi de {{Newton|newton}} lie force, masse et accélération : **F = m·a**.

  Complétez la boucle :

  ```c
  for (int i = 0; i < {{#10:0}}; i++) {
      total {{+=|+ =}} tab[i];
  }
  ```

  L'unité SI de la force est le {{=newton|joule|watt|pascal}}, de symbole {{2*/^N$/}}.
```

### 2.4 `code` (docs/04 §4.7)

```ts
export const CodeConfig = z.object({
  configVersion: z.literal(1),
  prompt: z.string().min(1).max(20_000),
  language: z.enum(["c", "cpp", "python", "js", "rust"]),
  template: z.string().max(40_000).default(""),
  files: z.array(z.object({ name: z.string().regex(/^[\w.-]{1,40}$/), content: z.string().max(64_000) })).max(4).default([]),
  action: z.enum(["check", "run"]).default("run"),
  compileArgs: z.string().max(400).default(""),
  limits: z.object({
    timeMs: z.number().int().min(100).max(10_000).default(2000),
    memoryMb: z.number().int().min(16).max(512).default(128),
    outputKb: z.number().int().min(1).max(256).default(64),
  }).default({}),
  runsPerMinute: z.number().int().min(1).max(30).default(10),
  allOrNothing: z.boolean().default(false),
  tests: z.object({
    mode: z.literal("io"),            // "tap" is phase 3
    compare: z.object({
      trimTrailing: z.boolean().default(true),
      ignoreCase: z.boolean().default(false),
      numeric: z.object({ epsilon: z.number().min(0), mode: z.enum(["abs", "rel"]) }).nullable().default(null),
    }).default({}),
    cases: z.array(z.object({
      name: z.string().min(1).max(60),
      stdin: z.string().max(16_000).default(""),
      expected: z.string().max(16_000),
      visible: z.boolean().default(false),
      points: z.number().min(0).max(100).default(1),
    })).min(1).max(30),
  }),
});

export const CodeAnswer = z.object({
  /** One entry per EDITABLE region of the template, in order. */
  regions: z.array(z.string().max(20_000)).max(20),
  lastRun: z.object({
    at: z.iso.datetime(), requestId: z.uuid(),
    compileOk: z.boolean(), passed: z.number().int(), total: z.number().int(),
  }).nullable().optional(),
});
```

**Lock regions.** `packages/domain/src/lockedTemplate.ts`:
```ts
export interface TemplateSegment { kind: "locked" | "editable"; index: number | null; text: string }
/** A line is a marker iff, once leading whitespace and the language's line-comment prefix
 *  (`//`, `#`, `--`) are stripped, it equals `@@lock` or `@@endlock`. Markers are part of
 *  the locked text (they are comments and must survive into the compiled source). */
export function splitTemplate(template: string, language: CodeLanguage): TemplateSegment[];
/** Rebuilds the source. Throws if regions.length !== editable count. NEVER accepts client text
 *  for a locked segment (docs/04 §4.7). */
export function assembleSource(template: string, language: CodeLanguage, regions: string[]): string;
```
A template with **no** marker is entirely editable (one region). The player hides marker lines but keeps the locked
body visible and read-only (Monaco `readOnly` decorations).

Student view:
```ts
export const CodeStudent = z.object({
  prompt: z.string(),
  language: z.enum(["c","cpp","python","js","rust"]),
  segments: z.array(z.object({ kind: z.enum(["locked","editable"]), index: z.number().int().nullable(), text: z.string() })),
  limits: z.object({ timeMs: z.number(), memoryMb: z.number(), outputKb: z.number() }),
  runsPerMinute: z.number().int(),
  /** VISIBLE cases only, with stdin and expected. */
  visibleCases: z.array(z.object({ name: z.string(), stdin: z.string(), expected: z.string(), points: z.number() })),
  /** Hidden cases exist but stay opaque during the attempt (docs/06 Q8). */
  hiddenCount: z.number().int(),
  hiddenPoints: z.number(),
  filesPreview: z.array(z.object({ name: z.string(), bytes: z.number().int() })),
  allOrNothing: z.boolean(),
});
```
Stripping: **drop** hidden case `stdin`/`expected`, `compare`, `compileArgs`, `files[].content`, `action`.
(`files[].content` is dropped because a data file may contain the answer; the runner injects it server-side.
Exposing `filesPreview` lets the player say "data.csv is available".)

Grading, two phases:
```ts
grade(config, answer, ctx): GradeResult {
  if (!answer || answer.regions.every(r => r.trim() === "")) return { kind:"graded", points:0, maxPoints:ctx.itemPoints, details:{ empty:true, … }, state:"validated" };
  const source = assembleSource(config.template, config.language, answer.regions);
  return { kind: "pending", via: "runner", request: {
      language: config.language,
      files: [{ name: mainFileName(config.language), content: source }, ...config.files],
      compileArgs: config.compileArgs, action: "run", limits: config.limits,
      cases: config.tests.cases.map(c => ({ name: c.name, stdin: c.stdin })),
      priority: "grading",
  }};
}

finalizeRunner(config, answer, ctx, outcome): GradedResult {
  if (!outcome.compile.ok) return zero with details.compile;
  const per = config.tests.cases.map((c, i) => ({ …, ok: compareOutput(c.expected, outcome.cases[i].stdout, config.tests.compare) && outcome.cases[i].exitCode === 0 && !timedOut && !oom }));
  const earned = per.filter(p => p.ok).reduce((s,p) => s + p.points, 0);
  const total  = config.tests.cases.reduce((s,c) => s + c.points, 0);
  const fraction = config.allOrNothing ? (earned === total ? 1 : 0) : (total ? earned / total : 0);
  return { kind:"graded", points: round2(fraction * ctx.itemPoints), maxPoints: ctx.itemPoints, details: { compile, cases: per, earned, total }, state:"validated" };
}
```

`compareOutput` (`packages/domain/src/compareOutput.ts`), applied in order:
1. CRLF → LF on both sides.
2. `trimTrailing`: strip trailing spaces/tabs of every line, then strip trailing newlines of the whole string.
3. `ignoreCase`: `toLowerCase()` both sides.
4. `numeric !== null`: split both on `/\s+/`; unequal token count ⇒ false; token pairs that both parse as finite
   numbers compare with `|a-b| ≤ eps` (abs) or `|a-b| ≤ eps·|b|` (rel); other pairs compare as strings.
5. otherwise strict `===`.

Details shape:
```ts
export const CodeDetails = z.object({
  runner: z.enum(["ok", "unavailable", "busy", "error"]),
  compile: z.object({ ok: z.boolean(), stderr: z.string().max(4000), ms: z.number() }).nullable(),
  cases: z.array(z.object({
    name: z.string(), visible: z.boolean(), points: z.number(), ok: z.boolean(),
    exitCode: z.number().nullable(), ms: z.number(), timedOut: z.boolean(), oom: z.boolean(),
    /** Present only for visible cases (or for the teacher). */
    expected: z.string().optional(), actual: z.string().optional(), stderr: z.string().optional(),
  })),
  earned: z.number(), total: z.number(), sourceSha256: z.string().length(64),
});
```

**Runner unavailable path (MVP default).** `RunnerUnavailable` in the `grading.runner` job ⇒ write
`{ source:"auto", state:"proposed", points:0, details:{ runner:"unavailable", … }, comment:"runner_unavailable" }`.
The grading panel lists these as "to grade by hand" with the assembled source visible and a points field.
Nothing blocks; the evaluation can still be released.

Example config:
```yaml
configVersion: 1
prompt: "Écrivez la somme des éléments du tableau lu sur stdin."
language: c
template: |
  #include <stdio.h>
  // @@lock
  int main(void) {
      int n; if (scanf("%d", &n) != 1) return 1;
      int tab[128]; for (int i = 0; i < n; i++) scanf("%d", &tab[i]);
  // @@endlock
      int total = 0;
      // votre code ici
      printf("%d\n", total);
  // @@lock
      return 0;
  }
  // @@endlock
action: run
compileArgs: "-Wall -Wextra -std=c17"
limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 }
runsPerMinute: 10
allOrNothing: false
tests:
  mode: io
  compare: { trimTrailing: true, ignoreCase: false, numeric: null }
  cases:
    - { name: "trois éléments", stdin: "3\n1 2 3\n", expected: "6\n", visible: true,  points: 1 }
    - { name: "tableau vide",   stdin: "0\n",        expected: "0\n", visible: true,  points: 1 }
    - { name: "négatifs",       stdin: "4\n-1 -2 3 5\n", expected: "5\n", visible: false, points: 1 }
```

### 2.5 The `toStudent` safety test (docs/05 §5.7, N-SEC-04) — mandatory in every qt package

```ts
// packages/qt-*/src/toStudent.test.ts
const FORBIDDEN_KEYS = ["correct", "matchers", "answers", "expected", "pattern", "value", "tolerance",
  "policy", "penalty", "compare", "compileArgs", "explanation", "internalName", "tags", "difficulty", "rubric"];
it("leaks no key", () => {
  const out = JSON.stringify(type.toStudent(FULL_FIXTURE, { seed: 7, itemId: "i", shuffle: true }));
  for (const k of FORBIDDEN_KEYS) expect(out).not.toContain(`"${k}"`);
  for (const secret of SECRET_VALUES) expect(out).not.toContain(secret);  // e.g. "0x1004", "Newton", hidden stdin
});
```
Plus a generic version in `apps/api/src/modules/live/studentView.test.ts` iterating the registry.

---

## 3. Drizzle schema, per module (`apps/api/src/db/<module>.ts`, re-exported by `db/schema.ts`)

Common columns omitted below: `id uuid pk` (uuid v7, app-generated), `created_at timestamptz not null default now()`,
`updated_at timestamptz` where the row mutates. All timestamps `timestamptz`, all times UTC.

### 3.1 Inherited from heig-classroom — keep, prune, extend

| Table | Status | Change for quiz |
|---|---|---|
| `users` | **exists** | keep `id, oidc_sub, email, display_name/given_name/family_name, role(student\|teacher\|admin), locale, date_format, last_login_at, anonymized_at`; **add** `theme text`; **drop** `github_user_id, github_login, github_linked_at, email_prefs` |
| `user_emails` | **exists** | keep as-is (`user_id, email unique, source login\|idp\|roster`) |
| `user_idp_claims` | **exists** | keep as-is |
| `sessions` | **exists** | keep as-is (`sid_hash char(64) pk`) |
| `audit_log` | **exists** | keep; replace the action catalogue with the quiz one (§3.6) |
| `avatars` | **exists** | keep as-is |
| `classrooms` | **exists** | **rework**: `course_id` replaces `teacher_id`/`org_login`; add `period text not null`, `join_code text unique`, `join_code_enabled bool`, `archived_at` |
| `enrollments` | **exists** | keep `classroom_id, user_id, email, status(pending\|claimed), claimed_at, conflict_flag`; **add** `time_bonus_percent int not null default 0`, `note text` |
| `courses`, `course_staff` | **exists (as `classroom_staff`)** | `course_staff` is `classroom_staff` renamed and re-pointed at `courses`; `courses` is new but trivially the old classroom head |
| `organizations`, `assignments`, `student_repos`, `grade_runs`, `webhooks`, `scheduled_tasks`, `milestones` | **delete** | GitHub-specific |

### 3.2 `db/pool.ts`

| Table | Columns | Constraints / indexes |
|---|---|---|
| `pools` | `name text nn`, `visibility text nn default 'private' {private,shared,public}`, `owner_id uuid → users nn`, `is_personal bool nn default false` | `idx pools(owner_id)`; partial unique `(owner_id) where is_personal` |
| `categories` | `pool_id uuid → pools cascade nn`, `parent_id uuid → categories cascade`, `name text nn`, `position int nn default 0` | `idx categories(pool_id, parent_id, position)` |
| `questions` | `pool_id nn`, `category_id uuid → categories set null`, `type text nn`, `internal_name text nn`, `difficulty smallint nn default 2 check 1..5`, `shuffleable bool nn default true`, `randomizable bool nn default false`, `created_by uuid → users`, `origin_question_id uuid → questions`, `deleted_at timestamptz` | unique `(pool_id, lower(internal_name)) where deleted_at is null`; `idx questions(pool_id, type)`; `idx questions(category_id)` |
| `question_tags` | `question_id uuid → questions cascade`, `tag text nn` | pk `(question_id, tag)`; `idx question_tags(tag)` |
| `question_versions` | `question_id nn`, `number int` (null = draft), `config jsonb nn`, `config_version int nn`, `explanation text nn default ''`, `search tsvector generated`, `published_at`, `published_by uuid → users`, `change_note text`, `deprecated_at`, `deprecation_note text` | unique `(question_id, number)`; **partial unique `(question_id) where number is null`**; `idx (question_id, number desc)`; GIN `search` |
| `assets` | `owner_id uuid → users nn`, `pool_id uuid → pools`, `sha256 char(64) nn`, `mime text nn`, `bytes int nn`, `width int`, `height int`, `path text nn` | unique `(sha256)`; `idx assets(pool_id)` |
| `question_version_assets` | `version_id uuid → question_versions cascade`, `asset_id uuid → assets` | pk `(version_id, asset_id)` |
| `course_pools` | `course_id`, `pool_id` | pk `(course_id, pool_id)` |
| `pool_members` | **phase 2 — create the table now, no routes** | pk `(pool_id, user_id)` |

`search` is a generated column: `to_tsvector('simple', coalesce(internal_name,'') || ' ' || coalesce(search_text,''))`
where `search_text text` is a plain column the service fills with `type.searchText(config)` on every draft save and
publication (Postgres cannot call TS). So: add `search_text text nn default ''` and generate `search` from
`search_text` + the joined `internal_name` via a trigger-free `GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED`.

### 3.3 `db/evaluation.ts`

| Table | Columns | Constraints / indexes |
|---|---|---|
| `evaluations` | `classroom_id uuid → classrooms cascade nn`, `title text nn`, `mode text nn {exam,exercise,poll}`, `state text nn default 'draft' {draft,scheduled,lobby,running,paused,closed,grading,released}`, `settings jsonb nn`, `grading_scale jsonb nn`, `feedback_policy jsonb nn`, `opens_at`, `closes_at`, `duration_s int`, `access_code text`, `ip_allowlist text[]`, `started_at`, `paused_at`, `closed_at`, `released_at`, `released_grades jsonb`, `modified_after_release bool nn default false`, `created_by uuid → users` | `idx evaluations(classroom_id, state)`; partial `idx (state) where state in ('lobby','running','paused')` |
| `evaluation_items` | `evaluation_id cascade nn`, `position int nn`, `question_version_id uuid → question_versions nn`, `points numeric(6,2) nn`, `milestone bool nn default false` | unique `(evaluation_id, position)` **deferrable initially deferred** (reorder in one UPDATE); `idx (question_version_id)` |

`settings` jsonb, validated by `EvaluationSettings` in contracts:
```ts
export const EvaluationSettings = z.object({
  navigation: z.enum(["free", "forward_only", "milestones"]).default("free"),
  presentation: z.enum(["zen", "continuous", "student_choice"]).default("zen"),
  lobby: z.enum(["skip", "auto", "manual"]).default("manual"),
  shuffleItems: z.boolean().default(false),
  shuffleChoices: z.boolean().default(true),
  timing: z.enum(["duration", "deadline", "manual"]).default("duration"),
  showProgressBar: z.boolean().default(true),
  logVisibility: z.boolean().default(true),
  requireFullscreen: z.boolean().default(false),
});
export const GradingScale = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linear"), rounding: z.enum(["nearest","up","down"]).default("nearest") }),
  z.object({ kind: z.literal("threshold"), threshold: z.number().positive(), rounding: z.enum(["nearest","up","down"]).default("nearest") }),
]);
export const FeedbackPolicy = z.object({
  when: z.enum(["none", "on_release", "immediate"]).default("on_release"),
  showAnswer: z.boolean().default(true),          // the student's own answer
  showKey: z.boolean().default(false),            // the solution
  showExplanation: z.boolean().default(false),
  showHiddenCaseNames: z.boolean().default(true), // docs/06 Q8
  showTeacherComment: z.boolean().default(true),
});
```

### 3.4 `db/live.ts`

| Table | Columns | Constraints / indexes |
|---|---|---|
| `attempts` | `evaluation_id cascade nn`, `user_id uuid → users nn`, `state text nn default 'not_started' {not_started,in_progress,submitted,expired}`, `seed int nn`, `started_at`, `deadline_at`, `bonus_s int nn default 0`, `extra_s int nn default 0`, `submitted_at`, `closed_at`, `closed_by text {server,student,teacher}`, `last_item_id uuid`, `present_at timestamptz` | unique `(evaluation_id, user_id)`; **partial `idx (deadline_at) where state='in_progress'`** (ticker); `idx (evaluation_id)` |
| `answers` | `attempt_id cascade nn`, `item_id uuid → evaluation_items cascade nn`, `payload jsonb nn`, `revision int nn default 0`, `marked_done bool nn default false`, `first_seen_at`, `updated_at nn` | unique `(attempt_id, item_id)`; `idx answers(attempt_id)`; `idx answers(item_id)` |
| `attempt_events` | `attempt_id cascade nn`, `kind text nn {visibility,focus,ip_change,reconnect,time_added,paused,resumed,run}`, `at timestamptz nn default now()`, `details jsonb` | `idx (attempt_id, at)`; retention: pruned with the classroom |
| `run_requests` | `attempt_id`, `item_id`, `user_id`, `requested_at`, `finished_at`, `ok bool`, `ms int`, `error text` | rate limit (F-EVAL/N-SEC-07) + admin metrics; `idx (user_id, requested_at desc)` |
| `guest_participants` | **phase 2 — not created in MVP** | |

### 3.5 `db/grading.ts` + `db/results.ts`

| Table | Columns | Constraints / indexes |
|---|---|---|
| `gradings` | `answer_id uuid → answers cascade nn`, `item_id uuid nn` (denormalised for the by-question query), `points numeric(6,2) nn`, `max_points numeric(6,2) nn`, `source text nn {auto,llm,manual}`, `state text nn {proposed,validated,superseded}`, `details jsonb`, `confidence text {low,medium,high}`, `comment text`, `graded_by uuid → users`, `graded_at nn default now()`, `supersedes_id uuid → gradings`, `regrade_note text` | **partial unique `(answer_id) where state='validated'`**; `idx (answer_id)`; `idx (item_id) where state='validated'` |
| `answer_flags` | phase 2 — table created, no routes | |
| `llm_calls` | phase 2 — not created in MVP | |
| `settings` | `key text pk`, `value jsonb nn` | global parameters (F-ADMIN-03 stub) |

Note: `attempts` has **no** grade column. Grades are recomputed from validated `gradings` and frozen into
`evaluations.released_grades` at release (invariant 5).

`released_grades` jsonb shape:
```ts
z.object({
  releasedAt: z.iso.datetime(),
  totalPoints: z.number(),
  scale: GradingScale,
  rows: z.array(z.object({ attemptId: z.uuid(), userId: z.uuid(), points: z.number(), grade: z.number(), perItem: z.record(z.string(), z.number()) })),
})
```

### 3.6 `audit_log` action catalogue (closed TS union)

`classroom.delete`, `classroom.archive`, `roster.import`, `roster.remove`, `question.publish`, `question.delete`,
`question.restore_version`, `question.deprecate`, `evaluation.start`, `evaluation.pause`, `evaluation.resume`,
`evaluation.extend`, `evaluation.close`, `evaluation.delete`, `grading.override`, `grading.regrade`,
`results.release`, `results.rerelease`, `user.role_change`.

### 3.7 Migrations

Drizzle SQL migrations in `apps/api/drizzle/`, applied at boot (N-OPS-04), additive only.
MVP is delivered as **two** migrations: `0001_base` (pruned heig-classroom tables + org) and `0002_quiz`
(pool, evaluation, live, grading). Tests use PGlite (`apps/api/src/test/db.ts`, inherited).

---

## 4. `packages/contracts` — HTTP routes and SSE grammar

Layout: `src/{common,org,pool,evaluation,live,grading,results,realtime,admin}.ts`, all re-exported by `index.ts`.
Every route is declared as a triple `{ params, body|query, response }` of zod schemas; the Fastify handler parses with
the same object the web client uses to type its call.

Conventions:
- Base path `/api/v1`. Auth by session cookie (`__Host-quiz_sid`) + double-submit CSRF header `x-csrf-token`
  on non-GET (inherited). Bearer API tokens: phase 2, same surface.
- Auth column: **T** = teacher staff of the course owning the resource (or admin); **S** = student enrolled and
  owner of the attempt; **A** = admin; **Any** = any session.
- Errors: `{ error: string, message?: string, details?: unknown }`.
  `403 forbidden`, `404 not_found` (indistinguishable from "no access", per `guards.ts` motif), `409 conflict`,
  `410 attempt_closed`, `422 validation_failed`, `429 rate_limited`.

### 4.1 `org`

| Method | Path | Auth | Body / query | Response |
|---|---|---|---|---|
| GET | `/me` | Any | — | `Me { id, displayName, email, role, locale, theme, dateFormat }` |
| PATCH | `/me` | Any | `{ locale?, theme?, dateFormat? }` | `Me` |
| GET | `/courses` | T | — | `CourseSummary[] { id, name, code, classroomCount, poolIds }` |
| POST | `/courses` | T | `{ name, code }` | `Course` |
| GET | `/courses/:courseId` | T | — | `CourseDetail { course, staff[], pools[], classrooms[] }` |
| PATCH | `/courses/:courseId` | T | `{ name?, code? }` | `Course` |
| POST | `/courses/:courseId/staff` | T | `{ email }` | `Staff[]` |
| DELETE | `/courses/:courseId/staff/:userId` | T | — | `204` |
| PUT | `/courses/:courseId/pools` | T | `{ poolIds: uuid[] }` | `Pool[]` |
| POST | `/courses/:courseId/classrooms` | T | `{ name, period }` | `Classroom` |
| GET | `/classrooms/:id` | T | — | `ClassroomDetail { classroom, course, counts, evaluations: EvaluationSummary[] }` |
| PATCH | `/classrooms/:id` | T | `{ name?, period?, joinCodeEnabled? }` | `Classroom` |
| POST | `/classrooms/:id/archive` | T | `{ archived: boolean }` | `Classroom` |
| DELETE | `/classrooms/:id` | T | `{ confirmName: string }` | `204` (F-ORG-09; audited) |
| GET | `/classrooms/:id/roster` | T | — | `RosterRow[] { enrollmentId, userId?, name, email, status, timeBonusPercent, note, conflictFlag }` |
| POST | `/classrooms/:id/roster/import` | T | `text/csv` body | `{ created, merged, errors: RosterError[] }` |
| PATCH | `/classrooms/:id/roster/:enrollmentId` | T | `{ timeBonusPercent?, note? }` | `RosterRow` |
| DELETE | `/classrooms/:id/roster/:enrollmentId` | T | — | `204` (attempts preserved) |
| POST | `/classrooms/join` | Any | `{ code }` | `{ classroomId }` (F-ORG-06) |

Reuses `packages/domain/src/roster.ts` verbatim + a `timeBonusPercent` column in the permissive header detection.

### 4.2 `pool`

| Method | Path | Auth | Body / query | Response |
|---|---|---|---|---|
| GET | `/pools` | T | — | `PoolSummary[] { id, name, visibility, questionCount }` |
| POST | `/pools` | T | `{ name }` | `Pool` |
| GET | `/pools/:id` | T | — | `PoolDetail { pool, categories: CategoryNode[], tags: string[] }` |
| POST | `/pools/:id/categories` | T | `{ name, parentId? }` | `Category` |
| PATCH | `/categories/:id` | T | `{ name?, parentId?, position? }` | `Category` |
| DELETE | `/categories/:id` | T | — | `204` (questions move to root) |
| GET | `/pools/:id/questions` | T | `?q&type[]&tag[]&difficulty[]&categoryId&limit&cursor` | `{ items: QuestionRow[], nextCursor }` |
| POST | `/pools/:id/questions` | T | `{ type, internalName, categoryId? }` | `QuestionDetail` (draft pre-filled by `emptyDraft()`) |
| GET | `/questions/:id` | T | — | `QuestionDetail { meta, draft: { config, explanation, configVersion, updatedAt }, versions: VersionRow[], latestPublished }` |
| PATCH | `/questions/:id` | T | `{ internalName?, categoryId?, difficulty?, tags?, shuffleable? }` | `QuestionMeta` |
| PUT | `/questions/:id/draft` | T | `{ config, explanation }` | `{ updatedAt, valid: boolean, issues: ZodIssueLite[] }` — **autosave; invalid drafts are STORED, not rejected** (F-QST-02) |
| POST | `/questions/:id/publish` | T | `{ changeNote? }` | `VersionRow` — full `configSchema.parse` here; 422 with issues |
| GET | `/questions/:id/versions/:number` | T | — | `{ config, explanation, configVersion, publishedAt, changeNote }` |
| POST | `/questions/:id/versions/:number/restore` | T | — | `QuestionDetail` (copies into draft) |
| POST | `/questions/:id/versions/:number/deprecate` | T | `{ note }` | `VersionRow` |
| DELETE | `/questions/:id` | T | — | `204` soft; `409 in_use` on `?hard=1` if referenced |
| POST | `/questions/:id/copy` | T | `{ targetPoolId, categoryId? }` | `QuestionDetail` |
| POST | `/questions/:id/preview` | T | `{ source: "draft" \| number }` | `{ student: unknown, itemPoints: number }` — teacher preview, `seed: 0` |
| POST | `/questions/:id/try` | T | `{ source, answer }` | `{ points, maxPoints, details, solution }` — grades in-process with the **stub-aware** runner; never persisted (F-QST-09) |
| POST | `/pools/:id/assets` | T | multipart, ≤ 5 MB, `image/png\|jpeg\|gif\|webp\|svg+xml` | `{ id, url: "/assets/:id", width, height }` |
| GET | `/assets/:id` | Any authorised to see the containing content | — | bytes, `cache-control: private, max-age=31536000, immutable` |

`QuestionRow` = `{ id, type, internalName, difficulty, tags, categoryId, latestNumber, hasDraftChanges, updatedAt, deprecated }`.

### 4.3 `evaluation`

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/classrooms/:id/evaluations` | T | — | `EvaluationSummary[]` |
| POST | `/classrooms/:id/evaluations` | T | `{ title, mode, preset? }` | `Evaluation` |
| GET | `/evaluations/:id` | T | — | `EvaluationDetail { evaluation, items: ItemRow[], totalPoints, staleItems: uuid[], attemptCount }` |
| PATCH | `/evaluations/:id` | T | `{ title?, settings?, gradingScale?, feedbackPolicy?, opensAt?, closesAt?, durationS?, accessCode?, ipAllowlist? }` | `EvaluationDetail` — `409 locked` if any attempt exists and the field is structural |
| DELETE | `/evaluations/:id` | T | `{ confirmTitle }` | `204` |
| POST | `/evaluations/:id/items` | T | `{ questionIds: uuid[] }` | `ItemRow[]` — freezes each question's current published version; `422 no_published_version` |
| PATCH | `/evaluations/:id/items/:itemId` | T | `{ points?, milestone? }` | `ItemRow` |
| PUT | `/evaluations/:id/items/order` | T | `{ itemIds: uuid[] }` | `ItemRow[]` |
| DELETE | `/evaluations/:id/items/:itemId` | T | — | `204` |
| POST | `/evaluations/:id/items/update-versions` | T | `{ itemIds?: uuid[] }` (omit = all) | `ItemRow[]` — `409 attempts_exist` (F-EVAL-03) |
| POST | `/evaluations/:id/duplicate` | T | `{ classroomId?, title }` | `Evaluation` |
| POST | `/evaluations/:id/preview` | T | — | `AttemptView` with fake attempt (`seed: 0`, read-only) |
| POST | `/evaluations/:id/state` | T | `{ to: "draft"\|"scheduled"\|"lobby" }` | `Evaluation` — the *operational* transitions are in `live` below |

`ItemRow` = `{ id, position, points, milestone, questionId, type, internalName, versionNumber, latestVersionNumber, deprecated }`.

### 4.4 `live`

Teacher side:

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/evaluations/:id/dashboard` | T | `?includeAnswers=0\|1` | `DashboardView` (below) |
| POST | `/evaluations/:id/start` | T | `{ confirm: true }` | `Evaluation` — `lobby\|scheduled → running` |
| POST | `/evaluations/:id/pause` | T | — | `Evaluation` |
| POST | `/evaluations/:id/resume` | T | — | `Evaluation` |
| POST | `/evaluations/:id/close` | T | — | `Evaluation` — closes open attempts, enqueues grading |
| POST | `/evaluations/:id/extend` | T | `{ minutes: 1\|5\|10, scope: "all"\|"attempt", attemptId? }` | `{ updated: number }` (F-LIVE-11/12) |
| GET | `/evaluations/:id/attempts/:attemptId` | T | — | `AttemptInspect { student, items: [{ item, studentConfig, answer, grading, solution }] }` (F-DASH-05) |
| GET | `/evaluations/:id/raw-export` | T | — | `application/json` full dump (N-RES-06) |

```ts
export const DashboardView = z.object({
  evaluation: z.object({ id, state, startedAt, pausedAt, closesAt, serverNow }),
  items: z.array(z.object({ id, position, points, type, internalName })),
  rows: z.array(z.object({
    attemptId: z.uuid().nullable(), userId: z.uuid(), displayName: z.string(),
    /** Stable per-row pseudonym when names are hidden (F-DASH-02). */
    pseudonym: z.string(),
    state: z.enum(["not_started","in_progress","submitted","expired"]),
    online: z.boolean(), lastSeenAt: z.iso.datetime().nullable(),
    deadlineAt: z.iso.datetime().nullable(), timeBonusPercent: z.number().int(),
    points: z.number().nullable(), maxPoints: z.number(),
    cells: z.array(z.object({
      itemId: z.uuid(),
      status: z.enum(["empty","seen","in_progress","done"]),
      verdict: z.enum(["correct","partial","wrong","pending"]).nullable(),
      points: z.number().nullable(), revision: z.number().int(),
      summary: z.string().nullable(),   // only when includeAnswers=1
    })),
  })),
  totals: z.array(z.object({ itemId: z.uuid(), completion: z.number(), successRate: z.number().nullable() })),
});
```
`pseudonym` = deterministic adjective+animal from `hashSeed(evaluationId, userId)` — stable across reloads.

Student side:

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/student/home` | Any | — | `StudentHome { open: EvaluationCard[], upcoming: [], results: ResultCard[] }` |
| POST | `/evaluations/:id/attempt` | S | `{ accessCode? }` | `AttemptView \| LobbyView` — idempotent `INSERT … ON CONFLICT DO NOTHING`; `403 access_code_invalid`, `403 ip_not_allowed`, `409 not_open` |
| GET | `/attempts/:id` | S | — | `AttemptView` |
| PUT | `/attempts/:id/answers/:itemId` | S | `AutosaveRequest` | `AutosaveResponse` — see §4.7 |
| POST | `/attempts/:id/answers/:itemId/done` | S | `{ done: boolean }` | `{ done, nextItemId? }` — `409 irreversible` in `forward_only` |
| POST | `/attempts/:id/position` | S | `{ itemId }` | `204` |
| POST | `/attempts/:id/submit` | S | `{ confirm: true }` | `{ state: "submitted", submittedAt }` |
| POST | `/attempts/:id/events` | S | `{ kind, details? }` | `204` — rate-limited to 60/min (F-EVAL-13 logging) |
| POST | `/attempts/:id/run` | S | `{ itemId, regions: string[], stdin?: string }` | `202 { requestId }` — result arrives via SSE `runner.result`; `429 rate_limited` per `runsPerMinute`; `503 runner_unavailable` |

```ts
export const AttemptView = z.object({
  attempt: z.object({ id, state, startedAt, deadlineAt: z.iso.datetime().nullable(), lastItemId: z.uuid().nullable(), serverNow }),
  evaluation: z.object({ id, title, mode, state, settings: EvaluationSettings, pausedAt: z.iso.datetime().nullable(), totalPoints }),
  items: z.array(z.object({
    id: z.uuid(), position: z.number().int(), points: z.number(), type: z.string(), milestone: z.boolean(),
    /** Output of type.toStudent — opaque to the core contracts. */
    student: z.unknown(),
    answer: z.unknown().nullable(), revision: z.number().int(), markedDone: z.boolean(),
  })),
});

export const LobbyView = z.object({
  evaluation: z.object({ id, title, state, announcedDurationS: z.number().int().nullable() }),
  navigation: Navigation,   // settings.navigation: the lobby's first rule (§6.3)
  present: z.number().int(), enrolled: z.number().int(),
  timeBonusPercent: z.number().int(), serverNow: z.iso.datetime(),
});
```
**Item order** in `items` is `shuffle(items, streamSeed(attempt.seed, evaluationId, "items"))` when
`settings.shuffleItems`; `position` stays the canonical position for grading and CSV export.

### 4.5 `grading`

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/evaluations/:id/grading/run` | T | `{ itemIds?: uuid[] }` | `202 { jobId }` — singleton per evaluation |
| GET | `/evaluations/:id/grading/progress` | T | — | `{ done, total, pending: { runner, llm }, failed }` |
| GET | `/evaluations/:id/grading` | T | `?by=question\|student&itemId&attemptId&state&anonymous=1` | `GradingQueue` |
| POST | `/answers/:answerId/gradings` | T | `{ points, comment: string (required), details? }` | `Grading` — manual, born `validated`, supersedes the previous (F-GRADE-05) |
| POST | `/gradings/:id/validate` | T | `{ points?, comment? }` | `Grading` |
| POST | `/evaluations/:id/grading/validate-batch` | T | `{ itemId?, state?: "proposed", confidence?: "high" }` | `{ validated: number }` |
| POST | `/evaluations/:id/items/:itemId/regrade` | T | `{ note, toVersionNumber? }` | `202 { jobId }` (F-GRADE-06) |
| POST | `/evaluations/:id/release` | T | `{ confirm: true }` | `{ releasedAt, rows: number }` |

```ts
export const GradingQueue = z.object({
  order: z.enum(["question", "student"]),
  items: z.array(z.object({ id, position, internalName, type, points })),
  entries: z.array(z.object({
    answerId: z.uuid(), attemptId: z.uuid(), itemId: z.uuid(),
    label: z.string(),          // pseudonym when anonymous=1, else display name
    answer: z.unknown().nullable(), student: z.unknown(), solution: z.unknown(),
    grading: z.object({ id, points, maxPoints, source, state, details, comment, confidence, gradedAt, regradeNote }).nullable(),
    history: z.array(z.object({ id, points, source, state, gradedAt, comment })),
  })),
  counts: z.object({ total: z.number(), validated: z.number(), proposed: z.number(), missing: z.number() }),
});
```

### 4.6 `results`

| Method | Path | Auth | Query | Response |
|---|---|---|---|---|
| GET | `/evaluations/:id/results` | T | — | `ResultsView { rows, stats, totalPoints, scale, released }` |
| GET | `/evaluations/:id/results.csv` | T | — | `text/csv; charset=utf-8` **with BOM**, `;` separator (F-RES-02) |
| GET | `/evaluations/:id/results/by-question` | T | — | `ByQuestion[] { item, student, solution, explanation, distribution, successRate, avgMs }` |
| GET | `/student/results` | Any | — | `ResultCard[]` |
| GET | `/attempts/:id/feedback` | S | — | `StudentFeedback = StudentResults \| FeedbackPending` (deviations W6-8, W6-9) |

```ts
export const ResultsView = z.object({
  totalPoints: z.number(), scale: GradingScale, released: z.boolean(), modifiedAfterRelease: z.boolean(),
  rows: z.array(z.object({ userId, displayName, email, attemptId: z.uuid().nullable(),
    perItem: z.record(z.string(), z.number()), points: z.number(), grade: z.number(),
    durationS: z.number().int().nullable(), state })),
  stats: z.object({ count, mean, median, stdev, min, max,
    histogram: z.array(z.object({ bucket: z.number(), count: z.number() })) }),  // buckets of 0.5 grade
});

export const StudentResults = z.object({
  evaluation: z.object({ id, title, releasedAt }),
  points: z.number(), totalPoints: z.number(), grade: z.number(),
  items: z.array(z.object({
    position: z.number().int(), points: z.number().nullable(), maxPoints: z.number(),
    student: z.unknown(),
    answer: z.unknown().nullable(),       // only if feedbackPolicy.showAnswer
    solution: z.unknown().nullable(),     // only if feedbackPolicy.showKey
    explanation: z.string().nullable(),   // only if feedbackPolicy.showExplanation
    details: z.unknown().nullable(),      // filtered: hidden case bodies removed
    comment: z.string().nullable(),       // only if feedbackPolicy.showTeacherComment
  })),
});
```
`studentResultsView()` in `modules/results/service.ts` is the **only** place where the feedback policy is applied,
and it is the second half of the §5.7 content gate. `details` filtering for `code`: hidden cases keep
`{ name, ok, points }` and lose `expected`/`actual`/`stderr` unless `showKey`.

CSV columns: `email;last_name;first_name;q1;q2;…;total;grade` — headers from `internal_name` truncated to 30 chars;
numbers with `.` decimal separator; `grade` at one decimal.

### 4.7 Autosave protocol (docs/05 §5.4) and the 410 rule

```ts
export const AutosaveRequest = z.object({
  payload: z.unknown(),                 // validated by type.answerSchema server-side
  revision: z.number().int().min(1),    // client-local monotonic counter
  clientTs: z.iso.datetime(),
});
export const AutosaveResponse = z.object({
  /** The revision now in the database. */
  revision: z.number().int(),
  /** Present ONLY when the write was rejected as stale: the client adopts it. */
  payload: z.unknown().optional(),
  accepted: z.boolean(),
  serverNow: z.iso.datetime(),
});
export const AttemptClosed = z.object({
  error: z.literal("attempt_closed"),
  reason: z.enum(["deadline", "submitted", "evaluation_closed", "paused"]),
  deadlineAt: z.iso.datetime().nullable(),
  serverNow: z.iso.datetime(),
});
```

Server algorithm (`modules/live/service.ts#saveAnswer`), one statement, no read-modify-write:
```sql
INSERT INTO answers (id, attempt_id, item_id, payload, revision, first_seen_at, updated_at)
VALUES ($id, $attempt, $item, $payload, $revision, now(), now())
ON CONFLICT (attempt_id, item_id) DO UPDATE
  SET payload = EXCLUDED.payload, revision = EXCLUDED.revision, updated_at = now()
  WHERE answers.revision < EXCLUDED.revision
RETURNING payload, revision;
```
- 0 rows returned ⇒ stale: re-select and answer `{ accepted:false, revision, payload }`.
- Gate **before** the write, in this order:
  1. attempt belongs to `req.user` — else `404`.
  2. `attempt.state !== "in_progress"` ⇒ `410 attempt_closed` (`submitted`).
  3. `evaluation.state === "paused"` ⇒ `410 attempt_closed` reason `paused` (client greys the UI; writes resume on `evaluation.state`).
  4. `evaluation.state` not in (`running`) ⇒ `410` reason `evaluation_closed`.
  5. `now() > attempt.deadline_at + interval '3 seconds'` ⇒ `410` reason `deadline` (F-LIVE-07).
     The 3 s grace is a **constant in `packages/domain/src/deadline.ts` (`GRACE_MS = 3000`)**, shared with the ticker.
  6. `type.answerSchema.safeParse(payload)` fails ⇒ `422 answer_invalid` (never persists garbage).
- On success: publish `dashboard.cell` through the 250 ms coalescer, return `{ accepted:true, revision, serverNow }`.

Client rules (`apps/web/src/attempt/autosave.ts`):
- debounce 300 ms per item; **at most one in-flight request per item**, the next waits with the latest payload;
- `revision` increments locally on every change, never resets;
- on network error: exponential backoff capped at 5 s, "offline" indicator after 3 s without ack, unacked payloads
  kept in memory and replayed on reconnect (N-RES-02);
- on `410`: stop all writes for that attempt, show "temps écoulé", switch to read-only;
- on `accepted:false`: adopt the server payload/revision for that item (last-writer-wins by revision).

### 4.8 SSE grammar (docs/05 §5.4) as zod

`GET /events?watch=evaluation:<uuid>` or `?watch=attempt:<uuid>` (omitted = user topics only).
Server verifies authorisation on the requested subject, then implicitly subscribes to `user:<id>` and,
for staff, `teacher:<id>` + `classroom:<id>` for every accessible classroom.
Named SSE events (`event: <name>\ndata: <json>`), `:ping` comment every 25 s, plus a `clock` every 10 s
(**every 1 s** while the watched subject is an `attempt` of a running evaluation — docs/07 §7.3).

```ts
// packages/contracts/src/realtime.ts
export const Topic = z.union([
  z.literal("admin"),
  z.templateLiteral([ "classroom:", z.string() ]),
  z.templateLiteral([ "teacher:",  z.string() ]),
  z.templateLiteral([ "user:",     z.string() ]),
  z.templateLiteral([ "evaluation:", z.string() ]),
  z.templateLiteral([ "attempt:",  z.string() ]),
]);

export const SnapshotEvent = z.object({ type: z.literal("snapshot"), serverNow: z.iso.datetime(),
  subject: z.string(), state: z.unknown() });                 // DashboardView | AttemptView | LobbyView
export const ClockEvent = z.object({ type: z.literal("clock"), serverNow: z.iso.datetime() });
export const EvaluationStateEvent = z.object({ type: z.literal("evaluation.state"),
  evaluationId: z.uuid(), state: EvaluationState,
  pausedAt: z.iso.datetime().nullable(), closesAt: z.iso.datetime().nullable(), serverNow: z.iso.datetime() });
export const AttemptDeadlineEvent = z.object({ type: z.literal("attempt.deadline"),
  attemptId: z.uuid(), deadlineAt: z.iso.datetime(), bonusS: z.number().int(),
  reason: z.enum(["teacher_extend","pause_resume","start"]) });
export const AttemptClosedEvent = z.object({ type: z.literal("attempt.closed"),
  attemptId: z.uuid(), closedBy: z.enum(["server","student","teacher"]) });
export const DashboardCellEvent = z.object({ type: z.literal("dashboard.cell"),
  evaluationId: z.uuid(), attemptId: z.uuid(), itemId: z.uuid(),
  status: z.enum(["empty","seen","in_progress","done"]), revision: z.number().int(),
  points: z.number().nullable(), summary: z.string().nullable() });
export const DashboardPresenceEvent = z.object({ type: z.literal("dashboard.presence"),
  evaluationId: z.uuid(), userId: z.uuid(), online: z.boolean(), lastSeenAt: z.iso.datetime() });
export const LobbyCountEvent = z.object({ type: z.literal("lobby.count"),
  evaluationId: z.uuid(), present: z.number().int(), enrolled: z.number().int() });
export const RunnerResultEvent = z.object({ type: z.literal("runner.result"),
  requestId: z.uuid(), itemId: z.uuid(),
  result: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), compile: z.object({ ok: z.boolean(), stderr: z.string() }),
               cases: z.array(z.object({ name: z.string(), ok: z.boolean(), stdout: z.string(),
                                         expected: z.string(), ms: z.number(), timedOut: z.boolean() })) }),
    z.object({ status: z.literal("unavailable") }),
    z.object({ status: z.literal("busy") }),
    z.object({ status: z.literal("error"), message: z.string() }),
  ]) });
export const GradingProgressEvent = z.object({ type: z.literal("grading.progress"),
  evaluationId: z.uuid(), done: z.number().int(), total: z.number().int(),
  phase: z.enum(["auto","runner","done"]) });
/** heig-classroom-style refresh hint, for everything that is not the live path. */
export const HintEvent = z.object({ type: z.literal("hint"),
  topics: z.array(z.string()), kinds: z.array(z.enum(["pool","evaluations","roster","results","grading","admin"])),
  notice: z.object({ kind: z.enum(["info","success","warning","error"]), message: z.string() }).nullish() });

export const ServerEvent = z.discriminatedUnion("type", [ SnapshotEvent, ClockEvent, EvaluationStateEvent,
  AttemptDeadlineEvent, AttemptClosedEvent, DashboardCellEvent, DashboardPresenceEvent, LobbyCountEvent,
  RunnerResultEvent, GradingProgressEvent, HintEvent ]);
export type ServerEvent = z.infer<typeof ServerEvent>;
```

Routing table (who receives what):

| Event | Published to | Coalescing |
|---|---|---|
| `snapshot` | the opening connection only | — |
| `clock` | every connection | 10 s (1 s on an `attempt:` subject of a running evaluation) |
| `evaluation.state` | `evaluation:<id>` | none |
| `attempt.deadline`, `attempt.closed` | `attempt:<id>` | none |
| `dashboard.cell` | `evaluation:<id>` **staff connections only** | 250 ms per `(attemptId,itemId)` |
| `dashboard.presence`, `lobby.count` | `evaluation:<id>` | 1 s |
| `runner.result` | `user:<id>` | none |
| `grading.progress` | `teacher:<id>` | 1 s |
| `hint` | any topic | none |

Server-side filtering: a connection carries a `Set<Topic>` **and a role flag**; `dashboard.*` is dropped for a
student connection even if it watches the same `evaluation:<id>` topic (a student in the lobby legitimately watches
`evaluation:<id>` for `lobby.count` and `evaluation.state`).

### 4.9 `admin`

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/admin/users?q&role` | A | `AdminUser[] { id, displayName, emails, role, lastLoginAt }` |
| POST | `/admin/users/:id/role` | A | `{ role }` → `AdminUser` (audited) |
| GET | `/admin/health` | A | `{ db: Check, runner: Check, disk: { freeBytes, totalBytes }, lastBackupAt }` |
| GET | `/admin/runner` | A | `{ ok, languages, queued, avgMs, errors24h, mode: "stub"\|"http" }` (F-ADMIN-02) |
| GET | `/admin/audit?limit&cursor&action&actorId` | A | `{ entries: AuditEntry[], nextCursor }` |

---

## 5. State machines and the grading flow

### 5.1 Evaluation state machine

```
                 ┌──────────────────────── teacher: reopen (no attempts) ───────┐
                 ▼                                                              │
draft ──schedule──▶ scheduled ──openLobby──▶ lobby ──start──▶ running ⇄ paused ─┘
  │                     │                      │                 │       │
  └────start (skip)─────┴──────────────────────┴─────────────────┘       │
                                                                  close  │ close
                                                                    ▼    ▼
                                                                  closed ──grade job──▶ grading ──all validated──▶ (closed, gradedAt set)
                                                                                                     │
                                                                                          teacher release
                                                                                                     ▼
                                                                                                 released
```

Stored as a single `evaluations.state` column. `grading` is entered automatically when the grading job starts and
left when it finishes; the UI shows `closed + progress`. `graded` from docs/01 §1.4 is **not** a stored state — it is
`state = 'closed' AND all answers have a validated grading`; see decision D6.

| Transition | Trigger | Preconditions | Side effects |
|---|---|---|---|
| `draft → scheduled` | teacher `POST /state {to:"scheduled"}` | ≥ 1 item, timing valid (`exam` needs `durationS` or `closesAt`, F-EVAL-04) | items frozen against further version updates once an attempt exists |
| `scheduled → lobby` | teacher, or ticker at `opensAt` when `settings.lobby !== "skip"` | — | students may join and see `LobbyView`; `lobby.count` starts |
| `lobby\|scheduled → running` | teacher `POST /start` (`lobby: manual`), or ticker (`lobby: auto` when present == enrolled, or `lobby: skip` at `opensAt`) | — | `started_at = now()`; for each present attempt: `state='in_progress'`, `started_at`, `deadline_at` computed; publish `evaluation.state` + `attempt.deadline` |
| `running → paused` | teacher `POST /pause` | mode `exam` only | `paused_at = now()`; autosave answers 410 `paused`; countdown frozen client-side |
| `paused → running` | teacher `POST /resume` | — | every `in_progress` attempt gets `deadline_at += (now − paused_at)`; publish `attempt.deadline` reason `pause_resume` |
| `* → closed` | teacher `POST /close`, or ticker at `closes_at`, or ticker when all attempts terminal | — | remaining `in_progress` → `expired`, `closed_by='server'`; enqueue `grading.evaluation` |
| `closed → released` | teacher `POST /release` | no `proposed` grading left (or forced with `?force=1`) | transaction: compute all grades, write `released_grades` + `released_at`, audit, `hint` to students |
| `released → released` | regrade after release | — | `modified_after_release = true`, `released_grades` recomputed |

### 5.2 Attempt state machine

```
not_started ──student opens/lobby join──▶ (row exists, state not_started)
not_started ──evaluation starts OR student enters a running evaluation──▶ in_progress
in_progress ──student POST /submit──▶ submitted            (closed_by = 'student')
in_progress ──ticker: now > deadline + 3 s──▶ expired      (closed_by = 'server')
in_progress ──teacher closes the evaluation──▶ expired     (closed_by = 'teacher')
submitted / expired: terminal, both gradable (docs/01 §1.4)
```

`deadline_at` at the transition to `in_progress` (`packages/domain/src/deadline.ts`):

| `settings.timing` | `deadline_at` |
|---|---|
| `duration` | `startedAt + durationS × (1 + bonusPercent/100) + extraS` |
| `deadline` | `closesAt + round((closesAt − opensAt) × bonusPercent/100) + extraS` |
| `manual` | `null` (only the teacher closes) |

Latecomers in `duration` mode get the **full** duration (docs/06 Q3). `extraS` accumulates teacher extensions.

### 5.3 What the ticker does (1 s period, `apps/api/src/ticker.ts`, advisory lock, adapted from heig-classroom)

```
every 1000 ms, under pg_try_advisory_lock:
 1. expire attempts:
    UPDATE attempts SET state='expired', closed_at=now(), closed_by='server'
     WHERE state='in_progress' AND deadline_at IS NOT NULL
       AND deadline_at + interval '3 seconds' <= now()
     RETURNING id, evaluation_id, user_id;
    → publish attempt.closed + dashboard.cell refresh
 2. open scheduled evaluations: scheduled → lobby at opens_at (lobby != 'skip')
                                scheduled → running at opens_at (lobby == 'skip')
 3. auto-start: lobby + settings.lobby == 'auto' + present == enrolled → running
 4. auto-close: running|paused with closes_at <= now()  → closed (+ enqueue grading)
                running with every attempt terminal      → closed (+ enqueue grading)
 5. presence sweep: mark connections silent > 45 s offline, publish dashboard.presence
```
Everything is an idempotent conditional UPDATE; re-running a tick is free, catching up after an outage is free.
Deadlines live in the database only (N-RES-04).

### 5.4 Grading job flow (docs/05 §5.6, adapted to the stub runner)

Queues (pg-boss): `grading.evaluation` (singleton key = evaluationId), `grading.answer`, `grading.runner`
(priority low, concurrency 2), `export.pool`.

```
POST /close  or  ticker auto-close
      └─▶ enqueue grading.evaluation { evaluationId }           (singletonKey = evaluationId)

grading.evaluation handler:
  for each (attempt × item) of the evaluation, in batches of 200:
     answer = answers row or null
     if a validated non-superseded grading already exists → skip     (idempotent)
     if answer is null →  write { source:'auto', state:'validated', points:0, details:{empty:true} }   (F-GRADE-01)
     else:
        config = loadConfig(type, version.config, version.config_version)
        r = await type.grade(config, answer.payload, ctx)            // ctx.runner = the configured RunnerService
        switch r.kind:
          'graded'  → insert grading (state = r.state ?? 'validated'), supersede any previous validated
          'pending' via 'runner' → enqueue grading.runner { answerId, request }
          'pending' via 'llm'    → insert { source:'llm', state:'proposed', points:0,
                                            comment:'llm_not_available' }    // MVP has no LLM
     publish grading.progress every 25 answers and at the end

grading.runner handler (concurrency 2, retryLimit 2, backoff 5 s):
  try     outcome = await runner.run(request)                → finalizeRunner → insert validated grading
  catch RunnerUnavailable → insert { source:'auto', state:'proposed', points:0,
                                     details:{ runner:'unavailable' }, comment:'runner_unavailable' }   (no retry)
  catch RunnerBusy        → throw (pg-boss retries with backoff)
  catch other             → after retries: insert { state:'proposed', points:0, details:{runner:'error'} }
```

Writing a grading is always the same transaction (`modules/grading/service.ts#writeGrading`):
```sql
BEGIN;
  UPDATE gradings SET state='superseded' WHERE answer_id=$1 AND state='validated';
  INSERT INTO gradings (…, supersedes_id = <the id just superseded>) VALUES (…);
COMMIT;
```
The partial unique index `(answer_id) WHERE state='validated'` makes a concurrent double-write fail loudly.

**Regrade** (`POST /items/:itemId/regrade`): optionally repoints `evaluation_items.question_version_id` to a newer
version, then enqueues `grading.evaluation` restricted to that item with `regradeNote = "re-graded with version N"`
stamped on every new grading; previous ones become `superseded`. If the evaluation was released,
`modified_after_release = true` and the release is recomputed.

**Manual override** always wins: `source:'manual'`, `state:'validated'`, comment mandatory (F-GRADE-05).

---

## 6. Web app

`apps/web/src/` keeps the heig-classroom skeleton: `main.tsx`, `App.tsx`, `Shell.tsx`, `Header.tsx`, `router.ts`,
`api.ts`, `i18n.tsx`, `theme.ts`, `notify.tsx`, `confirm.tsx`, `ui.tsx`, `style.css`, `mock/`, `scripts/screenshots.mjs`.
New code lives in feature folders: `pool/`, `evaluation/`, `live/`, `grading/`, `results/`, `student/`, `realtime/`.

> Superseded on 2026-09-23: `ui.tsx` is now `ui/{layers,controls,page,live,forms,state,combobox}.tsx` behind the `./ui` barrel (PRs #36, #41, #43, #47), `i18n.tsx` is `i18n/{en.ts,fr.ts,index.tsx}` (PR #56) and `mock/index.ts` is split by module (PR #24). The file names in §6 are those of the plan.

### 6.1 Routes (`router.ts`, extended union)

```ts
export type Route =
  | { view: "home" }                                              // role-dependent: TeacherHome | StudentHome
  | { view: "courses" } | { view: "course"; courseId: string }
  | { view: "classroom"; classroomId: string }
  | { view: "pool"; poolId: string; questionId?: string }
  | { view: "question"; questionId: string; tab: "edit" | "try" | "versions" }
  | { view: "evaluation"; evaluationId: string; tab: "questions" | "settings" | "attempts" }
  | { view: "live"; evaluationId: string }
  | { view: "grading"; evaluationId: string }
  | { view: "results"; evaluationId: string; tab: "students" | "questions" }
  | { view: "attempt"; evaluationId: string }                     // student: lobby OR player, server decides
  | { view: "studentResults"; attemptId: string }
  | { view: "settings" } | { view: "admin" };
```
Paths: `/courses/:id`, `/classrooms/:id`, `/pools/:id`, `/questions/:id`, `/evaluations/:id`,
`/evaluations/:id/live`, `/evaluations/:id/grading`, `/evaluations/:id/results`, `/take/:evaluationId`,
`/results/:attemptId`, `/settings`, `/admin`.

### 6.2 Teacher screens

| Screen | Mockup | Main components | `ui.tsx` primitives |
|---|---|---|---|
| **TeacherHome** `/` | — (derived from heig-classroom `TeacherHome.tsx`) | `CourseCard`, `RecentEvaluations`, `QuickStart` | `PageHeader`, `Card`, `Stat`, `EmptyState`, `Button` |
| **CourseView** `/courses/:id` | — | `ClassroomList`, `StaffSection`, `PoolLinks` | `PageHeader`, `SectionHeading`, `T` table, `Menu`, `Sheet` (add staff) |
| **ClassroomView** `/classrooms/:id` | — | `RosterTable` (reused), `RosterImport` (reused + bonus column), `EvaluationList`, `NewEvaluationSheet` | `Tabs`, `T`+`SortHeader`, `Sheet`, `useConfirm`, `Badge` |
| **PoolView** `/pools/:id` | `08-pool.html` | `CategoryTree` (left), `QuestionTable` (centre: name, type, difficulty 5-dot, tags, version, stats), `FilterBar` (`q`, type, tags, difficulty), `QuestionSidePanel` (right: prompt preview, versions, "Add to evaluation"), `BulkBar` (multi-select) | `SearchInput`, `Segmented`, `Badge`, `T`+`SortHeader`, `Menu`, `Sheet`, `Skeleton`, `EmptyState` |
| **QuestionEditor** `/questions/:id` | `01-editeur-qcm.html`, `02-editeur-code.html` | `EditorShell` (header: internal name, type badge, autosave state, `Publier` primary; tabs Edit / Try / Versions), `MarkdownField` (prompt), lazy `type.Editor`, `MetaPanel` (tags, difficulty, category, shuffleable), `PublishDialog` (change note + validation issues), `VersionHistory` (list + JSON diff), `TryPanel` (lazy `type.Player` + `type.Review` on `POST /try`) | `PageHeader`, `Tabs`, `Field`, `Select`, `Switch`, `Segmented`, `Badge`, `Alert`, `Modal`, `Sheet`, `Kbd` |
| **EvaluationConfig** `/evaluations/:id` | — (mockups 03/08 style) | 3-step layout per docs/08 §8.2: `ItemsStep` (ordered list, drag handle, points input, milestone toggle, "stale version" badge + update button, `AddQuestionsSheet` reusing `QuestionTable`), `TimingStep` (mode, timing, duration, opens/closes, lobby, navigation, presentation, shuffle — presets "Quiz noté 20 min" / "Exercice de la semaine"), `AdvancedDisclosure` (scale, feedback policy, access code, IP allowlist), `LaunchStep` (summary + `Démarrer`) | `Tabs`/`Segmented`, `Field`, `Select`, `Switch`, `SettingRow`, `Alert`, `Sheet`, `Stat` |
| **LiveDashboard** `/evaluations/:id/live` | `03-dashboard-live.html` | `LiveHeader` (title, countdown, `Pause`/`Reprendre`, `+1/+5/+10` menu, `Clôturer`), `ToggleBar` (names `n` / answers `r` / results `s` — `Switch`), `StudentGrid` (sticky first column, one `Cell` per item: shape+icon+tint, never colour alone), `TotalsRow`, `InspectModal` (a modal, every answer of one student stacked via `type.Review`, prev/next student; replaced the in-flow `InspectPanel`), `PresenceDot`, `Legend`, `FullscreenToggle` | `PageHeader`, `Switch`, `Menu`, `Badge`, `T`, `Tip`, `useConfirm`, `Progress`, `Spinner` |
| **GradingPanel** `/evaluations/:id/grading` | `04-correction.html` | `GradingHeader` (progress path of N items + neutral bar, single accent action = batch validate), `OrderSwitch` (by question / by student — `Segmented`), `AnonymousToggle`, `EntryList` and `EntryDetail` laid out as mockup `04-correction.html` has them — the question aside on the left, the entry list filling the page, and the detail expanding IN PLACE under the entry being graded rather than in a second column (answer via `type.Review`, per-case/per-blank detail, `Valider` + `v`/`→` shortcut; points and comment live in the override `Sheet`, deviation W10-5), `HistoryPopover` (superseded gradings), `RegradeSheet` | `Segmented`, `Switch`, `Field`, `Textarea`, `Button`, `Badge`, `Alert`, `Menu`, `Kbd`, `Progress` |
| **Results** `/evaluations/:id/results` | — | `ResultsTabs`, `GradeTable` (email, name, points, grade mono-tabular right-aligned, duration), `StatsRow` (`Stat` ×5), `Histogram` (svg, reuse `charts.tsx`), `ExportButton` (CSV), `ByQuestionView` (linear scroll: prompt, key, explanation, distribution bars, success rate) | `Tabs`, `T`+`SortHeader`, `Stat`, `Card`, `Button`, `EmptyState` |
| **AdminPanel** `/admin` | — (reused) | `UserTable` + role menu, `HealthCard`, `RunnerCard`, `AuditTable` | reused from heig-classroom |

### 6.3 Student screens

| Screen | Mockup | Main components | primitives |
|---|---|---|---|
| **StudentHome** `/` | `05-etudiant-accueil.html` | `OpenEvaluations` (card with countdown + single primary `Rejoindre`/`Commencer`), `UpcomingList`, `RecentResults` (grade mono right-aligned), `EmptyState` per course | `PageHeader`, `Card`, `Badge`, `Button`, `EmptyState`, `Stat` |
| **Lobby** `/take/:id` (state `lobby`) | `06-etudiant-attente.html` | `PresenceRing` (SVG ring, the only living element), `Instructions` (3 fixed lines), `TimeBonusBadge`, `ConnectionState`, discreet `Quitter` link, **no primary action** | new `Ring` component, `Badge`, `LinkButton` |
| **Player "zen"** `/take/:id` (state `running`) | `07-etudiant-zen.html` | `PlayerShell` (top: title, `Countdown`, `SyncState` icon+word, `ProgressSegments` 4 states clickable when navigation allows), lazy `type.Player`, `ItemFooter` (`Marquer comme faite` primary, prev/next `Alt+←/→`), `SubmitDialog`, `OfflineBanner`, `PausedOverlay`, `ExpiredOverlay` | `Button`, `Badge`, `Alert`, `Modal`, `useConfirm`, `Kbd`, new `Countdown`, `ProgressSegments`, `SyncBadge` |
| **StudentResults** `/results/:attemptId` | — (07 review variant) | `GradeHeader` (`Stat` points + grade), per-item `type.Review` cards with points badge, explanation block, teacher comment | `Card`, `Stat`, `Badge`, `Alert`, `EmptyState` |

### 6.4 New shared primitives to add (docs/07 §7.4 "à ajouter")

In `apps/web/src/ui.tsx` (or `packages/ui` if it exceeds ~6 components):
`Ring` (lobby progress ring), `Countdown` (server-clock driven), `Cell` (verdict shape+icon+tint),
`ProgressSegments`, `SyncBadge`, `MarkdownView` (sanitised + KaTeX), `PointsInput`, `DifficultyDots`,
`Pseudonym`. Each follows the hgc-ui rules: five states on every async surface, keyboard complete,
never colour alone, screenshot before "done".

### 6.5 Realtime client (`apps/web/src/realtime/`)

```
useEventStream(watch?: "evaluation:<id>" | "attempt:<id>")
  → EventSource("/events?watch=…"), parses ServerEvent with zod
  → "snapshot"        : seeds the TanStack Query cache for the watched subject
  → "clock"           : feeds useServerClock (median of the last 5 offsets, RTT/2 corrected)
  → live-domain events: applied directly to the cache with queryClient.setQueryData
  → "hint"            : invalidateQueries on the listed kinds (heig-classroom behaviour)
  → onerror           : EventSource reconnects natively; on reopen a fresh snapshot arrives
  + a 60 s safety refetch of the watched query (docs/05 §5.4 point 3)
useServerClock() → { serverNow(): number, offsetMs }
```

### 6.6 Code editor (Monaco), lazy

- `qt-code/src/Player.tsx` and `Editor.tsx` import Monaco through
  `const Monaco = lazy(() => import("./MonacoHost"))` inside an already-lazy client entry, so `monaco-editor`
  only enters a route that actually shows a code question (N-PERF-05).
- Use `@monaco-editor/react` with `loader.config({ paths: { vs: "/vendor/monaco/vs" } })` served from the same
  origin (N-SEC-02 CSP: no CDN). Bundled via `vite-plugin-monaco-editor` restricted to
  `["c","cpp","python","javascript","rust"]` languages and the `editor.main` worker only. No language server.
- Locked regions: one Monaco instance over the **assembled** template, with
  `editor.createDecorationsCollection` marking locked ranges `isWholeLine`, class `locked-region`
  (background `--surface-2`, `--fg-faint`), plus an `onDidChangeModelContent` guard that reverts an edit
  intersecting a locked range. Belt and braces: the server reassembles from the regions anyway.
- Fallback: if Monaco fails to load, render a `<textarea class="mono">` per editable region. The answer shape is
  identical, so nothing is lost.

### 6.7 Markdown editing in MVP — decision

**MVP ships a plain markdown textarea + live preview, not Tiptap.** Justification:

1. The single source of truth is markdown either way (docs/05 §5.10), so the WYSIWYG can be added later behind the
   existing `Source` toggle **without any data migration** — the field stays `string`.
2. Tiptap + `tiptap-markdown` + KaTeX + image-paste + table-paste is ~3 days of integration work and a permanent
   fidelity risk (round-tripping markdown through a ProseMirror document loses constructs). That risk is not on the
   MVP critical path: the MVP's goal is "run a graded quiz in class" (docs/00 §0.3).
3. The profane path is preserved cheaply with three affordances that cost hours, not days: a small toolbar
   (bold / italic / code / list / heading / link / image / equation) that inserts markdown at the cursor,
   **paste-an-image → upload → insert `![](asset:<id>)`**, and a side-by-side preview.
4. The renderer built for the preview is the same one used by the Player, the Review and the student results,
   so the sanitised + KaTeX pipeline is written once and is genuinely needed in MVP.

Concretely, `apps/web/src/markdown/`:
- `MarkdownView.tsx`: `unified` + `remark-parse` + `remark-math` + `remark-gfm` + `remark-rehype` +
  `rehype-katex` + **`rehype-sanitize` with a strict schema** (no raw HTML, `src` restricted to
  `/assets/…` same-origin, N-SEC-05) + `rehype-react`. Cloze sentinels are swapped for inputs by a
  custom `text` node handler.
- `MarkdownField.tsx`: `Segmented` "Écrire | Source | Aperçu", textarea in `JetBrains Mono`, toolbar,
  paste/drop image handler, `Ctrl+Shift+M` toggle persisted per user.
- `katex` CSS + fonts self-hosted.

Tiptap becomes **WP-later**, replacing only `MarkdownField`'s "Écrire" pane. Recorded as decision D11.

### 6.8 Command palette

`CommandPalette.tsx` + `commands.ts` + `fuzzy.ts` are **reused from heig-classroom**. MVP registers only:
navigation commands, "new question of type X", "new evaluation", pool search with `#tag` / `type:` / `diff:`
prefixes, and the contextual evaluation actions (start / pause / +5 min / close / release) when the live screen
is mounted. That is ~80 lines on top of an existing component; the `S`-priority full palette is deferred.

---

## 7. `packages/domain` — pure functions (no DB, no I/O, 100 % unit-tested)

```
packages/domain/src/
  grade.ts            Swiss scale
  deadline.ts         deadline & grace computation, time bonus
  mcqScore.ts         the three policies
  cloze.ts            parser + grader
  short.ts            normalisation + matchers
  compareOutput.ts    code output comparison
  lockedTemplate.ts   @@lock split / assemble
  roster.ts           (reused from heig-classroom, + timeBonusPercent column)
  stats.ts            mean / median / stdev / histogram / distribution
  pseudonym.ts        deterministic adjective+animal from a seed
  round.ts            round2, roundToTenth
  index.ts
```

### 7.1 Swiss grade scale (F-RES, F-EVAL-10)

```ts
export type Rounding = "nearest" | "up" | "down";
export type Scale =
  | { kind: "linear"; rounding?: Rounding }
  | { kind: "threshold"; threshold: number; rounding?: Rounding };

export const MIN_GRADE = 1;
export const MAX_GRADE = 6;

/** Rounds to one decimal, half away from zero (never banker's rounding). */
export function roundToTenth(x: number, mode: Rounding = "nearest"): number {
  const scaled = x * 10;
  const r = mode === "up" ? Math.ceil(scaled - 1e-9)
          : mode === "down" ? Math.floor(scaled + 1e-9)
          : Math.round(scaled + (scaled >= 0 ? 1e-9 : -1e-9));
  return r / 10;
}

/**
 * points → Swiss grade 1.0 … 6.0 at 0.1.
 *  linear    : 1 + 5 · points / total
 *  threshold : 1 + 5 · points / threshold, capped at 6 (the threshold is the
 *              point count that earns a 6; anything above is still a 6).
 * total <= 0 ⇒ 1.0. Negative points (allowNegative) clamp to 1.0.
 */
export function gradeFromPoints(points: number, total: number, scale: Scale): number {
  const base = scale.kind === "threshold" ? scale.threshold : total;
  if (!(base > 0)) return MIN_GRADE;
  const raw = 1 + 5 * (points / base);
  return Math.min(MAX_GRADE, Math.max(MIN_GRADE, roundToTenth(raw, scale.rounding ?? "nearest")));
}
```
Tests: `0/20 → 1.0`, `12/20 linear → 4.0`, `20/20 → 6.0`, `18/20 threshold 18 → 6.0`, `19/20 threshold 18 → 6.0`,
`9/20 threshold 18 → 3.5`, `-2/20 → 1.0`, `3/7 linear → 3.1` (rounding), `total 0 → 1.0`.

### 7.2 Cloze parser — see §2.3. Public surface:
```ts
export function parseCloze(text: string): ClozeParse;
export function clozeStudentTemplate(parse: ClozeParse, seed: number, itemId: string, shuffle: boolean): ClozeStudent;
export function gradeCloze(parse: ClozeParse, blanks: (string | null)[], caseSensitive: boolean): ClozeGrade;
```
Tests: every row of the docs/04 §4.6 table, `\{{` escape, `\|` inside an alternative, a blank inside a fenced
code block, an unterminated `{{`, weights summing correctly, a select with two `=` options, empty answers.

### 7.3 MCQ policies
```ts
export function mcqFraction(input: {
  correct: readonly number[]; selected: readonly number[];
  choiceCount: number; policy: McqPolicy; penalty: number; allowNegative: boolean;
}): { fraction: number; c: number; w: number; C: number; W: number };
```
Tests: the three policies × (all right / all wrong / partial / nothing selected / everything selected),
`W = 0` guard for `penalized`, `allowNegative` floor at −1, `C = 0` impossible (schema refine).

### 7.4 Time bonus and deadline
```ts
export const GRACE_MS = 3000;
export function attemptDeadline(input: {
  timing: "duration" | "deadline" | "manual";
  startedAt: Date; durationS: number | null;
  opensAt: Date | null; closesAt: Date | null;
  timeBonusPercent: number; extraS: number;
}): Date | null;
export function bonusSeconds(input: { timing; durationS; opensAt; closesAt; timeBonusPercent }): number;
export function isWritable(deadline: Date | null, now: Date): boolean;   // now <= deadline + GRACE_MS
```
Tests: 0 % bonus, 33 % on 30 min = 40 min, deadline mode extension based on `closesAt − opensAt`,
`manual` ⇒ null, extension accumulation, grace boundary at exactly +3000 ms and +3001 ms.

### 7.5 Seeded shuffle — `shuffle`/`streamSeed` live in `@quiz/core/rng` and are re-exported by domain
(`packages/domain` depends on `packages/core`; core depends on nothing but zod). Tests: same seed ⇒ same output,
different seed ⇒ different output for n ≥ 4 in ≥ 99 % of seeds, permutation property, empty/1-element arrays,
stability across Node and jsdom.

### 7.6 Stats
```ts
export function describe(values: number[]): { count; mean; median; stdev; min; max };
export function histogram(grades: number[], step = 0.5): { bucket: number; count: number }[];   // 1.0 … 6.0
export function mcqDistribution(answers: { selected: number[] }[], choiceCount: number): number[];
```

---

## 8. Work breakdown for parallel agents

Dependency graph:

```
WP0 skeleton (already running, another agent)
  ├─ WP1 core + domain ──┬─ WP2 qt-mcq/short/cloze ─┐
  │                      ├─ WP3 qt-code + runner IF ┤
  │                      └─ WP4 api pool ───────────┤
  ├─ WP4 ── WP5 api evaluation+live+realtime ── WP6 api grading+results
  └─ (contracts: authored inside WP4/WP5/WP6, consumed by WP7..WP10)

WP7 web pool/editors      ← WP2, WP3, WP4
WP8 web evaluation+dash   ← WP5
WP9 web student player    ← WP5, WP2, WP3
WP10 web grading/results  ← WP6
WP11 runner service       ← WP3 (contract only) — fully parallel, needs a machine with Podman
WP12 e2e + screenshots    ← all
```

Rule for every WP: **`pnpm build && pnpm typecheck && pnpm test && pnpm lint` green before hand-off.**
Rule for web WPs: a screenshot at 1440×900 and 390×844, light and dark, per screen (hgc-ui rule).
Rule for contracts: a route is not "done" until its zod schemas are exported from `@quiz/contracts` and used by
**both** sides.

---

### WP1 — `packages/core` + `packages/domain` + `packages/registry` skeleton

| | |
|---|---|
| **Inputs** | §1, §7 of this plan; heig-classroom `packages/domain` for style |
| **Outputs** | Published contract every other WP compiles against |
| **Files** | `packages/core/src/{contract,client,registry,rng,errors,runner,index}.ts`; `packages/domain/src/{grade,deadline,mcqScore,cloze,short,compareOutput,lockedTemplate,stats,pseudonym,round,index}.ts`; `packages/registry/src/{server,client}.ts` (initially empty maps behind a TODO); `packages/*/package.json`, `tsconfig.json`, `vitest.config.ts` |
| **DoD** | All §7 functions implemented and exported; `QuestionTypeServer`/`Client` compile; `defineServerRegistry` typed; the whole package tree builds with `"moduleResolution": "bundler"` and dual `./server` `./client` exports |
| **Tests** | 100 % line coverage on `packages/domain` (enforced in `vitest.config.ts`); RNG determinism test with a golden permutation table; `roundToTenth` boundary table; cloze parser table from docs/04 §4.6 |
| **Non-goals** | No qt package, no React component |

### WP2 — `qt-mcq`, `qt-short`, `qt-cloze` (server + client)

| | |
|---|---|
| **Inputs** | WP1; §2.1–2.3 |
| **Outputs** | Three packages registered in `packages/registry` |
| **Files** | per package: `src/schema.ts`, `src/grade.ts`, `src/server.ts`, `src/client.tsx`, `src/Editor.tsx`, `src/Player.tsx`, `src/Review.tsx`, `src/Stats.tsx` (mcq only), `src/canonical.ts`, `src/*.test.ts`, `package.json` with `exports { "./server", "./client" }` |
| **DoD** | `emptyDraft()` output validates; `toStudent` leak test green; graders handle `answer === null`; Editors autosave via `onChange` only (no internal fetch); Players are controlled components; `migrate(cfg, 1)` is identity |
| **Tests** | per type: config schema accept/reject table (≥ 10 cases), grading truth table (mcq: 3 policies × 5 selections; short: one case per matcher kind × match/near-miss/miss; cloze: 8 syntax rows + weights + shuffle stability), `toStudent` blacklist + secret-value search, `Editor`/`Player` Testing-Library smoke test (render, type, onChange fired) |
| **Non-goals** | No Monaco, no LLM matcher implementation (schema only, rejected at publish) |

### WP3 — `qt-code` + the runner interface and its stub

| | |
|---|---|
| **Inputs** | WP1; §2.4, §1.7 |
| **Outputs** | `packages/qt-code`; `apps/api/src/modules/runner/{index,http,unavailable}.ts` |
| **Files** | `qt-code/src/{schema,grade,server,client,Editor,Player,Review,MonacoHost,canonical}.tsx`; `apps/api/src/modules/runner/*`; `packages/core/src/runner.ts` finalised |
| **DoD** | `grade()` returns `pending: runner` with a request assembled server-side; `finalizeRunner()` is pure and fully testable with a fixture `RunnerOutcome`; `RUNNER_MODE=stub` is the dev default and the whole system works with it; `POST /attempts/:id/run` returns `503 runner_unavailable` cleanly; Monaco loads lazily and locked regions are non-editable |
| **Tests** | `splitTemplate`/`assembleSource` (no markers, nested, wrong region count, every language comment style); `compareOutput` matrix (trailing WS, case, numeric abs/rel, token-count mismatch); `finalizeRunner` on: compile failure, all pass, partial, timeout, OOM, `allOrNothing`; `UnavailableRunner` throws `RunnerUnavailable`; `HttpRunner` against a `msw`/`undici` mock (200, 429, 503, timeout) |
| **Non-goals** | The actual container engine (WP11); `tap` mode; codeimage |

### WP4 — `apps/api` module `pool` (+ `org` completion) + `packages/contracts` for both

| | |
|---|---|
| **Inputs** | WP1, WP2, WP3 (registry filled); §3.2, §4.1, §4.2 |
| **Outputs** | Working pool API on a PGlite test DB |
| **Files** | `apps/api/src/db/{pool,org}.ts`, `db/schema.ts`; `apps/api/src/modules/pool/{routes,service,events}.ts`; `modules/org/{routes,service}.ts`; `modules/assets.ts`; `packages/contracts/src/{org,pool,common}.ts`; `apps/api/drizzle/0002_quiz.sql` (pool part) |
| **DoD** | Draft autosave stores invalid configs with `issues`; publish is transactional and guarded by the partial unique index; version restore/deprecate work; search returns by tag/type/difficulty/text; asset upload dedupes by sha256 and serves same-origin; every route validated by a contracts schema; `staffAccess`-equivalent guard (`poolAccess`, `courseAccess`) returns 404 not 403 |
| **Tests** | `pool.db.test.ts`: publish → number 1, publish again → 2, concurrent publish → one wins; draft/publish round-trip through `migrate`; soft delete + `409 in_use`; search ranking; roster import merge with the extra column; `POST /questions/:id/try` grades with the stub runner |
| **Non-goals** | Canonical YAML export, pool sharing, API tokens |

### WP5 — `apps/api` modules `evaluation` + `live` + `realtime` + ticker

| | |
|---|---|
| **Inputs** | WP4; §3.3, §3.4, §4.3, §4.4, §4.8, §5.1–5.3 |
| **Outputs** | A quiz can be configured, started, taken, autosaved and closed, with SSE |
| **Files** | `db/{evaluation,live}.ts`; `modules/evaluation/{routes,service}.ts`; `modules/live/{routes,service,studentView,events}.ts`; `modules/realtime/{routes,bus,coalesce,presence}.ts`; `ticker.ts`; `packages/contracts/src/{evaluation,live,realtime}.ts` |
| **DoD** | Full state machine of §5.1 with every guard; `deadline_at` computed by `@quiz/domain`; autosave exactly as §4.7 including the three 410 reasons and the stale-revision path; `studentView()` is the only path producing student configs and is covered by the registry-wide leak test; SSE emits `snapshot` on connect, `clock` at 10 s / 1 s, coalesces `dashboard.cell` at 250 ms, and filters `dashboard.*` away from student connections; ticker expires attempts within 1 s + 3 s grace |
| **Tests** | `evaluation.db.test.ts` (state machine, item freeze, update-versions blocked by attempts); `live.db.test.ts` (attempt idempotent creation, autosave revision race with two concurrent writes, 410 at deadline + grace boundary, pause/resume shifts deadlines, extend all vs one); `ticker.test.ts` (expire, auto-open, auto-close, idempotent re-tick); `realtime.test.ts` (topic authorisation, coalescer emits once per window, snapshot shape) |
| **Non-goals** | Grading, results, poll mode |

### WP6 — `apps/api` modules `grading` + `results` + jobs

| | |
|---|---|
| **Inputs** | WP5; §3.5, §4.5, §4.6, §5.4, §7.1 |
| **Outputs** | Close → auto grading → panel → release → CSV |
| **Files** | `db/grading.ts`; `modules/grading/{routes,service,jobs}.ts`; `modules/results/{routes,service,csv}.ts`; `jobs.ts` (queue names); `packages/contracts/src/{grading,results}.ts` |
| **DoD** | `grading.evaluation` is a pg-boss singleton per evaluation and idempotent; missing answers graded 0 validated; runner-pending answers go through `grading.runner` and degrade to `proposed + runner_unavailable` under the stub; manual override requires a comment and supersedes; regrade stamps `regradeNote` and flips `modified_after_release`; release writes `released_grades` in one transaction; CSV has a UTF-8 BOM and `;` |
| **Tests** | `grading.db.test.ts` (run twice → no duplicate gradings; supersede chain; partial unique index enforced; batch validate filter); `regrade.db.test.ts`; `results.test.ts` (grade table against §7.1 fixtures, stats, CSV bytes start with `EF BB BF`, student feedback filtering per policy — key hidden, hidden case bodies stripped) |
| **Non-goals** | LLM grading, flags, item analysis |

### WP7 — Web: pool, question editors, try panel

| | |
|---|---|
| **Inputs** | WP2, WP3, WP4; mockups `08-pool.html`, `01-editeur-qcm.html`, `02-editeur-code.html`; §6.2, §6.7 |
| **Outputs** | A teacher can author and publish all 4 types |
| **Files** | `apps/web/src/pool/{PoolView,CategoryTree,QuestionTable,FilterBar,QuestionSidePanel,BulkBar}.tsx`; `apps/web/src/question/{QuestionEditor,MetaPanel,PublishDialog,VersionHistory,TryPanel}.tsx`; `apps/web/src/markdown/{MarkdownView,MarkdownField,katex.css}.tsx`; `apps/web/src/questionTypes.ts` (client registry hookup); i18n keys |
| **DoD** | Each type's `Editor` mounted lazily; draft autosaves 500 ms after the last keystroke with a visible state (`Enregistré` / `Non enregistré` / `Hors ligne`); publish shows zod issues inline; Try panel grades through `POST /try` and renders `Review`; markdown preview sanitised with KaTeX; image paste uploads and inserts; 5 states per async surface; screenshots captured |
| **Tests** | Testing Library: create → edit → publish flow per type with an MSW-mocked API; filter bar composes query params; `MarkdownView` sanitisation test (`<script>`, `onerror=`, external `src` all stripped); keyboard: `Ctrl+S`, `Ctrl+Shift+P`, `Ctrl+Shift+M` |

### WP8 — Web: evaluation config + live dashboard

| | |
|---|---|
| **Inputs** | WP5; mockup `03-dashboard-live.html`; §6.2 |
| **Outputs** | A teacher configures, starts, supervises and closes a quiz |
| **Files** | `apps/web/src/evaluation/{EvaluationConfig,ItemsStep,TimingStep,AdvancedDisclosure,AddQuestionsSheet,LaunchStep}.tsx`; `apps/web/src/live/{LiveDashboard,StudentGrid,Cell,ToggleBar,InspectModal,LiveHeader,Legend}.tsx`; `apps/web/src/realtime/{useEventStream,useServerClock}.ts`; new `ui.tsx` primitives (`Cell`, `Countdown`, `Ring`) |
| **DoD** | The three-screen flow of docs/08 §8.2 with the named presets; stale-version badges and one-click update; dashboard applies `dashboard.cell` / `presence` events to the cache without refetch; toggles `n`/`r`/`s` and `Space` for pause; inspection panel is **in-flow**, not a modal; fullscreen mode; grid stays usable at 30 students × 12 questions (sticky first column, horizontal scroll, no layout thrash) |
| **Tests** | Reducer test for the event→grid application (cell update, presence, out-of-order revision ignored); `useServerClock` offset median test with synthetic clock skew; keyboard shortcut tests; snapshot-seeded render test |

### WP9 — Web: student home, lobby, zen player

| | |
|---|---|
| **Inputs** | WP5, WP2, WP3; mockups `05`, `06`, `07`; §6.3 |
| **Outputs** | A student takes a quiz end to end |
| **Files** | `apps/web/src/student/{StudentHome,Lobby,Player,PlayerShell,ProgressSegments,SubmitDialog,OfflineBanner,PausedOverlay}.tsx`; `apps/web/src/attempt/{autosave.ts,useAttempt.ts}`; `ui.tsx` additions (`SyncBadge`, `ProgressSegments`, `Ring`, `Countdown`) |
| **DoD** | Autosave exactly as §4.7 client rules (300 ms debounce, one in-flight per item, local revision, backoff, offline after 3 s, replay on reconnect, stop on 410); reload restores answers and position (F-LIVE-06); countdown driven by the server clock; `forward_only` and `milestones` enforced client-side **and** server-side; keyboard complete (`Alt+←/→`, `Ctrl+Enter`); works at 360 px; code player runs visible cases and shows stdin / expected / got / verdict, and degrades gracefully when the runner is unavailable |
| **Tests** | `autosave.test.ts` with fake timers: debounce, single flight, stale adoption, 410 stop, offline/online transitions; player reducer tests; a jsdom "reload" test restoring state from `GET /attempts/:id`; axe check on the player |

### WP10 — Web: grading panel + results + export

| | |
|---|---|
| **Inputs** | WP6; mockup `04-correction.html`; §6.2 |
| **Outputs** | A teacher validates, overrides, regrades, releases and exports |
| **Files** | `apps/web/src/grading/{GradingPanel,EntryList,EntryDetail,HistoryPopover,RegradeSheet,BatchBar}.tsx`; `apps/web/src/results/{ResultsView,GradeTable,StatsRow,Histogram,ByQuestionView,ExportButton}.tsx` |
| **DoD** | By-question and by-student traversal, anonymous by default; one accent action only (batch validate); per-criterion / per-case / per-blank detail always shown, never a bare score; `v` + `→` validates and advances; override requires a comment; release behind `useConfirm` naming the evaluation; CSV downloads with the right headers; histogram and stats match `@quiz/domain` |
| **Tests** | Panel navigation and keyboard tests; override form validation; MSW-mocked release flow; `ByQuestionView` distribution rendering for mcq/short/cloze/code |

### WP11 — `apps/runner` (HTTP service, Podman)

| | |
|---|---|
| **Inputs** | `packages/core/src/runner.ts` (WP3) only — **no dependency on any other WP** |
| **Outputs** | A container-backed implementation of `POST /run` |
| **Files** | `apps/runner/src/{server,engine,queue,limits}.ts`; `apps/runner/images/{c,cpp,python,js,rust}/Containerfile`; `apps/runner/infra/seccomp/codespace.json` (copied); `deploy/compose.prod.yml` addition |
| **DoD** | Implements the `RunnerRequest`/`RunnerOutcome` contract byte for byte; two queues (`interactive` priority over `grading`), configurable concurrency (default 4), `429` beyond the queue depth limit; hardening flags from `apps/codespace/images/c-dev/run-hardened.sh` (`--network none`, `--read-only`, `--tmpfs /work:size=32m`, `--memory`, `--cpus 1`, `--pids-limit 64`, `--userns=auto`, `--cap-drop ALL`, `--security-opt no-new-privileges`, seccomp profile, `--runtime runsc` when available); wall clock enforced by the service, output truncated at `outputKb`; `GET /health` returns languages and queue stats |
| **Tests** | Per language: hello-world, compile error, infinite loop → `timedOut`, memory bomb → `oom`, output flood → `truncated`, network attempt → fails, `/etc/passwd` write → fails; N-PERF-04 load test (30 runs in 10 s under 5 s p95) |
| **Blocked by** | Needs a machine with Podman. **Everything else ships without it** thanks to `RUNNER_MODE=stub`. |

### WP12 — e2e, mock browser, screenshots, ops

| | |
|---|---|
| **Inputs** | WP7–WP10 |
| **Outputs** | Confidence + the deployable artifact |
| **Files** | `apps/web/src/mock/` fixtures for every new screen; `apps/web/scripts/screenshots.mjs` updated; `e2e/*.spec.ts` (Playwright); `deploy.sh` guard "refuse if an evaluation is running/lobby"; `docs/OPERATIONS.md` |
| **DoD** | One e2e per main journey (N-QUAL-02): teacher authors + publishes a question; teacher configures and starts a quiz; student takes it with a simulated disconnection; teacher closes, grades, releases; student reads their feedback. `dev:mock` renders every screen with `?as=teacher` / `?as=student` and no backend |
| **Tests** | The e2e themselves; screenshot diff for the 10 mockup-backed screens in light and dark |

**Suggested wave plan for parallel agents**
- Wave A (parallel): WP1, WP11 (contract-only start).
- Wave B: WP2, WP3, WP4.
- Wave C: WP5, WP7.
- Wave D: WP6, WP8, WP9.
- Wave E: WP10, WP12.

---

## 9. Open decisions (spec silent or contradictory)

| # | Question | Decision | Rationale |
|---|---|---|---|
| **D1** | docs/05 says the two registries live in `packages/core`, but `core` cannot import `qt-*` without a package cycle | Contract + RNG in `packages/core`; the static wiring moves to `packages/registry` (`./server`, `./client`) | Breaks the cycle without changing the "static import, two registries" property; adding a type still means "create the package, register it in two places" |
| **D2** | `GradeResult` shape: docs/04 says `{points,maxPoints,details}` or `{pending:'runner'\|'llm'}` | Discriminated union on `kind: "graded" \| "pending"`, plus an optional `state` on `graded` and a `finalizeRunner` second half | A bare `{pending}` cannot carry the assembled runner request; splitting grading into `grade` + `finalizeRunner` makes the code grader unit-testable with zero infrastructure |
| **D3** | MCQ answer indices leak the canonical order if exposed after shuffling | Expose the canonical index as `choices[].id` while shuffling the array order | Indices reveal nothing (correctness is not exposed); the alternative (opaque per-attempt tokens) needs server-side state for no security gain |
| **D4** | Cloze answer encoding for dropdown blanks | `select` blanks store the **canonical option index as a decimal string**; other blanks store the typed string | Keeps `blanks: string[]` as the spec says, while making the stored answer independent of the shuffle |
| **D5** | How a cloze blank is rendered inside markdown (and inside fenced code) | Parser emits a template with sentinels `⟦b<i>⟧` (U+2E22/U+2E23); the markdown renderer swaps sentinel text nodes for input components, including inside code blocks | Preserves markdown block structure; a per-segment render would break lists, tables and code fences |
| **D6** | docs/01 lists a `graded` evaluation state; docs/05 has no column for it | Stored states are `draft, scheduled, lobby, running, paused, closed, grading, released`. "graded" is derived (`closed` + no `proposed` grading left) and shown as a badge | Avoids a state that no transition can reliably enter or leave (a single regrade would invalidate it) |
| **D7** | `poll` mode is Phase 2 but the `mode` enum includes it | Column and enum accept `poll`; every `poll` code path returns `501 not_implemented` in MVP. **Partially lifted**: the `poll` module (ADR-014) now creates and runs `poll` evaluations through its own routes (`POST /app/api/polls`, `/app/api/p/:code`, `/app/api/evaluations/:id/poll/*`); the GENERIC create route still refuses `mode: "poll"`, so a poll is only ever born through the launcher | No migration later, no dead UI now — and one door into the mode rather than two, since a poll needs its single item, its session code and its immediate start in the same call |
| **D8** | Time-bonus base in `deadline` timing mode (F-EVAL-05 says "extends the individual end" without saying of what) | Extension = `(closesAt − opensAt) × bonus/100`, added to `closesAt` | Uses the announced common duration, so two students with the same accommodation get the same extension regardless of when they started |
| **D9** | Case-insensitive `exact`/cloze comparison and accents | `toLocaleLowerCase("fr")` on both sides; accents **remain significant** | "Galilée" ≠ "Galilee" is the pedagogically correct default for a French-language course; a teacher who disagrees adds an alternative or a regex |
| **D10** | Regex ReDoS in `short`/`cloze` | Pattern ≤ 300 chars, input ≤ 500 chars, flags restricted to `imsu`, compiled once at publication (invalid = publication error), executed in the grading worker (not the request path) | Bounded input makes catastrophic backtracking a worker-level slowdown at worst, not a request-path DoS. Revisit with `re2` if a real case appears |
| **D11** | Tiptap WYSIWYG in MVP (docs/05 §5.1 asks for it, F-QST-06 is M) | **MVP ships a markdown textarea + toolbar + live sanitised preview + image paste**, with the `Source` toggle already in place; Tiptap replaces only the "Écrire" pane later | Markdown is the single source of truth either way, so the upgrade needs no data migration; Tiptap round-tripping is ~3 days and a fidelity risk, off the critical path of "run a graded quiz" |
| **D12** | Where the `+3 s` grace constant lives | One exported constant `GRACE_MS` in `@quiz/domain/deadline`, used by the ticker **and** the autosave gate | The two must never drift; a student writing at deadline+2.9 s must be accepted by the same rule the ticker uses |
| **D13** | Points rounding granularity | `numeric(6,2)`, grader output `round2()`; grades rounded to 0.1 half-away-from-zero | Two decimals survive `partial`/`penalized` fractions without surprising the teacher; `Math.round` on negatives would round −0.5 toward zero, hence the explicit half-away rule |
| **D14** | Runner default in dev and CI | `RUNNER_MODE=stub` (an `UnavailableRunner` that throws), `http` only when `RUNNER_URL` is set; grading degrades to `proposed + runner_unavailable`, never blocks | The dev machine has no container engine; a code question must still be authorable, playable and releasable |
| **D15** | Hidden test cases during an attempt | The student sees `hiddenCount` and `hiddenPoints` but no name, stdin or expected; names + verdicts appear in the feedback when `feedbackPolicy.showHiddenCaseNames` (docs/06 Q8) | Lets a student reason about the scale without exposing the key |
| **D16** | Invalid drafts | `PUT /draft` **stores** an invalid config and returns `issues[]`; `configSchema.parse` is enforced only at publish | F-QST-02 says every change is auto-saved; a teacher must be able to leave a question half-written |
| **D17** | Autosave during `paused` | `410 attempt_closed` with `reason:"paused"`, client greys out and buffers locally, resends on `evaluation.state → running` | Pausing must actually stop work; nothing is lost because the client keeps the unacked payload (N-RES-02) |
| **D18** | Public API surface | One surface `/api/v1` serving cookie sessions now and bearer tokens later — not a separate `/app` prefix | docs/08 §8.1 principle 4: "everything the UI does, the API does". Avoids two route trees |
| **D19** | Attempt seed | `int4` drawn at attempt creation; all permutations derived as `hashSeed(seed, itemId, purpose)`, never stored | Reload, teacher preview and regrade reproduce the student's exact view; one integer instead of N stored permutations |
| **D20** | Grid pseudonyms (F-DASH-02 "stable pseudonym per row") | Deterministic adjective+animal from `hashSeed(evaluationId, userId)` in `@quiz/domain/pseudonym` | Stable across reloads and across the dashboard/grading panel, and not reversible without the evaluation id |

---

## 10. Quick reference for implementing agents

- Read **this file**, then `docs/07` (what already exists), then the mockup for your screen. Do **not** re-read the
  whole spec.
- Never write a raw jsonb config: go through `loadConfig` / `saveConfig` (§1.6).
- Never build a student payload by hand: go through `studentView()` (`modules/live/service.ts`), which calls
  `type.toStudent` and strips core metadata.
- Never compute a grade in a route: `@quiz/domain/grade#gradeFromPoints`.
- Never compute a deadline in a route: `@quiz/domain/deadline#attemptDeadline`, `GRACE_MS`.
- Never publish an event directly: `modules/realtime/bus.ts#publish`.
- Never read a module's `routes.ts` from another module: call its `service.ts`.
- A table belongs to exactly one module; other modules read it by join, never write it.
- Code, comments, commits and docs in English; UI strings through `t()` in `fr` + `en`.

---

## Deviations

Append-only log of places where the implementation departs from the plan above.
Each entry names the work package, what changed and why. Everything not listed
here follows §1–§10 verbatim.

### WP1 — `packages/core`, `packages/domain`, `packages/registry`

| # | Plan | Implemented | Why |
|---|---|---|---|
| W1-1 | §1 lists `packages/core` exports `.` and `./client` | `./server`, `./client` and `./rng` | The WP1 brief requires an explicit `./server` entry; `./rng` makes the `@quiz/core/rng` import path of §7.5 real. `.` was a byte copy of `./server` that nothing ever imported and is gone (audit P-18) |
| W1-2 | §7.1 puts `roundToTenth` in `grade.ts`, the §7 file list puts it in `round.ts` | `round.ts` owns `Rounding`, `roundToTenth`, `round2` and `clamp`; `grade.ts` imports them | The two statements contradict each other and a symbol cannot be exported twice through `index.ts` |
| W1-3 | §1.1 exports `shuffle` | `shuffle`, plus `seededShuffle` as a documented alias | The WP1 brief names the function `seededShuffle`; both names denote the same function, so neither WP2..WP6 nor the supervisor has to adapt |
| W1-4 | §1.5 `makeLookup(m: Record<string, T>)` | `makeLookup(m: Readonly<Record<string, T \| undefined>>)` | A registry that is still empty (or partial until WP3 lands) is typed `Partial<Record<QuestionTypeId, …>>`, which does not satisfy `Record<string, T>` under `exactOptionalPropertyTypes`. A full registry is still accepted unchanged |
| W1-5 | §1.5 declares `QUESTION_TYPE_IDS` in `packages/registry/src/server.ts` | Declared in `@quiz/core` (it is the source of the `QuestionTypeId` union) and re-exported by `@quiz/registry/server` **and** `@quiz/registry/client` | Keeps the constant and the union from drifting. The import path named in the plan keeps working |
| W1-6 | §1 file list names three error types | Adds `RunnerBusy` and an abstract `QuizCoreError` base | §1.7 requires the runner to throw `RunnerBusy` on a 429; the base class gives the API one `instanceof` to map to a status |
| W1-7 | §1.2/§1.3 use `LlmGradeRequest` and `LlmService` without defining them | Minimal shapes in `packages/core/src/llm.ts`, marked Phase 2 | `GradeResult` and `GradeContext` do not compile without them. Phase 2 may change the shapes freely; nothing in the MVP constructs one |
| W1-8 | The WP1 brief forbids `any` | Two aliases use it: `AnyQuestionTypeServer` and `AnyQuestionTypeClient` in `core/src/registry.ts` | As written in §1.5. A registry erases five unrelated type parameters, and `QuestionTypeServer`'s method parameters are contravariant, so `unknown` would make every concrete type unassignable. Confined to those two aliases; call sites go back through the concrete type via `loadConfig`/`saveConfig` |
| W1-9 | D5 writes the cloze sentinel `⟦b<i>⟧`, §2.3 writes `⸢{index}⸣` | `⸢<index>⸣` (U+2E22, U+2E23), as §2.3 and as D5's own code points | The two spellings name the same code points; §2.3 is the precise one. `parseCloze` additionally strips those two characters from the authoring text so a teacher cannot conjure a phantom input |
| W1-10 | §7.4 gives `attemptDeadline` / `bonusSeconds` inline input types | Named interfaces `BonusInput` and `DeadlineInput` (same fields) | Callers in WP5 need to name the type; the field list is unchanged |
| W1-11 | §7 names one function per concern | Domain also exports `isPassing`, `remainingSeconds`, `truncateSelection`, `clozeTotalWeight`, `matchBlank`, `describeBlank`, `describeMatcher`, `hasLlmMatcher`, `isValidPattern`, `compileFullMatch`, `regionCount`, `emptyRegions`, `mainFileName`, `uniquePseudonyms` | Additions, never replacements: the qt packages and the grading worker need them, and they belong in the pure layer rather than in an API module |
| W1-12 | §7.6 does not say what an empty series gives | `describe([])` returns `count: 0` and zeroes everywhere | Total function; the results screen shows a dash on `count === 0` |
| W1-13 | §2.4 says a marker line is a line comment (`//`, `#`, `--`) | Per-language prefixes: `//` and `/* … */` for c/cpp/js, `//` for rust, `#` for python | `--` belongs to no MVP language; a C template commonly writes `/* @@lock */` |
| W1-14 | — | `@quiz/domain` gains subpath exports (`@quiz/domain/grade`, `@quiz/domain/deadline`, …) next to `.` | §10 refers to `@quiz/domain/grade#gradeFromPoints`; the subpaths make that import real |

### WP4 — `apps/api` module `pool` (+ `org` completion) + `packages/contracts`

| # | Plan | Implemented | Why |
|---|---|---|---|
| W4-1 | §3.7 delivers the MVP as `0001_base` + `0002_quiz` | `0000_init` (bootstrap, untouched) + `0001_pool` (pool tables, `api_tokens`, `classrooms.join_code_enabled`) | The supervisor override forbids editing `0000_init.sql`; the pool half of `0002_quiz` therefore lands as `0001_pool`, and WP5/WP6 append their own |
| W4-2 | §3.2 `search` is generated from `search_text` "plus the joined `internal_name`" | `search_text` itself holds `internal_name + type.searchText(config)`, and `search` is `to_tsvector('simple', search_text)` | A generated column may only read its own row; joining another table is not expressible. PGlite 0.5 (PG 18) was verified to support the generated tsvector and its GIN index |
| W4-3 | §1.6 `loadConfig(type, raw, storedVersion)` | `loadConfig(type, row)` where `row` is `{ config, configVersion }` — the two columns of `question_versions` | Callers always hold the row; the three-argument form invited passing the two halves from different rows. `saveConfig` is unchanged, and `saveDraftConfig` is the D16 variant that stores what does not parse |
| W4-4 | §4.2 `GET /questions/:id` returns the draft config | A VALID draft is returned migrated; an INVALID one is returned exactly as stored | The editor always works at the current `configVersion`, and D16's promise ("a teacher may leave a question half-written") means the bytes of an invalid draft must come back untouched |
| W4-5 | §4.2 `DELETE /questions/:id` — `409 in_use` on `?hard=1` | `409 in_use` on both the soft and the hard delete | One rule instead of two: a question an evaluation still points at does not leave the pool, whichever button was pressed. `isVersionInUse` is the WP5 seam and returns `false` until `evaluation_items` exists |
| W4-6 | §4.1 `POST /classrooms/join { code }` | `POST /app/api/join/:code` | The WP4 brief names this path; the code is in the URL the teacher projects. Any session may call it, and a wrong, disabled or archived classroom is the same 404 |
| W4-7 | §4.1 `POST /classrooms/:id/archive { archived }` | The bootstrap's `POST /archive` + `POST /unarchive` pair, kept | Already implemented, already called by the web app; a body-driven variant would be a second way to do one thing |
| W4-8 | WP4 file list says `modules/org/{routes,service}.ts` | `modules/org/` holds ONLY the completion (course detail, `course_pools`, join code, self-join); courses, staff, classrooms and roster stay in `modules/courses.ts` and `modules/roster.ts` | Moving working routes under a new directory is churn the plan does not pay for. The `org` module is the union of the three files |
| W4-9 | §4.8 `HintEvent { type, topics, kinds }` over `GET /events?watch=` | The inherited bus: `publish("pool", ["pool:<id>"])`, topics computed at connection time, `{ type, notice }` on the wire | The `watch=` protocol and the typed `ServerEvent` union belong to WP5's realtime module. WP4 adds the `pool` kind, the `pool:<id>` topic and its authorisation (`poolAccess`), which is what the pool screens need now |
| W4-10 | §3.6 catalogue | Adds `category.*`, `pool.*`, `question.*`, `course.pools_update`, `classroom.join_code`, `roster.join`; `PUT /draft` is NOT audited | Every write is audited except the autosave, which fires every few seconds per open editor: it would drown the append-only log, and the publication that follows carries the content |
| W4-11 | §4.2 asset allowlist includes `image/svg+xml` | SVG is refused; the accepted type is decided by the MAGIC BYTES, not by the declared `content-type` | An SVG is a script container; sanitising one is a project of its own. Sniffing also makes a lie about the content type harmless |
| W4-12 | — | `registerForTests(type)` in `@quiz/registry/server`, a no-op under `NODE_ENV=production` | `packages/registry` is empty until WP2/WP3 land, and the `pool` module cannot be tested without a type. The fakes live in `apps/api/src/test/fakeType.ts` |
| W4-13 | WP4 DoD "concurrent publish → one wins" | Asserted as "two distinct numbers and exactly one draft", plus a direct test that a second draft row violates the partial unique index | PGlite is single-connection: two transactions are serialized, so the interleaving cannot be reproduced. What the indexes guarantee is what is asserted; a real Postgres run of the same test exercises the race |
| W4-14 | §4.2 `POST /pools/:id/assets` → `{ id, url: "/assets/:id" }` | `url` is `/app/api/assets/:id` | The whole SPA API lives under `/app/api` (supervisor override of D18); the asset URL must be one the browser can actually fetch |
| W4-15 | §4.2 `GET /assets/:id` — "Any authorised to see the containing content" | Any STAFF session reads an asset; a student gets 404 until WP5 wires the attempt | The store is deduplicated instance-wide (`unique (sha256)`), so `assets.pool_id` names the pool that uploaded the bytes first, not the pools that display them: a per-pool check would 404 the second teacher's own image. The id is a random uuid, and a colleague holding the same bytes obtains the same id by uploading them |
### WP3 — `packages/qt-code`, the runner interface and its stub

| # | Plan | Implemented | Why |
|---|---|---|---|
| W3-1 | §2.4 `CodeDetails.sourceSha256: z.string().length(64)` | `.length(64).nullable()`, plus an optional `reason` | An unanswered question — or an answer that no longer fits the template — has no assembled source to hash, and the details must still say why |
| W3-2 | §2.4 has no per-case time budget | `tests.cases[].timeMs` (nullable, `null` = use `limits.timeMs`). The request asks for the LARGEST budget of the cases it sends; `finalizeRunner` re-applies each case's own limit to the measured time | The WP3 brief requires it, and §1.7's wire contract carries one global `limits.timeMs`, so a tighter per-case budget can only be enforced on the way back |
| W3-3 | §2.4 has no reference solution | `config.referenceSolution`, used only by the editor's "try" button | The WP3 brief requires it. It is dropped by `toStudent` and asserted absent by the leak test |
| W3-4 | §2.5 forbids the key `"expected"` in a student view | `expected` IS published, for the VISIBLE cases only | docs/04 §4.7 has the player show "stdin / expected output / got" for those cases. The hidden cases' names, inputs and outputs are covered by the secret-VALUE search, which is the check that matters |
| W3-5 | §2.4 says details hold `expected`/`actual` "only for visible cases (or for the teacher)" | `finalizeRunner` stores the whole truth; `studentDetails(details, { showHiddenCaseNames })` in `grade.ts` is the filter | `finalizeRunner` has no audience parameter and the grading panel needs everything, so the redaction is a separate pure function the feedback policy (WP6) applies |
| W3-6 | §1.4 `PlayerProps.run?: (payload: unknown) => Promise<unknown>` | The player also accepts a typed `onRun(answer) => Promise<RunnerOutcome \| "unavailable">` | Named by the WP3 brief. The contract's generic `run` stays as it is; the host adapts |
| W3-7 | §1.7 selects the runner with `stub \| http \| fake` | `RUNNER_MODE` is `stub \| http` | The WP3 brief. A fake is a test double the tests construct directly, not an env value that could ship |
| W3-8 | §2.4 locks regions with "Monaco `readOnly` decorations" | Stacked surfaces: one read-only block per locked segment, one editor per editable region (documented in `MonacoHost.tsx`) | A read-only range inside one model is a rendering rule; separate buffers mean the locked text is in no editable buffer at all, and the `<textarea>` fallback keeps the same property with no extra code |
| W3-9 | §2.4 stores `cases[].visible` | Still `visible`; the editor shows the opposite switch, "Hidden" | The stored spelling stays the spec's, the control matches the decision a teacher makes (and the WP3 brief) |
| W3-10 | — | `HealthResponse.checks` gains `runner: "up" \| "down" \| "disabled"` in `packages/contracts` | `/healthz` must report the runner. `stub` reports `disabled` and never degrades the overall status, so a machine without a container engine is not unhealthy (decision D14) |
| W3-11 | — | `packages/qt-code` adds `strings.ts` (UI strings, English defaults, overridable through a `strings` prop), `styles.ts` (the class lists of `apps/web/src/ui.tsx`, mirrored) and `segments.ts` (marker-line display helpers) | A package cannot import `apps/web`, and the authoritative split still comes from `@quiz/domain/lockedTemplate` — `segments.ts` only decides what is *shown* Superseded on 2026-09-23 (PR #51): the shared class lists of `styles.ts` moved to `@quiz/ui`, and the file is gone from `qt-code`. |
| W3-12 | — | `packages/qt-code/tsconfig.json` names `"types": ["node"]` | `grade.ts` hashes the assembled source with `node:crypto`; the automatic `@types` sweep does not reach this package's own pnpm link |
### WP2 — `packages/qt-mcq`, `qt-short`, `qt-cloze`

| # | Plan | Implemented | Why |
|---|---|---|---|
| W2-1 | The WP2 brief names the editor props `value`/`onChange`/`issues` and the player props `config`/`answer`/`onChange`/`disabled` | The names of the §1.4 contract: `config`/`onChange`/`disabled` and `student`/`answer`/`onChange`/`readOnly`, plus optional `issues`, `strings` and `renderMarkdown`. A player also accepts `disabled` as an alias of `readOnly` | `packages/registry` types every component as `ComponentType<EditorProps<…>>` / `ComponentType<PlayerProps<…>>`: a renamed required prop does not compile. The brief's `disabled` is honoured as an alias |
| W2-2 | §1.4 `EditorProps.uploadAsset` is required | Optional on the three editors | The MVP editors are markdown textareas (D11) and upload nothing. An optional prop keeps the component assignable to `EditorProps` |
| W2-3 | §1.4 has no place for UI strings, markdown injection or draft issues | `@quiz/core/client` gains `StringOverrides<K>`, `resolveStrings`, `MarkdownRenderer` and `ConfigIssue` | A `qt-*` package cannot import `apps/web`, so it ships English defaults and takes a typed partial override (N-I18N-01), takes the host's sanitised renderer as a prop, and places the `issues[]` of D16 next to the offending field. Defined once, as the brief asks |
| W2-4 | §2.1 `McqDetails` | Adds `truncated: boolean` | §2.1 requires a payload longer than `maxSelections` to be truncated "and logged in `details`", but the listed shape had nowhere to log it |
| W2-5 | §2.1 third refinement, `.refine((c) => c.policy !== "all_or_nothing" \|\| true)` | Dropped | It is a tautology: it accepts every config and would only add noise to the issue list |
| W2-6 | §8 WP2 requires `emptyDraft()` to validate, without saying what it holds | Language-free `…` placeholders (`mcq`: one prompt, two choices, the first correct; `short`: one `exact` matcher; `cloze`: `… {{…}} …`) | Every string of the three schemas is `min(1)`, so a draft cannot be empty. An English sentence would be content a French-speaking teacher has to delete, and a translated one would put UI strings in a stored config |
| W2-7 | §2.3 does not define a `cloze` solution shape | `{ blanks: [{ index, expected }] }`, `expected` rendered by `describeBlank` | `toSolution` is part of the contract and the review panel shows the key blank by blank; the index keeps it aligned with `details.perBlank` |
| W2-8 | §2 is silent on `defaultPoints` for `cloze` | One point per blank (`mcq` and `short` default to 1) | The blanks are already weighted against each other; making the item worth its blank count is what a teacher expects from "somme des poids" |
| W2-9 | §2.2 "compilation wrapped in try/catch at publication time (invalid regex = publication error)" | `ShortConfigSchema` refuses an uncompilable pattern, with the path `["matchers", i, "pattern"]` and the key `short.invalid_pattern` | Publication IS `configSchema.parse` (§1.6). Putting the check in the schema means the draft still saves (D16) and the error arrives with a path the editor can place |
| W2-10 | §2.2 "a config containing an `llm` matcher is rejected at publication with `llm_not_available`" | The schema accepts it (so an imported question survives a round trip) and `hasLlmMatcher` (`@quiz/domain/short`) flags it; the refusal itself belongs to WP4's publish service | A schema that refused it would also refuse the round trip the canonical format needs, and the error code belongs to the HTTP layer |
| W2-11 | §8 WP2 file list | Each package also carries `src/strings.ts`, `src/ui.tsx` and `src/fixtures.ts`; `qt-cloze` carries `src/text.tsx` | The strings dictionary is the English half of W2-3; `ui.tsx` holds the handful of class strings the three components share (duplicated per package on purpose: `packages/ui` is a later WP and a package may not import `apps/web`); `text.tsx` is the D5 sentinel renderer and its fallback Superseded on 2026-09-23 (PR #51): the shared class strings moved to `@quiz/ui`; only `qt-mcq` keeps a `ui.tsx`, for its own components. |
| W2-12 | WP1 packages exclude `*.test.ts` from `typecheck` as well as from the build | `typecheck` runs a second pass (`tsconfig.test.json`) that includes the tests | Vitest does not typecheck. A test suite that nothing type-checks silently drifts from the contract it is supposed to hold, and "no `any`" cannot be enforced in it |
| W2-13 | The brief asks for the qt sources to be added to the `@source` directives of `apps/web/src/style.css` | One line, `@source "../../../packages/{qt-mcq,qt-short,qt-cloze}/src";` | Measured: Tailwind 4 expands a brace list in a directory position but not a `*` (`packages/qt-*/src` produced none of the packages' utilities). WP3 adds `qt-code` to the same line |
| W2-14 | D5 leaves the cloze rendering to "the markdown renderer" | The player and the review take `renderText({ template, renderBlank })`; the built-in fallback handles paragraphs, fenced code, inline code, bold and italic | The host's renderer must be able to place a React input at a sentinel, which a `(source) => ReactNode` signature cannot express. `apps/web` will pass its `MarkdownView` behind the same prop |

### WP5 — `apps/api` modules `evaluation` + `live` + `realtime` + ticker

| # | Plan | Implemented | Why |
|---|---|---|---|
| W5-1 | §3.7 delivers the MVP as `0001_base` + `0002_quiz` | `0002_evaluation.sql` on top of W4-1's `0001_pool` | The supervisor override forbids editing `0000_init.sql`; each work package appends its own migration instead of rewriting a shared one |
| W5-2 | §3.4 creates `run_requests` | Not created. The per-minute budget of `POST /attempts/:id/run` is counted from `attempt_events` where `kind = 'run'` | The journal already records the fact, with the attempt it belongs to and the instant it happened — which is exactly what a sliding-window limit and the F-ADMIN-02 metrics read. One table fewer, and the retention rule (pruned with the classroom) is inherited |
| W5-3 | §3.4 says `guest_participants` is "phase 2 — not created in MVP" | The table exists, empty, with no route | The WP5 brief asks for it. Creating it now settles the column set and saves a migration when guests land |
| W5-4 | §3.3 `(evaluation_id, position)` unique **deferrable initially deferred** | A plain unique index, and `renumber()` moves every row out of the way (`position + 100000`) before giving it its final place, in ONE transaction | `drizzle-kit` cannot emit a deferrable constraint, and hand-editing the generated SQL would desynchronise the snapshot it maintains. The two-phase update is portable, works on PGlite, and is asserted by the reorder test |
| W5-5 | §3.4 `answers.payload jsonb not null` | Unchanged — and "seen, nothing typed" stores the JSON value `null` (`'null'::jsonb`) | Marking a question done before answering it has to create the row. `null` is already what `grade(config, null, …)` means (F-GRADE-01), so nothing downstream learns a new case |
| W5-6 | §4.8 `GET /events?watch=` | ONE handler at `/app/api/events` | The SPA API lives under `/app/api` (supervisor override of D18). WP5 also mounted the handler at the inherited `/app/events`, on the belief that `apps/web/src/live.ts` still opened it; the web WPs had already migrated, so the alias never had a caller and was removed on 2026-09-22 (audit B-11) |
| W5-7 | §4.8 describes one grammar of named SSE events | A HINT goes out as an UNNAMED frame (`data: {"type":"hint",…}`), every typed live event as a NAMED one (`event: clock`, `event: dashboard.cell`, …) | `EventSource.onmessage` only receives unnamed frames, so the shipped client keeps working unchanged while a new client subscribes by name. One stream, two readerships, no second endpoint |
| W5-8 | §4.8 `HintEvent.notice.kind` is `info\|success\|warning\|error` | The inherited `NoticeKind` of `contracts/src/notifications.ts` (`student_joined \| roster_conflict`) | That catalogue is the one `apps/web` renders and filters on. Two notice vocabularies would be two places to keep in step for no gain |
| W5-9 | §4.8 lists `modules/realtime/routes.ts` next to the existing `modules/events.ts` | `modules/events.ts` is DELETED; its topic computation moved into `modules/realtime/routes.ts` | The WP5 brief asks to extend the existing stream, not to duplicate it. Two SSE endpoints computing the same topic set is exactly the drift the brief forbids |
| W5-10 | §10 "never publish an event directly" | `apps/api/src/events.ts` (the bus) gains `publishData` and an `Audience`; `publish` and its call sites are untouched; `modules/realtime/bus.ts` is the only thing that calls either | WP4's `poolChanged` keeps working verbatim, and the coalescing and topic decisions have one home |
| W5-11 | §4.4 `POST /attempts/:id/run` → `202 { requestId }`, "result arrives via SSE" | `202 { requestId, result }`: the runner call is awaited (bounded by `RUNNER_TIMEOUT_MS`) and the outcome is BOTH published on `user:<id>` and returned | With `RUNNER_MODE=stub` — every development machine and CI runner — the honest answer is a synchronous `503 runner_unavailable`, which the WP5 brief requires. Answering 202 and never delivering anything would be a lie. A client that lost its stream still gets its result |
| W5-12 | §4.4 `POST /attempts/:id/run` is "for code questions" | The route is type-agnostic: any type declaring `finalizeRunner` works, and the cases sent are the ones the STUDENT VIEW already publishes (`visibleCases`, matched by name) or one ad-hoc case when `stdin` is given | `live` must not import a `qt-*` package. Deriving the visible set from `toStudent` also makes the "no hidden case ever leaves the server" property true by construction rather than by review |
| W5-13 | §4.4 `runsPerMinute` comes from the question config | Read from the STUDENT view of the item, default 10 when a type publishes none | The limit is one the student is shown, so it must be the same number on both sides; and the live module does not open configs it does not own |
| W5-14 | §4.4 `POST /evaluations/:id/attempt` → `AttemptView \| LobbyView` | `{ kind: "attempt" \| "lobby", view }` | A bare union of two object shapes is not discriminable by the client that shares the schema (invariant 7). One tag makes it a `z.discriminatedUnion` on both sides |
| W5-15 | §4.4 `AttemptView` | `items[].locked` and `evaluation.feedbackPolicy` added | Navigation is enforced on the SERVER (`forward_only`, `milestones`); the player must be told which items the server will refuse, rather than deducing it. The feedback policy decides what the player may show after a validation and is not worth a second request |
| W5-16 | §4.3 `POST /evaluations/:id/preview` → "`AttemptView` with fake attempt (`seed: 0`, read-only)" | Same, with `attempt.preview: true` and a fixed `attempt.id` (`PREVIEW_ATTEMPT_ID`) | The player needs one flag to know it must not write; a fixed id makes an accidental write hit nothing |
| W5-17 | §4.3 `PATCH` answers `409 locked` "if the field is structural" without listing them | Editable once an attempt exists: `title`, `accessCode`, `ipAllowlist`, `feedbackPolicy`. Everything else is `409 locked` | Those four change nothing a student already saw and nothing about their clock. The list is a constant in the service, next to the rule |
| W5-18 | §4.3 / F-EVAL-11 | An `exam` never stores `feedbackPolicy.when = "immediate"`: the value is clamped to `on_release` on write | F-EVAL-11 reserves immediate feedback to `exercise` and `poll`. Clamping on write means no route has to re-check it later |
| W5-19 | §4.4 teacher controls | Two routes the plan does not list: `POST /evaluations/:id/attempts/:attemptId/close` and `…/reopen` | The WP5 brief asks for "close one / close all, reopen". Reopening recomputes the deadline from the ORIGINAL start plus everything already granted, so it is not a second full duration |
| W5-20 | §4.4 `DashboardView.rows[].points`, `cells[].verdict`, `totals[].successRate` | `null` until WP6 writes `gradings` | The MVP grid is a PROGRESS grid; the read model is already shaped for the grades and the shape does not change when they arrive |
| W5-21 | §4.4 `/student/home` → `{ open, upcoming, results }` | `{ open, upcoming, past, serverNow }` | `results` is WP6's (a card there carries a grade). `past` is the same list without the grade, so WP6 adds a field instead of adding an endpoint |
| W5-22 | §5.3 step 5 "presence sweep" | The presence map lives in memory (`modules/realtime/presence.ts`); `attempts.present_at` keeps the durable last sign of life | Presence changes several times a minute per student: on a table that is pure write amplification. The consequence is explicit — with `WORKER_MODE` split across processes each one knows its own connections — and the MVP runs one process (ADR-001, ADR-009). The bus is already shaped for LISTEN/NOTIFY the day that changes |
| W5-23 | §5.3 runs under `pg_try_advisory_lock` | No advisory lock. Every task is a conditional UPDATE with `RETURNING`, which IS the claim | The lock would serialise the whole tick for a guarantee the `WHERE` clause already gives per row. Two processes ticking together close each attempt exactly once between them, which is what the test asserts by re-ticking |
| W5-24 | — | `apps/api/src/clock.ts`: `app.clock` is decorated at build time, `TestClock` in the tests, and no service reads the wall clock | The WP5 rule "time must be injectable so tests never sleep". The deadline boundary, the three-second grace and the pause shift are asserted by moving one object |
| W5-25 | — | `JOBS_DISABLED=1` in `config.ts`; `startJobs` returns `null` and decorates nothing. Set by `test/http.ts` and by `app.test.ts`, which also drops to `WORKER_MODE=web` | `app.test.ts` points the API at a dead port on purpose; pg-boss answered that by retrying and printing an ECONNREFUSED stack trace per attempt, and the ticker then did the same once a second. /healthz still reports `jobs: "down"`, which is true |
| W5-26 | Invariant 4 says `toStudent` has one caller | WP4's teacher preview (`POST /questions/:id/preview`) now goes through `studentViewOf` in `modules/live/studentView.ts` | It was the second caller. Routing it through the same exit makes "one place to audit" literally true, and the registry-wide leak test then covers that route too |
| W5-27 | §2.5 / invariant 4 leak test | `studentView.leak.test.ts` sows markers into the SECRET-named fields of each type's `emptyDraft()`, keeping the config valid at every step, and asserts the forbidden-key list, the marker search AND that the stripped payload still satisfies the type's own `studentSchema` | A type whose key lives inside its authoring text (`cloze`) or in a non-string field (`mcq`'s `correct`) sows nothing; those are covered by the forbidden-key half and by the package's own `toStudent.test.ts`. The test prints which types the value search exercises, so a type that later adds a secret string field is covered with no edit here |
| W5-28 | §1.6 / §10 | `studentView()` also strips a forbidden-key list from whatever `toStudent` returned | Defence in depth: a type that respects its contract loses nothing, and a type that slips gains no reach. Asserted with a deliberately rogue type |

### WP7 — Web: pool, question editors, try panel

| # | Plan | Implemented | Why |
|---|---|---|---|
| W7-1 | §8 WP7 file list names `apps/web/src/questionTypes.ts` | `apps/web/src/questionTypes.tsx` | The module mounts the three surfaces behind `Suspense` and builds the `renderMarkdown` elements it injects, so it contains JSX and cannot be a `.ts` file |
| W7-2 | §5.2 has `apps/web` talk to the registry only | `@quiz/web` declares `@quiz/registry` **and** `@quiz/core` as dependencies | The registry erases the five type parameters of a client entry; the props the host passes (`ConfigIssue`, `StringOverrides`, `MarkdownRenderer`) are `@quiz/core/client` types, and a package used in a type position is still a dependency |
| W7-3 | §6.2 reaches a pool through a course page | Linking and unlinking a pool lives on the course card of `TeacherHome`; there is no `/courses/:id` route yet | WP7 owns the pool, not the course screens. One card with the pools of a course is enough to reach every pool, and the route can land later without moving the control |
| W7-4 | Mockup `08-pool.html` shows an "Uncategorized" node in the category tree | No such node: the tree lists the real categories, and a search matches across the whole pool | "Uncategorized" is a filter, not a category, and it has no id to send to `GET /pools/:id/questions`. Search already answers "what is not filed", so a node that cannot round-trip through the API was not invented |
| W7-5 | §6.2 category ordering | Two buttons, move up / move down, on each node | Drag and drop needs a pointer, a keyboard fallback and a touch story for a list a teacher reorders twice a year. Two buttons are the same operation, accessible by construction |
| W7-6 | WP7 Tests name `Ctrl+Shift+M` without saying what it does | It toggles the student preview panel of the question editor | `Ctrl+S` saves and `Ctrl+Shift+P` publishes; the third shortcut belongs to the third thing the editor screen does, which is showing the teacher what the student will read |
| W7-7 | §1.4 types every surface as `ComponentType<EditorProps<…>>` | `questionTypes.tsx` casts the registry's `Editor` / `Player` / `Review` to a permissive props type before mounting them | `AnyQuestionTypeClient` erases the five type parameters, so `issues`, `strings` and `renderMarkdown` are invisible through it. Every value passed is still built from the package's own exported defaults, and `questionTypes.test.tsx` fails on a renamed or untranslated key |
| W7-8 | W2-3 defines one `MarkdownRenderer` signature for every surface | The host injects two: a block renderer for the editors' preview, and `<MarkdownView as="span">` for the players and the reviews | A statement preview is a document; a prompt inside a `<legend>`, a `<p>` or a table cell is phrasing content, and a `<div>` there is invalid HTML the browser reparents |
| W7-9 | §6.2 bulk actions on the selected questions | Sequential single-question calls, one per selected row | WP4 exposes no bulk route, and a loop keeps the per-question authorisation, the per-question error and the existing audit entries. A bulk endpoint can replace the loop without touching the screen |
| W7-10 | Mockup `08-pool.html` gives the question table a "Réussite" column | Dropped | The success rate comes from item analysis, which §0 puts out of the MVP. A column that would always read "—" is a promise the product does not keep |
| W7-11 | §4.2 asset upload | `api()` sets no `Content-Type` when the body is a `FormData` | The browser must write the header itself to add the multipart boundary; a hand-set `multipart/form-data` produces a body the server cannot parse |
| W7-12 | N-I18N-01 / W2-3 have `apps/web` translate the packages' strings | `i18n.tsx` carries the four packages' dictionaries — about 390 keys — and ships in the entry chunk | The dictionaries are plain data the host owns; splitting them per type would fetch a second file before an editor can render its own labels. The surfaces themselves stay lazy, which is what N-PERF-05 asks Superseded on 2026-09-23 (PR #56): `i18n.tsx` is now `i18n/{en.ts,fr.ts,index.tsx}`; the dictionaries still ship in the entry chunk. |

### WP6 — `apps/api` modules `grading` + `results` + jobs

| # | Plan | Implemented | Why |
|---|---|---|---|
| W6-1 | §3.7 delivers the MVP as `0001_base` + `0002_quiz` | `0003_grading.sql` on top of W5-1's `0002_evaluation` | The supervisor override forbids editing `0000_init.sql`; each work package appends its own migration |
| W6-2 | §3.5 `gradings.answer_id uuid → answers nn`, partial unique `(answer_id) where state='validated'` | `answer_id` is NULLABLE, `attempt_id` is denormalised next to `item_id`, and a SECOND partial unique index `(attempt_id, item_id) where state='validated'` joins the one the plan names | F-GRADE-01 grades an answer that does not exist ("une réponse absente vaut 0") and there is no `answers` row to hang it on. Writing one would mean the `grading` module writing the `live` module's table, which the conventions forbid. `answers` is itself unique on `(attempt_id, item_id)`, so the two indexes can never disagree, and the index of §3.5 still holds for every answer that exists |
| W6-3 | §4.5 `POST /answers/:answerId/gradings` is the manual override | Kept, plus `POST /gradings/:id/override` with the same body and the same service call | A cell with no answer row (W6-2) has no `answerId` to address. The panel entry always carries a grading once the pass has run, so the grading id is the address that exists for every cell |
| W6-4 | §4.5 `POST /grading/run` → `202 { jobId }` | `202 { evaluationId, itemIds, queued }` | Neither pg-boss's `send` nor the in-process development runner hands back a job id the client could do anything with. `queued: false` says the pass ran inline (W6-5) |
| W6-5 | §5.4 the pass always goes through the queue | With no queue — `JOBS_DISABLED=1`, every route test, a database unreachable at boot — `enqueueEvaluationGrading` RUNS the pass inline instead of dropping it | A missing queue is a real configuration, not a failure. The queue is what makes the work durable and retried, not what makes it happen; and it makes the job assertable in a test with no timer and no sleep |
| W6-6 | §5.4 "`POST /close` or ticker auto-close → enqueue" without naming the seam | `closeEvaluation(db, evaluation, now, closedBy, app?)` enqueues when the caller hands over the Fastify instance; the close route and the ticker's `autoCloseDue` both do | The hook lives IN the transition, so the two entry points cannot drift apart, and the service keeps taking a `Db` rather than an `app` for everything else |
| W6-7 | §4.5 lists `POST /evaluations/:id/release` in the `grading` table | It is a `results` route, next to the grade table it freezes | §4.6 is where the release is specified and where `released_grades` is computed. One module owns the release, and it is the one that owns the grade |
| W6-8 | §4.6 `GET /student/attempts/:id/results` | `GET /attempts/:id/feedback` is the route, and the only one | The WP6 brief names `/attempts/:id/feedback`. The plan's path was first mounted on the same handler as an alias; nothing but its own test ever called it, so it was removed on 2026-09-22 (audit B-11), like the SSE alias of W5-6 |
| W6-9 | §4.6 `StudentResults` | A discriminated union `StudentFeedback = StudentResults \| FeedbackPending` on `available` | "Before the release the student sees nothing but 'results pending'" has to be a payload the client can branch on without guessing, and the negative case must carry NO question content at all — not a `StudentResults` with nulls everywhere |
| W6-10 | §4.6 `ResultsView.rows[].state` | `absent \| not_started \| in_progress \| submitted \| expired`, and the rows are the class list, not the attempt list | F-RES-02 exports "un étudiant par ligne". An absent student is a 1.0 that must appear in the export AND in the statistics, or every class average is flattered |
| W6-11 | F-GRADE-09 "une re-correction après publication met à jour les notes" | The student is shown the RECOMPUTED grade; `released_grades` is the record of what was published, and `modified_after_release` is what tells the teacher the two have drifted apart | A frozen number the student sees and a corrected one the teacher sees would be the dispute the flag exists to prevent |
| W6-12 | §4.6 "`details` filtering for `code`" | `filterDetails(type, details, policy)` in `modules/results/service.ts` dispatches on the type id and calls `studentDetails` from `@quiz/qt-code/server` | `QuestionTypeServer` has no per-type details filter (deviation W3-5 put the redaction in a pure function instead), and adding one to the contract is WP1's call, not WP6's. `code` is the only MVP type whose details hold a secret |
| W6-13 | §3.5 `llm_calls` "phase 2 — not created in MVP"; `settings (key, value)` | `llm_calls` and `answer_flags` ARE created, empty, with no route; `settings` is NOT created | The WP6 brief asks for the two grading-side tables, and creating them now settles their column set. `settings` is the `admin` module's (F-ADMIN-03) and no route of this work package reads it |
| W6-14 | §4.5 `GradingQueue.entries[].answerId: z.uuid()` | `.nullable()`, same reason as W6-2 | An absent answer is an entry of the panel like any other; the teacher must be able to override the zero |
| W6-15 | §4.6 has no un-release | `POST /evaluations/:id/unrelease` | A release published with a wrong key has to be withdrawable, and doing it by hand in the database is not an operation. Audited as `results.unrelease` |
| W6-16 | §4.6 `ByQuestion.avgMs` | Always `null` | Nothing records the time a student spent ON ONE ITEM: `attempt_events` journals visibility and runs, not per-question dwell time. The field stays in the contract so the screen does not change shape when WP12 adds the measurement |
| W6-17 | §3.6 catalogue | Adds `grading.run`, `grading.validate` and `results.unrelease` next to `grading.override`, `grading.regrade`, `results.release` and `results.rerelease` | Same posture as W4-10: every write is audited. Validating a batch of forty proposals is a grading decision, and so is pressing "re-grade" |
| W6-18 | §5.4 `regrade` "previous ones become superseded" | The regrade route stands every non-superseded grading of the item down BEFORE enqueuing the pass | The pass is idempotent by design (it skips a validated cell); a regrade that did not stand the old gradings down would therefore be a no-op. Nothing is deleted: the chain is the history §4.5 serves |
| W6-19 | §4.5 `history` is "the gradings of this answer" | Ordered newest first, with `superseded` as the tiebreaker at equal `graded_at` | The automatic pass and the override a teacher presses right after it can land in the same millisecond — certainly on the `TestClock`, which does not move by itself. A superseded grading is never newer than the one that replaced it |
| W6-20 | W5-21 `/student/home` `past` | `EvaluationCard` gains `grade: number \| null`, filled for a released evaluation | The field WP5 said WP6 would add, added where WP5 left room for it. `null` everywhere else: an unreleased evaluation must not leak the grade it would have |
### WP9 — Web: student home, lobby, zen player

| # | Plan | Implemented | Why |
|---|---|---|---|
| W9-1 | §6.3 keeps `StudentHome` where it is | `apps/web/src/StudentHome.tsx` (the classroom list) is DELETED; `src/student/StudentHome.tsx` replaces it with the three sections of `/student/home` plus the classroom list and the join-by-code card as its last section | The student's home is their evaluations now (mockup 05). Two components called "student home" would have left the sidebar, the palette and `App.tsx` pointing at the old one. The sidebar row is renamed with it (`shome.title`, "Home" / "Accueil") |
| W9-2 | §6.5 `realtime/useEventStream.ts` seeds the query cache from `snapshot` | `attempt/attemptStream.ts`: the same named frames, but a `snapshot` feeds the CLOCK and nothing else | WP8 owns the shared hook (the supervisor unifies the two). A snapshot written into the cache while a student is typing would replace their own unacked answers with the server's older copy — the exact loss `Autosave` exists to prevent Superseded on 2026-09-23 (PR #55): `attemptStream.ts` is deleted; the player and the lobby use `realtime/useEventStream.ts`, one client per page. |
| W9-3 | §6.3 the lobby shows three fixed lines, the first being the navigation rule | The navigation line is shown only when the caller knows the setting; otherwise a clock line takes its place | `LobbyView` (§4.4) carries no `settings`, and a student in the lobby has no attempt to read them from. Announcing "free navigation" without knowing would be worse than not announcing it. **Superseded 2026-09-23** (audit FF-22): `LobbyView` carries `navigation`, the rule is always the first line and the clock fallback is gone |
| W9-4 | §8 WP9 injects the host's `MarkdownView` into every type's player | Injected as `renderMarkdown` into `mcq` and `short`. `cloze` keeps its own `ClozeFallbackText`, and `code` renders its prompt as plain text | `renderText` (W2-14) must place a React input AT a sentinel; the host's pipeline produces sanitised HTML, which cannot host React children. `CodePlayerProps` accepts no renderer at all (W3-6 lists `onRun` and `strings` only) |
| W9-5 | — | `MarkdownView` gains `inline`, and `style.css` a `.md-inline` block | Every place a question type calls the injected renderer is already a `<p>`, a `<legend>` or a `<label>`. A `<div>` inside a `<p>` is invalid markup that the browser repairs by closing the paragraph early, which moves the text the student is reading. `inline` renders a `span` and drops the wrapper of a single-paragraph source |
| W9-6 | §6.1 routes the attempt like any other page | `/take/:id` renders OUTSIDE `Shell`: no sidebar, no header | A zen player (one question, one action) beside a navigation sidebar is not a zen player, and an exam is the one screen where the rest of the app must go away. Every other route keeps the shell |
| W9-7 | §4.4 / W5-11 `POST /attempts/:id/run` answers `202 { requestId, result }` | The host maps that `result` to the `RunnerOutcome` the code player expects (`exitCode = ok ? 0 : 1`, `oom` unavailable), and treats `429 rate_limited` like `503` | The SSE result shape (named cases, server-side verdict) and the runner shape (exit codes, per-case flags) are two different contracts; one of the two has to be adapted, and the host is the only place that knows both. A rate-limited run is "not now", which is what the degraded message already says |
| W9-8 | §8 WP9 has no results screen; §6.3 lists `StudentResults` | `student/Feedback.tsx` is a "result not published yet" screen behind `TODO(WP10)` | `packages/contracts` carries no `GET /attempts/:id/feedback`: the `results` module is WP10's. The route exists and the home page links to it, so WP10 fills a page instead of adding one |
| W9-9 | — | `apps/web` gains `@quiz/core` and `@quiz/registry` (dependencies) and `axe-core` (dev) | The player mounts the type's `Player` through the client registry, and the DoD asks for an axe check on it |
| W9-10 | §8 WP9 lists `SyncBadge`, `ProgressSegments`, `Ring` and `Countdown` as additions to `ui.tsx` | They were already there; WP9 consumes them unchanged | They landed with the primitive gallery. The player is their first real caller, and none of them needed a change Superseded on 2026-09-23 (PR #36): `ui.tsx` is split; these four live in `ui/live.tsx`. |
| W9-11 | Mockup 07 shows the question's TYPE beside its points | Only the points are shown | The type labels are `qt.<id>.label` keys that no dictionary holds yet; they belong to the question editor (WP7), and inventing them here would collide on the merge |
### WP8 — Web: evaluation configuration + live dashboard

| # | Plan | Implemented | Why |
|---|---|---|---|
| W8-1 | §6.1 routes carry a `tab` in the union (`{ view: "evaluation"; evaluationId; tab }`) | `{ view: "evaluation"; id }` and `{ view: "live"; id }`; the step lives in `?step=` through the existing `useSearchParam` | The shipped router names its parameter `id` on every route and already has one mechanism for in-page tabs. Two ways to say "which tab" would be one too many, and the step has to survive a reload without adding a path segment per step |
| W8-2 | §6.5 `useEventStream(watch)` is a hook | A hook over ONE module-level connection shared by every subscriber | The shell mounts `useLiveUpdates` on every screen and the dashboard mounts its own watcher on top. Two `EventSource`s would mean two presence records, two snapshots and two clocks a round trip apart. `live.ts` now sits on the same connection and its behaviour is unchanged |
| W8-3 | §6.5 "a 60 s safety refetch" | Only for a WATCHER; the hint-only shell stream does not get one | Invalidating every query of the app once a minute is polling, which is the thing ADR-005's hint replaced. A watcher refetches its own query and nothing else |
| W8-4 | §4.8 `snapshot` seeds the cache | It seeds it only while the answers toggle is OFF; with answers on it triggers a refetch of `?includeAnswers=1` | The server builds the snapshot with `includeAnswers: false` (`modules/realtime/routes.ts`), because the stream does not know the teacher's toggles. Seeding from it would blank every answer on screen |
| W8-5 | — | The dashboard query uses `keepPreviousData` | The answers toggle changes the query KEY. Without it, hiding the answers before projecting blanks the grid to a skeleton at the worst possible moment |
| W8-6 | §6.2 `InspectPanel` shows the answer through `type.Review` | Resolved: `InspectModal` renders through `QuestionReviewHost`, which injects the inline `MarkdownView` | Closed once `MarkdownView` gained its `inline` form; prompts now render in the teacher's modal exactly as the student sees them |
| W8-7 | §6.2 `StudentGrid` row actions | The row's overflow menu is inside the STICKY first column, not at the end of the row | DESIGN.md puts actions in the last column; in a matrix that scrolls sideways the last column is off screen. An action a teacher has to scroll to reach is an action they do not take while twenty-four people are waiting |
| W8-8 | §6.2 `ItemsStep` has a drag handle | Two arrows per row instead | Dragging thirty rows is pleasant with a mouse and impossible with a keyboard, and the order is exactly what a teacher tweaks one step at a time |
| W8-9 | §6.8 "contextual evaluation actions when the live screen is mounted" | `commands.ts` gains a small registry (`registerContextualCommands`) that `buildCommands` folds in; the dashboard registers into it | The Shell builds the palette and has no access to a mutation living two components down. Threading live controls through the frame of every page to reach the palette is worse than a registry Superseded on 2026-09-23 (audit FC-03, PR #28): the contextual registry is gone; the dashboard registers through `useScreenCommands` like every other screen. |
| W8-10 | — | `apps/web` gains `@quiz/core` and `@quiz/registry` as dependencies | The preview and the inspection panel render a question through its type's `Player`/`Review`, which is what the client registry is for (decision D1) |
| W8-11 | — | The mock addresses an evaluation by its STATE as well as by its id (`/evaluations/running/live`) | Ids are UUIDs now (the SSE client validates every frame against the contracts), and a screenshot scene cannot name a generated UUID. The real API only knows uuids, and so does every id the mock puts on the wire |
| W8-12 | — | The grid's scroll container is `relative` | The accessible names in the cells are `sr-only`, which is `position: absolute`. Without a positioned ancestor their containing block is the page, so they escaped the scroll container and stretched the DOCUMENT to the width of the grid — a page scrolling sideways on a phone, which is what the sticky column exists to prevent |

### WP10 — Web: grading panel + results + export

| # | Plan | Implemented | Why |
|---|---|---|---|
| W10-1 | §4.6 `StudentResults.items[]` carries no type id | `StudentResultItem.type` added to `packages/contracts/src/results.ts` and filled by `studentFeedback()` | The feedback page mounts the question type's own `Review`, and without the id the browser would have to guess the type from the SHAPE of `student` — exactly the kind of reconstruction invariant 8 and the §5.7 gate exist to avoid. The id is not a secret: the student already saw the widget it names |
| W10-2 | §6.1 `{ view: "results"; tab }` and `{ view: "studentResults"; attemptId }` | `{ view: "results"; evaluationId }` with the tab in `?tab=`, and `{ view: "feedback"; attemptId }` at `/attempts/:id/feedback` | `useSearchParam` is how every other screen of this app holds a tab, and the route mirrors the endpoint the WP6 brief actually shipped (`GET /attempts/:id/feedback`, deviation W6-8) |
| W10-3 | §8 WP10 "batch validate … of this filter" | The batch bar appears in the BY QUESTION traversal only | `BatchValidateBody` scopes a batch by `itemId`, `source` and `confidence` — there is no `attemptId`. In a by-student traversal the only honest scope would be the whole evaluation, which is not what the button would appear to promise |
| W10-4 | §6.2 `GradingHeader` "single accent action = batch validate" | The accent moves: "Run grading" holds it while NOTHING has been graded, the batch validation once anything has | With a pass half-done both were red at once, and the squint test then names neither. Running the pass is the only thing the screen can offer on an ungraded evaluation; after that, validating is the work |
| W10-5 | §6.2 `EntryDetail` shows the answer, the points field and the comment field inline | Points and comment live in the override `Sheet`; the detail shows Validate, Adjust and the history | `.claude/skills/quiz-ui/SKILL.md` rule 4 puts a form in a layer, and an editable points field on each of thirty rows is thirty forms open at once. Validating one still takes a single click (or `v`) |
| W10-6 | §6.5 the realtime client is `useEventStream` | `grading/progress.ts` opens its own `EventSource` for the single named `grading.progress` frame | The shared stream hook belongs to the live dashboard (WP8). `grading.progress` is a NAMED frame, which `onmessage` never receives (deviation W5-7), so the plain hint channel of `live.ts` cannot move a progress bar. One event, one query, one screen — and it steps aside the day the general hook lands |
| W10-7 | §6.2 `GradingPanel` reads the queue | It also reads `GET /evaluations/:id` (items, title) and `GET …/results/by-question` (explanations) | `GradingQueue` carries neither the evaluation's title nor the question's explanation, and the panel needs the item list before it can scope its first request. The by-question read is an aid: it never produces an error state, it only adds the explanation when it arrives |
| W10-8 | F-RES-03 "énoncé, bonne réponse" for every type | The per-question view prints a `code` question's `solution.referenceSolution` itself | A type's `Review` renders its key BESIDE a graded answer, and a class debrief has no answer to show. The one documented field of the payload is read directly rather than fabricating a grading to make the component talk |
| W10-9 | — | `results.csv` is an `<a download>`, not a fetch | It is a GET the browser already knows how to do, with the session cookie and the server's own `content-disposition` filename. A blob would cost a second copy in memory and lose the filename |
| W10-10 | §6.1 keeps WP9's `/results/:id` beside the feedback page | WP9's `{ view: "studentResults" }` route is DELETED; `{ view: "feedback"; attemptId }` at `/attempts/:id/feedback` is the only student results page, and WP9's callers (the home's `past` cards, the player's finished screen) go through `feedbackLink()` | Two routes to one page is two places to keep in step, and the pre-release case is the same screen: `GET /attempts/:id/feedback` answers `available: false` and the page renders that. The tails of `/evaluations/:id/…` are parsed in ONE `switch` in `router.ts`, with `evaluation` as the fallback |
| W10-11 | §8 WP10 mocks its own evaluations (`e1`, `e2`) | The browser mock has ONE set of evaluations. A GRADING WORLD is derived from the `closed` and the `released` evaluation of WP8's section 3 — same ids, same items, same dashboard rows — and holds only what the first half has no use for: the answers and the chain of gradings | Two parallel sets meant two `GET /app/api/evaluations/:id` registrations, the last silently winning, and a grading queue whose item ids matched nothing the configuration screen listed. Derived, `/evaluations/<id>/grading` opened from the classroom list is the screen the panel links to, and the results' absent rows are the live grid's rows without an attempt (deviation W6-10) |

### Security pass (2026-09-20, after the API review)

| # | Plan | Implemented | Why |
|---|---|---|---|
| S-1 | `GET /attempts/:id` returns `AttemptView` | Returns the `AttemptOrLobby` union (`{kind:"lobby"}` until the evaluation is `running`; `attempt.readOnly` afterwards) | C1: no question content may leave the server before the start |
| S-2 | `trustProxy: true` | `TRUSTED_PROXIES` (address list, default loopback + `172.16.0.0/12`) | H2: a forged left-most X-Forwarded-For bypassed the IP allowlist; a hop count is fail-closed on this Fastify |
| S-3 | Feedback strips `code` details only | `QuestionTypeServer.studentDetails(details, policy)` hook in every type + a recursive forbidden-key strip when `showKey` is false | H1: mcq/cloze/short keys were published inside `gradings.details` |
| S-4 | Auto-close at `closesAt` | Auto-close at `max(closesAt, last in-progress deadline) + GRACE_MS`; `extend all` moves `closes_at` in `deadline` timing | H4: accommodations were voided by the ticker |

### WP11 — `apps/runner` (HTTP service, Podman)

| # | Plan | Implemented | Why |
|---|---|---|---|
| W11-1 | §8 files: `src/{server,engine,queue,limits}.ts` | `src/{server,app,config,engine,probe,execute,languages,images,queue,routes}.ts`; no `limits.ts` | The limits are three numbers of `RunnerRequest`, applied where they belong (`--memory` in `engine.ts`, the clocks in `execute.ts`); a module for them would only be a place to forget one. `app.ts`/`server.ts` split like `apps/api`, so a test builds the app without listening |
| W11-2 | One `podman run` per request implied | One CONTAINER per request, `sleep <ttl>` its only process, driven by `podman exec`: files in on stdin, build, then each case | A compiled artifact has to survive from the build to the cases, and nothing from the host may be mounted. One container start (~300 ms) per request instead of one per case is also what makes the p95 of thirty runs 635 ms |
| W11-3 | Hardening list of `run-hardened.sh` verbatim | The same list minus `--dns=none` and `--security-opt apparmor=…`, plus `--memory-swap` equal to `--memory` | Podman refuses `--dns=none` with `--network none`; the AppArmor profile exists to let gdb ptrace in a codespace and nothing here debugs. Without `--memory-swap` a memory bomb pages instead of dying, and `oom` never comes |
| W11-4 | `--userns=auto` always | `RUNNER_USERNS_AUTO=auto`: always on rootful, probed once at startup rootless, dropped with a log line when the engine cannot do it | Production is rootful and keeps the flag; a development workstation may have too small an `/etc/subuid` range, and silently dropping a hardening flag without saying so is how a hardening flag disappears |
| W11-5 | `apps/runner/infra/seccomp/codespace.json` (copied) | `apps/runner/infra/seccomp/runner.json`, byte for byte the same profile | It is this project's profile now; the name says whose it is. `_from-codespace/` is deleted and credited in `apps/runner/README.md` |
| W11-6 | — | `POST /run` answers `503 language_unavailable` for a language with no image | The runner never pulls (no registry credential, and in production no route to one), so a missing image is a deployment fact. 503 is what the API already maps to `RunnerUnavailable`, which degrades to a proposed grade (D14) |
| W11-7 | `GET /health` returns languages and queue stats | `RunnerHealth` plus `running`, `concurrency`, `queueMax` and an `engine` object (version, rootless, remote, userns, runtime, cgroups) | `RunnerHealth.safeParse` on the API side drops what it does not know, so the contract is untouched and `GET /admin/runner` and a human `curl` get the whole truth |
| W11-8 | §2.4 per-case `timeMs` | Every case gets `limits.timeMs`; the tighter per-case budget stays where deviation W3-2 put it, in `finalizeRunnerCode` | `RunnerRequest.cases[]` carries only `{name, stdin}`: the wire has one budget, and the runner cannot enforce a limit it is not told about |
| W11-9 | — | `ms` is measured around the `podman exec` call, engine overhead included (~100 ms) | Measuring inside the container would mean trusting the sandbox's clock or polluting the program's stdout. Documented in `apps/runner/README.md`: a per-case budget below ~200 ms is not useful |
| W11-10 | Integration tests run per language | They run for `c` and `python`, and skip themselves without a reachable Podman or without the image | `cpp` and `js` share the same code path (their images are built and served all the same); `rust` is a 700 MB toolchain that `images/build.sh` only builds when named |
