import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import { classrooms, courses, enrollments, pools } from "../db/schema.js";
import { subscribe } from "../events.js";
import { poolAccess, staffAccess } from "./guards.js";

/**
 * SSE stream (ADR-005): unidirectional, session cookies reused,
 * `:ping` heartbeat every 25 s, no replay; on (re)connection the client
 * re-issues its requests. Filtering is done via topics computed at
 * connection time based on the role; events carry no data.
 */
export async function eventsPlugin(app: FastifyInstance) {
  app.get(
    "/app/events",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const me = req.user!;
      const topics = new Set<string>([`user:${me.id}`]);
      if (me.role === "teacher" || me.role === "admin") {
        topics.add(`teacher:${me.id}`);
        // Same access predicate as the guards: a co-teacher receives the
        // hints of every course they are staff of, and of its classrooms.
        const own = await app.db
          .select({ courseId: courses.id, roomId: classrooms.id })
          .from(courses)
          .leftJoin(classrooms, eq(classrooms.courseId, courses.id))
          .where(me.role === "admin" ? undefined : staffAccess(me.id));
        for (const r of own) {
          topics.add(`course:${r.courseId}`);
          if (r.roomId) topics.add(`classroom:${r.roomId}`);
        }
        // `pool:<id>` is authorized by THE pool predicate, exactly like
        // `course:<id>` is by the staff one: a connection is subscribed to a
        // pool if and only if `poolAccess` lets it in (PLAN-MVP §4.8).
        const reachablePools = await app.db
          .select({ id: pools.id })
          .from(pools)
          .where(me.role === "admin" ? undefined : poolAccess(me.id));
        for (const p of reachablePools) topics.add(`pool:${p.id}`);
      } else {
        const rooms = await app.db
          .select({ id: enrollments.classroomId })
          .from(enrollments)
          .where(and(eq(enrollments.userId, me.id), eq(enrollments.status, "claimed")));
        for (const r of rooms) topics.add(`classroom:${r.id}`);
      }

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // Caddy/nginx: do not buffer this stream (docs/03, flush_interval -1).
        "x-accel-buffering": "no",
      });
      res.write(":connected\n\n");

      const unsubscribe = subscribe((e) => {
        if (e.topics.some((t) => topics.has(t))) {
          res.write(`data: ${JSON.stringify({ type: e.type, notice: e.notice ?? null })}\n\n`);
        }
      });
      const ping = setInterval(() => res.write(":ping\n\n"), 25_000);

      req.raw.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
    },
  );
}
