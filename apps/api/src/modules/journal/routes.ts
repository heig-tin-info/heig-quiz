/**
 * The journal's read routes (spec 05 §5.11, F-JRN-07, F-JRN-12), base
 * `/app/api/classrooms/:id/journal`: the navigation, a page, an asset.
 * Registered only when Quiz's App is configured (`app.ts`), like the rest of
 * the GitHub work: without it none exists. The writes are M4-03's.
 *
 * Every route loads the classroom through `readableClassroom` (invariant 6):
 * the course's staff get the staff payload unless `?view=student` narrows it
 * (a teacher in the student view, ADR-018), an impersonation session and a
 * claimed seat the student payload, anyone else the 404 of a missing
 * classroom. Portal sessions only (ADR-027): no route here lists a session
 * kind, so a `seb` or `kiosk` session is nobody. The student payloads come
 * from `studentView.ts` alone (invariant 4).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  IdParam,
  JOURNAL_ASSETS_PATH,
  JournalAssetParams,
  JournalPageParams,
  JournalViewQuery,
} from "@quiz/contracts";

import type { AppConfig } from "../../config.js";
import { readableClassroom } from "../guards.js";
import { notFound, studentRoute } from "../http.js";
import { INERT_IMAGE_HEADERS } from "../pool/assets.js";
import { registerJournalHandlers } from "./jobs.js";
import * as service from "./service.js";
import * as studentView from "./studentView.js";

/**
 * The asset headers: the pool's inert ones (`nosniff`, inline), revalidated
 * on every use against the blob sha, with N-SEC-13's policy — no script,
 * nothing but inline style. Not the pool's `sandbox` for every asset: a
 * journal serves PDF handouts, and a browser's PDF viewer does not run in a
 * sandboxed document.
 */
const ASSET_HEADERS = {
  ...INERT_IMAGE_HEADERS,
  "cache-control": "private, max-age=0, must-revalidate",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
} as const;

/**
 * An SVG is a document a browser runs scripts from when it is opened
 * directly: sandboxed, as the pool's images are, it runs nothing and has no
 * origin, while an `<img>` of a page still draws it.
 */
const SVG_HEADERS = {
  ...ASSET_HEADERS,
  "content-security-policy": `${ASSET_HEADERS["content-security-policy"]}; sandbox`,
} as const;

export async function journalPlugin(app: FastifyInstance, _opts: { config: AppConfig }) {
  registerJournalHandlers();
  const read = studentRoute(app);
  const session = { preHandler: (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply) };
  const base = "/app/api/classrooms/:id/journal";

  /**
   * The classroom, for the payload the caller may read. `?view=student` was
   * validated before (`query`); it can only narrow (`classroomPayload`).
   */
  const load = (req: FastifyRequest, reply: FastifyReply, params: { id: string }) =>
    readableClassroom(app, req, reply, params, {
      studentView: JournalViewQuery.parse(req.query ?? {}).view === "student",
    });

  app.get(
    base,
    session,
    read({ params: IdParam, query: JournalViewQuery, load }, async ({ reply, scope }) => {
      if (scope.payload === "staff") return service.staffJournal(app.db, scope.room);
      // No journal is, for a student, no journal to read: a 404.
      if (!(await service.hasJournal(app.db, scope.room.id))) return notFound(reply);
      return studentView.studentJournal(app.db, scope.room.id);
    }),
  );

  app.get(
    `${base}/pages/*`,
    session,
    read({ params: JournalPageParams, query: JournalViewQuery, load }, async ({ reply, params, scope }) => {
      const path = params["*"];
      const page =
        scope.payload === "staff"
          ? await service.staffPage(app.db, scope.room.id, path)
          : await studentView.studentPage(app.db, scope.room.id, path);
      return page ?? notFound(reply);
    }),
  );

  app.get(
    `${JOURNAL_ASSETS_PATH(":id")}/*`,
    session,
    read({ params: JournalAssetParams, query: JournalViewQuery, load }, async ({ req, reply, params, scope }) => {
      const asset = await service.journalAsset(app.db, scope.room.id, params["*"], scope.payload);
      if (!asset) return notFound(reply);
      const etag = `"${asset.blobSha}"`;
      reply.headers(asset.contentType === "image/svg+xml" ? SVG_HEADERS : ASSET_HEADERS).header("etag", etag);
      if (req.headers["if-none-match"] === etag) return reply.code(304).send();
      return reply.type(asset.contentType).send(Buffer.from(asset.data));
    }),
  );
}
