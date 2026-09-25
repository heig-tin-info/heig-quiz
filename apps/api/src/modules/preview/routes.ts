/**
 * HTTP surface of the teacher's stateless evaluation preview (issue #75,
 * ADR-018 fourth addendum). Four POSTs under `/app/api/evaluations/:id/preview`.
 *
 * Every one of them is a teacher route: the evaluation is LOADED through
 * `loadEvaluation`, so a caller off the course's staff gets the same 404 as a
 * missing evaluation (invariant 6), and every body is parsed by a schema from
 * `@quiz/contracts` that the web client uses too (invariant 7). The preview
 * is open in every state of the evaluation: it touches nothing a student
 * could see.
 *
 * All four are reads behind a POST as far as the refresh hints are concerned
 * (`config: { readOnly: true }`, see `app.ts`): nothing was written, so there
 * is nothing for another screen to re-read.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  IdParam,
  PreviewGradeBody,
  PreviewRunBody,
  PreviewSimulateBody,
  type EvaluationPreview,
  type PreviewCorrection,
  type RunAccepted,
} from "@quiz/contracts";
import type { RunnerOutcome } from "@quiz/core/server";

import { loadEvaluation, teacherGuard } from "../guards.js";
import { teacherRoute } from "../http.js";
import * as service from "./service.js";

export async function previewPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  function failure(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof service.PreviewError) {
      const { retryAfterS, ...extra } = error.extra;
      if (typeof retryAfterS === "number") reply.header("retry-after", String(retryAfterS));
      return reply.code(error.status).send({ error: error.code, ...extra });
    }
    reply.log.error({ err: error, cause: (error as Error)?.cause }, "preview route failed");
    return reply.code(500).send({ error: "internal_error" });
  }

  const teacher = teacherRoute(app, failure);
  const staffEvaluation = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    loadEvaluation(app, req, reply, p.id);
  const options = { preHandler: requireTeacher, config: { readOnly: true } };

  /** A fresh seed, and the evaluation as a student holding it would get it. */
  app.post(
    "/app/api/evaluations/:id/preview",
    options,
    teacher(
      { params: IdParam, load: staffEvaluation },
      ({ now, scope }): Promise<EvaluationPreview> =>
        service.startPreview(app.db, scope.evaluation, now, service.drawPreviewSeed()),
    ),
  );

  /** The Run button of a code question, visible cases only (or a free stdin). */
  app.post(
    "/app/api/evaluations/:id/preview/run",
    options,
    teacher(
      { params: IdParam, body: PreviewRunBody, load: staffEvaluation },
      async ({ req, now, body, scope }): Promise<RunAccepted> => {
        const result = await service.runPreview(app.db, {
          runner: app.runner,
          evaluation: scope.evaluation,
          userId: req.user!.id,
          seed: body.seed,
          itemId: body.itemId,
          regions: body.regions,
          stdin: body.stdin,
          args: body.args,
          compileOnly: body.compileOnly,
          now,
        });
        // The shape of `POST /attempts/:id/run`, so the player reads both the
        // same way. There is no SSE frame behind it: the response IS the
        // delivery, and the request id only names it.
        return { requestId: randomUUID(), result };
      },
    ),
  );

  /** The Simulate button of a type that builds its own request (ADR-019). */
  app.post(
    "/app/api/evaluations/:id/preview/simulate",
    options,
    teacher(
      { params: IdParam, body: PreviewSimulateBody, load: staffEvaluation },
      ({ req, now, body, scope }): Promise<RunnerOutcome> =>
        service.simulatePreview(app.db, {
          runner: app.runner,
          evaluation: scope.evaluation,
          userId: req.user!.id,
          seed: body.seed,
          itemId: body.itemId,
          answer: body.answer,
          now,
        }),
    ),
  );

  /** Every answer and the seed in; the full correction out. Nothing stored. */
  app.post(
    "/app/api/evaluations/:id/preview/grade",
    options,
    teacher(
      { params: IdParam, body: PreviewGradeBody, load: staffEvaluation },
      ({ req, now, body, scope }): Promise<PreviewCorrection> =>
        service.gradePreview(app.db, {
          runner: app.runner,
          evaluation: scope.evaluation,
          userId: req.user!.id,
          seed: body.seed,
          answers: body.answers,
          now,
          log: (err, msg) => req.log.error({ err }, msg),
        }),
    ),
  );
}
