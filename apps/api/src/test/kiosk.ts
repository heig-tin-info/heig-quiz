/**
 * A kiosk station for the route tests (ADR-051 §5): a device in the registry,
 * `active` under `label`, and the station cookie that names it (named by
 * the instance's `cookieName`: `__Host-quiz_kiosk` in production mode) — made
 * through the registry's own service, the way an accepted attestation and an
 * admin's naming make one. And what the station's page does with it: its
 * POSTs, its pairing code, the headers of the session a pairing opens.
 */
import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";

import { KioskDeviceAuthorization } from "@quiz/contracts";

import { sessionCookies } from "../auth/testing.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/client.js";
import { kioskPairings } from "../db/schema.js";
import { KIOSK_COOKIE, recordAttested, updateDevice } from "../modules/kiosk/service.js";
import { sessionOf, type Payload } from "./http.js";

export interface TestStation {
  deviceId: string;
  /** Google's device id: `mock:<googleDeviceId>` re-attests this station under the mock attestor. */
  googleDeviceId: string;
  credential: string;
  /** `<station cookie>=<credential>`, to join to a request's `cookie` header. */
  cookie: string;
}

/** Attested at the SERVER's instant (`app.clock`), so a test's clock and the station's last check agree. */
export async function kioskStation(
  app: { db: Db; clock: Clock; cookieName: (base: string) => string },
  opts: { label?: string | null; status?: "active" | "retired" } = {},
): Promise<TestStation> {
  const { db } = app;
  const googleDeviceId = `test-${randomUUID()}`;
  const { device, credential } = await recordAttested(db, googleDeviceId, app.clock.now());
  const label = opts.label === undefined ? "Poste n° 7" : opts.label;
  if (label !== null) await updateDevice(db, device.id, { label });
  if (opts.status === "retired") await updateDevice(db, device.id, { status: "retired" });
  return { deviceId: device.id, googleDeviceId, credential, cookie: `${app.cookieName(KIOSK_COOKIE)}=${credential}` };
}

/** Each station call from its own address: the attestation limiter is not under test. */
let host = 0;

/** A station's POST (its routes serve no session): its cookie alone, from a fresh address. */
export const stationPost = (
  app: Pick<FastifyInstance, "inject">,
  url: string,
  station: TestStation | null,
  payload?: Payload,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: "POST",
    url,
    remoteAddress: `10.9.${Math.floor(++host / 250)}.${host % 250}`,
    headers: station ? { cookie: station.cookie } : {},
    ...(payload ? { payload } : {}),
  });

/** The station's pairing screen: a code (RFC 8628 §3.1–3.2). */
export async function authorize(app: Pick<FastifyInstance, "inject">, station: TestStation): Promise<KioskDeviceAuthorization> {
  const res = await stationPost(app, "/app/api/kiosk/device_authorization", station);
  expect(res.statusCode, res.body).toBe(200);
  return KioskDeviceAuthorization.parse(res.json());
}

/**
 * The headers of the session a response opened (`sessionCookies`), beside
 * `station`'s cookie when given: what the station's browser then sends.
 */
export function stationHeaders(res: LightMyRequestResponse, station: TestStation | null = null): Record<string, string> {
  const headers = sessionCookies(res);
  return station ? { ...headers, cookie: `${headers.cookie}; ${station.cookie}` } : headers;
}


/**
 * A station's session of `projectId` for `userId`, as a consumed pairing
 * opens one — the pairing row written here, for the cells of the matrix the
 * pairing list would never offer (a station on a SEB-only project) and for
 * the readers of a project's student view (ADR-089). With `evaluationId`,
 * the station sits that evaluation instead.
 */
export async function kioskSession(
  app: { db: Db; clock: Clock; cookieName: (base: string) => string },
  userId: string,
  projectId: string,
  opts: { actorUserId?: string; evaluationId?: string } = {},
): Promise<{ headers: Record<string, string>; station: TestStation; sitting: string }> {
  const station = await kioskStation(app);
  const pairingId = randomUUID();
  const now = app.clock.now();
  const activity = opts.evaluationId ? { evaluationId: opts.evaluationId } : { projectId };
  await app.db.insert(kioskPairings).values({
    id: pairingId,
    deviceId: station.deviceId,
    deviceCodeHash: createHash("sha256").update(randomUUID()).digest("hex"),
    userCodeHash: createHash("sha256").update(randomUUID()).digest("hex"),
    state: "consumed",
    userId,
    ...activity,
    expiresAt: new Date(now.getTime() + 300_000),
    consumedAt: now,
  });
  const headers = await sessionOf(app.db, userId, {
    kind: "kiosk",
    deviceId: station.deviceId,
    kioskPairingId: pairingId,
    ...activity,
    ...(opts.actorUserId ? { actorUserId: opts.actorUserId } : {}),
  });
  return { headers: { ...headers, cookie: `${headers.cookie}; ${station.cookie}` }, station, sitting: pairingId };
}
