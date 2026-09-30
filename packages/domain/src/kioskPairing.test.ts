import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PAIRING_STATES,
  USER_CODE_ALPHABET,
  formatUserCode,
  generateUserCode,
  normalizeUserCode,
  pairingStateAt,
  pairingTransition,
  pollAnswer,
  type PairingEvent,
} from "./kioskPairing.js";

/** A source that hands out `bytes` in order, in batches of whatever size is asked for. */
function scripted(bytes: number[]) {
  let at = 0;
  const asked: number[] = [];
  const source = (n: number) => {
    asked.push(n);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = bytes[at++] ?? 0;
    return out;
  };
  return { source, asked };
}

describe("the user code", () => {
  it("has no vowel and none of 0 O 1 I L", () => {
    expect(USER_CODE_ALPHABET).toHaveLength(27);
    for (const ch of "AEIOUYL01") expect(USER_CODE_ALPHABET).not.toContain(ch);
    expect(new Set(USER_CODE_ALPHABET).size).toBe(USER_CODE_ALPHABET.length);
  });

  it("is XXXX-XXXX on the alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateUserCode((n) => randomBytes(n));
      expect(code).toMatch(/^[BCDFGHJKMNPQRSTVWXZ2-9]{4}-[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/);
    }
  });

  it("maps a byte to a symbol by its remainder, and never takes one from the biased tail", () => {
    // 243..255 would favour the first 13 symbols: they are skipped.
    const { source } = scripted([0, 243, 255, 1, 26, 27, 250, 28, 53, 242]);
    expect(generateUserCode(source)).toBe("BC9B-C99B");
  });

  it("asks for more bytes when a whole batch was thrown away", () => {
    const { source, asked } = scripted([...Array(16).fill(255), 0, 1, 2, 3, 4, 5, 6, 7]);
    expect(generateUserCode(source)).toBe("BCDF-GHJK");
    expect(asked).toEqual([16, 16]);
  });

  it("normalizes what a student types", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
    expect(normalizeUserCode(" bc df  gh-jk ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDF--GHJK")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("-BCDF-GHJK-")).toBe("BCDF-GHJK");
  });

  it("is shaped as it is typed", () => {
    expect(formatUserCode("bcdf")).toBe("BCDF");
    expect(formatUserCode("bcdfg")).toBe("BCDF-G");
    expect(formatUserCode(" bc df-gh jk xx")).toBe("BCDF-GHJK");
  });

  it("refuses what cannot be a code", () => {
    for (const bad of ["", "BCDF-GHJ", "BCDF-GHJKM", "ABCD-EFGH", "BCDF-GHJ0", "BCDF_GHJK", "BCDF-GHJé"]) {
      expect(normalizeUserCode(bad), bad).toBeNull();
    }
  });
});

describe("the state machine", () => {
  const events: PairingEvent[] = ["approve", "consume", "expire"];
  const legal: Record<string, string> = {
    "pending approve": "approved",
    "pending expire": "expired",
    "approved consume": "consumed",
    "approved expire": "expired",
  };

  it("allows exactly pending → approved → consumed, and expiry from the two live states", () => {
    for (const state of PAIRING_STATES) {
      for (const event of events) {
        expect(pairingTransition(state, event), `${state} ${event}`).toBe(legal[`${state} ${event}`] ?? null);
      }
    }
  });

  it("expires a live pairing once its time is up, and leaves a finished one as it is", () => {
    const expiresAt = new Date("2026-09-30T10:05:00Z");
    const before = new Date("2026-09-30T10:04:59Z");
    expect(pairingStateAt("pending", expiresAt, before)).toBe("pending");
    expect(pairingStateAt("pending", expiresAt, expiresAt)).toBe("expired");
    expect(pairingStateAt("approved", expiresAt, expiresAt)).toBe("expired");
    expect(pairingStateAt("consumed", expiresAt, expiresAt)).toBe("consumed");
    expect(pairingStateAt("expired", expiresAt, before)).toBe("expired");
  });
});

describe("the answer to a station's poll (RFC 8628 §3.5)", () => {
  const t0 = new Date("2026-09-30T10:00:00Z");
  const at = (s: number) => new Date(t0.getTime() + s * 1000);
  const base = { state: "pending" as const, expiresAt: at(300), lastPollAt: null, interval: 2 };

  it("is pending on the first poll, and on one that waited the interval", () => {
    expect(pollAnswer({ ...base, now: at(1) })).toEqual({ outcome: "authorization_pending", interval: 2 });
    expect(pollAnswer({ ...base, lastPollAt: at(1), now: at(3) })).toEqual({
      outcome: "authorization_pending",
      interval: 2,
    });
  });

  it("slows a station down by five seconds when it polls too fast", () => {
    expect(pollAnswer({ ...base, lastPollAt: at(1), now: at(2) })).toEqual({ outcome: "slow_down", interval: 7 });
    expect(pollAnswer({ ...base, interval: 7, lastPollAt: at(2), now: at(8) })).toEqual({
      outcome: "slow_down",
      interval: 12,
    });
  });

  it("hands out an approved pairing however fast it is asked", () => {
    expect(pollAnswer({ ...base, state: "approved", lastPollAt: at(1), now: at(1) })).toEqual({
      outcome: "approved",
      interval: 2,
    });
  });

  it("says expired once the time is up, and denies a pairing already consumed", () => {
    expect(pollAnswer({ ...base, now: at(300) }).outcome).toBe("expired_token");
    expect(pollAnswer({ ...base, state: "approved", now: at(301) }).outcome).toBe("expired_token");
    expect(pollAnswer({ ...base, state: "expired", now: at(1) }).outcome).toBe("expired_token");
    expect(pollAnswer({ ...base, state: "consumed", now: at(1) }).outcome).toBe("access_denied");
  });
});
