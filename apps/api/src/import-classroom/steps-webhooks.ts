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
import { inArray } from "drizzle-orm";

import { webhookDeliveries } from "../db/schema.js";
import { note, tally, type Ctx } from "./ctx.js";
import { insertAll, presentKeys } from "./steps-repos.js";

const DAYS = 30;

export async function importWebhookDeliveries(ctx: Ctx) {
  const cutoff = new Date(ctx.now.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const rows = ctx.snapshot.webhookDeliveries.filter((d) => d.receivedAt >= cutoff);
  await insertAll(
    ctx,
    webhookDeliveries,
    rows.map((d) => ({
      deliveryId: d.deliveryId,
      event: d.event,
      action: d.action,
      payload: d.payload,
      receivedAt: d.receivedAt,
      processedAt: d.processedAt ?? ctx.now,
      error: d.error,
    })),
  );
  const unprocessed = rows.filter((d) => d.processedAt === null).length;
  if (unprocessed > 0) {
    note(ctx, "webhooks", `${unprocessed} delivery(ies) not yet processed by classroom, recorded as processed at the import (Quiz never replays them)`);
  }
  const older = ctx.snapshot.webhookDeliveries.length - rows.length;
  if (older > 0) note(ctx, "webhooks", `${older} delivery(ies) older than ${DAYS} days not copied`);
  const carried = await presentKeys(
    rows.map((d) => d.deliveryId),
    async (ids) => (await ctx.db.select({ id: webhookDeliveries.deliveryId }).from(webhookDeliveries).where(inArray(webhookDeliveries.deliveryId, ids))).map((r) => r.id),
  );
  tally(ctx, "webhook_deliveries", { source: rows.length, carried: carried.size, leftOut: [] });
}
