/**
 * The station's side of ADR-051, without React: the attestation through the
 * companion extension (§5) and the pairing (§7, RFC 8628). `useKioskStation`
 * runs them in a loop; each step answers what the screen should show next.
 */
import {
  DEVICE_CODE_GRANT,
  type KioskAttestVerify,
  type KioskAttested,
  type KioskChallenge,
  type KioskDeviceAuthorization,
  type KioskStation,
  type KioskTokenApproved,
  type KioskTokenRequest,
  type PublicConfig,
} from "@quiz/contracts";

import { ApiError, api, refusalCodeOf, refusedWith } from "../api";
import { readStored, writeStored } from "../ui/state";

/**
 * Why a station cannot show a code: not in the registry (or not named), the
 * platform out of reach, or held — its last project sitting's workspace is
 * not closed yet (ADR-089, amendment of 2026-11-15, point 4).
 */
export type StationTrouble = "not_recognised" | "unavailable" | "held";

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const status = (err: unknown) => (err instanceof ApiError ? err.status : null);

// --- The extension -----------------------------------------------------------

/** What the companion extension answers (`extensions/kiosk-attestation/`). */
type ExtensionReply = { ok: true; response?: string } | { ok: false; error?: string };

/** How long a silent extension is waited for. */
const EXTENSION_TIMEOUT_MS = 10_000;

interface ChromeRuntime {
  sendMessage: (id: string, message: unknown, callback: (reply: unknown) => void) => void;
  lastError?: { message?: string } | undefined;
}

/** One message to the extension; rejects when it is not installed, not allowed, or silent. */
function askExtension(extensionId: string, message: object): Promise<ExtensionReply> {
  const runtime = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
  if (typeof runtime?.sendMessage !== "function") {
    return Promise.reject(new Error("extension_unreachable"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("extension_timeout")), EXTENSION_TIMEOUT_MS);
    try {
      runtime.sendMessage(extensionId, message, (reply) => {
        clearTimeout(timer);
        if (runtime.lastError || reply === undefined) reject(new Error("extension_unreachable"));
        else resolve(reply as ExtensionReply);
      });
    } catch {
      clearTimeout(timer);
      reject(new Error("extension_unreachable"));
    }
  });
}

/**
 * The device a browser plays in the development attestation (`mock`): one
 * random id per browser, kept, so that two browsers are two stations.
 */
const MOCK_DEVICE_KEY = "quiz.kiosk.mockDevice";

export function mockDeviceId(): string {
  const kept = readStored(MOCK_DEVICE_KEY);
  if (kept) return kept;
  const id = `dev-${Math.random().toString(36).slice(2, 10)}`;
  writeStored(MOCK_DEVICE_KEY, id);
  return id;
}

/** What `verify` is handed: the extension's response, or what it said instead (ADR-051 §6). */
async function attestationOf(
  kiosk: NonNullable<PublicConfig["kiosk"]>,
  challenge: string,
): Promise<KioskAttestVerify> {
  if (kiosk.mock) return { response: `mock:${mockDeviceId()}` };
  if (!kiosk.extensionId) return { error: "extension_not_configured" };
  try {
    const ping = await askExtension(kiosk.extensionId, { type: "ping" });
    if (!ping.ok) return { error: ping.error ?? "extension_refused" };
    const reply = await askExtension(kiosk.extensionId, { type: "attest", challenge });
    return reply.ok && reply.response ? { response: reply.response } : { error: (!reply.ok && reply.error) || "challenge_failed" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "extension_unreachable" };
  }
}

/**
 * How one attestation ended (ADR-051 §6):
 *  - `ok`: attested, and the station is `active`;
 *  - `revoked`: attested, but the station is out of the registry or unnamed;
 *  - `refused` (a 403) and `unavailable` (no challenge from Google, the
 *    route's 503): the server RECORDED the attempt;
 *  - `lost`: no attempt reached it — no answer, another 5xx, a 429, or no
 *    configuration to attest with.
 */
export type AttestOutcome = "ok" | "revoked" | "refused" | "unavailable" | "lost";

/** One attestation: the station the server answered, or how it went wrong. */
async function attestStation(kiosk: PublicConfig["kiosk"]): Promise<KioskStation | Exclude<AttestOutcome, "ok" | "revoked">> {
  if (!kiosk) return "lost";
  try {
    const { challenge } = await post<KioskChallenge>("/app/api/kiosk/attest/challenge");
    const body = (await attestationOf(kiosk, challenge)) satisfies KioskAttestVerify;
    return (await post<KioskAttested>("/app/api/kiosk/attest/verify", body)).station;
  } catch (err) {
    if (status(err) === 403) return "refused";
    return refusalCodeOf(err) === "attestation_unavailable" ? "unavailable" : "lost";
  }
}

/** One attestation: a challenge, the extension's answer, the verdict. */
export async function attestOnce(kiosk: PublicConfig["kiosk"]): Promise<AttestOutcome> {
  const station = await attestStation(kiosk);
  if (typeof station === "string") return station;
  return station.status === "active" ? "ok" : "revoked";
}

/**
 * One attestation, for the station's screen: null when attested, `active`
 * and not held; otherwise what to show. The hold is read here only, before a
 * code: during its own sitting a station is held too, and that is no trouble.
 */
export async function attest(kiosk: PublicConfig["kiosk"]): Promise<StationTrouble | null> {
  const station = await attestStation(kiosk);
  if (typeof station === "string") return station === "refused" ? "not_recognised" : "unavailable";
  if (station.status !== "active") return "not_recognised";
  return station.held ? "held" : null;
}

// --- A project sitting (ADR-089) ---------------------------------------------------

/**
 * How **Leave this station** ended: `left` when the server will not hear
 * this station's sitting any more — ended now (the 204), already ended by
 * another end (a 404), or the station no longer trusted with it (a 401: the
 * sitting then ends at its expiry or the sweep); `suspended` when the station must be
 * checked again first (the `423`, whose notice the page already shows);
 * `failed` otherwise, the sitting still running.
 */
export type LeaveOutcome = "left" | "suspended" | "failed";

/**
 * **Leave this station** (`POST /app/api/kiosk/leave`, no body, a `204`):
 * ends the station's project sitting on the server, which closes the portal
 * session it opened (ADR-089, amendment of 2026-11-15, point 4).
 */
export async function endProjectSitting(): Promise<LeaveOutcome> {
  try {
    await post<void>("/app/api/kiosk/leave");
    return "left";
  } catch (err) {
    if (status(err) === 401 || status(err) === 404) return "left";
    return refusedWith(err, "kiosk_suspended") ? "suspended" : "failed";
  }
}

// --- The pairing ---------------------------------------------------------------

/** A new code for the station, or why there is none. */
export async function authorize(): Promise<KioskDeviceAuthorization | StationTrouble> {
  try {
    return await post<KioskDeviceAuthorization>("/app/api/kiosk/device_authorization");
  } catch (err) {
    if (refusedWith(err, "station_held")) return "held";
    return status(err) === 403 ? "not_recognised" : "unavailable";
  }
}

/**
 * One poll of the token endpoint (RFC 8628 §3.4): the exam to open, or the
 * RFC's word for why not. A network failure is `authorization_pending`: the
 * station just polls again.
 */
export async function pollToken(
  deviceCode: string,
): Promise<{ redirect: string } | { error: string }> {
  try {
    return await post<KioskTokenApproved>("/app/api/kiosk/token", {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
    } satisfies KioskTokenRequest);
  } catch (err) {
    if (!(err instanceof ApiError)) return { error: "authorization_pending" };
    if (err.status === 403) return { error: "not_recognised" };
    return { error: refusalCodeOf(err) ?? "authorization_pending" };
  }
}
