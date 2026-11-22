import { describe, expect, it } from "vitest";

import { attemptVerdict, mayAskAgain, REDELIVERY_ASK_WINDOW_MS, REDELIVERY_MAX_ASKS } from "./webhookRedelivery.js";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("attemptVerdict", () => {
  it("reads a 2xx as delivered", () => {
    expect(attemptVerdict(200)).toBe("delivered");
    expect(attemptVerdict(204)).toBe("delivered");
  });

  it("retries no answer, an overload and a server failure", () => {
    expect(attemptVerdict(0)).toBe("retry");
    expect(attemptVerdict(429)).toBe("retry");
    expect(attemptVerdict(500)).toBe("retry");
    expect(attemptVerdict(502)).toBe("retry");
    expect(attemptVerdict(504)).toBe("retry");
  });

  it("takes any other answer as a refusal, never asked again", () => {
    expect(attemptVerdict(400)).toBe("refused");
    expect(attemptVerdict(401)).toBe("refused");
    expect(attemptVerdict(413)).toBe("refused");
    expect(attemptVerdict(302)).toBe("refused");
  });
});

describe("mayAskAgain", () => {
  it("asks a delivery never asked", () => {
    expect(mayAskAgain(undefined, NOW)).toBe(true);
  });

  it("asks again under three asks within a day of the first", () => {
    expect(mayAskAgain({ asks: 1, firstAskedAt: ago(15 * 60_000), refusedAt: null }, NOW)).toBe(true);
    expect(mayAskAgain({ asks: REDELIVERY_MAX_ASKS - 1, firstAskedAt: ago(REDELIVERY_ASK_WINDOW_MS - 1), refusedAt: null }, NOW)).toBe(true);
  });

  it("stops at three asks, a day after the first, or once refused", () => {
    expect(mayAskAgain({ asks: REDELIVERY_MAX_ASKS, firstAskedAt: ago(60_000), refusedAt: null }, NOW)).toBe(false);
    expect(mayAskAgain({ asks: 1, firstAskedAt: ago(REDELIVERY_ASK_WINDOW_MS), refusedAt: null }, NOW)).toBe(false);
    expect(mayAskAgain({ asks: 0, firstAskedAt: ago(60_000), refusedAt: ago(60_000) }, NOW)).toBe(false);
  });
});
