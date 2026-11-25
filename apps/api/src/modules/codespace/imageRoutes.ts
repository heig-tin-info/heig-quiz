/**
 * The workspace images' routes (ADR-146 §4–§8), registered by the
 * `codespace` plugin, so only while the online workspace is on (`CODESPACE_URL`
 * and Quiz's App): otherwise each is the 404 of a missing entity. Every body
 * is a schema of `@quiz/contracts`' `codespace.ts` (invariant 7).
 *
 * On a course the caller reaches (`accessibleCourse`: its staff, an admin's
 * Super Powers; anyone else the 404 of a missing course, invariant 6):
 *   - `GET    /app/api/courses/:id/workspace-images` — every staff member;
 *   - `POST   /app/api/courses/:id/workspace-images` — add;
 *   - `PATCH  /app/api/courses/:id/workspace-images/:imageId` — rename;
 *   - `POST   /app/api/courses/:id/workspace-images/:imageId/refresh` — Refresh;
 *   - `DELETE /app/api/courses/:id/workspace-images/:imageId` — remove.
 * A write is the managers' ({@link managerRefusal}: a course owner, `403
 * owner_required`, holding the workspace grant, `403
 * codespace_not_granted`), refused in the loader, before the body; an image
 * of another course is the 404 of a missing one.
 *
 * On a project the caller reaches, the same rule on its course:
 * `PUT /app/api/projects/:id/workspace/image`.
 *
 * The administrator's: `GET /app/api/admin/workspace-images`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";

import {
  ADMIN_WORKSPACE_IMAGES_PATH,
  CourseWorkspaceImageCreate,
  CourseWorkspaceImageParams,
  CourseWorkspaceImagePatch,
  IdParam,
  ProjectWorkspaceImageBody,
} from "@quiz/contracts";

import { actorOf } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { accessibleCourse, adminGuard, callerOf, isCourseOwner, withRoleStep } from "../guards.js";
import { DomainError, notFound, sendFailure, type teacherRoute } from "../http.js";
import * as images from "./images.js";
import { hasGrant, projectWorkspace } from "./service.js";

/** What the `codespace` plugin already built and these routes share with its own. */
interface PluginParts<P> {
  teacher: ReturnType<typeof teacherRoute>;
  session: RouteShorthandOptions;
  /** The staff's project loader (`accessibleProject`). */
  onProject: { params: typeof IdParam; load: (req: FastifyRequest, reply: FastifyReply, params: { id: string }) => Promise<P | null> };
}

export function registerImageRoutes<P extends { project: { id: string } & Parameters<typeof projectWorkspace>[2]; course: { id: string } }>(
  app: FastifyInstance,
  config: AppConfig,
  { teacher, session, onProject }: PluginParts<P>,
): void {
  const requireAdmin = adminGuard(app);
  // The current quiz-base, cached by this plugin instance (ADR-146 §7).
  const bases = images.baseReader(app, config);

  /** THE rule of an image write (ADR-146 §4): an owner of the course, holding the workspace grant; null when the caller is one. */
  const managerRefusal = async (req: FastifyRequest, courseId: string): Promise<"owner_required" | "codespace_not_granted" | null> => {
    const caller = callerOf(req);
    if (!(await isCourseOwner(app.db, courseId, caller))) return "owner_required";
    return (await hasGrant(app.db, caller.id)) ? null : "codespace_not_granted";
  };
  /** {@link managerRefusal} as a loader's role step: its 403. */
  const manager =
    <S>(courseIdOf: (scope: S) => string) =>
    async (req: FastifyRequest, reply: FastifyReply, scope: S): Promise<boolean> => {
      const refusal = await managerRefusal(req, courseIdOf(scope));
      if (refusal === null) return true;
      const error =
        refusal === "owner_required"
          ? new DomainError(refusal, 403, "Only an owner of this course may do that")
          : images.imageError(refusal, "The online workspace is not granted to you");
      sendFailure(reply, error, app.clock.now());
      return false;
    };

  const loadCourse = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) => accessibleCourse(app, req, reply, p);
  const managedCourse = withRoleStep(loadCourse, manager((course: { id: string }) => course.id));
  /** The image of the managed course, or the 404 of a missing one. */
  const managedImage = async (req: FastifyRequest, reply: FastifyReply, p: { id: string; imageId: string }) => {
    const course = await managedCourse(req, reply, p);
    if (!course) return null;
    const row = await images.imageOfCourse(app.db, course.id, p.imageId);
    if (row) return row;
    notFound(reply);
    return null;
  };
  const onImage = { params: CourseWorkspaceImageParams, load: managedImage };

  app.get(
    "/app/api/courses/:id/workspace-images",
    session,
    teacher({ params: IdParam, load: loadCourse }, async ({ req, scope: course }) =>
      images.courseImages(app.db, bases, course.id, (await managerRefusal(req, course.id)) === null),
    ),
  );

  app.post(
    "/app/api/courses/:id/workspace-images",
    session,
    teacher({ params: IdParam, load: managedCourse, body: CourseWorkspaceImageCreate }, async ({ req, reply, now, body, scope: course }) => {
      const row = await images.addImage(app, config, course.id, body, { userId: callerOf(req).id, actor: actorOf(req) }, now);
      return reply.code(201).send(await images.imageView(app.db, bases, row));
    }),
  );

  app.patch(
    "/app/api/courses/:id/workspace-images/:imageId",
    session,
    teacher({ ...onImage, body: CourseWorkspaceImagePatch }, async ({ req, now, body, scope }) =>
      images.imageView(app.db, bases, await images.renameImage(app.db, scope, body.name, actorOf(req), now)),
    ),
  );

  app.post(
    "/app/api/courses/:id/workspace-images/:imageId/refresh",
    session,
    teacher(onImage, async ({ req, now, scope }) =>
      images.imageView(app.db, bases, await images.refreshImage(app, config, scope, actorOf(req), now)),
    ),
  );

  app.delete(
    "/app/api/courses/:id/workspace-images/:imageId",
    session,
    teacher(onImage, async ({ req, reply, now, scope }) => {
      await images.removeImage(app.db, scope, actorOf(req), now);
      return reply.code(204).send();
    }),
  );

  app.put(
    "/app/api/projects/:id/workspace/image",
    session,
    teacher(
      { params: IdParam, load: withRoleStep(onProject.load, manager((scope: P) => scope.course.id)), body: ProjectWorkspaceImageBody },
      async ({ req, now, body, scope }) => {
        await images.setProjectImage(app, config, { id: scope.project.id, courseId: scope.course.id }, body.imageId, actorOf(req), now);
        return projectWorkspace(app.db, config, scope.project, scope.course.id, { userId: callerOf(req).id, owner: true });
      },
    ),
  );

  app.get(ADMIN_WORKSPACE_IMAGES_PATH, { preHandler: requireAdmin }, async (_req, reply) => {
    try {
      return await images.adminImages(app, config);
    } catch (error) {
      return sendFailure(reply, error, app.clock.now());
    }
  });
}
