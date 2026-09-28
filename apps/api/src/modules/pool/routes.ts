/**
 * HTTP surface of the `pool` module (PLAN-MVP §4.2).
 *
 * Every body, query and parameter is parsed by a schema from
 * `@quiz/contracts` (invariant 7); every entity is loaded through a guard
 * that answers 404 when the caller has no access, never 403 (invariant 6);
 * every write is audited and publishes a `pool:<id>` refresh hint.
 *
 * Routes live under `/app/api` (supervisor override of decision D18): the
 * SPA keeps its session cookies, and the future `/api/v1` bearer surface
 * will alias these same handlers.
 */
import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";

import { DEFAULT_MCQ_POLICY, McqPolicy, type QuestionTypeId } from "@quiz/contracts";
import { QUESTION_TYPE_IDS } from "@quiz/core/server";
import {
  DEFAULT_MCQ_SCORE_POLICY,
  MCQ_SCORE_POLICIES,
  type McqScorePolicy,
} from "@quiz/domain/mcqScore";

import type { AppConfig } from "../../config.js";
import { poolRouteContext } from "./routeContext.js";
import { poolRoutes } from "./poolRoutes.js";
import { memberRoutes } from "./memberRoutes.js";
import { categoryRoutes } from "./categoryRoutes.js";
import { questionRoutes } from "./questionRoutes.js";
import { moveRoutes } from "./moveRoutes.js";
import { tryRoutes } from "./tryRoutes.js";
import { assetRoutes } from "./assetRoutes.js";

/**
 * The contracts enum and the registry constant must name the same types.
 * This assignment is the compile-time proof: adding a fifth type to
 * `@quiz/core` without adding it to `@quiz/contracts` stops the build here.
 */
const _questionTypesAgree: readonly QuestionTypeId[] = QUESTION_TYPE_IDS;
void _questionTypesAgree;

/**
 * The same proof for the MCQ policies: the wire enum of `@quiz/contracts` and
 * the scoring formulas of `@quiz/domain` (their reference list), both ways,
 * and the same default.
 */
const _mcqPoliciesAgree: readonly McqScorePolicy[] = McqPolicy.options;
const _mcqPoliciesAgreeBack: readonly McqPolicy[] = MCQ_SCORE_POLICIES;
const _mcqDefaultsAgree: typeof DEFAULT_MCQ_SCORE_POLICY = DEFAULT_MCQ_POLICY;
void [_mcqPoliciesAgree, _mcqPoliciesAgreeBack, _mcqDefaultsAgree];

export async function poolPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const ctx = poolRouteContext(app, config);

  await app.register(fastifyMultipart, {
    limits: { fileSize: config.ASSETS_MAX_BYTES, files: 1, fields: 4 },
  });

  poolRoutes(app, ctx);
  memberRoutes(app, ctx);
  categoryRoutes(app, ctx);
  questionRoutes(app, ctx);
  moveRoutes(app, ctx);
  tryRoutes(app, ctx);
  assetRoutes(app, ctx);
}
