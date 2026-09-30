/**
 * `kiosk` route schemas (ADR-051 §5): the attestation of a station, what a
 * station knows of itself, and the admin's registry.
 */
import { z } from "zod";

export const KIOSK_DEVICE_STATUSES = ["unnamed", "active", "retired"] as const;
export type KioskDeviceStatus = (typeof KIOSK_DEVICE_STATUSES)[number];

/** The outcome of a station's last attestation attempt (ADR-051 §6). */
export const KIOSK_ATTESTATIONS = ["ok", "unavailable", "refused"] as const;
export type KioskAttestation = (typeof KIOSK_ATTESTATIONS)[number];

/** `POST /app/api/kiosk/attest/challenge` — Verified Access's challenge, base64. */
export const KioskChallenge = z.object({ challenge: z.string() });
export type KioskChallenge = z.infer<typeof KioskChallenge>;

/**
 * `POST /app/api/kiosk/attest/verify`: the extension's response to the
 * challenge, or — when the extension failed — what it said instead. A
 * reported failure is recorded as a refusal (ADR-051 §6); its text is never
 * stored nor echoed.
 */
export const KioskAttestVerify = z.union([
  z.strictObject({ response: z.string().min(1).max(16_384) }),
  z.strictObject({ error: z.string().max(500) }),
]);
export type KioskAttestVerify = z.infer<typeof KioskAttestVerify>;

/** What a station shows of itself: its label (null until an admin names it) and its status. */
export const KioskStation = z.object({
  label: z.string().nullable(),
  status: z.enum(KIOSK_DEVICE_STATUSES),
});
export type KioskStation = z.infer<typeof KioskStation>;

/** An accepted attestation answers the station it proved to be. */
export const KioskAttested = z.object({ station: KioskStation });
export type KioskAttested = z.infer<typeof KioskAttested>;

/** One row of `GET /app/api/admin/kiosk-devices`. */
export const KioskDevice = z.object({
  id: z.uuid(),
  label: z.string().nullable(),
  status: z.enum(KIOSK_DEVICE_STATUSES),
  /** The last attestation Google accepted. */
  attestedAt: z.iso.datetime().nullable(),
  /** The last attempt, and what came of it. */
  checkedAt: z.iso.datetime().nullable(),
  attestation: z.enum(KIOSK_ATTESTATIONS).nullable(),
});
export type KioskDevice = z.infer<typeof KioskDevice>;

/** `PATCH /app/api/admin/kiosk-devices/:id`. Naming an unnamed station makes it active. */
export const KioskDevicePatch = z
  .strictObject({
    label: z.string().trim().min(1).max(80).optional(),
    status: z.enum(["active", "retired"]).optional(),
  })
  .refine((p) => p.label !== undefined || p.status !== undefined, {
    message: "Nothing to change",
  });
export type KioskDevicePatch = z.infer<typeof KioskDevicePatch>;
