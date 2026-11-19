import { describe, expect, it } from "vitest";

import { repoAccessState } from "./repoAccess.js";

const AT = new Date("2026-11-19T12:00:00.000Z");

describe("repoAccessState (F-PROJ-07, ADR-070 amendment of 2026-11-19)", () => {
  it("is unlinked without a live grant", () => {
    expect(repoAccessState(null)).toBe("unlinked");
  });

  it("is joined once GitHub said the account is a collaborator, whatever a check said", () => {
    expect(repoAccessState({ acceptedAt: AT, absentAt: null })).toBe("joined");
    expect(repoAccessState({ acceptedAt: AT, absentAt: AT })).toBe("joined");
  });

  it("is pending while no check found the invitation gone", () => {
    expect(repoAccessState({ acceptedAt: null, absentAt: null })).toBe("pending");
  });

  it("is expired once a check found the account neither in nor invited", () => {
    expect(repoAccessState({ acceptedAt: null, absentAt: AT })).toBe("expired");
  });
});
