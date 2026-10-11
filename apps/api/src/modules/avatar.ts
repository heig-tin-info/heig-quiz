import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, like, or } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { avatars, users } from "../db/schema.js";
import { publish } from "../events.js";
import { PICTURE_TYPES, remoteImageCache, type RemoteImage } from "../remoteImage.js";
import { callerOf, seesUser, type Caller } from "./guards.js";
import { INERT_IMAGE_HEADERS, sniffImage } from "./pool/assets.js";

/** An upload's cap; `PICTURE_TYPES` (`remoteImage.ts`) is the one list of types, as `app.ts` parses it (B-19). */
const MAX_BYTES = 1_000_000; // cropped to 256x256 client-side: ~30-80 KB in practice

/** The IdP's picture is served only from an https address (`remoteImage.ts` refuses any other). */
const IDP_PICTURE_SCHEME = "https://";

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
 * claim (an https one), else null (the client draws initials). `userId` is
 * null for an unclaimed roster seat, which has neither. Both are served from
 * the same route, so a browser never loads an image from the IdP's host and
 * the CSP admits no `https:` image (audit 2026-10-10, §6); `?v=` of the
 * IdP's is a digest of its address, so a new claim busts the cache.
 */
export function shownAvatar(
  userId: string | null,
  uploadedAt: Date | null | undefined,
  pictureUrl: string | null,
): string | null {
  if (!userId) return null;
  if (uploadedAt) return avatarUrl(userId, uploadedAt);
  if (!pictureUrl?.startsWith(IDP_PICTURE_SCHEME)) return null;
  const version = createHash("sha256").update(pictureUrl).digest("hex").slice(0, 12);
  return `/app/api/users/${userId}/avatar?v=${version}`;
}

/**
 * THE visibility of a user's picture (#318): the user, when the caller may
 * see them, and they have one to show — an upload, or an https IdP claim
 * (as {@link shownAvatar} says). One predicate for the route and for
 * {@link seesAvatar}, over `users LEFT JOIN avatars`.
 */
const visiblePicture = (caller: Caller, userId: string) =>
  and(
    eq(users.id, userId),
    or(isNotNull(avatars.userId), like(users.pictureUrl, `${IDP_PICTURE_SCHEME}%`)),
    seesUser(caller, userId),
  );

/**
 * The user's picture if the caller may see that user: the upload's bytes,
 * else the IdP's address; null alike for no picture and no right (#318).
 */
export async function findVisibleAvatar(db: Db, caller: Caller, userId: string) {
  const [row] = await db
    .select({ data: avatars.data, contentType: avatars.contentType, pictureUrl: users.pictureUrl })
    .from(users)
    .leftJoin(avatars, eq(avatars.userId, users.id))
    .where(visiblePicture(caller, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Whether the caller sees a picture of that user: {@link findVisibleAvatar}
 * itself, ONE query — its one caller (a legacy link's redirect) is rare
 * enough that reading an upload's bytes for it costs nothing worth a second.
 */
export async function seesAvatar(db: Db, caller: Caller, userId: string): Promise<boolean> {
  return (await findVisibleAvatar(db, caller, userId)) !== null;
}

/** The IdP's pictures, by address, fetched and kept under the one policy of `remoteImage.ts`. */
const idpPictures = remoteImageCache();

/**
 * Uploaded avatar (cropped client-side, circular preview). Takes precedence
 * over the OIDC `picture` claim; deletable to fall back to it. Both are read
 * at `/app/api/users/:uid/avatar`.
 */
export async function avatarPlugin(app: FastifyInstance) {
  app.put(
    "/app/api/me/avatar",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const contentType = req.headers["content-type"] ?? "";
      if (!PICTURE_TYPES.has(contentType)) {
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
      // The upload, else the IdP's picture, through here (audit 2026-10-10, §6).
      const picture: RemoteImage | null = !row
        ? null
        : row.data !== null && row.contentType !== null
          ? { bytes: row.data, mime: row.contentType }
          : await idpPictures.get(row.pictureUrl!, app.clock.now().getTime(), req.log);
      // No picture and a picture the caller may not see answer alike (#318).
      if (!picture) return reply.code(404).send({ error: "not_found" });
      return reply
        .type(picture.mime)
        .header("cache-control", "private, max-age=86400")
        .headers(INERT_IMAGE_HEADERS)
        .send(picture.bytes);
    },
  );
}
