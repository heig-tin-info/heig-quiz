/**
 * What the supervisor is told of a station while it sits an exam (ADR-051
 * §6, §8): a suspension (refused, or silent), an attestation Google cannot
 * give, and the return to normal — each once per change, as a
 * `dashboard.alert` on the evaluation the station sits, and, for a
 * suspension and its end, `kiosk.suspended` / `kiosk.resumed` in the audit.
 *
 * What was last told is the device's `watch` column. A change is claimed by
 * ONE conditional UPDATE (`watch IS DISTINCT FROM` the new value), so two
 * attempts, or a sweep repeated every minute, tell it once. It is stored
 * whether the station sits or not; the alert and the audit are a sitting's,
 * so they go out only while the station carries a kiosk session — and when
 * a station starts sitting, its current state is told then
 * ({@link stationSeated}).
 */
import { and, eq, gt, isNull, lte, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  KIOSK_SILENT_AFTER_MS,
  kioskAttestationState,
  kioskTransition,
  kioskWatchOf,
  type KioskAlert,
  type KioskAttestationState,
  type KioskWatch,
} from "@quiz/domain";

import { audit } from "../../audit.js";
import type { Db } from "../../db/client.js";
import { kioskDevices, sessions } from "../../db/schema.js";
import * as bus from "../realtime/bus.js";
import { recordFailed } from "./service.js";

/** The alert that says a station's current state to a supervisor who has not heard it. */
const ALERT_OF: Record<KioskWatch, KioskAlert> = {
  ok: "kiosk_resumed",
  unavailable: "kiosk_unavailable",
  suspended: "kiosk_suspended",
};

/** The student and the exam the station sits now, from its live `kiosk` session; null when it sits nothing. */
async function sittingOn(db: Db, deviceId: string, now: Date) {
  const [row] = await db
    .select({ userId: sessions.userId, evaluationId: sessions.evaluationId })
    .from(sessions)
    .where(and(eq(sessions.deviceId, deviceId), eq(sessions.kind, "kiosk"), gt(sessions.expiresAt, now)))
    .limit(1);
  return row?.evaluationId ? { userId: row.userId, evaluationId: row.evaluationId } : null;
}

/** The audit of a suspension or its end, and the alert — for the sitting the station carries, if any. */
async function tell(
  db: Db,
  deviceId: string,
  told: { suspension: "suspended" | "resumed" | null; alert: KioskAlert | null; reason: KioskAttestationState },
  now: Date,
): Promise<void> {
  const sitting = await sittingOn(db, deviceId, now);
  if (sitting === null) return;
  if (told.suspension !== null) {
    await audit(db, {
      actorType: "system",
      action: told.suspension === "suspended" ? "kiosk.suspended" : "kiosk.resumed",
      subjectType: "kiosk_device",
      subjectId: deviceId,
      at: now,
      payload: { ...(told.suspension === "suspended" && { reason: told.reason }), ...sitting },
    });
  }
  if (told.alert !== null) bus.dashboardAlert({ ...sitting, kind: told.alert, at: now });
}

/** Moves the station's `watch` to what `state` means, and tells the change — once, whoever races. */
async function announce(db: Db, deviceId: string, state: KioskAttestationState, now: Date): Promise<void> {
  const after = kioskWatchOf(state);
  const before = alias(kioskDevices, "before");
  const [moved] = await db
    .update(kioskDevices)
    .set({ watch: after })
    .from(before)
    .where(and(eq(kioskDevices.id, deviceId), eq(before.id, kioskDevices.id), ne(kioskDevices.watch, after)))
    .returning({ before: before.watch });
  if (!moved) return;
  await tell(db, deviceId, { ...kioskTransition(moved.before, after), reason: state }, now);
}

/**
 * One attestation attempt of a known station — accepted (already recorded
 * by `recordAttested`), refused, or unavailable (Google failed the verify,
 * or would not even give a challenge) — and what it changes for the
 * supervisor.
 */
export async function recordAttempt(
  db: Db,
  deviceId: string,
  outcome: "ok" | "unavailable" | "refused",
  now: Date,
): Promise<void> {
  if (outcome !== "ok") await recordFailed(db, deviceId, outcome, now);
  await announce(db, deviceId, outcome, now);
}

/**
 * A station just started sitting (the pairing's consumption): its row shows
 * the station at once, and a station already suspended — or that Google
 * cannot attest — says so to the supervisor now.
 */
export async function stationSeated(db: Db, deviceId: string, now: Date): Promise<void> {
  const [device] = await db.select().from(kioskDevices).where(eq(kioskDevices.id, deviceId));
  if (!device) return;
  const state = kioskAttestationState(device, now);
  const watch = kioskWatchOf(state);
  if (device.watch !== watch) {
    await db.update(kioskDevices).set({ watch }).where(eq(kioskDevices.id, deviceId));
  }
  await tell(
    db,
    deviceId,
    { suspension: watch === "suspended" ? "suspended" : null, alert: ALERT_OF[watch], reason: state },
    now,
  );
}

/**
 * The ticker's pass: every station sitting an exam that has not attempted an
 * attestation for twelve minutes is silent, hence suspended — told once,
 * the sweeps after it finding its `watch` already `suspended`.
 */
export async function sweepSilentStations(db: Db, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - KIOSK_SILENT_AFTER_MS);
  const rows = await db
    .select({ id: kioskDevices.id })
    .from(sessions)
    .innerJoin(kioskDevices, eq(sessions.deviceId, kioskDevices.id))
    .where(
      and(
        eq(sessions.kind, "kiosk"),
        gt(sessions.expiresAt, now),
        ne(kioskDevices.watch, "suspended"),
        or(isNull(kioskDevices.checkedAt), lte(kioskDevices.checkedAt, cutoff)),
      ),
    );
  for (const { id } of rows) await announce(db, id, "silent", now);
}
