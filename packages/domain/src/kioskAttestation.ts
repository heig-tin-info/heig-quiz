/**
 * The re-attestation of a kiosk station while it sits an exam (ADR-051 §6).
 * Pure: the station's last check and the server's instant are passed in.
 *
 *  - the STATE of a station at `now`, from its last attempt: `ok`,
 *    `unavailable` (Google could not answer), `refused`, or `silent` (no
 *    attempt for {@link KIOSK_SILENT_AFTER_MS});
 *  - which states SUSPEND a sitting (refused, silent — never unavailable);
 *  - whether a check is FRESH enough for the submit;
 *  - what the supervisor is told when the state changes.
 */

/** The page re-attests every 10 minutes; two missed rounds and it is silent. */
export const KIOSK_SILENT_AFTER_MS = 12 * 60_000;
/** The submit of a kiosk sitting needs a check younger than this (ADR-051 §6). */
export const KIOSK_FRESH_MS = 2 * 60_000;

/** The station's last attempt, as `kiosk_devices` stores it. */
export interface KioskCheck {
  attestation: "ok" | "unavailable" | "refused" | null;
  checkedAt: Date | null;
}

export type KioskAttestationState = "ok" | "unavailable" | "refused" | "silent";

const ageMs = (check: KioskCheck, now: Date) => now.getTime() - check.checkedAt!.getTime();

/**
 * Where a station stands at `now`. A station that never attempted, or not
 * for twelve minutes, is `silent` whatever its last attempt said.
 */
export function kioskAttestationState(check: KioskCheck, now: Date): KioskAttestationState {
  if (check.attestation === null || check.checkedAt === null) return "silent";
  if (ageMs(check, now) >= KIOSK_SILENT_AFTER_MS) return "silent";
  return check.attestation;
}

/** Refused or silent: writes answer `423 kiosk_suspended`. A Google outage suspends nothing. */
export const kioskSuspends = (state: KioskAttestationState): boolean =>
  state === "refused" || state === "silent";

/** The check the submit needs: `ok` or `unavailable`, less than two minutes old. */
export function kioskCheckFresh(check: KioskCheck, now: Date): boolean {
  return !kioskSuspends(kioskAttestationState(check, now)) && ageMs(check, now) < KIOSK_FRESH_MS;
}

/**
 * What the supervisor sees of a station: fine, attesting impossible, or
 * suspended. Stored as `kiosk_devices.watch`: what the supervisor was last
 * told, so each change is told once.
 */
export const KIOSK_WATCHES = ["ok", "unavailable", "suspended"] as const;
export type KioskWatch = (typeof KIOSK_WATCHES)[number];

export const kioskWatchOf = (state: KioskAttestationState): KioskWatch =>
  kioskSuspends(state) ? "suspended" : state === "unavailable" ? "unavailable" : "ok";

export type KioskAlert = "kiosk_suspended" | "kiosk_unavailable" | "kiosk_resumed";

/**
 * What a change from what the supervisor was last told (`before`) to `after`
 * costs: the audit of the suspension (`suspended`, or `resumed` when one is
 * lifted) and the one alert of the dashboard row. Nothing when nothing
 * changed, so a station re-attesting `ok` every ten minutes says nothing.
 */
export function kioskTransition(
  before: KioskWatch,
  after: KioskWatch,
): { suspension: "suspended" | "resumed" | null; alert: KioskAlert | null } {
  if (before === after) return { suspension: null, alert: null };
  const suspension = after === "suspended" ? "suspended" : before === "suspended" ? "resumed" : null;
  const alert = after === "suspended" ? "kiosk_suspended" : after === "unavailable" ? "kiosk_unavailable" : "kiosk_resumed";
  return { suspension, alert };
}
