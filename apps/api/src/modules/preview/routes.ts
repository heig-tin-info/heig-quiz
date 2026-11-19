/**
 * HTTP surface of the teacher's stateless preview (issue #75, ADR-018 fourth
 * addendum): four POSTs under `<home>/:id/preview`, one GET for a single
 * item (issue #127) and one for its key. Every one of them exists for both
 * homes of a paper: an evaluation of a classroom
 * (`/app/api/evaluations/:id/...`) and a template of a course
 * (`/app/api/templates/:id/...`, F-EVAL-25), registered from ONE list so
 * the two can never drift apart.
 *
 * Every one of them is a teacher route: the evaluation is LOADED through
 * `loadEvaluation`, the template through `loadTemplate`, so a caller off the
 * course's staff gets the same 404 as a missing one (invariant 6) — and so
 * does a template's id on an evaluation's route, or the other way round:
 * each loader finds only its own kind. Every body is parsed by a schema from
 * `@quiz/contracts` that the web client uses too (invariant 7). The preview
 * is open in every state: it touches nothing a student could see.
 *
 * All four POSTs are reads behind a POST as far as the refresh hints are
 * concerned (`config: { readOnly: true }`, see `app.ts`): nothing was
 * written, so there is nothing for another screen to re-read.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  IdParam,
  ItemParam,
  PreviewGradeBody,
  PreviewRunBody,
  PreviewSimulateBody,
  PreviewStartBody,
  type EvaluationPreview,
  type ItemPreview,
  type PreviewCorrection,
  type PreviewSolution,
  type RunAccepted,
} from "@quiz/contracts";
import type { InteractiveOutcome } from "@quiz/core/server";

import type { EvaluationRecord } from "../evaluation/service.js";
import { callerOf, loadEvaluation, loadTemplate, teacherGuard } from "../guards.js";
import { teacherRoute } from "../http.js";
import * as service from "./service.js";

/** One home of a previewed paper: its path, and the loader that finds it for the caller. */
interface Home {
  readonly prefix: string;
  load(req: FastifyRequest, reply: FastifyReply, params: { id: string }): Promise<EvaluationRecord | null>;
}

export async function previewPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  /** A refusal of the preview is `{ error, ...extra }`, a `retry-after` lifted to a header. */
  function arms(reply: FastifyReply, error: unknown): FastifyReply | null {
    if (!(error instanceof service.PreviewError)) return null;
    const { retryAfterS, ...extra } = error.details ?? {};
    if (typeof retryAfterS === "number") reply.header("retry-after", String(retryAfterS));
    return reply.code(error.status).send({ error: error.code, ...extra });
  }

  const teacher = teacherRoute(app, arms);
  const options = { preHandler: requireTeacher, config: { readOnly: true } };

  /*
   * A template is a row of `evaluations` (ADR-031), and the preview service
   * reads nothing of a run: it takes the row either loader found. The item
   * routes look the item up INSIDE that row, so an item of another paper is
   * a 404 like a missing one, whoever owns its pool (issue #127, ADR-031
   * addendum c): a colleague on the course's staff previews every item.
   */
  const homes: readonly Home[] = [
    {
      prefix: "/app/api/evaluations",
      load: async (req, reply, p) => (await loadEvaluation(app, req, reply, p.id))?.evaluation ?? null,
    },
    {
      prefix: "/app/api/templates",
      load: async (req, reply, p) => (await loadTemplate(app, req, reply, p.id))?.template ?? null,
    },
  ];

  for (const { prefix, load } of homes) {
    /**
     * A fresh seed — or the one the walk already holds, to reload it (ADR-018,
     * sixth addendum) — and the paper as a student holding it would get it.
     */
    app.post(
      `${prefix}/:id/preview`,
      options,
      teacher(
        { params: IdParam, body: PreviewStartBody, optionalBody: true, load },
        ({ body, now, scope }): Promise<EvaluationPreview> =>
          service.startPreview(app.db, scope, now, body.seed ?? service.drawPreviewSeed()),
      ),
    );

    /** One item as the student will see it, at its frozen version: a row's Preview button. */
    app.get(
      `${prefix}/:id/preview/items/:itemId`,
      { preHandler: requireTeacher },
      teacher(
        { params: ItemParam, load },
        ({ params, scope }): Promise<ItemPreview> => service.itemPreview(app.db, scope, params.itemId),
      ),
    );

    /** The key of one item preview, for its "Show answers". */
    app.get(
      `${prefix}/:id/preview/items/:itemId/solution`,
      { preHandler: requireTeacher },
      teacher(
        { params: ItemParam, load },
        ({ params, scope }): Promise<PreviewSolution> => service.itemSolution(app.db, scope, params.itemId),
      ),
    );

    /** The Run button of a code question, visible cases only (or a free stdin). */
    app.post(
      `${prefix}/:id/preview/run`,
      options,
      teacher(
        { params: IdParam, body: PreviewRunBody, load },
        async ({ req, now, body, scope }): Promise<RunAccepted> => {
          const result = await service.runPreview(app.db, {
            runner: app.runner,
            evaluation: scope,
            userId: callerOf(req).id,
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
      `${prefix}/:id/preview/simulate`,
      options,
      teacher(
        { params: IdParam, body: PreviewSimulateBody, load },
        ({ req, now, body, scope }): Promise<InteractiveOutcome> =>
          service.simulatePreview(app.db, {
            runner: app.runner,
            evaluation: scope,
            userId: callerOf(req).id,
            seed: body.seed,
            itemId: body.itemId,
            answer: body.answer,
            now,
          }),
      ),
    );

    /** Every answer and the seed in; the full correction out. Nothing stored. */
    app.post(
      `${prefix}/:id/preview/grade`,
      options,
      teacher(
        { params: IdParam, body: PreviewGradeBody, load },
        ({ req, now, body, scope }): Promise<PreviewCorrection> =>
          service.gradePreview(app.db, {
            runner: app.runner,
            evaluation: scope,
            userId: callerOf(req).id,
            seed: body.seed,
            answers: body.answers,
            coordinates: body.coordinates,
            now,
            log: (err, msg) => req.log.error({ err }, msg),
          }),
      ),
    );
  }
}
