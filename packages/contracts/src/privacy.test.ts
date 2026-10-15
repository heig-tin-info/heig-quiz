import { describe, expect, it } from "vitest";

import { PersonalDataExport } from "./privacy.js";

const empty = {
  version: 1,
  generatedAt: "2026-10-15T09:00:00.000Z",
  account: {
    id: "0199e5a0-0000-7000-8000-000000000001",
    email: "alice@heig.test",
    givenName: "Alice",
    familyName: "Martin",
    role: "student",
    lastLoginAt: null,
    avatarUrl: null,
    hasUploadedAvatar: false,
    locale: null,
    dateFormat: null,
    mcqPolicy: null,
    coach: { enabled: null, seen: [] },
    rpnCalculator: null,
  },
  emails: [],
  github: null,
  activity: { hours: [], lastActiveAt: null },
  classrooms: [],
  grades: [],
  feedback: [],
  projects: [],
  drill: { classrooms: [], calibration: [] },
};

describe("PersonalDataExport (ADR-112 §9)", () => {
  it("strips a field beyond the contract: a session never travels in the file", () => {
    const parsed = PersonalDataExport.parse({
      ...empty,
      account: { ...empty.account, session: { kind: "portal" } },
      staffNote: "never",
    });
    expect(parsed.account).not.toHaveProperty("session");
    expect(parsed).not.toHaveProperty("staffNote");
  });

  it("refuses another version", () => {
    expect(PersonalDataExport.safeParse({ ...empty, version: 2 }).success).toBe(false);
  });
});
