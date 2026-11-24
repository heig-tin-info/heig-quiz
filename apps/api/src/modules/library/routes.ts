/**
 * HTTP surface of the `library` module (F-ORG-18, F-ADMIN-10, ADR-144):
 * staff routes only.
 *
 * Every route loads the course through `accessibleCourse` — any member of
 * its staff, an admin's Super Powers included (`staffAccess`, invariant 6);
 * anyone else gets the 404 of a missing course, and a document of another
 * course is the 404 of a missing document. Any member uploads and renames;
 * a delete is the uploader's or a course owner's (`403 owner_required`),
 * refused inside the loader, before anything else is read. The quota is an
 * administrator's alone (`adminGuard`), on a course they reach.
 */
import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { CourseDocumentParam, CourseDocumentPatch, DocumentsQuotaPatch, IdParam } from "@quiz/contracts";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { accessibleCourse, adminGuard, callerOf, isCourseOwner, requireCourseRole, teacherGuard, withRoleStep } from "../guards.js";
import { multipartFile, notFound, sendRanged, teacherRoute } from "../http.js";
import { setDocumentsQuota } from "../org/service.js";
import * as service from "./service.js";

export async function libraryPlugin(
  app: FastifyInstance,
  opts: { config: Pick<AppConfig, "ASSETS_DIR" | "DOCUMENT_MAX_BYTES"> },
) {
  const { config } = opts;
  // Past the cap the file stream is cut and marked `truncated`: the service's `413 file_too_large`.
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.DOCUMENT_MAX_BYTES, files: 1, fields: 4 },
  });

  const requireTeacher = teacherGuard(app);
  const requireAdmin = adminGuard(app);
  const teacher = teacherRoute(app);
  const trace = tracer(app);
  const loadCourse = (req: FastifyRequest, reply: FastifyReply, p: { id: string }) =>
    accessibleCourse(app, req, reply, p);
  const onCourse = { params: IdParam, load: loadCourse };

  /** The document of the course, or the 404 of a missing one. */
  const loadDocument = async (req: FastifyRequest, reply: FastifyReply, p: { id: string; documentId: string }) => {
    const course = await loadCourse(req, reply, p);
    if (!course) return null;
    const row = await service.documentOfCourse(app.db, course.id, p.documentId);
    if (row) return { course, row };
    notFound(reply);
    return null;
  };
  const onDocument = { params: CourseDocumentParam, load: loadDocument };
  const viewerOf = async (req: FastifyRequest, courseId: string): Promise<service.Viewer> => ({
    id: callerOf(req).id,
    owner: await isCourseOwner(app.db, courseId, callerOf(req)),
  });
  /**
   * A delete: `mayDelete`, the rule the list's `canDelete` reads too; anyone
   * else meets the owner role's `403 owner_required`.
   */
  const onDeletable = {
    params: CourseDocumentParam,
    load: withRoleStep(
      loadDocument,
      async (req, reply, scope) =>
        service.mayDelete(scope.row, await viewerOf(req, scope.course.id)) ||
        (await requireCourseRole(app, req, reply, scope.course.id, "owner")) !== null,
    ),
  };
  const auditPayload = (row: { id: string; title: string; kind: string; bytes: number }) => ({
    documentId: row.id,
    title: row.title,
    kind: row.kind,
    bytes: row.bytes,
  });

  app.get(
    "/app/api/courses/:id/documents",
    { preHandler: requireTeacher },
    teacher(onCourse, async ({ req, scope: course }) =>
      service.libraryOf(app.db, config.ASSETS_DIR, course, await viewerOf(req, course.id)),
    ),
  );

  /** One file, multipart: `201` new, `200` when this course already holds the same bytes. */
  app.post(
    "/app/api/courses/:id/documents",
    { preHandler: requireTeacher },
    teacher(onCourse, async ({ req, reply, now, scope: course }) => {
      const part = await multipartFile(req, reply);
      if (!part) return reply;
      const received = await service.receiveUpload(config.ASSETS_DIR, part, config.DOCUMENT_MAX_BYTES);
      const caller = callerOf(req).id;
      const { row, created } = await service.storeDocument(app.db, config.ASSETS_DIR, course.id, received, caller, now);
      if (created) await trace(req, "course.document_upload", "course", course.id, auditPayload(row));
      const document = await service.documentOf(app.db, config.ASSETS_DIR, row, await viewerOf(req, course.id));
      return reply.code(created ? 201 : 200).send(document);
    }),
  );

  app.patch(
    "/app/api/courses/:id/documents/:documentId",
    { preHandler: requireTeacher },
    teacher({ ...onDocument, body: CourseDocumentPatch }, async ({ req, now, body, scope }) => {
      const row = await service.renameDocument(app.db, scope.row, body.title, now);
      if (row.title !== scope.row.title) {
        await trace(req, "course.document_rename", "course", scope.course.id, { ...auditPayload(row), from: scope.row.title });
      }
      return service.documentOf(app.db, config.ASSETS_DIR, row, await viewerOf(req, scope.course.id));
    }),
  );

  app.delete(
    "/app/api/courses/:id/documents/:documentId",
    { preHandler: requireTeacher },
    teacher(onDeletable, async ({ req, reply, now, scope }) => {
      await service.deleteDocument(app.db, config.ASSETS_DIR, scope.row, now);
      await trace(req, "course.document_delete", "course", scope.course.id, auditPayload(scope.row));
      return reply.code(204).send();
    }),
  );

  /** The bytes, as an attachment, with `Range`; `404 file_missing` when the row outlived its file. */
  app.get(
    "/app/api/courses/:id/documents/:documentId/file",
    { preHandler: requireTeacher },
    teacher(onDocument, async ({ req, reply, scope }) =>
      sendRanged(req, reply, await service.documentFile(config.ASSETS_DIR, scope.row)),
    ),
  );

  /** F-ADMIN-10: the course's quota, an administrator's alone, on a course they reach. */
  app.patch(
    "/app/api/admin/courses/:id/documents-quota",
    { preHandler: requireAdmin },
    teacher({ ...onCourse, body: DocumentsQuotaPatch }, async ({ req, now, body, scope: course }) => {
      const quotaBytes = await setDocumentsQuota(app.db, course.id, body.quotaBytes, now);
      if (quotaBytes !== course.documentsQuotaBytes) {
        await trace(req, "course.documents_quota", "course", course.id, { from: course.documentsQuotaBytes, to: quotaBytes });
      }
      return { quotaBytes };
    }),
  );
}
