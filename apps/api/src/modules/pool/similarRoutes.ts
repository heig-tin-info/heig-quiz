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
 * and a draft never does either (`rankReachableQuestions` keeps the
 * published, live questions only).
 *
 * The statistics are the pool screen's own (`poolQuestionStats`, ADR-038),
 * narrowed to the hits, so the ten-answer threshold and the exams-only rule
 * hold here exactly as there. Composed here rather than in the pool service:
 * the stats module already imports the pool module.
 */
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import {
  IdParam,
  SimilarQuestionSearch,
  type QuestionTypeId,
  type SimilarQuestions,
} from "@quiz/contracts";
import { linkModeFor } from "@quiz/domain";
import { similarityTerms } from "@quiz/domain/similarityTerms";

import { pools } from "../../db/schema.js";
import { accessibleCourse, callerOf } from "../guards.js";
import { poolQuestionStats } from "../stats/service.js";
import type { PoolRouteContext } from "./routeContext.js";
import * as service from "./service.js";

/** How much of a statement a hit shows: enough to recognise it. */
const EXCERPT_CHARS = 240;

/** The indexed text of a version without the internal name it starts with, folded and cut. */
function excerptOf(searchText: string, internalName: string): string {
  const text = searchText.startsWith(internalName) ? searchText.slice(internalName.length) : searchText;
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
        const hits = await service.rankReachableQuestions(app.db, {
          poolWhere: mine(req),
          courseId: course.id,
          terms: similarityTerms(query.text),
          limit: query.limit,
          type: query.type,
        });
        const byPool = new Map<string, string[]>();
        for (const hit of hits) byPool.set(hit.pool.id, [...(byPool.get(hit.pool.id) ?? []), hit.question.id]);
        if (byPool.size === 0) return { items: [] };
        const hitPools = inArray(pools.id, [...byPool.keys()]);
        const [roles, stats] = await Promise.all([
          service.poolRolesOf(app.db, hitPools, callerOf(req)),
          Promise.all([...byPool].map(([poolId, ids]) => poolQuestionStats(app.db, poolId, ids))),
        ]);
        const statsOf = new Map(stats.flatMap((s) => s.items).map((s) => [s.questionId, s] as const));
        return {
          items: hits.map(({ question, pool, latestNumber, linked, searchText }) => {
            const figures = statsOf.get(question.id);
            const held = roles.get(pool.id);
            return {
              questionId: question.id,
              pool,
              type: question.type as QuestionTypeId,
              internalName: question.internalName,
              excerpt: excerptOf(searchText, question.internalName),
              latestNumber,
              linked,
              // `linkModeFor`: edit where the caller contributes, read-only on a public pool (ADR-095).
              canLink: linked || (held !== undefined && linkModeFor(held.role, held.isPublic) !== null),
              stats: figures ? { n: figures.n, p: figures.p, r: figures.discrimination?.r ?? null } : null,
            };
          }),
        };
      },
    ),
  );
}
