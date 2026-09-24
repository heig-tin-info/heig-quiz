/**
 * The `code` question type: schemas (PLAN-MVP §2.4, docs/spec/04 §4.7).
 *
 * Four shapes travel through the platform and each one has its own schema:
 *
 * - {@link CodeConfig}   what the teacher authors (the answer key lives here);
 * - {@link CodeAnswer}   what the student sends back: the editable regions only;
 * - {@link CodeStudent}  what `toStudent` is allowed to hand to a student;
 * - {@link CodeSolution} the key, served only when the feedback policy allows it;
 * - {@link CodeDetails}  the breakdown stored in `gradings.details`.
 *
 * The template carries `@@lock` / `@@endlock` comment markers; the split and
 * the reassembly live in `@quiz/domain/lockedTemplate` and are never
 * re-implemented here (invariant 14: the source is rebuilt server-side).
 */
import type { RunnerLanguage } from "@quiz/core/server";
import type { TemplateLanguage } from "@quiz/domain/lockedTemplate";
import { z } from "zod";

/**
 * The languages a `code` question may pick: `RunnerLanguage` of `@quiz/core`
 * minus `spice`, which serves the `circuit` type only. A name the runner does
 * not know fails the `satisfies`; a drift from `TemplateLanguage` (the
 * languages `@quiz/domain/lockedTemplate` can split) fails the line below.
 */
export const CODE_LANGUAGES = [
  "c",
  "cpp",
  "python",
  "js",
  "rust",
] as const satisfies readonly RunnerLanguage[];
export const CodeLanguage = z.enum(CODE_LANGUAGES);
export type CodeLanguage = z.infer<typeof CodeLanguage>;
const _templateLanguagesAgree: [CodeLanguage, TemplateLanguage] extends [TemplateLanguage, CodeLanguage]
  ? true
  : never = true;
void _templateLanguagesAgree;

/**
 * Bumped when the shape below changes; stored in `question_versions.config_version`.
 *
 * It stays at 1 although `args`, `compareStdout`, `expectedExitCode`,
 * `runtime` and `cooldown` were added after the first questions were stored:
 * every one of them has a DEFAULT, so a config written before them parses unchanged and
 * means exactly what it meant. A version bump is for a shape a stored config
 * can no longer satisfy (ADR-015).
 */
export const CODE_CONFIG_VERSION = 1;

export const CodeLimits = z.object({
  timeMs: z.number().int().min(100).max(10_000).default(2000),
  memoryMb: z.number().int().min(16).max(512).default(128),
  outputKb: z.number().int().min(1).max(256).default(64),
});
export type CodeLimits = z.infer<typeof CodeLimits>;

export const DEFAULT_LIMITS: CodeLimits = { timeMs: 2000, memoryMb: 128, outputKb: 64 };

export const CodeCompare = z.object({
  trimTrailing: z.boolean().default(true),
  ignoreCase: z.boolean().default(false),
  numeric: z
    .object({ epsilon: z.number().min(0), mode: z.enum(["abs", "rel"]) })
    .nullable()
    .default(null),
});
export type CodeCompare = z.infer<typeof CodeCompare>;

export const DEFAULT_COMPARE: CodeCompare = {
  trimTrailing: true,
  ignoreCase: false,
  numeric: null,
};

/**
 * One input/output test case.
 *
 * `visible` is the stored spelling (docs/spec/04 §4.7); the editor shows the
 * opposite switch ("hidden"), because that is the decision a teacher makes.
 * `timeMs` overrides `limits.timeMs` for this case alone — `null` means "use
 * the question limit".
 */
export const CodeCase = z
  .object({
    name: z.string().min(1).max(60),
    /** The command line, one argument per entry, handed to the program as `argv[1..]`. */
    args: z.array(z.string().max(200)).max(32).default([]),
    stdin: z.string().max(16_000).default(""),
    expected: z.string().max(16_000),
    /**
     * Whether `expected` is compared with stdout at all. Off, the case checks
     * only the exit code (and a crash or a timeout still fails it).
     */
    compareStdout: z.boolean().default(true),
    /** The exit code the case requires; `null` accepts any (crashes still fail). */
    expectedExitCode: z.number().int().min(0).max(255).nullable().default(0),
    visible: z.boolean().default(false),
    points: z.number().min(0).max(100).default(1),
    timeMs: z.number().int().min(100).max(20_000).nullable().default(null),
  })
  .refine((c) => c.compareStdout || c.expectedExitCode !== null, {
    message: "code.case_checks_nothing",
    path: ["compareStdout"],
  });
export type CodeCase = z.infer<typeof CodeCase>;

/**
 * Where the STUDENT'S trial run executes ("Run" in the player). Grading
 * always runs on the backend runner: a browser result is not evidence.
 * `runno` is WASI in a Web Worker, for the languages it ships (`c`,
 * `python`); the backend stays the fallback when a browser cannot.
 */
export const CodeRuntime = z.enum(["backend", "runno"]);
export type CodeRuntime = z.infer<typeof CodeRuntime>;

/**
 * How long the student's run buttons take to refill after a use
 * (`@quiz/domain/cooldown`): `fixed` is 3 s every time; `progressive` is
 * 3 s, then 30 % longer per recent use, up to 30 s, and it decays back when
 * the student stops clicking. A server run never refills faster than its
 * `runsPerMinute` budget allows, whatever this says.
 */
export const CodeCooldown = z
  .enum(["fixed", "progressive"])
  .describe(
    "Cooldown of the student's run buttons: fixed (3 s) or progressive (3 s, +30 % per recent use, up to 30 s).",
  );
export type CodeCooldown = z.infer<typeof CodeCooldown>;

/** The languages the browser runner can run (docs/04 §4.7). */
export const RUNNO_LANGUAGES = ["c", "python"] as const satisfies readonly CodeLanguage[];

export const CodeFile = z.object({
  name: z.string().regex(/^[\w.-]{1,40}$/),
  content: z.string().max(64_000),
});
export type CodeFile = z.infer<typeof CodeFile>;

/**
 * The fields of a PROGRAM question: what the student writes, in what, and
 * how it is built and bounded. `code` and `codeimage` share them field for
 * field (ADR-021) and differ only in how the program is judged — test cases
 * for one, a pixel grid for the other — so the list is written once and each
 * config spreads it. Every field keeps the default it always had: a `code`
 * config stored before the split parses to exactly the same object.
 */
export const programFields = {
  prompt: z.string().min(1).max(20_000),
  language: CodeLanguage,
  runtime: CodeRuntime.default("backend"),
  /**
   * The refill rule of the student's run buttons. A default, like `runtime`:
   * a config stored before it parses to `fixed`, the 3 s wait every run had.
   */
  cooldown: CodeCooldown.default("fixed"),
  /** Starting code, with the locked regions marked by `@@lock` / `@@endlock`. */
  template: z.string().max(40_000).default(""),
  /** Extra files the program reads; injected server-side, never by the client. */
  files: z.array(CodeFile).max(4).default([]),
  action: z.enum(["check", "run"]).default("run"),
  compileArgs: z.string().max(400).default(""),
  limits: CodeLimits.default(DEFAULT_LIMITS),
  runsPerMinute: z.number().int().min(1).max(30).default(10),
  /**
   * The teacher's own solution. It exists for ONE purpose: the "try" button of
   * the editor, which runs it to check the question. It is never sent to a
   * student, in any view.
   */
  referenceSolution: z.string().max(40_000).default(""),
};

/**
 * The program part of any config that carries one — what the shared editor
 * section, the reference cut and the request builders read. Structural, so a
 * `CodeConfig` and a `CodeImageConfig` both satisfy it.
 */
export type ProgramConfig = z.infer<z.ZodObject<typeof programFields>>;

export const CodeConfig = z.object({
  configVersion: z.literal(CODE_CONFIG_VERSION),
  ...programFields,
  allOrNothing: z.boolean().default(false),
  tests: z.object({
    mode: z.literal("io"), // "tap" is phase 3
    compare: CodeCompare.default(DEFAULT_COMPARE),
    cases: z.array(CodeCase).min(1).max(30),
  }),
});
export type CodeConfig = z.infer<typeof CodeConfig>;

export const CodeAnswer = z.object({
  /** One entry per EDITABLE region of the template, in order. */
  regions: z.array(z.string().max(20_000)).max(20),
  /** Summary of the last interactive run, for the live dashboard. */
  lastRun: z
    .object({
      at: z.iso.datetime(),
      requestId: z.uuid(),
      compileOk: z.boolean(),
      passed: z.number().int(),
      total: z.number().int(),
    })
    .nullable()
    .optional(),
});
export type CodeAnswer = z.infer<typeof CodeAnswer>;

export const CodeSegment = z.object({
  kind: z.enum(["locked", "editable"]),
  index: z.number().int().nullable(),
  text: z.string(),
});
export type CodeSegment = z.infer<typeof CodeSegment>;

/**
 * What a student receives. Everything that could carry the key is gone:
 * hidden `stdin`/`expected`, `compileArgs`, the contents of the extra files
 * and the reference solution (decision D15).
 *
 * The comparison options DO travel (audit R-06): they say HOW an output is
 * compared — trailing whitespace, case, a numeric tolerance — never WHAT the
 * answer is, and without them the player judged a visible case by a
 * different rule than the grade (ADR-015 §2).
 */
/**
 * The program half of a student view, shared by `code` and `codeimage`: the
 * statement, the template split into segments, where "Run" executes and how
 * much it may do. Everything that could carry the key — `compileArgs`, the
 * extra files' bytes, the reference solution — is absent by construction.
 */
export const programStudentFields = {
  prompt: z.string(),
  language: CodeLanguage,
  /** Where "Run" executes; the key never depends on it. */
  runtime: CodeRuntime,
  /**
   * How the run buttons refill. Defaulted so that a student view built before
   * the field existed (a payload cached by the host) still parses.
   */
  cooldown: CodeCooldown.default("fixed"),
  segments: z.array(CodeSegment),
  limits: CodeLimits,
  runsPerMinute: z.number().int(),
  /** Enough to say "data.csv is available", never the bytes themselves. */
  filesPreview: z.array(z.object({ name: z.string(), bytes: z.number().int() })),
};

/** The program half of a student view; both types' views satisfy it. */
export type ProgramStudent = z.infer<z.ZodObject<typeof programStudentFields>>;

export const CodeStudent = z.object({
  ...programStudentFields,
  visibleCases: z.array(
    z.object({
      name: z.string(),
      args: z.array(z.string()),
      stdin: z.string(),
      /** Empty when the case does not compare stdout. */
      expected: z.string(),
      compareStdout: z.boolean(),
      expectedExitCode: z.number().int().nullable(),
      points: z.number(),
    }),
  ),
  /** Hidden cases exist but stay opaque during the attempt (docs/06 Q8). */
  hiddenCount: z.number().int(),
  hiddenPoints: z.number(),
  allOrNothing: z.boolean(),
  /** How a visible case's output is compared — the grade's own options. */
  compare: CodeCompare,
});
export type CodeStudent = z.infer<typeof CodeStudent>;

export const CodeSolution = z.object({
  referenceSolution: z.string(),
  cases: z.array(
    z.object({
      name: z.string(),
      args: z.array(z.string()),
      stdin: z.string(),
      expected: z.string(),
      compareStdout: z.boolean(),
      expectedExitCode: z.number().int().nullable(),
      points: z.number(),
      visible: z.boolean(),
    }),
  ),
  compare: CodeCompare,
});
export type CodeSolution = z.infer<typeof CodeSolution>;

export const CodeCaseDetail = z.object({
  name: z.string(),
  visible: z.boolean(),
  points: z.number(),
  ok: z.boolean(),
  exitCode: z.number().nullable(),
  ms: z.number(),
  timedOut: z.boolean(),
  oom: z.boolean(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  stderr: z.string().optional(),
});
export type CodeCaseDetail = z.infer<typeof CodeCaseDetail>;

export const CodeDetails = z.object({
  runner: z.enum(["ok", "unavailable", "busy", "error"]),
  compile: z.object({ ok: z.boolean(), stderr: z.string().max(4000), ms: z.number() }).nullable(),
  cases: z.array(CodeCaseDetail),
  earned: z.number(),
  total: z.number(),
  /**
   * sha256 of the source the runner compiled. `null` when no source was ever
   * assembled (an unanswered question, or a stale answer that does not fit the
   * template any more).
   */
  sourceSha256: z.string().length(64).nullable(),
  /** Machine reason when `runner !== "ok"`, e.g. `template_region_mismatch`. */
  reason: z.string().optional(),
});
export type CodeDetails = z.infer<typeof CodeDetails>;

/** The total the cases are worth, before the item scale is applied. */
export function totalCasePoints(config: CodeConfig): number {
  return config.tests.cases.reduce((sum, c) => sum + c.points, 0);
}

/** The wall-clock budget of one case: its own, or the question's. */
export function caseTimeMs(config: CodeConfig, testCase: CodeCase): number {
  return testCase.timeMs ?? config.limits.timeMs;
}

/**
 * A fresh case, with every default spelled out.
 *
 * The editor adds cases one by one and the schema's defaults only apply when
 * a value is PARSED, so the one place that writes a case literal is here.
 */
export function emptyCodeCase(overrides: Partial<CodeCase> = {}): CodeCase {
  return {
    name: "",
    args: [],
    stdin: "",
    expected: "",
    compareStdout: true,
    expectedExitCode: 0,
    visible: false,
    points: 1,
    timeMs: null,
    ...overrides,
  };
}

/**
 * A fresh draft: the shape, the defaults, and NO content — see `emptyMcqDraft`.
 *
 * It does not validate (an empty prompt and an unnamed case are refused by
 * {@link CodeConfig}), which decision D16 allows for a draft. `language` is
 * the one field that cannot be empty, because the editor needs a syntax to
 * colour; `c` is the language of the course this platform was built for.
 */
export function emptyCodeConfig(): CodeConfig {
  return {
    configVersion: CODE_CONFIG_VERSION,
    prompt: "",
    language: "c",
    // A NEW question runs the student's trials in the browser — instant, and
    // free for the server. Only here: a stored config without the field keeps
    // the zod default, "backend", and so keeps its meaning.
    runtime: "runno",
    cooldown: "fixed",
    template: "",
    files: [],
    action: "run",
    compileArgs: "",
    limits: DEFAULT_LIMITS,
    runsPerMinute: 10,
    allOrNothing: false,
    referenceSolution: "",
    tests: {
      mode: "io",
      compare: DEFAULT_COMPARE,
      cases: [emptyCodeCase({ visible: true })],
    },
  };
}
