import { describe, expect, it } from "vitest";

import { ContestationConfirmBody, ContestationProposalView, StaffContestation, StudentContestation } from "./contestation.js";
import { ContestationProposalBody, ContestationResolveBody } from "./grading.js";
import { OAuthDecision } from "./oauth.js";
import { ProjectContestationResolveBody, ProjectStaffContestation, ProjectStudentContestation } from "./project.js";
import { ApiTokenCreate } from "./tokens.js";

/*
 * An assistant's proposals on contestations (ADR-139 §14): every answer's
 * body refuses with the domain's code, the student's schemas carry no
 * proposal, the owner confirms the proposal they read, a consent says what
 * it showed.
 */
const AT = "2026-11-20T10:00:00.000Z";
const ACCEPTED = { part: "b0", answer: "1", scope: "everyone" } as const;
const issues = (result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => ({ message: i.message, path: i.path })) ?? [];

describe("every answer's body refuses with the domain's code", () => {
  it.each([
    ["an exam's answer", ContestationResolveBody],
    ["an exam's proposal", ContestationProposalBody],
    ["a project's answer and proposal", ProjectContestationResolveBody],
  ])("%s", (_name, schema) => {
    expect(schema.safeParse({ verdict: "accepted" }).success).toBe(true);
    expect(schema.safeParse({ verdict: "accepted", points: 1, reply: "Oui." }).success).toBe(true);
    expect(issues(schema.safeParse({ verdict: "refused" }))).toEqual([{ message: "unexplained", path: ["reply"] }]);
    expect(issues(schema.safeParse({ verdict: "accepted", points: 1, reply: " " }))).toEqual([{ message: "unexplained", path: ["reply"] }]);
    expect(issues(schema.safeParse({ verdict: "refused", reply: "Non.", points: 1 }))).toEqual([{ message: "refusal_with_points", path: [] }]);
  });

  it("an exam's proposal: an accepted answer, never with points nor a refusal; the answer's criteria count as points", () => {
    expect(ContestationProposalBody.safeParse({ verdict: "accepted", accepted: ACCEPTED }).success).toBe(true);
    expect(issues(ContestationProposalBody.safeParse({ verdict: "refused", reply: "Non.", accepted: ACCEPTED }))).toEqual([
      { message: "refusal_with_acceptance", path: [] },
    ]);
    expect(issues(ContestationProposalBody.safeParse({ verdict: "accepted", reply: "Oui.", points: 1, accepted: ACCEPTED }))).toEqual([
      { message: "points_and_acceptance", path: [] },
    ]);
    expect(ContestationProposalBody.safeParse({ verdict: "accepted", accepted: { ...ACCEPTED, scope: "class" } }).success).toBe(false);
    expect(ContestationProposalBody.safeParse({ verdict: "accepted", criteria: [] }).success).toBe(false);
    expect(issues(ContestationResolveBody.safeParse({ verdict: "refused", reply: "Non.", criteria: [{ id: "c1", points: 1 }] }))).toEqual([
      { message: "refusal_with_points", path: [] },
    ]);
  });

  it("a project's: a rationale goes with points", () => {
    expect(issues(ProjectContestationResolveBody.safeParse({ verdict: "accepted", rationale: "x" }))).toEqual([
      { message: "a rationale goes with new points", path: ["rationale"] },
    ]);
  });
});

describe("a proposal stays the staff's", () => {
  const proposal = { verdict: "accepted", reply: "", points: 1, rationale: null, accepted: null, proposedAt: AT, stale: false, affected: null };
  const student = { state: "open", reason: "r", filedAt: AT, reply: null, resolvedAt: null };

  it("travels on the staff's contestations, nullable, and on no student's", () => {
    expect(ContestationProposalView.safeParse(proposal).success).toBe(true);
    const staff = { ...student, id: "11111111-1111-4111-8111-111111111111", counted: true };
    expect(StaffContestation.safeParse({ ...staff, proposal: null }).success).toBe(true);
    expect(StaffContestation.safeParse({ ...staff, proposal }).success).toBe(true);
    expect("proposal" in StudentContestation.shape).toBe(false);
    expect("proposal" in ProjectStudentContestation.shape).toBe(false);
    expect("proposal" in ProjectStaffContestation.shape).toBe(true);
  });
});

describe("the owner confirms the proposal they read", () => {
  it("names its instant, and nothing else", () => {
    expect(ContestationConfirmBody.parse({ proposedAt: AT })).toEqual({ proposedAt: AT });
    expect(ContestationConfirmBody.safeParse({}).success).toBe(false);
    expect(ContestationConfirmBody.safeParse({ proposedAt: AT, verdict: "accepted" }).success).toBe(false);
  });
});

describe("a consent says which revision it showed", () => {
  it("as an approval and a token's creation, optional for an older page", () => {
    expect(OAuthDecision.parse({ approve: true })).toEqual({ approve: true });
    expect(OAuthDecision.parse({ approve: true, consentRevision: 2 })).toEqual({ approve: true, consentRevision: 2 });
    expect(OAuthDecision.safeParse({ approve: true, consentRevision: 0 }).success).toBe(false);
    expect(ApiTokenCreate.parse({ name: "t", consentRevision: 2 })).toMatchObject({ consentRevision: 2 });
    expect(ApiTokenCreate.parse({ name: "t" }).consentRevision).toBeUndefined();
  });
});
