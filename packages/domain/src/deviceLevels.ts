/**
 * The device levels (ADR-089, amendment of 2026-11-15, point 2): which
 * trusted clients an activity accepts, in one vocabulary for an exam's
 * **Allowed devices** and a supervised project's. Pure (invariant 8).
 *
 * An exam stores its level as two booleans (`safeExamBrowser`, `kiosk`,
 * ADR-051 §2), a project as one id (`projects.devices`); both read this
 * table, in the order the screen shows it.
 */
import { TRUSTED_CLIENTS, type TrustedClient } from "./evaluationConfig.js";

/**
 * THE four levels, in the order shown: any device, Safe Exam Browser only,
 * SEB or a kiosk station, a kiosk station only. Each lists the trusted
 * clients it accepts, in `TRUSTED_CLIENTS`' order; none means the portal.
 */
export const DEVICE_LEVELS = [
  { id: "any", clients: [] },
  { id: "seb", clients: ["seb"] },
  { id: "either", clients: ["seb", "kiosk"] },
  { id: "kiosk", clients: ["kiosk"] },
] as const satisfies readonly { id: string; clients: readonly TrustedClient[] }[];

export type DeviceLevel = (typeof DEVICE_LEVELS)[number]["id"];

/** The level ids, for a closed enum (`@quiz/contracts` builds its schema from it). */
export const DEVICE_LEVEL_IDS = DEVICE_LEVELS.map((l) => l.id) as unknown as readonly [DeviceLevel, ...DeviceLevel[]];

/** The levels that require a trusted client: what a supervised project (`online_seb`) may hold. */
export const SUPERVISED_DEVICE_LEVELS = ["seb", "either", "kiosk"] as const satisfies readonly Exclude<DeviceLevel, "any">[];
export type SupervisedDeviceLevel = (typeof SUPERVISED_DEVICE_LEVELS)[number];

/** The trusted clients a level accepts, in `TRUSTED_CLIENTS`' order; empty for `any`. */
export function deviceLevelClients(level: DeviceLevel): readonly TrustedClient[] {
  return DEVICE_LEVELS.find((l) => l.id === level)!.clients;
}

/** The level that accepts exactly `clients` (any order): the table covers every subset of `TRUSTED_CLIENTS`. */
export function deviceLevelOf(clients: readonly TrustedClient[]): DeviceLevel {
  const set = TRUSTED_CLIENTS.filter((c) => clients.includes(c));
  return DEVICE_LEVELS.find((l) => l.clients.length === set.length && l.clients.every((c, i) => c === set[i]))!.id;
}

/** Whether a level accepts a kiosk station: a "station level" (ADR-089, amendment point 1). */
export const acceptsKiosk = (level: DeviceLevel): boolean => deviceLevelClients(level).includes("kiosk");
