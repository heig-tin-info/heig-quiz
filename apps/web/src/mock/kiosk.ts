/**
 * 10. The kiosk stations (ADR-051 §5): the admin's registry and what a
 * station knows of itself. The stations are the school's Chromebooks; one
 * attested this morning and waits for a name, one is retired.
 *
 * `?empty=1`: no station has ever attested.
 */
import type { KioskDevice, KioskDevicePatch, KioskStation } from "@quiz/contracts";

import { D, flags, H, iso, MockError, on } from "./runtime";

const devices: KioskDevice[] = flags.empty
  ? []
  : [
      {
        id: "33333333-3333-4333-8333-000000000001",
        googleDeviceId: "5CD3281JXQ",
        label: null,
        status: "unnamed",
        attestedAt: iso(-2 * H),
        checkedAt: iso(-2 * H),
        attestation: "ok",
      },
      {
        id: "33333333-3333-4333-8333-000000000007",
        googleDeviceId: "5CD2417KLM",
        label: "Poste de secours n° 7",
        status: "active",
        attestedAt: iso(-20 * 60_000),
        checkedAt: iso(-20 * 60_000),
        attestation: "ok",
      },
      {
        id: "33333333-3333-4333-8333-000000000008",
        googleDeviceId: "5CD2417KLP",
        label: "Poste de secours n° 8",
        status: "active",
        attestedAt: iso(-3 * D),
        checkedAt: iso(-5 * 60_000),
        attestation: "unavailable",
      },
      {
        id: "33333333-3333-4333-8333-000000000003",
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

// The station's side, for the `/kiosk` page to come (ADR-051 step 6): the
// mock is always station n° 7.
on("POST", "/app/api/kiosk/attest/challenge", () => ({ challenge: "bW9jay1jaGFsbGVuZ2U=" }));
on("POST", "/app/api/kiosk/attest/verify", () => ({ station: station() }));
on("GET", "/app/api/kiosk/station", () => station());

function station(): KioskStation {
  const d = devices.find((x) => x.status === "active");
  if (!d) throw new MockError(404, "Not found");
  return { label: d.label, status: d.status };
}
