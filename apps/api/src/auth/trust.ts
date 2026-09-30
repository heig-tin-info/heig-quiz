/**
 * The trust of a confined session, checked on EVERY request it makes
 * (ADR-051 §1): one rule per session kind, no provider class. A confined
 * session (`seb`, `kiosk`) is only worth something from the client it was
 * opened in; its cookie alone, carried to another HTTP client, must not be.
 */
import type { FastifyRequest } from "fastify";

import type { TrustedClient } from "@quiz/domain";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { KIOSK_COOKIE, deviceByCredential, type KioskDeviceRow } from "../modules/kiosk/service.js";
import { CONFIG_KEY_HEADER, configKeyHashMatches, requestUrl } from "./seb.js";
import type { SessionAuth } from "./session.js";

/**
 * Why a confined session's request is not trusted: SEB's Config Key does not
 * match; the request does not come from the station the kiosk session was
 * opened on (no `quiz_kiosk` cookie, or not that device's); that station is
 * no longer `active`.
 */
export type TrustRefusal = "seb_config_key" | "kiosk_station" | "kiosk_inactive";

/** What the session hook knows of a confined session: its kind, and what it was opened with. */
export interface TrustedSession {
  auth: SessionAuth & { kind: TrustedClient };
  sebConfigKey: string | null;
  deviceId: string | null;
}

/** The request as SEB (or the station) sent it. */
export interface TrustRequest {
  /** The absolute URL, path and query as received (`requestUrl`). */
  url: string;
  headers: FastifyRequest["headers"];
  /** The station the request's `quiz_kiosk` cookie names (`deviceByCredential`); null without one. */
  station: KioskDeviceRow | null;
}

/**
 * ADR-051 §6, STEP 7's HOOK: whether the station's attestation suspends its
 * sitting (refused, or silent for 12 minutes). Until step 7 writes the rule,
 * no attestation state refuses anything here; the station's cookie and its
 * `active` status (below) still do.
 */
export function kioskAttestationRefusal(_device: KioskDeviceRow): TrustRefusal | null {
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
      // carries the station's own cookie, and the station it names is the
      // session's device — so the session cannot be carried to another
      // machine — still `active`. Fails closed on a missing or rotated
      // cookie, and on another station's.
      const station = request.station;
      if (station === null || station.id !== session.deviceId) return "kiosk_station";
      if (station.status !== "active") return "kiosk_inactive";
      return kioskAttestationRefusal(station);
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
  const station =
    session.auth.kind === "kiosk" ? await deviceByCredential(db, req.cookies[KIOSK_COOKIE]) : null;
  const refusal = trustRefusal(session, {
    url: requestUrl(config.PUBLIC_URL, req.raw.url ?? req.url),
    headers: req.headers,
    station,
  });
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
