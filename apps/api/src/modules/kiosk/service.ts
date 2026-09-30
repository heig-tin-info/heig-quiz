/**
 * The station registry (ADR-051 §5): the one module that writes
 * `kiosk_devices`. A station is known by Google's `devicePermanentId` and,
 * between two attestations, by its `quiz_kiosk` cookie — whose SHA-256 alone
 * is stored, rotated by every accepted attestation.
 *
 * `deviceByCredential` and `stationOf` are what the pairing (step 6) and the
 * session hook's `trustRefusal` (step 7) read a station through.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { asc, eq, getTableColumns, sql } from "drizzle-orm";

import type { KioskAttestation, KioskDevice, KioskDevicePatch, KioskStation } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { kioskDevices } from "../../db/schema.js";
import { DomainError } from "../http.js";

/** The station's own cookie: its identity, never a user's. */
export const KIOSK_COOKIE = "quiz_kiosk";
/** Every accepted attestation re-issues it for this long (ADR-051 §5). */
export const KIOSK_COOKIE_HOURS = 12;

export type KioskDeviceRow = typeof kioskDevices.$inferSelect;

/** Hex SHA-256 of a station credential: what `credential_hash` holds. */
export const credentialHash = (credential: string) =>
  createHash("sha256").update(credential).digest("hex");

/** The device whose current credential is `cookie`; null for anything else. */
export async function deviceByCredential(
  db: Db,
  cookie: string | undefined,
): Promise<KioskDeviceRow | null> {
  // 256 bits in base64url are 43 characters; anything else is not ours and
  // costs no query.
  if (!cookie || cookie.length !== 43) return null;
  const [device] = await db
    .select()
    .from(kioskDevices)
    .where(eq(kioskDevices.credentialHash, credentialHash(cookie)));
  return device ?? null;
}

/** What a station's page shows of itself; null when the cookie names no station. */
export async function stationOf(db: Db, cookie: string | undefined): Promise<KioskStation | null> {
  const device = await deviceByCredential(db, cookie);
  return device ? { label: device.label, status: device.status } : null;
}

/**
 * An attestation Google accepted: the device is created (`unnamed`) or
 * updated, and gets a new credential. The previous cookie stops naming it at
 * once. `registered` says the device is new.
 */
export async function recordAttested(
  db: Db,
  googleDeviceId: string,
  now: Date,
): Promise<{ device: KioskDeviceRow; credential: string; registered: boolean }> {
  const credential = randomBytes(32).toString("base64url");
  const hash = credentialHash(credential);
  const [row] = await db
    .insert(kioskDevices)
    .values({
      id: randomUUID(),
      googleDeviceId,
      attestedAt: now,
      checkedAt: now,
      attestation: "ok",
      credentialHash: hash,
    })
    .onConflictDoUpdate({
      target: kioskDevices.googleDeviceId,
      set: { attestedAt: now, checkedAt: now, attestation: "ok", credentialHash: hash },
    })
    // `xmax` is 0 on a row this statement inserted, and the updating
    // transaction's id on one it updated: one round trip, no race between a
    // SELECT and an INSERT of two first attestations.
    .returning({ ...getTableColumns(kioskDevices), registered: sql<boolean>`(xmax = 0)` });
  const { registered, ...device } = row!;
  return { device, credential, registered };
}

/** A failed attestation of a known station: the last attempt, and what came of it. */
export async function recordFailed(
  db: Db,
  deviceId: string,
  reason: Exclude<KioskAttestation, "ok">,
  now: Date,
): Promise<void> {
  await db
    .update(kioskDevices)
    .set({ checkedAt: now, attestation: reason })
    .where(eq(kioskDevices.id, deviceId));
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

function adminView(d: KioskDeviceRow): KioskDevice {
  return {
    id: d.id,
    googleDeviceId: d.googleDeviceId,
    label: d.label,
    status: d.status,
    attestedAt: iso(d.attestedAt),
    checkedAt: iso(d.checkedAt),
    attestation: d.attestation,
  };
}

/** The registry, the stations waiting for a name first, then by label. */
export async function listDevices(db: Db): Promise<KioskDevice[]> {
  const rows = await db
    .select()
    .from(kioskDevices)
    .orderBy(
      sql`CASE ${kioskDevices.status} WHEN 'unnamed' THEN 0 WHEN 'active' THEN 1 ELSE 2 END`,
      asc(kioskDevices.label),
      asc(kioskDevices.createdAt),
    );
  return rows.map(adminView);
}

/**
 * An admin's change to a station. Naming an unnamed station makes it
 * `active`; a station is never `active` without a name, so reactivating one
 * retired before it was named needs the name in the same patch.
 */
export async function updateDevice(
  db: Db,
  id: string,
  patch: KioskDevicePatch,
): Promise<{ before: KioskDeviceRow; after: KioskDevice } | null> {
  const [before] = await db.select().from(kioskDevices).where(eq(kioskDevices.id, id));
  if (!before) return null;
  const label = patch.label ?? before.label;
  const status =
    patch.status ?? (before.status === "unnamed" && patch.label !== undefined ? "active" : before.status);
  if (status === "active" && label === null) {
    throw new DomainError("label_required", 409, "A station is named before it is active");
  }
  const [after] = await db
    .update(kioskDevices)
    .set({ label, status })
    .where(eq(kioskDevices.id, id))
    .returning();
  return { before, after: adminView(after!) };
}
