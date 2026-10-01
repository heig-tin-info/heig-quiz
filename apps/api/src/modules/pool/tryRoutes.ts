/** Previewing a question and trying an answer on it. */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  IdParam,
  PreviewBody,
  TryBody,
  issuesOf,
  type PreviewSolution,
  type TryResult,
} from "@quiz/contracts";
import {
  RunnerBusy,
  RunnerUnavailable,
  type FinalizeContext,
  type GradeContext,
  type GradedResult,
} from "@quiz/core/server";

import { questions } from "../../db/schema.js";
import { studentSolutionViewOf, studentViewOf, teacherPreviewView } from "../live/studentView.js";
import { loadConfig, tryLoadConfig, typeOf } from "./config.js";
import { instanceOf, isParameterized, parameterIssues } from "./instance.js";
import type { VersionRecord } from "./shared.js";
import * as service from "./service.js";
import type { PoolRouteContext } from "./routeContext.js";

export function tryRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, teacher, onQuestion } = ctx;

  /** The config of `"draft"` or of a published number, migrated and parsed. */
  async function configOf(
    reply: FastifyReply,
    question: typeof questions.$inferSelect,
    source: "draft" | number,
  ): Promise<{ config: unknown } | null> {
    const row =
      source === "draft"
        ? await service.draftOf(app.db, question.id)
        : await service.versionRow(app.db, question.id, source);
    if (!row) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    const outcome = isParameterized(row) ? tryInstance(question, row) : tryLoadConfig(question.type, row);
    if (!outcome.ok) {
      await reply
        .code(422)
        .send({ error: "config_invalid", message: "This version cannot be rendered", details: outcome.issues });
      return null;
    }
    return { config: outcome.config };
  }

  /**
   * A parameterized draft or version is previewed and tried as the instance
   * of the preview's seed (0) and stream (the question's id), drawn on the
   * spot: the same numbers on every open (ADR-056 §8 shows five, PR 3). A
   * table that cannot draw is the draft's issues, not a 500.
   */
  function tryInstance(question: typeof questions.$inferSelect, row: VersionRecord) {
    try {
      const { version } = instanceOf(question.type, row, { seed: 0, itemId: question.id });
      return { ok: true as const, config: loadConfig(question.type, version) };
    } catch (error) {
      const issues = parameterIssues(question.type, row);
      return { ok: false as const, issues: issues.length > 0 ? issues : issuesOf(error) };
    }
  }

  app.post(
    "/app/api/questions/:id/preview",
    // A read behind a POST: no refresh hint on its response (see `app.ts`).
    { preHandler: requireTeacher, config: { readOnly: true } },
    teacher(
      { params: IdParam, body: PreviewBody, optionalBody: true, load: onQuestion() },
      async ({ reply, body, scope }) => {
        const loaded = await configOf(reply, scope.question, body.source);
        if (!loaded) return reply;
        const t = typeOf(scope.question.type);
        return {
          // The type, so a client that has nothing but this payload knows which
          // `Player` to mount (the full-page preview of one question).
          type: scope.question.type,
          // Teacher preview: seed 0 and no shuffle, so the view is stable
          // between two reloads (decision D19). It goes through the ONE student
          // exit of the API (`live/studentView.ts`), like every other payload a
          // student could ever see (invariant 4, WP5).
          student: studentViewOf(scope.question.type, loaded.config, teacherPreviewView(scope.question.id)),
          itemPoints: t.defaultPoints(loaded.config),
        };
      },
    ),
  );

  /**
   * The key of the same view, for the preview's "Show answers": asked for on
   * the click, so the preview above never carries it. The key a student reads
   * once it is shown (ADR-037), not the teacher's whole solution.
   */
  app.post(
    "/app/api/questions/:id/preview/solution",
    { preHandler: requireTeacher, config: { readOnly: true } },
    teacher(
      { params: IdParam, body: PreviewBody, optionalBody: true, load: onQuestion() },
      async ({ reply, body, scope }) => {
        const loaded = await configOf(reply, scope.question, body.source);
        if (!loaded) return reply;
        return {
          solution: studentSolutionViewOf(scope.question.type, loaded.config, teacherPreviewView(scope.question.id)),
        } satisfies PreviewSolution;
      },
    ),
  );

  /**
   * Teacher rehearsal (F-QST-09): the answer is graded in process and
   * nothing is persisted. A `pending: runner` grading is forwarded to the
   * runner when there is one, and degrades to `runner_unavailable`
   * otherwise (decision D14) — never to a 500.
   */
  app.post(
    "/app/api/questions/:id/try",
    // A read behind a POST: no refresh hint on its response (see `app.ts`).
    { preHandler: requireTeacher, config: { readOnly: true } },
    teacher(
      { params: IdParam, body: TryBody, optionalBody: true, load: onQuestion() },
      async ({ reply, body, scope }) => {
        try {
          const loaded = await configOf(reply, scope.question, body.source);
          if (!loaded) return reply;
          const t = typeOf(scope.question.type);
          const answer =
            body.answer === undefined || body.answer === null
              ? null
              : t.answerSchema.parse(body.answer);
          const view = teacherPreviewView(scope.question.id);
          const base: FinalizeContext = {
            seed: 0,
            itemId: scope.question.id,
            attemptId: randomUUID(),
            itemPoints: t.defaultPoints(loaded.config),
            now: new Date(),
          };
          // `app.runner` is always decorated (`modules/runner/index.ts`); on a
          // machine without a container engine it is the `UnavailableRunner`,
          // whose `run()` rejects with `RunnerUnavailable` (decision D14).
          const runner = app.runner;
          const ctx: GradeContext = { ...base, runner };
          const result = await t.grade(loaded.config, answer, ctx);

          if (result.kind === "graded") {
            return graded(result, t.toSolution(loaded.config, view));
          }
          if (result.via === "llm") return { status: "llm_unavailable" } satisfies TryResult;
          if (!t.finalizeRunner) {
            return { status: "runner_unavailable", reason: "not_configured" } satisfies TryResult;
          }
          const outcome = await runner.run(result.request);
          const final = t.finalizeRunner(loaded.config, answer, base, outcome);
          return graded(final, t.toSolution(loaded.config, view));
        } catch (error) {
          if (error instanceof RunnerUnavailable) {
            return { status: "runner_unavailable", reason: error.reason } satisfies TryResult;
          }
          if (error instanceof RunnerBusy) {
            return { status: "runner_unavailable", reason: "busy" } satisfies TryResult;
          }
          if (error instanceof z.ZodError) {
            return reply.code(422).send({ error: "answer_invalid", details: issuesOf(error) });
          }
          // The rest is the module's tail: `coreFailure`, else a 500.
          throw error;
        }
      },
    ),
  );
}

function graded(result: GradedResult, solution: unknown): TryResult {
  const { points, maxPoints, details } = result;
  return {
    status: "graded",
    points,
    maxPoints,
    details,
    solution,
    // A proposal is not a grade: a person decides it (issue #267).
    ...(result.state === "proposed" ? { manual: true as const } : {}),
    ...(result.state === "proposed" && result.comment ? { comment: result.comment } : {}),
  };
}
