import { describe, expect, it } from "vitest";

import { INVITATION_EXPIRY_MS, latestGrant, repoAccessState } from "./repoAccess.js";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 24 * 3_600_000;

describe("repoAccessState (F-PROJ-07, ADR-070 amendment of 2026-11-19)", () => {
  it("is unlinked without a live grant", () => {
    expect(repoAccessState(null, NOW)).toBe("unlinked");
  });

  it("is joined once GitHub said the account is a collaborator, whatever the age or a check", () => {
    expect(repoAccessState({ invitedAt: ago(30 * DAY), acceptedAt: ago(DAY), absentAt: null }, NOW)).toBe("joined");
    expect(repoAccessState({ invitedAt: ago(DAY), acceptedAt: ago(DAY), absentAt: ago(DAY) }, NOW)).toBe("joined");
  });

  it("is pending while the invitation is younger than seven days, even found gone (declined)", () => {
    expect(repoAccessState({ invitedAt: ago(DAY), acceptedAt: null, absentAt: null }, NOW)).toBe("pending");
    expect(repoAccessState({ invitedAt: ago(INVITATION_EXPIRY_MS - 1), acceptedAt: null, absentAt: ago(0) }, NOW)).toBe("pending");
  });

  it("is never expired without a check that found the account gone", () => {
    expect(repoAccessState({ invitedAt: ago(30 * DAY), acceptedAt: null, absentAt: null }, NOW)).toBe("pending");
  });

  it("is expired seven days after the invitation once a check found it gone", () => {
    expect(repoAccessState({ invitedAt: ago(INVITATION_EXPIRY_MS), acceptedAt: null, absentAt: ago(0) }, NOW)).toBe("expired");
    expect(repoAccessState({ invitedAt: ago(9 * DAY), acceptedAt: null, absentAt: ago(DAY) }, NOW)).toBe("expired");
  });
});

describe("latestGrant", () => {
  it("picks the last invited, or null", () => {
    expect(latestGrant([])).toBeNull();
    const a = { id: "a", invitedAt: ago(2 * DAY) };
    const b = { id: "b", invitedAt: ago(DAY) };
    expect(latestGrant([a, b])).toBe(b);
    expect(latestGrant([b, a])).toBe(b);
  });
});
