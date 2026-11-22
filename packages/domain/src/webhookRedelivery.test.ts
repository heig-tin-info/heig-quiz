import { describe, expect, it } from "vitest";

import { attemptVerdict, nextAskAt, REDELIVERY_BACKOFF_MS, REDELIVERY_SLACK_MS, REDELIVERY_WINDOW_MS } from "./webhookRedelivery.js";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const MINUTE = 60_000;

describe("attemptVerdict", () => {
  it("reads a 2xx as delivered", () => {
    expect(attemptVerdict(200)).toBe("delivered");
    expect(attemptVerdict(204)).toBe("delivered");
  });

  it("refuses only a payload too large or unprocessable", () => {
    expect(attemptVerdict(413)).toBe("refused");
    expect(attemptVerdict(422)).toBe("refused");
  });

  it("retries everything else: no answer, a server failure, and the 4xx a deploy or a secret rotation answers", () => {
    for (const status of [0, 400, 401, 403, 404, 408, 429, 500, 502, 503, 504, 302]) expect(attemptVerdict(status)).toBe("retry");
  });
});

describe("nextAskAt", () => {
  it("waits 15 minutes after the first ask, then doubles, less a minute of slack", () => {
    const wait = (asks: number) => (nextAskAt(asks, NOW).getTime() - NOW.getTime() + REDELIVERY_SLACK_MS) / MINUTE;
    expect([1, 2, 3, 4, 5, 6, 7].map(wait)).toEqual([15, 30, 60, 120, 240, 480, 960]);
    expect(nextAskAt(0, NOW).getTime()).toBe(NOW.getTime() + REDELIVERY_BACKOFF_MS - REDELIVERY_SLACK_MS);
  });

  it("asks about seven times within the window, the last some 16 hours after the first", () => {
    let at = NOW;
    let asks = 1;
    while (true) {
      const next = nextAskAt(asks, at);
      if (next.getTime() - NOW.getTime() >= REDELIVERY_WINDOW_MS) break;
      at = next;
      asks += 1;
    }
    expect(asks).toBe(7);
    expect((at.getTime() - NOW.getTime()) / 3_600_000).toBeGreaterThan(15);
  });
});
