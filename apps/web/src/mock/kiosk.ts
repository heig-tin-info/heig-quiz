/**
 * 10. The kiosk stations (ADR-051 §5): the admin's registry and what a
 * station knows of itself. The stations are the school's Chromebooks; one
 * attested this morning and waits for a name, one is retired.
 *
 * `?empty=1`: no station has ever attested.
 */
import type {
  KioskDevice,
  KioskDeviceAuthorization,
  KioskDevicePatch,
  KioskStation,
  PairApproved,
  PairPreview,
} from "@quiz/contracts";
import { generateUserCode, normalizeUserCode } from "@quiz/domain";

import { D, flags, H, iso, MockError, MockPayload, on, rand } from "./runtime";
import { STUDENT_EVAL } from "./student";

const devices: KioskDevice[] = flags.empty
  ? []
  : [
      {
        id: "5cd3281a-0c1e-4a71-9b02-3f6d1e8a0001",
        googleDeviceId: "5CD3281JXQ",
        label: null,
        status: "unnamed",
        attestedAt: iso(-2 * H),
        checkedAt: iso(-2 * H),
        attestation: "ok",
      },
      {
        id: "5cd2417b-7d2c-4e58-8a13-9c4b2f7e0007",
        googleDeviceId: "5CD2417KLM",
        label: "Poste de secours n° 7",
        status: "active",
        attestedAt: iso(-20 * 60_000),
        checkedAt: iso(-20 * 60_000),
        attestation: "ok",
      },
      {
        id: "5cd2417c-1a9f-4b36-8c24-6e0d3a5b0008",
        googleDeviceId: "5CD2417KLP",
        label: "Poste de secours n° 8",
        status: "active",
        attestedAt: iso(-3 * D),
        checkedAt: iso(-5 * 60_000),
        attestation: "unavailable",
      },
      {
        id: "9e7a41d0-3b82-4f15-9d46-2c8e7f1a0003",
        googleDeviceId: "NXHQEEZ001",
        label: "Ancien poste B03",
        status: "retired",
        attestedAt: iso(-40 * D),
        checkedAt: iso(-40 * D),
        attestation: "refused",
      },
    ];

const RANK = { unnamed: 0, active: 1, retired: 2 } as const;

on("GET", "/app/api/admin/kiosk-devices", () =>
  [...devices].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || (a.label ?? "").localeCompare(b.label ?? ""),
  ),
);

on("PATCH", "/app/api/admin/kiosk-devices/:id", (m, body) => {
  const device = devices.find((d) => d.id === m.groups!.id);
  if (!device) throw new MockError(404, "Not found");
  const patch = body as KioskDevicePatch;
  const label = patch.label?.trim() ?? device.label;
  const status =
    patch.status ?? (device.status === "unnamed" && patch.label !== undefined ? "active" : device.status);
  if (status === "active" && !label) throw new MockError(409, "A station is named before it is active");
  Object.assign(device, { label, status });
  return device;
});

// The station's side (ADR-051 §5): the mock is always station n° 7.
on("POST", "/app/api/kiosk/attest/challenge", () => ({ challenge: "bW9jay1jaGFsbGVuZ2U=" }));
on("POST", "/app/api/kiosk/attest/verify", () => ({ station: station() }));
on("GET", "/app/api/kiosk/station", () => station());

function station(): KioskStation {
  const d = devices.find((x) => x.status === "active");
  if (!d) throw new MockError(404, "Not found");
  return { label: d.label, status: d.status };
}

// --- The pairing (ADR-051 §7) ---------------------------------------------------
//
// The station (`/kiosk`) and the phone (`/pair`) are two tabs, and each tab
// runs its own mock: the one pending pairing lives in `localStorage`, which
// both read. Approve on `/pair` and the station's next poll opens the exam.

const PAIRING_KEY = "quiz-mock-kiosk-pairing";

interface MockPairing {
  deviceCode: string;
  userCode: string;
  expiresAt: number;
  state: "pending" | "approved" | "consumed";
  evaluationId: string | null;
}

function readPairing(): MockPairing | null {
  try {
    const raw = localStorage.getItem(PAIRING_KEY);
    return raw ? (JSON.parse(raw) as MockPairing) : null;
  } catch {
    return null;
  }
}

function writePairing(p: MockPairing) {
  try {
    localStorage.setItem(PAIRING_KEY, JSON.stringify(p));
  } catch {
    // A private window: the mock pairs within one tab only.
  }
}

const refusal = (status: number, error: string) => new MockPayload(status, { error });

on("POST", "/app/api/kiosk/device_authorization", (): KioskDeviceAuthorization => {
  const d = devices.find((x) => x.status === "active");
  if (!d?.label) throw refusal(403, "not_recognised");
  const userCode = generateUserCode((n) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256)));
  const deviceCode = `mock-device-${Date.now()}`;
  writePairing({ deviceCode, userCode, expiresAt: Date.now() + 300_000, state: "pending", evaluationId: null });
  const uri = `${window.location.origin}/pair`;
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: uri,
    verification_uri_complete: `${uri}?code=${userCode}`,
    expires_in: 300,
    interval: 2,
    label: d.label,
  };
});

on("POST", "/app/api/kiosk/token", (_m, body) => {
  const p = readPairing();
  if (!p || p.deviceCode !== body.device_code) throw refusal(400, "invalid_grant");
  if (Date.now() >= p.expiresAt) throw refusal(400, "expired_token");
  if (p.state === "consumed") throw refusal(400, "access_denied");
  if (p.state === "pending") throw refusal(400, "authorization_pending");
  writePairing({ ...p, state: "consumed" });
  return { redirect: `/take/${p.evaluationId}` };
});

/** The pending pairing `code` names, or the 404 a wrong code gets. */
function pending(code: string): MockPairing {
  const p = readPairing();
  if (!p || p.state !== "pending" || Date.now() >= p.expiresAt || normalizeUserCode(code) !== p.userCode) {
    throw refusal(404, "pairing_not_found");
  }
  return p;
}

/** The station the phone pairs with: n° 7, even under `?empty=1`, which empties the registry. */
const pairedLabel = () => devices.find((x) => x.status === "active")?.label ?? "Poste de secours n° 7";

/** The exam the student can start on a station; `?empty=1`: none. */
const pairable = (): PairPreview["evaluations"] =>
  flags.empty
    ? []
    : [
        {
          id: STUDENT_EVAL,
          title: "Quiz 3 — Pointeurs et lois fondamentales",
          classroomName: "PRG1-2026",
          courseCode: "PRG1",
        },
      ];

on("GET", "/app/api/pair/:code", (m): PairPreview => {
  pending(decodeURIComponent(m.groups!.code!));
  return { station: { label: pairedLabel() }, evaluations: pairable() };
});

on("POST", "/app/api/pair", (_m, body): PairApproved => {
  const p = pending(String(body.code ?? ""));
  if (!pairable().some((e) => e.id === body.evaluationId)) throw refusal(409, "evaluation_not_pairable");
  writePairing({ ...p, state: "approved", evaluationId: String(body.evaluationId) });
  return { station: { label: pairedLabel() } };
});

// The supervisor's fallback (ADR-051 §7): the pending code, approved for a
// student of the evaluation. `?empty=1` has no station showing one.
on("POST", "/app/api/evaluations/:id/kiosk-assign", (_m, body): PairApproved => {
  const p = pending(String(body.userCode ?? ""));
  writePairing({ ...p, state: "approved", evaluationId: STUDENT_EVAL });
  return { station: { label: pairedLabel() } };
});
