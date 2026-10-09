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

import type { AppConfig } from "../../config.js";
import { poolRouteContext } from "./routeContext.js";
import { poolRoutes } from "./poolRoutes.js";
import { memberRoutes } from "./memberRoutes.js";
import { categoryRoutes } from "./categoryRoutes.js";
import { questionRoutes } from "./questionRoutes.js";
import { reviewRoutes } from "./reviewRoutes.js";
import { moveRoutes } from "./moveRoutes.js";
import { starRoutes } from "./starRoutes.js";
import { tryRoutes } from "./tryRoutes.js";
import { assetRoutes } from "./assetRoutes.js";
import { similarRoutes } from "./similarRoutes.js";

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
  reviewRoutes(app, ctx);
  moveRoutes(app, ctx);
  starRoutes(app, ctx);
  tryRoutes(app, ctx);
  assetRoutes(app, ctx);
  similarRoutes(app, ctx);
}
