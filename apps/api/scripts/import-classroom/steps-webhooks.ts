/**
 * Recent webhook deliveries (M8-01d), copied for traceability only: the last
 * 30 days, measured from the run's clock (`ctx.now`), into Quiz's own
 * `webhook_deliveries` (same shape, same primary key: GitHub's delivery id,
 * so a delivery both Apps ever received is carried once). Older rows are not
 * copied (the table's purge empties their payload after 30 days anyway).
 *
 * Every copied delivery is recorded as PROCESSED: one classroom had not
 * processed (a first import runs on a live classroom) is stamped with the
 * import's time, because Quiz's `reconcile.deliveries` replays what is left
 * unprocessed through ITS handlers, and a classroom payload is not Quiz's to
 * act on. Its `error` is kept as it was. Insert-only and immutable on both
 * sides: no re-import rule (a second run inserts nothing).
 */
import { count, inArray } from "drizzle-orm";

import { webhookDeliveries } from "../../src/db/schema.js";
import { note, tally, written, type Ctx } from "./ctx.js";

const DAYS = 30;
const CHUNK = 500;

export async function importWebhookDeliveries(ctx: Ctx) {
  const cutoff = new Date(ctx.now.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const rows = ctx.snapshot.webhookDeliveries.filter((d) => d.receivedAt >= cutoff);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const done = await ctx.db
      .insert(webhookDeliveries)
      .values(
        rows.slice(i, i + CHUNK).map((d) => ({
          deliveryId: d.deliveryId,
          event: d.event,
          action: d.action,
          payload: d.payload,
          receivedAt: d.receivedAt,
          processedAt: d.processedAt ?? ctx.now,
          error: d.error,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.deliveryId });
    inserted += done.length;
  }
  written(ctx, "webhook_deliveries", inserted);
  const unprocessed = rows.filter((d) => d.processedAt === null).length;
  if (unprocessed > 0) {
    note(ctx, "webhooks", `${unprocessed} delivery(ies) not yet processed by classroom, recorded as processed at the import (Quiz never replays them)`);
  }
  const older = ctx.snapshot.webhookDeliveries.length - rows.length;
  if (older > 0) note(ctx, "webhooks", `${older} delivery(ies) older than ${DAYS} days not copied`);
  let carried = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const [n] = await ctx.db
      .select({ n: count() })
      .from(webhookDeliveries)
      .where(inArray(webhookDeliveries.deliveryId, rows.slice(i, i + CHUNK).map((d) => d.deliveryId)));
    carried += n?.n ?? 0;
  }
  tally(ctx, "webhook_deliveries", { source: rows.length, carried, leftOut: [] });
}
