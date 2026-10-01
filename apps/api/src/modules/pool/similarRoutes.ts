/**
 * `GET /courses/:id/similar-questions` (ADR-022, addendum of 2026-10-01):
 * the published questions closest to a statement about to be written, so
 * that an existing one is reused — and its statistics grow — instead of a
 * duplicate starting from nothing. The MCP tool `find_similar_questions` is a
 * thin client of it; the web app may call it too (docs/08 §8.1, principle 4).
 *
 * Access is loaded twice, never checked afterwards (invariant 6): the course
 * through the staff predicate (a 404 otherwise), the questions through the
 * caller's `poolAccess` — a pool they cannot see never contributes a hit,
 * and a draft never does either (`searchReachableQuestions` keeps the
 * published, live questions only).
 *
 * The statistics are the pool screen's own (`poolQuestionStats`, ADR-038),
 * read once per distinct pool of the hits, so the ten-answer threshold and
 * the exams-only rule hold here exactly as there.
 */
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import {
  IdParam,
  SimilarQuestionSearch,
  type QuestionTypeId,
  type SimilarQuestion,
  type SimilarQuestions,
} from "@quiz/contracts";
import { poolRoleAllows } from "@quiz/domain";
import { similarityTerms } from "@quiz/domain/similarityTerms";

import { pools } from "../../db/schema.js";
import { accessibleCourse, callerOf } from "../guards.js";
import { poolQuestionStats } from "../stats/service.js";
import type { PoolRouteContext } from "./routeContext.js";
import * as service from "./service.js";

/** How much of a statement a hit shows: enough to recognise it. */
const EXCERPT_CHARS = 240;

/** The start of a version's statement, as the type indexes it; empty when it no longer parses. */
function excerptOf(type: string, version: { config: unknown; configVersion: number }): string {
  let text = "";
  try {
    text = service.typeOf(type).searchText(service.loadConfig(type, version) as never);
  } catch {
    return "";
  }
  const folded = text.replace(/\s+/g, " ").trim();
  return folded.length > EXCERPT_CHARS ? `${folded.slice(0, EXCERPT_CHARS - 1)}…` : folded;
}

export function similarRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, teacher, mine } = ctx;

  app.get(
    "/app/api/courses/:id/similar-questions",
    { preHandler: requireTeacher },
    teacher(
      {
        params: IdParam,
        query: SimilarQuestionSearch,
        load: (req, reply, params) => accessibleCourse(app, req, reply, params),
      },
      async ({ req, query, scope: course }): Promise<SimilarQuestions> => {
        const found = await service.searchReachableQuestions(app.db, {
          poolWhere: mine(req),
          course: { id: course.id, only: query.scope === "linked" },
          types: query.type ? [query.type] : null,
          order: {
            kind: "rank",
            terms: similarityTerms(query.text),
            limit: query.limit,
            linkedFirst: query.scope === undefined,
          },
        });
        const poolIds = [...new Set(found.items.map((hit) => hit.pool.id))];
        if (poolIds.length === 0) return { items: [] };
        const [roles, stats] = await Promise.all([
          service.listPools(app.db, inArray(pools.id, poolIds), callerOf(req)),
          Promise.all(poolIds.map((id) => poolQuestionStats(app.db, id))),
        ]);
        const roleOf = new Map(roles.map((p) => [p.id, p.role] as const));
        const statsOf = new Map(stats.flatMap((s) => s.items).map((s) => [s.questionId, s] as const));
        return {
          items: found.items.map(({ question, pool, latestNumber, latest, linked }): SimilarQuestion => {
            const figures = statsOf.get(question.id);
            const role = roleOf.get(pool.id);
            return {
              questionId: question.id,
              pool,
              type: question.type as QuestionTypeId,
              internalName: question.internalName,
              excerpt: excerptOf(question.type, latest),
              latestNumber,
              linked,
              canLink: linked || (role !== undefined && poolRoleAllows(role, "contributor")),
              stats: figures
                ? { n: figures.n, p: figures.p, r: figures.discrimination?.r ?? null }
                : null,
            };
          }),
        };
      },
    ),
  );
}
