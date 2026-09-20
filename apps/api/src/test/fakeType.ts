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
