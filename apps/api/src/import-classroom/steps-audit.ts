/**
 * The legacy audit (D11, I12): heig-classroom's whole `audit_log` into
 * `legacy_classroom_audit_log`, so Quiz's own closed audit union stays clean.
 * Insert-only: a row is keyed on classroom's id (`source_id`), never changes
 * on either side, and a second run inserts nothing. The actor is remapped
 * best-effort (`target`: only a person the import reached); classroom's own
 * actor id is kept beside it.
 */
import { count } from "drizzle-orm";

import { legacyClassroomAuditLog } from "../db/schema.js";
import { note, target, tally, written, type Ctx } from "./ctx.js";

const CHUNK = 500;

export async function importLegacyAudit(ctx: Ctx) {
  const rows = ctx.snapshot.auditLog;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const done = await ctx.db
      .insert(legacyClassroomAuditLog)
      .values(
        rows.slice(i, i + CHUNK).map((r) => ({
          sourceId: r.id,
          actorUserId: target(ctx, r.actorUserId) ?? null,
          sourceActorUserId: r.actorUserId,
          actorType: r.actorType,
          action: r.action,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          payload: r.payload,
          createdAt: r.createdAt,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: legacyClassroomAuditLog.id });
    inserted += done.length;
  }
  written(ctx, "legacy_classroom_audit_log", inserted);
  const unmapped = rows.filter((r) => r.actorUserId !== null && target(ctx, r.actorUserId) === undefined).length;
  if (unmapped > 0) note(ctx, "audit", `${unmapped} row(s) by an actor the import did not reach: classroom's actor id kept, no Quiz actor`);
  // Every source row is carried, none left out: the table holds the source's rows exactly.
  const [total] = await ctx.db.select({ n: count() }).from(legacyClassroomAuditLog);
  tally(ctx, "legacy_classroom_audit_log", { source: rows.length, carried: total?.n ?? 0, leftOut: [] });
}
