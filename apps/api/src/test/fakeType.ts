/**
 * Question types for the API tests.
 *
 * `packages/registry` is empty until WP2/WP3 register the real `qt-*`
 * packages, and the `pool` module cannot be tested without a type: these two
 * fakes are registered through `registerForTests` (a no-op in production) so
 * the read/write pipeline, publication, search and grading are exercised for
 * real, against a type whose behaviour the test controls completely.
 *
 * `fakeShort` is deliberately at `configVersion: 2` with a working `migrate`
 * from 1, because "a stored config is raised on read" (PLAN-MVP §1.6) is
 * precisely what a fake at version 1 could not prove.
 */
import { z } from "zod";

import type {
  GradeContext,
  GradeResult,
  QuestionTypeServer,
  StudentView,
} from "@quiz/core/server";

const FakeConfig = z.object({
  /** Renamed from `prompt` at configVersion 2 — see `migrate`. */
  statement: z.string(),
  answer: z.string().min(1),
});
export type FakeConfig = z.infer<typeof FakeConfig>;

const FakeStudent = z.object({ statement: z.string() });
const FakeSolution = z.object({ answer: z.string() });
const FakeDetails = z.object({ matched: z.boolean(), expected: z.string() });

/** A v1 config, as the fake stored it before the rename. */
export const fakeV1Config = (prompt: string, answer: string) => ({ prompt, answer });

export const fakeShort: QuestionTypeServer<
  FakeConfig,
  string,
  z.infer<typeof FakeStudent>,
  z.infer<typeof FakeSolution>,
  z.infer<typeof FakeDetails>
> = {
  id: "short",
  configVersion: 2,
  configSchema: FakeConfig,
  answerSchema: z.string(),
  studentSchema: FakeStudent,
  solutionSchema: FakeSolution,
  detailsSchema: FakeDetails,

  emptyDraft: () => ({ statement: "", answer: "?" }),

  migrate(config, fromVersion) {
    if (fromVersion >= 2) return FakeConfig.parse(config);
    const old = z.object({ prompt: z.string(), answer: z.string() }).parse(config);
    return { statement: old.prompt, answer: old.answer };
  },

  defaultPoints: () => 1,
  shuffleable: () => false,

  toStudent(config: FakeConfig, _view: StudentView) {
    return { statement: config.statement };
  },
  toSolution(config: FakeConfig) {
    return { answer: config.answer };
  },

  grade(config: FakeConfig, answer: string | null, ctx: GradeContext): GradeResult<
    z.infer<typeof FakeDetails>
  > {
    const matched = answer !== null && answer.trim() === config.answer.trim();
    return {
      kind: "graded",
      points: matched ? ctx.itemPoints : 0,
      maxPoints: ctx.itemPoints,
      details: { matched, expected: config.answer },
      state: "validated",
    };
  },

  /** The statement only: an index is not a place to put the answer key. */
  searchText: (config: FakeConfig) => config.statement,
};

const RunnerConfig = z.object({ source: z.string() });

/**
 * A type whose grading is `pending: runner`, to exercise the branch of
 * `POST /try` that degrades to `runner_unavailable` when no runner is
 * configured (decision D14).
 */
export const fakeRunnerType: QuestionTypeServer<
  z.infer<typeof RunnerConfig>,
  string,
  { source: string },
  { source: string },
  { ok: boolean }
> = {
  id: "code",
  configVersion: 1,
  configSchema: RunnerConfig,
  answerSchema: z.string(),
  studentSchema: z.object({ source: z.string() }),
  solutionSchema: z.object({ source: z.string() }),
  detailsSchema: z.object({ ok: z.boolean() }),

  emptyDraft: () => ({ source: "" }),
  migrate: (config) => RunnerConfig.parse(config),
  defaultPoints: () => 2,
  shuffleable: () => false,
  toStudent: (config) => ({ source: config.source }),
  toSolution: (config) => ({ source: config.source }),

  grade(_config, answer): GradeResult<{ ok: boolean }> {
    return {
      kind: "pending",
      via: "runner",
      request: {
        language: "c",
        files: [{ name: "main.c", content: answer ?? "" }],
        compileArgs: "",
        action: "run",
        limits: { timeMs: 1000, memoryMb: 64, outputKb: 8 },
        cases: [],
        priority: "interactive",
      },
    };
  },

  searchText: (config) => config.source,
};

const RunnableConfig = z.object({
  template: z.string(),
  runsPerMinute: z.number().int().default(2),
  cases: z.array(
    z.object({
      name: z.string(),
      /** `argv[1..]`, like a `qt-code` case: the live module must forward it. */
      args: z.array(z.string()).default([]),
      expected: z.string(),
      visible: z.boolean(),
    }),
  ),
});

/**
 * A runner-backed type whose answer has the `{ regions }` shape of
 * `POST /attempts/:id/run`, with BOTH halves of the runner protocol
 * (`grade` → `pending`, then `finalizeRunner`). It is what makes the WP5 run
 * route testable without `@quiz/qt-code`: the live module must work for any
 * type that declares `finalizeRunner`, not for one package in particular.
 */
export const fakeRunnableCode: QuestionTypeServer<
  z.infer<typeof RunnableConfig>,
  { regions: string[] },
  {
    template: string;
    runsPerMinute: number;
    visibleCases: { name: string; args: string[]; stdin: string; expected: string }[];
  },
  { cases: { name: string; expected: string }[] },
  { passed: number }
> = {
  id: "code",
  configVersion: 1,
  configSchema: RunnableConfig,
  answerSchema: z.object({ regions: z.array(z.string()) }),
  studentSchema: z.object({
    template: z.string(),
    runsPerMinute: z.number().int(),
    visibleCases: z.array(
      z.object({
        name: z.string(),
        args: z.array(z.string()),
        stdin: z.string(),
        expected: z.string(),
      }),
    ),
  }),
  solutionSchema: z.object({
    cases: z.array(z.object({ name: z.string(), expected: z.string() })),
  }),
  detailsSchema: z.object({ passed: z.number().int() }),

  emptyDraft: () => ({
    template: "",
    runsPerMinute: 2,
    cases: [{ name: "visible-1", args: [], expected: "ok", visible: true }],
  }),
  migrate: (config) => RunnableConfig.parse(config),
  defaultPoints: (config) => config.cases.length,
  shuffleable: () => false,

  toStudent(config) {
    return {
      template: config.template,
      runsPerMinute: config.runsPerMinute,
      // Only the visible half, exactly like `qt-code` (decision D15).
      visibleCases: config.cases
        .filter((c) => c.visible)
        .map((c) => ({ name: c.name, args: [...c.args], stdin: "", expected: c.expected })),
    };
  },
  toSolution: (config) => ({
    cases: config.cases.map((c) => ({ name: c.name, expected: c.expected })),
  }),

  grade(config, answer) {
    return {
      kind: "pending",
      via: "runner",
      request: {
        language: "c",
        files: [{ name: "main.c", content: (answer?.regions ?? []).join("\n") }],
        compileArgs: "",
        action: "run",
        limits: { timeMs: 1000, memoryMb: 64, outputKb: 8 },
        cases: config.cases.map((c) => ({ name: c.name, args: [...c.args], stdin: "" })),
        priority: "grading",
      },
    };
  },

  finalizeRunner(config, _answer, ctx, outcome) {
    const passed = outcome.cases.filter((c) => c.exitCode === 0).length;
    return {
      kind: "graded",
      points: (passed / Math.max(1, config.cases.length)) * ctx.itemPoints,
      maxPoints: ctx.itemPoints,
      details: { passed },
      state: "validated",
    };
  },

  searchText: (config) => config.template,
};
