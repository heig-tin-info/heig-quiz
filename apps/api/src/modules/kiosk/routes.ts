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
 *     platform-wide and admin-only: anyone else gets a 404 (invariant 6);
 *   - the PAIRING (ADR-051 §7, RFC 8628): the station asks for a code and
 *     polls for it (`device_authorization`, `token`, station routes again),
 *     and the student's phone — a portal session of their own, never a
 *     delegated one — reads the code and approves it (`/pair`).
 *
 * The client learns nothing of why an attestation failed: `not_attested`,
 * whatever Google said. The audit knows the reason; it never holds a
 * challenge, a response, a token or a cookie.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  IdParam,
  KioskAssign,
  KioskAttestVerify,
  KioskDevicePatch,
  KioskTokenRequest,
  PairApprove,
  PairCodeParam,
  type KioskAttested,
  type KioskChallenge,
  type KioskDevice,
  type KioskDeviceAuthorization,
  type KioskStation,
  type KioskTokenApproved,
  type PairApproved,
  type PairPreview,
} from "@quiz/contracts";

import { audit, tracer, type AuditAction } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { delegated, endStationSessions } from "../../auth/session.js";
import { users } from "../../db/schema.js";
import { adminGuard, loadEvaluation, teacherGuard } from "../guards.js";
import { csrfRefused, emptyBody, invalid, notFound, sendFailure, teacherRoute } from "../http.js";
import { AttestationUnavailable } from "./attestation.js";
import { FixedWindowLimiter } from "../../limiter.js";
import { PairRateLimited, approvePairing, issuePairing, pollPairing, previewPairing } from "./pairing.js";
import {
  KIOSK_COOKIE,
  KIOSK_COOKIE_HOURS,
  deviceByCredential,
  listDevices,
  recordAttested,
  stationOf,
  updateDevice,
} from "./service.js";
import { recordAttempt, stationSeated } from "./watch.js";

/** A station is no session kind: every user session is anonymous on its routes. */
const STATION = { sessions: [] } as const;

/**
 * Attestation calls (challenge and verify together) per client address per
 * minute. One attestation is two calls, and a station attests every ten
 * minutes (ADR-051 §6) — but a room of stations sits behind one NAT address
 * and they all start together: 240 lets about 120 stations attest in the
 * same minute, and still stops a script from spending the Google quota.
 */
export const ATTEST_LIMIT = 240;

/**
 * Pairing previews (`GET /pair/:code`) per user per minute. The GET counts no
 * refusal in the audit (a cross-site navigation must not lock a student out,
 * ADR-051 §7), so this in-memory budget is what bounds guessing through it:
 * a student types a code a few times, a script gets 30 of 27⁸ per minute. A
 * page that forces navigations can at worst hold the preview for a minute;
 * the counted limit stays on the approving POST.
 */
export const PAIR_PREVIEW_LIMIT = 30;

export async function kioskPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const secure = opts.config.NODE_ENV === "production";
  const requireAdmin = adminGuard(app, { hidden: true });
  const trace = tracer(app);
  const attempts = new FixedWindowLimiter(ATTEST_LIMIT, 60_000);
  const previews = new FixedWindowLimiter(PAIR_PREVIEW_LIMIT, 60_000);
  const staffRoute = teacherRoute(app);

  /** The 429 of an address over its budget, with its `retry-after`; null otherwise. */
  const throttled = (req: FastifyRequest, reply: FastifyReply) => {
    const retryAfterS = attempts.hit(req.ip, app.clock.now().getTime());
    if (retryAfterS === null) return null;
    return reply.header("retry-after", String(retryAfterS)).code(429).send({ error: "rate_limited" });
  };

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
    const refused = throttled(req, reply) ?? csrfRefused(req, reply);
    if (refused) return refused;
    try {
      return { challenge: await app.kioskAttestor!.challenge() } satisfies KioskChallenge;
    } catch (err) {
      if (err instanceof AttestationUnavailable) {
        // An attempt all the same (ADR-051 §6): a known station that cannot
        // even get a challenge is `unavailable`, never silent — a Google
        // outage must not suspend it twelve minutes later.
        const known = await deviceByCredential(app.db, req.cookies[KIOSK_COOKIE]);
        if (known) await recordAttempt(app.db, known.id, "unavailable", app.clock.now());
        return reply.code(503).send({ error: "attestation_unavailable" });
      }
      throw err;
    }
  });

  app.post("/app/api/kiosk/attest/verify", { config: STATION }, async (req, reply) => {
    const refused = throttled(req, reply) ?? csrfRefused(req, reply);
    if (refused) return refused;
    const body = KioskAttestVerify.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    const now = app.clock.now();
    // The extension's failure is a refusal (ADR-051 §6); what it said is not kept.
    const verdict =
      "response" in body.data
        ? await app.kioskAttestor!.verify(body.data.response)
        : ({ ok: false, reason: "refused" } as const);

    // Every attempt of a known station is compared with what its supervisor
    // was last told (ADR-051 §6): a suspension, an outage, their end.
    const cookie = req.cookies[KIOSK_COOKIE];
    const known = await deviceByCredential(app.db, cookie);
    if (verdict.ok) {
      // The cookie that already names this device is kept, and re-set for
      // another 12 hours: a write of the sitting sent while this attestation
      // was in flight carries it, and must not turn anonymous.
      const current = known?.googleDeviceId === verdict.googleDeviceId ? cookie! : null;
      const { device, credential, registered } = await recordAttested(
        app.db,
        verdict.googleDeviceId,
        now,
        current,
      );
      if (registered) await stationAudit("kiosk.device_registered", device.id);
      await stationAudit("kiosk.attested", device.id);
      if (!registered) await recordAttempt(app.db, device.id, "ok", now);
      reply.setCookie(KIOSK_COOKIE, credential, {
        path: "/app/api",
        httpOnly: true,
        secure,
        sameSite: "strict",
        maxAge: KIOSK_COOKIE_HOURS * 3600,
      });
      return { station: { label: device.label, status: device.status } } satisfies KioskAttested;
    }

    await stationAudit("kiosk.attest_failed", known?.id ?? null, { reason: verdict.reason });
    if (known) await recordAttempt(app.db, known.id, verdict.reason, now);
    return reply.code(403).send({ error: "not_attested" });
  });

  app.get("/app/api/kiosk/station", { config: STATION }, async (req, reply) => {
    const station: KioskStation | null = await stationOf(app.db, req.cookies[KIOSK_COOKIE]);
    return station ?? notFound(reply);
  });

  // =========================================================================
  // The pairing (ADR-051 §7, RFC 8628): the station's half
  // =========================================================================

  /**
   * The station the request's `quiz_kiosk` cookie names, when it may be
   * paired: `active`, hence named. Anything else — no cookie, a rotated one,
   * an unnamed or retired station — is the one 403 the page words as
   * "Station not recognised, call the supervisor".
   */
  const pairableStation = async (req: FastifyRequest, reply: FastifyReply) => {
    const device = await deviceByCredential(app.db, req.cookies[KIOSK_COOKIE]);
    if (device?.status === "active" && device.label !== null) return { ...device, label: device.label };
    reply.code(403).send({ error: "not_recognised" });
    return null;
  };

  app.post("/app/api/kiosk/device_authorization", { config: STATION }, async (req, reply) => {
    const refused = throttled(req, reply) ?? csrfRefused(req, reply);
    if (refused) return refused;
    const station = await pairableStation(req, reply);
    if (!station) return reply;
    const issued = await issuePairing(app.db, station.id, app.clock.now());
    const verification = new URL("/pair", opts.config.PUBLIC_URL);
    const complete = new URL(verification);
    complete.searchParams.set("code", issued.userCode);
    reply.header("cache-control", "no-store");
    return {
      device_code: issued.deviceCode,
      user_code: issued.userCode,
      verification_uri: verification.toString(),
      verification_uri_complete: complete.toString(),
      expires_in: issued.expiresIn,
      interval: issued.interval,
      label: station.label,
    } satisfies KioskDeviceAuthorization;
  });

  /**
   * The station's poll. Not under the per-address limiter: a room of stations
   * behind one NAT polls every two seconds, and each pairing is paced by its
   * own `slow_down`. On approval the station gets a `kiosk` session: the
   * student, the evaluation, this device — and NO actor, whoever approved
   * (ADR-051 §7): a non-null actor is an impersonation, read-only.
   */
  app.post("/app/api/kiosk/token", { config: STATION }, async (req, reply) => {
    const refused = csrfRefused(req, reply);
    if (refused) return refused;
    const body = KioskTokenRequest.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    const station = await pairableStation(req, reply);
    if (!station) return reply;
    reply.header("cache-control", "no-store");
    const outcome = await pollPairing(app.db, station.id, body.data.device_code, app.clock.now());
    if (outcome.kind === "error") return reply.code(400).send({ error: outcome.error });
    const [user] = await app.db.select().from(users).where(eq(users.id, outcome.userId));
    if (!user) return reply.code(400).send({ error: "access_denied" });
    await app.openSession(reply, user, {
      kind: "kiosk",
      actorUserId: null,
      evaluationId: outcome.evaluationId,
      deviceId: station.id,
    });
    // The supervisor's row shows the station at once, and its state (§6).
    await stationSeated(app.db, station.id, app.clock.now());
    return { redirect: `/take/${outcome.evaluationId}` } satisfies KioskTokenApproved;
  });

  // =========================================================================
  // The pairing: the phone's half (a portal session)
  // =========================================================================

  /**
   * The phone is a portal session of the user themself: these routes
   * declare no kind, so a `seb` or `kiosk` session is anonymous here, and a
   * delegated one (ADR-034) or an API token finds nothing to pair.
   */
  const phone = async (req: FastifyRequest, reply: FastifyReply) => {
    const refused = await app.requireSession(req, reply);
    if (refused) return refused;
    if (req.authVia !== "session" || delegated(req.auth)) return notFound(reply);
    return undefined;
  };

  const pairingNotFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "pairing_not_found" });

  const rateLimited = (reply: FastifyReply, err: unknown) => {
    if (!(err instanceof PairRateLimited)) throw err;
    return reply
      .header("retry-after", String(err.retryAfterS))
      .code(429)
      .send({ error: "rate_limited" });
  };

  app.get("/app/api/pair/:code", { preHandler: phone }, async (req, reply) => {
    const params = PairCodeParam.safeParse(req.params);
    if (!params.success) return pairingNotFound(reply);
    const retryAfterS = previews.hit(req.user!.id, app.clock.now().getTime());
    if (retryAfterS !== null) {
      return reply.header("retry-after", String(retryAfterS)).code(429).send({ error: "rate_limited" });
    }
    try {
      const found = await previewPairing(app.db, req.user!.id, params.data.code, app.clock.now());
      if (!found) return pairingNotFound(reply);
      return { station: { label: found.label }, evaluations: found.evaluations } satisfies PairPreview;
    } catch (err) {
      return rateLimited(reply, err);
    }
  });

  app.post("/app/api/pair", { preHandler: phone }, async (req, reply) => {
    const body = PairApprove.safeParse(emptyBody(req.body));
    if (!body.success) return invalid(reply, body.error);
    const userId = req.user!.id;
    const now = app.clock.now();
    try {
      const outcome = await approvePairing(app.db, { userId, ...body.data }, now);
      if (outcome.kind === "not_found") return pairingNotFound(reply);
      if (outcome.kind === "evaluation") {
        await trace(req, "kiosk.pair_refused", "evaluation", body.data.evaluationId, {
          reason: "evaluation",
        });
        return reply.code(409).send({ error: "evaluation_not_pairable" });
      }
      await trace(req, "kiosk.paired", "kiosk_pairing", outcome.pairingId, {
        evaluationId: body.data.evaluationId,
        deviceId: outcome.deviceId,
      });
      return { station: { label: outcome.label } } satisfies PairApproved;
    } catch (err) {
      return rateLimited(reply, err);
    }
  });

  // =========================================================================
  // The supervisor's fallback (ADR-051 §7)
  // =========================================================================

  /**
   * A student without a phone reads the station's code to the supervisor,
   * who approves the SAME pairing from the dashboard. Staff of the
   * evaluation only (invariant 6: a 404 for anyone else); the student must
   * be able to start the exam on a station now, as on `/pair`. The
   * supervisor is recorded in `approved_by` and `kiosk.assigned`, never as
   * the session's actor: the student must be able to answer. The label comes
   * back in the answer, so the dialog confirms which station it paired — the
   * supervisor is standing at it, reading its code, and a code that names
   * another pending station is a one-in-27⁸ typo.
   */
  app.post(
    "/app/api/evaluations/:id/kiosk-assign",
    { preHandler: teacherGuard(app) },
    staffRoute(
      { params: IdParam, body: KioskAssign, load: (req, reply, p) => loadEvaluation(app, req, reply, p.id) },
      async ({ req, reply, now, body, scope }) => {
        const evaluationId = scope.evaluation.id;
        try {
          const outcome = await approvePairing(
            app.db,
            { userId: body.userId, code: body.userCode, evaluationId, approvedBy: req.user!.id },
            now,
          );
          if (outcome.kind === "not_found") return pairingNotFound(reply);
          if (outcome.kind === "evaluation") {
            await trace(req, "kiosk.pair_refused", "evaluation", evaluationId, {
              reason: "evaluation",
              userId: body.userId,
            });
            return reply.code(409).send({ error: "evaluation_not_pairable" });
          }
          await trace(req, "kiosk.assigned", "kiosk_pairing", outcome.pairingId, {
            evaluationId,
            userId: body.userId,
            deviceId: outcome.deviceId,
          });
          return { station: { label: outcome.label } } satisfies PairApproved;
        } catch (err) {
          return rateLimited(reply, err);
        }
      },
    ),
  );

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
      // A retired station's sitting ends now, its stream with it.
      if (changed.after.status === "retired") await endStationSessions(app.db, changed.after.id);
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
