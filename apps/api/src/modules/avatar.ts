import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { AvatarMime } from "@quiz/contracts";

import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { avatars } from "../db/schema.js";
import { publish } from "../events.js";
import { callerOf, seesUser, type Caller } from "./guards.js";
import { INERT_IMAGE_HEADERS, sniffImage } from "./pool/assets.js";

/** `AvatarMime` is the one list (B-19); `app.ts` parses the same set. */
const ACCEPTED: ReadonlySet<string> = new Set<string>(AvatarMime.options);
const MAX_BYTES = 1_000_000; // cropped to 256x256 client-side: ~30-80 KB in practice

/**
 * The URL of a user's uploaded picture, `?v=` busting the cache on change.
 * The one place it is written: any NEW caller that shows it to someone else
 * must be covered by `seesUser` in `guards.ts`, or the picture 404s there.
 */
export function avatarUrl(userId: string, updatedAt: Date): string {
  return `/app/api/users/${userId}/avatar?v=${updatedAt.getTime()}`;
}

/**
 * The picture a user is shown with: their upload, else the IdP's `picture`
 * claim, else null (the client draws initials). `userId` is null for an
 * unclaimed roster seat, which has neither.
 */
export function shownAvatar(
  userId: string | null,
  uploadedAt: Date | null | undefined,
  pictureUrl: string | null,
): string | null {
  return uploadedAt && userId ? avatarUrl(userId, uploadedAt) : pictureUrl;
}

/** The user's uploaded picture, if the caller may see that user; null alike for no picture and no right (#318). */
export async function findVisibleAvatar(db: Db, caller: Caller, userId: string) {
  const [row] = await db
    .select()
    .from(avatars)
    .where(and(eq(avatars.userId, userId), seesUser(caller, userId)))
    .limit(1);
  return row ?? null;
}

/** {@link findVisibleAvatar} without the image: whether the caller sees a picture of that user. */
export async function seesAvatar(db: Db, caller: Caller, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: avatars.userId })
    .from(avatars)
    .where(and(eq(avatars.userId, userId), seesUser(caller, userId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Uploaded avatar (cropped client-side, circular preview). Takes precedence
 * over the OIDC `picture` claim; deletable to fall back to it.
 */
export async function avatarPlugin(app: FastifyInstance) {
  app.put(
    "/app/api/me/avatar",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const contentType = req.headers["content-type"] ?? "";
      if (!ACCEPTED.has(contentType)) {
        return reply
          .code(415)
          .send({ error: "unsupported_type", message: "Expected JPEG, PNG or WebP" });
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "empty_body", message: "Image body expected" });
      }
      if (body.length > MAX_BYTES) {
        return reply.code(413).send({ error: "too_large", message: "Image exceeds 1 MB" });
      }
      // The bytes decide the type, not the header the browser sent: an HTML
      // page declared `image/png` is refused here, whatever `nosniff` does
      // on the way out.
      if (sniffImage(body)?.mime !== contentType) {
        return reply
          .code(415)
          .send({ error: "unsupported_type", message: "Expected JPEG, PNG or WebP" });
      }
      await app.db
        .insert(avatars)
        .values({ userId: req.user!.id, data: body, contentType, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: avatars.userId,
          set: { data: body, contentType, updatedAt: new Date() },
        });
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "avatar.update",
        subjectType: "user",
        subjectId: req.user!.id,
        payload: { bytes: body.length, contentType },
      });
      // The actor's OTHER tabs show the same avatar in the shell. The generic
      // `onResponse` fallback used to cover this; it does not any more (see
      // `app.ts`), so the route says it itself. It only ever refreshes GETs,
      // so it cannot feed itself.
      publish("mutation", [`user:${req.user!.id}`]);
      return reply.code(204).send();
    },
  );

  app.delete(
    "/app/api/me/avatar",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      await app.db.delete(avatars).where(eq(avatars.userId, req.user!.id));
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "avatar.delete",
        subjectType: "user",
        subjectId: req.user!.id,
      });
      publish("mutation", [`user:${req.user!.id}`]);
      return reply.code(204).send();
    },
  );

  const UserParam = z.object({ uid: z.uuid() });

  app.get(
    "/app/api/users/:uid/avatar",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = UserParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const row = await findVisibleAvatar(app.db, callerOf(req), params.data.uid);
      // No picture and a picture the caller may not see answer alike (#318).
      if (!row) return reply.code(404).send({ error: "not_found" });
      return reply
        .type(row.contentType)
        .header("cache-control", "private, max-age=86400")
        .headers(INERT_IMAGE_HEADERS)
        .send(row.data);
    },
  );
}
