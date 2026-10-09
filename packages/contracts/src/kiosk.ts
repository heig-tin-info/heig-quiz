/**
 * `kiosk` route schemas (ADR-051 §5): the attestation of a station, what a
 * station knows of itself, and the admin's registry.
 */
import { z } from "zod";

import { KIOSK_ATTESTATIONS, type KioskAttestation } from "@quiz/domain";

import { EvaluationConditions } from "./live.js";

export const KIOSK_DEVICE_STATUSES = ["unnamed", "active", "retired"] as const;

/** The outcome of a station's last attestation attempt (ADR-051 §6). */
export { KIOSK_ATTESTATIONS, type KioskAttestation };

/** The longest station label an admin may give (`KioskDevicePatch`, the admin's field). */
export const KIOSK_LABEL_MAX = 80;

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
  /**
   * Verified Access's `devicePermanentId`, the hardware serial printed on
   * the Chromebook: how an admin tells which machine an unnamed row is. Never
   * in a station's own payload.
   */
  googleDeviceId: z.string(),
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
    label: z.string().trim().min(1).max(KIOSK_LABEL_MAX).optional(),
    status: z.enum(["active", "retired"]).optional(),
  })
  .refine((p) => p.label !== undefined || p.status !== undefined, {
    message: "Nothing to change",
  });
export type KioskDevicePatch = z.infer<typeof KioskDevicePatch>;

// --- The pairing (ADR-051 §7, RFC 8628) ----------------------------------------

/**
 * `POST /app/api/kiosk/device_authorization`: the RFC's fields, as the RFC
 * spells them, and the station's label for its own screen.
 */
export const KioskDeviceAuthorization = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
  label: z.string(),
});
export type KioskDeviceAuthorization = z.infer<typeof KioskDeviceAuthorization>;

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** `POST /app/api/kiosk/token`: the station's poll (RFC 8628 §3.4). */
export const KioskTokenRequest = z.strictObject({
  grant_type: z.literal(DEVICE_CODE_GRANT),
  device_code: z.string().min(1).max(128),
});
export type KioskTokenRequest = z.infer<typeof KioskTokenRequest>;

/** The 400 of a poll (RFC 8628 §3.5, and RFC 6749 §5.2 for an unknown code). */
export const KIOSK_TOKEN_ERRORS = [
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
  "invalid_grant",
] as const;
export const KioskTokenError = z.object({ error: z.enum(KIOSK_TOKEN_ERRORS) });
export type KioskTokenError = z.infer<typeof KioskTokenError>;

/** An approved poll: the station now holds a `kiosk` session, and goes to its exam. */
export const KioskTokenApproved = z.object({ redirect: z.string() });
export type KioskTokenApproved = z.infer<typeof KioskTokenApproved>;

/** What `/pair` offers: an exam the student can start on the station now. */
export const PairableEvaluation = z.object({
  id: z.uuid(),
  title: z.string(),
  classroomName: z.string(),
  courseCode: z.string(),
  /** ADR-079 §7: read on the phone before confirming, since the station begins the attempt directly. */
  conditions: EvaluationConditions,
});
export type PairableEvaluation = z.infer<typeof PairableEvaluation>;

/** `GET /app/api/pair/:code`: the station to compare with the screen, and the exams. */
export const PairPreview = z.object({
  station: z.object({ label: z.string() }),
  evaluations: z.array(PairableEvaluation),
});
export type PairPreview = z.infer<typeof PairPreview>;

/** `/app/api/pair/:code`: the code as typed; the route normalizes it. */
export const PairCodeParam = z.object({ code: z.string().min(1).max(32) });
export type PairCodeParam = z.infer<typeof PairCodeParam>;

/** `POST /app/api/pair`: the student approves the pairing for one exam. */
export const PairApprove = z.strictObject({
  code: z.string().min(1).max(32),
  evaluationId: z.uuid(),
});
export type PairApprove = z.infer<typeof PairApprove>;

/** The approval, answered with the station's label. */
export const PairApproved = z.object({ station: z.object({ label: z.string() }) });
export type PairApproved = z.infer<typeof PairApproved>;

/**
 * `POST /app/api/evaluations/:id/kiosk-assign` (ADR-051 §7, the supervisor's
 * fallback): the code a station shows, approved for one student of the
 * evaluation who has no phone. Answered with the station's label, like
 * {@link PairApproved}.
 */
export const KioskAssign = z.strictObject({
  userCode: z.string().min(1).max(32),
  userId: z.uuid(),
});
export type KioskAssign = z.infer<typeof KioskAssign>;
