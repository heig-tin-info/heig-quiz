/**
 * The drill's hooks are wired where the application is built (ADR-041 §1),
 * never by the side effect of an import. This file imports nothing that
 * registers them — not `test/db.ts` — so the only registration it can see
 * is `buildApp`'s.
 */
import { describe, expect, it } from "vitest";

import { testServer } from "../../test/http.js";
import { hasAttemptsEndedListener } from "../live/service.js";
import { hasResultsReleasedListener } from "../results/service.js";
import { cardsAtHandIn, cardsAtRelease } from "./lifecycle.js";

describe("buildApp", () => {
  it("registers the drill on the release and on the end of an attempt", async () => {
    expect(hasResultsReleasedListener(cardsAtRelease)).toBe(false);
    expect(hasAttemptsEndedListener(cardsAtHandIn)).toBe(false);
    const server = await testServer();
    try {
      expect(hasResultsReleasedListener(cardsAtRelease)).toBe(true);
      expect(hasAttemptsEndedListener(cardsAtHandIn)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
