/**
 * Who may read a question image (F-QST-06, N-SEC-05), in one place: the
 * asset route serves it by this rule, and a PDF draws an image only by it
 * (ADR-125 §2).
 *
 * Assets are content-addressed and deduplicated across the whole instance
 * (`unique (sha256)`), so `assets.pool_id` names the pool that uploaded the
 * bytes FIRST, not the set of pools that show them: a per-pool check would
 * break the second teacher's image. Any staff session may therefore read an
 * asset — its id is a random uuid, and a colleague holding the same bytes
 * obtains the same id anyway. A STUDENT reaches it through the attempt that
 * shows it, and only then (`assetReachableBy`): the image of a question they
 * are taking or reviewing, never the instance's image store.
 */
import { inArray } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { assets } from "../../db/schema.js";
import { isAllowedMime, readAsset } from "./assets.js";
import { assetReachableBy } from "./questionWrite.js";

/** Who reads: an account's id and role. */
export interface AssetReader {
  id: string;
  role: string;
}

/** May `reader` read `asset`? Staff always, its uploader, else a student through `assetReachableBy`. */
export async function mayReadAsset(db: Db, asset: { id: string; ownerId: string }, reader: AssetReader): Promise<boolean> {
  return (
    reader.role === "teacher" ||
    reader.role === "admin" ||
    asset.ownerId === reader.id ||
    assetReachableBy(db, asset.id, reader.id)
  );
}

/** An asset id is a UUID: anything else names no row, and is not sent to the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The bytes of the assets `ids` that `reader` may read, of an allowed type;
 * an id with no row, not theirs to read, or whose file cannot be read is
 * left out.
 */
export async function readableAssets(
  db: Db,
  assetsDir: string,
  ids: readonly string[],
  reader: AssetReader,
): Promise<{ id: string; bytes: Buffer }[]> {
  const wanted = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (wanted.length === 0) return [];
  const rows = await db.select().from(assets).where(inArray(assets.id, wanted.map((id) => id.toLowerCase())));
  const read = await Promise.all(
    wanted.map(async (id) => {
      const row = rows.find((r) => r.id === id.toLowerCase());
      if (!row || !isAllowedMime(row.mime) || !(await mayReadAsset(db, row, reader))) return null;
      try {
        return { id, bytes: await readAsset(assetsDir, row.path) };
      } catch {
        return null;
      }
    }),
  );
  return read.filter((a): a is { id: string; bytes: Buffer } => a !== null);
}
