/**
 * A kiosk station for the route tests (ADR-051 §5): a device in the registry,
 * `active` under `label`, and the station cookie that names it (named by
 * the instance's `cookieName`: `__Host-quiz_kiosk` in production mode) — made
 * through the registry's own service, the way an accepted attestation and an
 * admin's naming make one. And what the station's page does with it: its
 * POSTs, its pairing code, the headers of the session a pairing opens.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";

import { KioskDeviceAuthorization } from "@quiz/contracts";

import { sessionCookies } from "../auth/testing.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/client.js";
import { KIOSK_COOKIE, recordAttested, updateDevice } from "../modules/kiosk/service.js";
import type { Payload } from "./http.js";

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

