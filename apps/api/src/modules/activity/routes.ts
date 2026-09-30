import type { FastifyInstance } from "fastify";

import { teacherGuard } from "../guards.js";
import * as service from "./service.js";

export async function activityPlugin(app: FastifyInstance) {
  const requireTeacher = teacherGuard(app);

  /**
   * The Activities section (issue #190): every activity of the classrooms
   * the caller teaches, and their own anonymous polls, in one read. The
   * scope IS each kind's access predicate (invariant 6), without the admin
   * override: an admin sees their own activities, like any teacher. No
   * input, so no schema.
   */
  app.get("/app/api/activities", { preHandler: requireTeacher }, async (req) =>
    service.listForTeacher(app.db, req.user!, app.clock.now()),
  );
}
