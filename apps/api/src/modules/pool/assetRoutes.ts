/** The image store of the pools: upload, and serving an asset. */
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { IdParam, type Asset } from "@quiz/contracts";

import { assets } from "../../db/schema.js";
import { INERT_IMAGE_HEADERS, isAllowedMime, readAsset, sniffImage, storeAsset } from "./assets.js";
import * as service from "./service.js";
import type { PoolRouteContext } from "./routeContext.js";

export function assetRoutes(app: FastifyInstance, ctx: PoolRouteContext): void {
  const { config, requireTeacher, trace, teacher, inPool } = ctx;

  app.post(
    "/app/api/pools/:id/assets",
    { preHandler: requireTeacher },
    teacher(
      { params: IdParam, load: inPool("contributor") },
      async ({ req, reply, scope: pool }) => {
        const upload = await readImage(req, reply);
        if (!upload) return reply;
        const { row, fresh } = await storeAsset(app.db, config.ASSETS_DIR, {
          ...upload,
          ownerId: req.user!.id,
          poolId: pool.id,
        });
        if (!fresh) return reply.code(200).send(assetJson(row));
        await trace(req, "pool.asset_upload", "asset", row.id, {
          poolId: pool.id,
          mime: row.mime,
          bytes: row.bytes,
        });
        return reply.code(201).send(assetJson(row));
      },
    ),
  );

  /**
   * The one image of a multipart upload, or null once the refusal is sent:
   * `415` when it is not multipart, `400` without a file, and `415` again
   * when the BYTES are not an accepted image — the bytes decide the type, not
   * the header, so an SVG (or anything else) sniffs to nothing and is refused
   * here. Past `ASSETS_MAX_BYTES` the `413` is Fastify's: `toBuffer()` throws
   * `FST_REQ_FILE_TOO_LARGE`, which the wrapper hands to the global handler.
   */
  async function readImage(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ bytes: Buffer; facts: NonNullable<ReturnType<typeof sniffImage>> } | null> {
    if (!req.isMultipart()) {
      await reply.code(415).send({ error: "unsupported_media_type", message: "Expected multipart/form-data" });
      return null;
    }
    const part = await req.file();
    if (!part) {
      await reply.code(400).send({ error: "validation", message: "No file in the request" });
      return null;
    }
    const bytes = await part.toBuffer();
    const facts = sniffImage(bytes);
    if (!facts || !isAllowedMime(facts.mime)) {
      await reply.code(415).send({
        error: "unsupported_media_type",
        message: "Only PNG, JPEG, GIF and WebP images are accepted",
      });
      return null;
    }
    return { bytes, facts };
  }

  /**
   * Served from our own origin, with an immutable cache (the URL contains a
   * uuid whose bytes never change) and `nosniff`: the browser gets exactly
   * the type we verified at upload, and nothing else.
   */
  app.get(
    "/app/api/assets/:id",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = z.object({ id: z.uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const [asset] = await app.db.select().from(assets).where(eq(assets.id, params.data.id)).limit(1);
      if (!asset || !isAllowedMime(asset.mime)) return reply.code(404).send({ error: "not_found" });
      // Staff, its uploader, or a student through the attempt that shows it (`assetAccess.ts`).
      if (!(await service.mayReadAsset(app.db, asset, req.user!))) return reply.code(404).send({ error: "not_found" });
      let bytes: Buffer;
      try {
        bytes = await readAsset(config.ASSETS_DIR, asset.path);
      } catch {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply
        .header("content-type", asset.mime)
        .header("cache-control", "private, max-age=31536000, immutable")
        .headers(INERT_IMAGE_HEADERS)
        .send(bytes);
    },
  );
}

function assetJson(row: typeof assets.$inferSelect): Asset {
  return {
    id: row.id,
    url: `/app/api/assets/${row.id}`,
    mime: row.mime as Asset["mime"],
    bytes: row.bytes,
    width: row.width,
    height: row.height,
  };
}
