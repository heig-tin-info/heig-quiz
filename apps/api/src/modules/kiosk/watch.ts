/**
 * What the supervisor is told of a station while it sits an exam (ADR-051
 * §6, §8): a suspension (refused, or silent), an attestation Google cannot
 * give, and the return to normal — each once per change, as a
 * `dashboard.alert` on the evaluation the station sits, and, for a
 * suspension and its end, `kiosk.suspended` / `kiosk.resumed` in the audit.
 *
 * The attestation route reports every attempt ({@link afterAttempt}); the
 * ticker finds the stations that stopped attempting
 * ({@link sweepSilentStations}). Both compare with what the supervisor was
 * LAST TOLD, so a station re-attesting every ten minutes says nothing, and a
 * sweep repeated every minute alerts once.
 *
 * What was told is read back, never stored twice: a suspension is told while
 * the station's last `kiosk.suspended` / `kiosk.resumed` entry is a
 * suspension (the audit is append-only and indexed by subject); an outage is
 * the device's own last attempt, `unavailable`. No column to keep in step,
 * and no migration beside the one of ADR-051.
 */
import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";

import {
  KIOSK_SILENT_AFTER_MS,
  kioskAttestationState,
  kioskTransition,
  kioskWatchOf,
  type KioskAttestationState,
  type KioskWatch,
} from "@quiz/domain";

import { audit } from "../../audit.js";
import type { Db } from "../../db/client.js";
import { auditLog, kioskDevices, sessions } from "../../db/schema.js";
import * as bus from "../realtime/bus.js";
import type { KioskDeviceRow } from "./service.js";

const SUSPENSION = ["kiosk.suspended", "kiosk.resumed"] as const;

/** What the supervisor was last told of `device`, read from its row BEFORE the attempt at hand. */
async function toldOf(db: Db, device: KioskDeviceRow): Promise<KioskWatch> {
  const [last] = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.subjectType, "kiosk_device"),
        eq(auditLog.subjectId, device.id),
        inArray(auditLog.action, [...SUSPENSION]),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(1);
  if (last?.action === "kiosk.suspended") return "suspended";
  return device.attestation === "unavailable" ? "unavailable" : "ok";
}

/** The student and the exam the station sits now, from its live `kiosk` session; null when it sits nothing. */
async function sittingOn(db: Db, deviceId: string, now: Date) {
  const [row] = await db
    .select({ userId: sessions.userId, evaluationId: sessions.evaluationId })
    .from(sessions)
    .where(and(eq(sessions.deviceId, deviceId), eq(sessions.kind, "kiosk"), gt(sessions.expiresAt, now)))
    .limit(1);
  return row?.evaluationId ? { userId: row.userId, evaluationId: row.evaluationId } : null;
}

/**
 * Tells the change from `before` to the station's `state`, once. A
 * suspension is a sitting's: a station that sits nothing is suspended in
 * nothing, and its refusal stays `kiosk.attest_failed` alone. Its end is
 * written whenever one was told, sitting or not, so the next suspension is
 * told again.
 */
async function announce(
  db: Db,
  deviceId: string,
  before: KioskWatch,
  state: KioskAttestationState,
  now: Date,
): Promise<void> {
  const { suspension, alert } = kioskTransition(before, kioskWatchOf(state));
  if (suspension === null && alert === null) return;
  const sitting = await sittingOn(db, deviceId, now);
  if (suspension === "suspended" && sitting === null) return;
  if (suspension !== null) {
    await audit(db, {
      actorType: "system",
      action: suspension === "suspended" ? "kiosk.suspended" : "kiosk.resumed",
      subjectType: "kiosk_device",
      subjectId: deviceId,
      at: now,
      payload: { ...(suspension === "suspended" && { reason: state }), ...sitting },
    });
  }
  if (alert !== null && sitting !== null) bus.dashboardAlert({ ...sitting, kind: alert, at: now });
}

/**
 * An attestation attempt of a known station, `previous` being its row before
 * the attempt was recorded (the route reads it anyway).
 */
export async function afterAttempt(
  db: Db,
  previous: KioskDeviceRow,
  outcome: "ok" | "unavailable" | "refused",
  now: Date,
): Promise<void> {
  await announce(db, previous.id, await toldOf(db, previous), outcome, now);
}

/**
 * The ticker's pass: every station sitting an exam that has not attempted an
 * attestation for twelve minutes is silent, hence suspended — told once,
 * the sweeps after it finding the suspension already told.
 */
export async function sweepSilentStations(db: Db, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - KIOSK_SILENT_AFTER_MS);
  const rows = await db
    .select({ device: kioskDevices })
    .from(sessions)
    .innerJoin(kioskDevices, eq(sessions.deviceId, kioskDevices.id))
    .where(
      and(
        eq(sessions.kind, "kiosk"),
        gt(sessions.expiresAt, now),
        or(isNull(kioskDevices.checkedAt), lte(kioskDevices.checkedAt, cutoff)),
      ),
    );
  for (const { device } of rows) {
    const state = kioskAttestationState(device, now);
    if (state === "silent") await announce(db, device.id, await toldOf(db, device), state, now);
  }
}
