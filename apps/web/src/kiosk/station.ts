/**
 * The station's side of ADR-051, without React: the attestation through the
 * companion extension (§5) and the pairing (§7, RFC 8628). `useKioskStation`
 * runs them in a loop; each step answers what the screen should show next.
 */
import {
  DEVICE_CODE_GRANT,
  type KioskAttested,
  type KioskChallenge,
  type KioskDeviceAuthorization,
  type KioskTokenApproved,
  type PublicConfig,
} from "@quiz/contracts";

import { ApiError, api } from "../api";
import { readStored, writeStored } from "../ui/state";

/** Why a station cannot show a code: not in the registry (or not named), or the platform is out of reach. */
export type StationTrouble = "unrecognised" | "unavailable";

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
): Promise<{ response: string } | { error: string }> {
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
 * One attestation: a challenge, the extension's answer, the verdict. Null
 * when the station is attested and `active`; otherwise what to show.
 */
export async function attest(kiosk: PublicConfig["kiosk"]): Promise<StationTrouble | null> {
  if (!kiosk) return "unavailable";
  try {
    const { challenge } = await post<KioskChallenge>("/app/api/kiosk/attest/challenge");
    const verdict = await post<KioskAttested>("/app/api/kiosk/attest/verify", await attestationOf(kiosk, challenge));
    return verdict.station.status === "active" ? null : "unrecognised";
  } catch (err) {
    return status(err) === 403 ? "unrecognised" : "unavailable";
  }
}

// --- The pairing ---------------------------------------------------------------

/** A new code for the station, or why there is none. */
export async function authorize(): Promise<KioskDeviceAuthorization | StationTrouble> {
  try {
    return await post<KioskDeviceAuthorization>("/app/api/kiosk/device_authorization");
  } catch (err) {
    return status(err) === 403 ? "unrecognised" : "unavailable";
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
    });
  } catch (err) {
    if (!(err instanceof ApiError)) return { error: "authorization_pending" };
    if (err.status === 403) return { error: "not_recognised" };
    return { error: (err.body as { error?: string } | null)?.error ?? "authorization_pending" };
  }
}
