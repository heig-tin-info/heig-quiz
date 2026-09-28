/** Moving questions between pools (ADR-017). */
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  MoveBody,
  type MoveBlockingCourse,
  type MoveConflict,
  type MoveResult,
} from "@quiz/contracts";

import { pools, questions } from "../../db/schema.js";
import { findAccessiblePool, requirePoolRole } from "../guards.js";
import { invalid } from "../http.js";
import { publish } from "../../events.js";
import { poolChanged } from "./events.js";
import * as service from "./service.js";
import type { PoolRouteContext } from "./routeContext.js";

/** A course that plays a moved question, with whether the caller may link it. */
type BlockingCourse = service.UsingCourse & { mayLink: boolean };

export function moveRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { requireTeacher, trace, mine, teacher } = ctx;

  /**
   * `POST /questions/move` — the question changes pool and KEEPS its id.
   *
   * It is the sibling of `/copy` above and its opposite: a copy is a new
   * question that remembers where it came from, a move is the same question
   * somewhere else. Everything frozen on one of its versions goes on
   * resolving, which is precisely why the id may not change (F-EVAL-03).
   *
   * One route for one question and for twenty: the drag-and-drop of the
   * sidebar sends a list of one. Rights are the ones the two halves of a move
   * really are — `contributor` on every SOURCE pool (what it takes to delete
   * a question from it) and `contributor` on the TARGET (what it takes to
   * create one there) — and a target the caller cannot reach is a 404, like
   * any entity they cannot see (invariant 6).
   *
   * The refusal that matters is the third one: a classroom already PLAYS one
   * of these questions, and the target pool is not among the pools its course
   * draws from. Moving would leave the staff of that course unable to reach
   * the question again. The server always checks it; the client only asks the
   * teacher and retries with `linkCourses: true`, which links the pool to
   * those courses — never to a course the caller is not staff of (ADR-017).
   */
  app.post("/app/api/questions/move", { preHandler: requireTeacher }, async (req, reply) => {
    const body = MoveBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const ids = [...new Set(body.data.questionIds)];

    const sources = await moveSources(req, ids);
    if (sources.length !== ids.length) return reply.code(404).send({ error: "not_found" });
    const target = await findAccessiblePool(app.db, req.user!, body.data.targetPoolId);
    if (!target) return reply.code(404).send({ error: "not_found" });

    const sourcePools = new Map(sources.map((row) => [row.pool.id, row.pool]));
    for (const pool of [...sourcePools.values(), target]) {
      if (!(await requirePoolRole(app, req, reply, pool, "contributor"))) return reply;
    }

    const categoryId = body.data.categoryId ?? null;
    if (!(await service.isCategoryOf(app.db, target.id, categoryId))) {
      return reply.code(404).send({ error: "not_found" });
    }

    const named = await blockingCourses(req, ids, target.id);
    const refusal = linkRefusal(named, body.data.linkCourses, target);
    if (refusal) return reply.code(409).send(refusal);
    const linkCourseIds = named.map((c) => c.courseId);

    try {
      await service.moveQuestions(app.db, {
        questions: sources.map((row) => row.question),
        targetPoolId: target.id,
        categoryId,
        linkCourseIds,
      });
    } catch (error) {
      if (error instanceof service.MoveNameTaken) {
        const conflict: MoveConflict = {
          error: "name_taken",
          message: `The pool "${target.name}" already has a question named ${error.names[0]}`,
          courses: [],
          names: error.names,
        };
        return reply.code(409).send(conflict);
      }
      throw error;
    }

    await afterMove(req, sources, target, categoryId, linkCourseIds);
    const result: MoveResult = {
      moved: sources.length,
      questionIds: sources.map((row) => row.question.id),
      targetPoolId: target.id,
      categoryId,
      linkedCourseIds: linkCourseIds,
    };
    return result;
  });

  /**
   * Every source question of a move, LOADED under `poolAccess` in one query:
   * a list that comes back short holds at least one question this caller
   * cannot see, and the answer is the same 404 a missing id would give.
   */
  function moveSources(req: FastifyRequest, ids: string[]) {
    return app.db
      .select({ question: questions, pool: pools })
      .from(questions)
      .innerJoin(pools, eq(questions.poolId, pools.id))
      .where(and(inArray(questions.id, ids), mine(req)));
  }

  /**
   * The courses that already PLAY one of these questions and do not draw
   * from the target pool, each with whether the caller may link the pool to
   * it (a staff seat there, or admin).
   */
  async function blockingCourses(
    req: FastifyRequest,
    ids: string[],
    targetPoolId: string,
  ): Promise<BlockingCourse[]> {
    const using = await service.coursesUsingQuestions(app.db, ids);
    const linked = await service.coursesLinkedToPool(
      app.db,
      targetPoolId,
      using.map((c) => c.courseId),
    );
    const blocking = using.filter((c) => !linked.has(c.courseId));
    const seats =
      req.user!.role === "admin"
        ? null
        : await service.staffSeatsOf(app.db, req.user!.id, blocking.map((c) => c.courseId));
    return blocking.map((c) => ({
      ...c,
      mayLink: seats === null || seats.has(c.courseId),
    }));
  }

  /**
   * The 409 a move meets while blocking courses remain: the client has not
   * asked to link them yet, or one of them is a course the caller may not
   * link. Null when the move may go on (linking every blocking course).
   */
  function linkRefusal(
    named: BlockingCourse[],
    linkCourses: boolean | undefined,
    target: typeof pools.$inferSelect,
  ): MoveConflict | null {
    if (named.length === 0) return null;
    if (linkCourses !== true) {
      return {
        error: "pool_not_linked",
        message: `This question is used by ${named[0]!.courseCode}; the pool "${target.name}" is not one of that course's pools`,
        courses: named.map(asSeen),
        names: [],
      };
    }
    const forbidden = named.filter((c) => !c.mayLink);
    if (forbidden.length > 0) {
      return {
        error: "course_forbidden",
        message: `You are not on the teaching staff of ${forbidden[0]!.courseCode}, so this pool cannot be added to it`,
        courses: forbidden.map(asSeen),
        names: [],
      };
    }
    return null;
  }

  /**
   * A blocking course as the caller may see it: in full when they hold a
   * seat on it, by its code alone otherwise — no id, no name, no classroom
   * of a course they cannot open (invariant 6).
   */
  function asSeen(course: BlockingCourse): MoveBlockingCourse {
    return course.mayLink
      ? course
      : { courseId: null, courseName: null, courseCode: course.courseCode, classrooms: [], mayLink: false };
  }

  /** The audit rows and the refresh hints of a move that went through. */
  async function afterMove(
    req: FastifyRequest,
    sources: Awaited<ReturnType<typeof moveSources>>,
    target: typeof pools.$inferSelect,
    categoryId: string | null,
    linkCourseIds: string[],
  ): Promise<void> {
    for (const row of sources) {
      await trace(req, "question.move", "question", row.question.id, {
        fromPoolId: row.pool.id,
        toPoolId: target.id,
        categoryId,
        internalName: row.question.internalName,
      });
    }
    for (const courseId of linkCourseIds) {
      await trace(req, "course.pools_update", "course", courseId, {
        addedPoolId: target.id,
        reason: "question.move",
      });
      publish("courses", [`course:${courseId}`, `teacher:${req.user!.id}`]);
    }
    // Both ends refresh: the questions left one list and joined another.
    const poolIds = new Set([...sources.map((row) => row.pool.id), target.id]);
    for (const poolId of poolIds) poolChanged(poolId);
  }
}
