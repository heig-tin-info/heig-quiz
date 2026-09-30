/**
 * HTTP surface of the `kiosk` module (ADR-051 §5), registered only when
 * `KIOSK_ATTESTATION` is not `off`. Two audiences:
 *
 *   - a STATION, which has no user and no session: it asks for a challenge,
 *     hands back the extension's response, and is answered with its
 *     `quiz_kiosk` cookie — its identity, never a user's. These routes serve
 *     no session kind at all (`sessions: []`): a user session riding along is
 *     anonymous here. They are public POSTs, under the same double-submit
 *     rule as the poll's (`csrfRefused`);
 *   - an ADMIN, who names, retires and reactivates stations. The registry is
 *     platform-wide and admin-only: anyone else gets a 404 (invariant 6).
 *
 * The client learns nothing of why an attestation failed: `not_attested`,
 * whatever Google said. The audit knows the reason; it never holds a
 * challenge, a response, a token or a cookie.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  IdParam,
  KioskAttestVerify,
  KioskDevicePatch,
  type KioskAttested,
  type KioskChallenge,
  type KioskDevice,
  type KioskStation,
} from "@quiz/contracts";

import { audit, tracer, type AuditAction } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { adminGuard } from "../guards.js";
import { csrfRefused, emptyBody, invalid, notFound, sendFailure } from "../http.js";
import { AttestationUnavailable } from "./attestation.js";
import {
  KIOSK_COOKIE,
  KIOSK_COOKIE_HOURS,
  deviceByCredential,
  listDevices,
  recordAttested,
  recordFailed,
  stationOf,
  updateDevice,
} from "./service.js";

/** A station is no session kind: every user session is anonymous on its routes. */
const STATION = { sessions: [] } as const;

export async function kioskPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const secure = opts.config.NODE_ENV === "production";
  const requireAdmin = adminGuard(app, { hidden: true });
  const trace = tracer(app);

  /** What a station did, audited with no actor: a station is not a person. */
  const stationAudit = (action: AuditAction, deviceId: string | null, payload?: object) =>
    audit(app.db, {
      actorType: "system",
      action,
      subjectType: "kiosk_device",
      subjectId: deviceId ?? "unknown",
      at: app.clock.now(),
      ...(payload ? { payload } : {}),
    });

  // =========================================================================
  // The station
  // =========================================================================

  app.post("/app/api/kiosk/attest/challenge", { config: STATION }, async (req, reply) => {
    const refused = csrfRefused(req, reply);
    if (refused) return refused;
    try {
      return { challenge: await app.kioskAttestor!.challenge() } satisfies KioskChallenge;
    } catch (err) {
      if (err instanceof AttestationUnavailable) {
        return reply.code(503).send({ error: "attestation_unavailable" });
      }
      throw err;
    }
  });

  app.post("/app/api/kiosk/attest/verify", { config: STATION }, async (req, reply) => {
    const refused = csrfRefused(req, reply);
    if (refused) return refused;
    const body = KioskAttestVerify.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    const now = app.clock.now();
    // The extension's failure is a refusal (ADR-051 §6); what it said is not kept.
    const verdict =
      "response" in body.data
        ? await app.kioskAttestor!.verify(body.data.response)
        : ({ ok: false, reason: "refused" } as const);

    if (verdict.ok) {
      const { device, credential, registered } = await recordAttested(
        app.db,
        verdict.googleDeviceId,
        now,
      );
      if (registered) await stationAudit("kiosk.device_registered", device.id);
      await stationAudit("kiosk.attested", device.id);
      reply.setCookie(KIOSK_COOKIE, credential, {
        path: "/app/api",
        httpOnly: true,
        secure,
        sameSite: "strict",
        maxAge: KIOSK_COOKIE_HOURS * 3600,
      });
      return { station: { label: device.label, status: device.status } } satisfies KioskAttested;
    }

    const known = await deviceByCredential(app.db, req.cookies[KIOSK_COOKIE]);
    if (known) await recordFailed(app.db, known.id, verdict.reason, now);
    await stationAudit("kiosk.attest_failed", known?.id ?? null, {
      reason: verdict.reason,
      ...(known ? { deviceId: known.id } : {}),
    });
    return reply.code(403).send({ error: "not_attested" });
  });

  app.get("/app/api/kiosk/station", { config: STATION }, async (req, reply) => {
    const station: KioskStation | null = await stationOf(app.db, req.cookies[KIOSK_COOKIE]);
    return station ?? notFound(reply);
  });

  // =========================================================================
  // The registry (admin)
  // =========================================================================

  app.get(
    "/app/api/admin/kiosk-devices",
    { preHandler: requireAdmin },
    async (): Promise<KioskDevice[]> => listDevices(app.db),
  );

  app.patch("/app/api/admin/kiosk-devices/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const body = KioskDevicePatch.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    try {
      const changed = await updateDevice(app.db, params.data.id, body.data);
      if (!changed) return notFound(reply);
      await auditChange(req, changed.before, changed.after);
      return changed.after;
    } catch (err) {
      return sendFailure(reply, err, app.clock.now());
    }
  });

  /** One entry per thing that changed: the name, the retirement, the return to service. */
  async function auditChange(
    req: FastifyRequest,
    before: { label: string | null; status: KioskDevice["status"] },
    after: KioskDevice,
  ) {
    if (after.label !== before.label) {
      await trace(req, "kiosk.device_labeled", "kiosk_device", after.id, {
        from: before.label,
        to: after.label,
      });
    }
    if (after.status !== before.status && after.status === "retired") {
      await trace(req, "kiosk.device_retired", "kiosk_device", after.id);
    } else if (before.status === "retired" && after.status === "active") {
      await trace(req, "kiosk.device_reactivated", "kiosk_device", after.id);
    }
  }
}
