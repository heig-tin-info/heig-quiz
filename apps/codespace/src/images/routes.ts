/**
 * Quiz → portal, the workspace images (ADR-146): five service routes, each
 * behind the single-use service token bound to its request (ADR-078's
 * amendment of 2026-10-11), registered in the service routes' own context
 * (`classroom/routes.ts`), whose only body parser is JSON kept as bytes. An
 * admission is addressed by its reference, in the query string.
 *
 *   POST   /api/images/admissions               ask for an admission (202), a tag or a digest
 *   GET    /api/images/admissions?reference=    follow it
 *   GET    /api/images/base                     the current quiz-base (503 before the first release)
 *   GET    /api/images                          the store's workspace images and this instance's admissions
 *   DELETE /api/images?reference=               un-admit one (409 while a live session runs it); the store keeps it
 */
import {
  CodespaceImageAdmissionRequest,
  CodespaceImageQuery,
  IMAGE_ADMISSIONS_PATH,
  IMAGE_BASE_PATH,
  IMAGES_PATH,
} from "@quiz/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

import type { ImageAdmissions } from "./admission.js";

export interface ImageRoutesOptions {
  images: ImageAdmissions;
  /** The service routes' token check: false once it has answered the 401. */
  serviceToken: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
}

function invalid(reply: FastifyReply, error: string, issues: z.core.$ZodIssue[]): FastifyReply {
  return reply.code(400).send({ error, issues: issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
}

export function registerImageRoutes(api: FastifyInstance, { images, serviceToken }: ImageRoutesOptions): void {
  api.post(IMAGE_ADMISSIONS_PATH, async (request, reply) => {
    if (!(await serviceToken(request, reply))) return reply;
    const parsed = CodespaceImageAdmissionRequest.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "invalid_body", parsed.error.issues);
    const result = await images.request(parsed.data.reference);
    request.log.info({ image: { reference: parsed.data.reference, status: result.status } }, "image admission asked");
    return reply.code(result.status).send(result.status === 202 ? result.admission : result.error);
  });

  api.get(IMAGE_ADMISSIONS_PATH, async (request, reply) => {
    if (!(await serviceToken(request, reply))) return reply;
    const query = CodespaceImageQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "invalid_query", query.error.issues);
    const admission = images.get(query.data.reference);
    return admission ? reply.code(200).send(admission) : reply.code(404).send({ error: "unknown_image" });
  });

  api.get(IMAGE_BASE_PATH, async (request, reply) => {
    if (!(await serviceToken(request, reply))) return reply;
    try {
      const base = await images.base();
      return base ? reply.code(200).send(base) : reply.code(503).send({ error: "base_unreleased" });
    } catch (err) {
      request.log.warn({ err: String((err as Error).message ?? err) }, "the current quiz-base could not be read");
      return reply.code(503).send({ error: "registry_unavailable" });
    }
  });

  api.get(IMAGES_PATH, async (request, reply) => {
    if (!(await serviceToken(request, reply))) return reply;
    return reply.code(200).send(await images.list());
  });

  api.delete(IMAGES_PATH, async (request, reply) => {
    if (!(await serviceToken(request, reply))) return reply;
    const query = CodespaceImageQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "invalid_query", query.error.issues);
    const result = await images.remove(query.data.reference);
    if (result === "removed") return reply.code(204).send();
    if (result === "not_found") return reply.code(404).send({ error: "unknown_image" });
    return reply.code(409).send({ error: result });
  });
}
