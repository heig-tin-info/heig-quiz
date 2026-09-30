/**
 * A kiosk station for the route tests (ADR-051 §5): a device in the registry,
 * `active` under `label`, and the `quiz_kiosk` cookie that names it — made
 * through the registry's own service, the way an accepted attestation and an
 * admin's naming make one.
 */
import { randomUUID } from "node:crypto";

import type { Db } from "../db/client.js";
import { KIOSK_COOKIE, recordAttested, updateDevice } from "../modules/kiosk/service.js";

export interface TestStation {
  deviceId: string;
  credential: string;
  /** `quiz_kiosk=<credential>`, to join to a request's `cookie` header. */
  cookie: string;
}

export async function kioskStation(
  db: Db,
  opts: { label?: string | null; status?: "active" | "retired" } = {},
): Promise<TestStation> {
  const { device, credential } = await recordAttested(db, `test-${randomUUID()}`, new Date());
  const label = opts.label === undefined ? "Poste n° 7" : opts.label;
  if (label !== null) await updateDevice(db, device.id, { label });
  if (opts.status === "retired") await updateDevice(db, device.id, { status: "retired" });
  return { deviceId: device.id, credential, cookie: `${KIOSK_COOKIE}=${credential}` };
}
