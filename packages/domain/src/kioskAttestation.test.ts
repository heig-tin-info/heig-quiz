import { describe, expect, it } from "vitest";

import {
  KIOSK_FRESH_MS,
  KIOSK_SILENT_AFTER_MS,
  kioskAttestationState,
  kioskCheckFresh,
  kioskSuspends,
  kioskTransition,
  kioskWatchOf,
  type KioskCheck,
} from "./kioskAttestation.js";

const now = new Date("2026-09-30T10:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const check = (attestation: KioskCheck["attestation"], ms: number): KioskCheck => ({
  attestation,
  checkedAt: ago(ms),
});

describe("kioskAttestationState (ADR-051 §6)", () => {
  it("reads the last attempt while it is recent", () => {
    expect(kioskAttestationState(check("ok", 0), now)).toBe("ok");
    expect(kioskAttestationState(check("unavailable", 60_000), now)).toBe("unavailable");
    expect(kioskAttestationState(check("refused", 60_000), now)).toBe("refused");
  });

  it("is silent from twelve minutes without an attempt, whatever it said", () => {
    expect(kioskAttestationState(check("ok", KIOSK_SILENT_AFTER_MS - 1), now)).toBe("ok");
    for (const a of ["ok", "unavailable", "refused"] as const) {
      expect(kioskAttestationState(check(a, KIOSK_SILENT_AFTER_MS), now)).toBe("silent");
    }
  });

  it("is silent for a station that never attempted", () => {
    expect(kioskAttestationState({ attestation: null, checkedAt: null }, now)).toBe("silent");
    expect(kioskAttestationState({ attestation: "ok", checkedAt: null }, now)).toBe("silent");
  });
});

describe("kioskSuspends", () => {
  it("suspends refused and silent, never unavailable", () => {
    expect(kioskSuspends("refused")).toBe(true);
    expect(kioskSuspends("silent")).toBe(true);
    expect(kioskSuspends("unavailable")).toBe(false);
    expect(kioskSuspends("ok")).toBe(false);
  });
});

describe("kioskCheckFresh (the submit)", () => {
  it("wants ok or unavailable, younger than two minutes", () => {
    expect(kioskCheckFresh(check("ok", KIOSK_FRESH_MS - 1), now)).toBe(true);
    expect(kioskCheckFresh(check("unavailable", 0), now)).toBe(true);
    expect(kioskCheckFresh(check("ok", KIOSK_FRESH_MS), now)).toBe(false);
    expect(kioskCheckFresh(check("refused", 0), now)).toBe(false);
    expect(kioskCheckFresh({ attestation: null, checkedAt: null }, now)).toBe(false);
  });
});

describe("kioskTransition (what the supervisor is told)", () => {
  it("says nothing when nothing changed", () => {
    for (const w of ["ok", "unavailable", "suspended"] as const) {
      expect(kioskTransition(w, w)).toEqual({ suspension: null, alert: null });
    }
  });

  it("suspends, and lifts the suspension by itself", () => {
    expect(kioskTransition("ok", "suspended")).toEqual({ suspension: "suspended", alert: "kiosk_suspended" });
    expect(kioskTransition("unavailable", "suspended")).toEqual({
      suspension: "suspended",
      alert: "kiosk_suspended",
    });
    expect(kioskTransition("suspended", "ok")).toEqual({ suspension: "resumed", alert: "kiosk_resumed" });
  });

  it("alerts on an outage without suspending, and clears it", () => {
    expect(kioskTransition("ok", "unavailable")).toEqual({ suspension: null, alert: "kiosk_unavailable" });
    expect(kioskTransition("unavailable", "ok")).toEqual({ suspension: null, alert: "kiosk_resumed" });
    expect(kioskTransition("suspended", "unavailable")).toEqual({
      suspension: "resumed",
      alert: "kiosk_unavailable",
    });
  });

  it("maps a state to what the supervisor sees", () => {
    expect(kioskWatchOf("silent")).toBe("suspended");
    expect(kioskWatchOf("refused")).toBe("suspended");
    expect(kioskWatchOf("unavailable")).toBe("unavailable");
    expect(kioskWatchOf("ok")).toBe("ok");
  });
});
