/**
 * The trust of a confined session, checked on EVERY request it makes
 * (ADR-051 §1): one rule per session kind, no provider class. A confined
 * session (`seb`, `kiosk`) is only worth something from the client it was
 * opened in; its cookie alone, carried to another HTTP client, must not be.
 */
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

import type { TrustedClient } from "@quiz/domain";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { kioskDevices } from "../db/schema.js";
import { KIOSK_COOKIE, credentialHash } from "../modules/kiosk/service.js";
import { CONFIG_KEY_HEADER, configKeyHashMatches, requestUrl } from "./seb.js";
import type { SessionAuth } from "./session.js";

/**
 * Why a confined session's request is not trusted: SEB's Config Key does not
 * match; the request does not come from the station the kiosk session was
 * opened on (no `quiz_kiosk` cookie, or not that device's); that station is
 * no longer `active`.
 */
export type TrustRefusal = "seb_config_key" | "kiosk_station" | "kiosk_inactive";

/** What a kiosk session's trust reads of its station (`kiosk_devices`). */
export type TrustedDevice = Pick<
  typeof kioskDevices.$inferSelect,
  "credentialHash" | "status" | "attestation" | "checkedAt"
>;

/** What the session hook knows of a confined session: its kind, and what it was opened with. */
export interface TrustedSession {
  auth: SessionAuth & { kind: TrustedClient };
  sebConfigKey: string | null;
  deviceId: string | null;
  /** The station of a `kiosk` session, as loaded for this request; null when it is gone. */
  device?: TrustedDevice | null;
}

/** The request as SEB (or the station) sent it. */
export interface TrustRequest {
  /** The absolute URL, path and query as received (`requestUrl`). */
  url: string;
  headers: FastifyRequest["headers"];
  /** The station's own cookie (`quiz_kiosk`), when the request carried one. */
  kioskCookie?: string | undefined;
}

/**
 * ADR-051 §6, STEP 7's HOOK: whether the station's attestation suspends its
 * sitting (refused, or silent for 12 minutes). Until step 7 writes the rule,
 * no attestation state refuses anything here; the station's cookie and its
 * `active` status (below) still do.
 */
export function kioskAttestationRefusal(_device: TrustedDevice): TrustRefusal | null {
  return null;
}

/**
 * THE rule, one branch per kind; null when the request is trusted. Pure: what
 * a refusal costs (anonymous, audited) is {@link trustRefused}'s.
 */
export function trustRefusal(session: TrustedSession, request: TrustRequest): TrustRefusal | null {
  switch (session.auth.kind) {
    case "seb":
      // ADR-051 §3: `sha256(absolute URL + Config Key)`, the key stored at
      // launch. A session with no stored key (opened before this check
      // existed) matches nothing.
      return session.sebConfigKey !== null &&
        configKeyHashMatches(request.url, session.sebConfigKey, request.headers[CONFIG_KEY_HEADER])
        ? null
        : "seb_config_key";
    case "kiosk": {
      // ADR-051 §1: the session cookie alone is worth nothing. The request
      // carries the station's own cookie, whose hash is the credential of
      // the session's device — so the session cannot be carried to another
      // machine — and that device is still `active`. Fails closed on a
      // missing cookie, a missing device, a rotated credential.
      const device = session.device ?? null;
      const cookie = request.kioskCookie;
      if (device === null || !cookie || device.credentialHash !== credentialHash(cookie)) {
        return "kiosk_station";
      }
      if (device.status !== "active") return "kiosk_inactive";
      return kioskAttestationRefusal(device);
    }
  }
}

/**
 * The mismatches already audited, `sid_hash route`: once per session and
 * route template, in this process's memory — best effort, a restart may
 * write one more (ADR-051 §3). Bounded: the oldest entry goes first.
 */
const audited = new Set<string>();
const AUDITED_MAX = 10_000;

function firstTime(key: string): boolean {
  if (audited.has(key)) return false;
  if (audited.size >= AUDITED_MAX) audited.delete(audited.values().next().value!);
  audited.add(key);
  return true;
}

/**
 * Whether the session hook must treat this confined session's request as
 * anonymous. A Config Key mismatch refuses only once `SEB_CONFIG_KEY_ENFORCE`
 * is on (after proof B, ADR-051 §3); until then it is audited — the route
 * template, never the header nor the key — and the request proceeds.
 */
export async function trustRefused(
  db: Db,
  config: AppConfig,
  session: TrustedSession & { sidHash: string; userId: string },
  req: FastifyRequest,
): Promise<boolean> {
  const device =
    session.auth.kind === "kiosk" && session.deviceId !== null
      ? ((
          await db
            .select({
              credentialHash: kioskDevices.credentialHash,
              status: kioskDevices.status,
              attestation: kioskDevices.attestation,
              checkedAt: kioskDevices.checkedAt,
            })
            .from(kioskDevices)
            .where(eq(kioskDevices.id, session.deviceId))
        )[0] ?? null)
      : null;
  const refusal = trustRefusal(
    { ...session, device },
    {
      url: requestUrl(config.PUBLIC_URL, req.raw.url ?? req.url),
      headers: req.headers,
      kioskCookie: req.cookies[KIOSK_COOKIE],
    },
  );
  if (refusal === null) return false;
  // Only the Config Key has an audit-only mode; every other refusal refuses.
  if (refusal !== "seb_config_key" || config.SEB_CONFIG_KEY_ENFORCE) return true;
  const route = req.routeOptions.url ?? "";
  if (firstTime(`${session.sidHash} ${route}`)) {
    await audit(db, {
      actorUserId: session.userId,
      actorType: "user",
      action: "auth.seb_config_key_mismatch",
      subjectType: "evaluation",
      subjectId: session.auth.evaluationId ?? "unknown",
      payload: { route },
    });
  }
  return false;
}
