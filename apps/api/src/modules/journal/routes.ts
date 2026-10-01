/**
 * The journal's routes (spec 05 §5.11), base `/app/api/classrooms/:id/journal`:
 * the reads (F-JRN-07, F-JRN-12) — the navigation, a page, an asset — and
 * the staff's writes ({@link registerWrites}, M4-03, M4-08). Registered on
 * every platform: a Quiz-mode journal needs no GitHub (ADR-057). What only a
 * GitHub-mode journal does — use a repository, Refresh, the webhooks — is
 * registered only with Quiz's App configured, like the rest of the GitHub
 * work; without it, creating a GitHub-mode journal is 409 `not_connected`.
 *
 * Every read loads the classroom through `readableClassroom` (invariant 6):
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
  assetContentType,
  JOURNAL_ASSET_MAX_BYTES,
  JOURNAL_ASSETS_PATH,
  JournalAssetParams,
  JournalCreate,
  JournalPageAdd,
  JournalPageParams,
  JournalPageSave,
  JournalPreview,
  JournalRemoveQuery,
  JournalRestore,
  JournalUploadHeaders,
  JournalUse,
  JournalViewQuery,
} from "@quiz/contracts";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { githubApp } from "../../github/app.js";
import { accessibleClassroom, readableClassroom } from "../guards.js";
import { notFound, studentRoute, teacherRoute } from "../http.js";
import { INERT_IMAGE_HEADERS } from "../pool/assets.js";
import { registerJournalHandlers } from "./jobs.js";
import * as quiz from "./quiz.js";
import * as service from "./service.js";
import * as studentView from "./studentView.js";
import * as writes from "./writes.js";

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

export async function journalPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  if (githubApp(opts.config)) registerJournalHandlers();
  const read = studentRoute(app);
  const session = { preHandler: (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply) };
  const base = "/app/api/classrooms/:id/journal";
  await registerWrites(app, opts.config, base);

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

/**
 * The writes (M4-03, `writes.ts`; the content's, Quiz mode only, M4-08,
 * `quiz.ts`) and the revisions' reads: the course's STAFF only, loaded through
 * `accessibleClassroom` (invariant 6): a student, a teacher off the staff and
 * a missing classroom get the same 404, and a staff member reading in the
 * student view is still staff here (a write is never a student's). Portal
 * sessions only, like the reads; an impersonation session writes nothing
 * (ADR-034, the auth plugin's 403). Each write is audited on the classroom
 * as its actor (`note`); the refusals are `JournalError`s.
 */
async function registerWrites(app: FastifyInstance, config: AppConfig, base: string) {
  const session = { preHandler: (req: FastifyRequest, reply: FastifyReply) => app.requireSession(req, reply) };
  const trace = tracer(app);
  const teacher = teacherRoute(app);
  const load = (req: FastifyRequest, reply: FastifyReply, params: { id: string }) =>
    accessibleClassroom(app, req, reply, params);
  const onClassroom = { params: IdParam, load };
  const onPage = { params: JournalPageParams, load };
  const as = (req: FastifyRequest, room: { id: string }): writes.WriteContext => ({
    app,
    config,
    userId: req.user!.id,
    note: (action, payload) => trace(req, action, "classroom", room.id, payload),
  });

  /**
   * Create a journal, by its mode (ADR-057): held in Quiz, or a new
   * repository (F-JRN-02; 409 `name_taken` with a `suggestion`, never an
   * adoption).
   */
  app.post(
    base,
    session,
    teacher({ ...onClassroom, body: JournalCreate }, async ({ req, reply, body, scope }) => {
      const ctx = as(req, scope.room);
      const created =
        body.mode === "quiz"
          ? await quiz.createQuizJournal(ctx, scope.room)
          : await writes.createJournal(ctx, scope.room, body.name);
      return reply.code(201).send(created);
    }),
  );

  /**
   * Remove the journal (F-JRN-04): the copy goes, the repository stays; a
   * Quiz-mode journal's pages, the only copy, with the classroom's name typed.
   */
  app.delete(
    base,
    session,
    teacher({ ...onClassroom, query: JournalRemoveQuery }, async ({ req, reply, query, scope }) => {
      await writes.removeJournal(as(req, scope.room), scope.room, query.confirm);
      return reply.code(204).send();
    }),
  );

  if (githubApp(config)) {
    /** Use a repository of the organization (F-JRN-03, D27). */
    app.post(
      `${base}/use`,
      session,
      teacher({ ...onClassroom, body: JournalUse }, async ({ req, reply, body, scope }) =>
        reply.code(201).send(await writes.useJournal(as(req, scope.room), scope.room, body)),
      ),
    );

    app.post(
      `${base}/refresh`,
      session,
      teacher(onClassroom, async ({ req, reply, scope }) => {
        await writes.refreshJournal(as(req, scope.room), scope.room.id);
        // The outcome is the row's `syncStatus`, read again on the `journal` hint.
        return reply.code(202).send();
      }),
    );
  }

  /** A read behind a POST (the body is the markdown): no mutation hint. */
  app.post(
    `${base}/preview`,
    { ...session, config: { readOnly: true } },
    teacher({ ...onClassroom, body: JournalPreview }, async ({ body, scope }) =>
      writes.previewPage(app.db, scope.room.id, body.path, body.markdown),
    ),
  );

  app.put(
    `${base}/pages/*`,
    session,
    teacher({ ...onPage, body: JournalPageSave }, async ({ req, params, body, scope }) =>
      quiz.savePage(as(req, scope.room), scope.room.id, params["*"], body),
    ),
  );

  app.post(
    `${base}/pages`,
    session,
    teacher({ ...onClassroom, body: JournalPageAdd }, async ({ req, reply, body, scope }) =>
      reply.code(201).send(await quiz.addPage(as(req, scope.room), scope.room.id, body)),
    ),
  );

  app.delete(
    `${base}/pages/*`,
    session,
    teacher(onPage, async ({ req, reply, params, scope }) =>
      (await quiz.deletePage(as(req, scope.room), scope.room.id, params["*"])) ? reply.code(204).send() : notFound(reply),
    ),
  );

  /** A page's revisions, newest first (ADR-057), a deleted page's too. */
  app.get(
    `${base}/revisions/*`,
    session,
    teacher(onPage, async ({ params, scope }) => quiz.revisions(app.db, scope.room.id, params["*"])),
  );

  /** The deleted pages a revision can bring back. */
  app.get(
    `${base}/deleted`,
    session,
    teacher(onClassroom, async ({ scope }) => quiz.deletedPages(app.db, scope.room.id)),
  );

  /** A revision restored: a save, or the deleted page created again. */
  app.post(
    `${base}/restore`,
    session,
    teacher({ ...onClassroom, body: JournalRestore }, async ({ req, reply, body, scope }) => {
      const restored = await quiz.restoreRevision(as(req, scope.room), scope.room.id, body.revisionId);
      return restored ?? notFound(reply);
    }),
  );

  /**
   * An upload (F-JRN-11): the raw bytes, at most {@link JOURNAL_ASSET_MAX_BYTES},
   * declared with the content type of the path's extension
   * (`JournalUploadHeaders`); over the cap, Fastify's own 413. In a child
   * context of its own: its catch-all byte parser and its body limit reach
   * no other route.
   */
  await app.register(async (uploads) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    uploads.post(
      `${JOURNAL_ASSETS_PATH(":id")}/*`,
      { ...session, bodyLimit: JOURNAL_ASSET_MAX_BYTES },
      teacher({ params: JournalAssetParams, load }, async ({ req, reply, params, scope }) => {
        const path = params["*"];
        const declared = JournalUploadHeaders.parse(req.headers)["content-type"];
        if (declared !== assetContentType(path)) throw new writes.JournalError("type_mismatch");
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (data.length === 0) throw new writes.JournalError("empty_upload");
        return reply.code(201).send(await quiz.uploadAsset(as(req, scope.room), scope.room.id, path, data));
      }),
    );
  });
}
