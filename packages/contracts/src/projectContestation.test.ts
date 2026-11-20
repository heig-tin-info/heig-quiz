/**
 * The contracts of a project criterion's contestation (ADR-139 §13): the
 * window's days, the members' and the staff's readings, the owner's answer
 * and its refinements, the routes' params, the two notification kinds.
 */
import { describe, expect, it } from "vitest";

import { ContestationDays } from "./contestation.js";
import { NotificationPayload } from "./notifications.js";
import {
  ProjectContestationParams,
  ProjectContestationResolution,
  ProjectContestationResolveBody,
  ProjectContestations,
  ProjectErrorCode,
  ProjectPatch,
  ProjectStaffContestation,
  ProjectStudentContestation,
  ProjectStudentCriterionParams,
  StudentCriteriaRow,
} from "./project.js";

const ID = "0190d3c4-0000-7000-8000-000000000001";
const REPO = "0190d3c4-0000-7000-8000-000000000002";
const AT = "2026-11-20T10:00:00.000Z";

const member = {
  state: "open",
  reason: "Test 3 is flaky.",
  filedAt: AT,
  reply: null,
  resolvedAt: null,
  criterionId: "rendu.tests",
  criterionDescription: "Tests",
  pointsAtFiling: 8,
  maxAtFiling: 10,
  bonusAtFiling: null,
} as const;
const staff = { ...member, id: ID, repoId: REPO, counted: true, inSnapshot: true, proposal: null };

describe("the window's days (ADR-139 §13)", () => {
  it("lie within 0 and 60, whole, and a patch may carry them alone", () => {
    for (const days of [0, 7, 60]) expect(ContestationDays.safeParse(days).success).toBe(true);
    for (const days of [-1, 61, 2.5]) expect(ContestationDays.safeParse(days).success).toBe(false);
    expect(ProjectPatch.parse({ contestationDays: 0 })).toEqual({ contestationDays: 0 });
    expect(ProjectPatch.safeParse({ contestationDays: 61 }).success).toBe(false);
  });
});

describe("the readings of a contestation", () => {
  it("give the members the criterion as it read at the filing, a bonus's points or none, never who filed it", () => {
    expect(ProjectStudentContestation.parse(member)).toEqual(member);
    const bonus = { ...member, criterionId: "rapport.extra", maxAtFiling: 0, bonusAtFiling: 1, pointsAtFiling: 0 };
    expect(ProjectStudentContestation.parse(bonus).bonusAtFiling).toBe(1);
    const answered = { ...member, state: "refused", reply: "No.", resolvedAt: AT };
    expect(ProjectStudentContestation.parse(answered)).toEqual(answered);
    expect(Object.keys(ProjectStudentContestation.parse({ ...member, filedBy: ID }))).not.toContain("filedBy");
    expect(ProjectStudentContestation.safeParse({ ...member, state: "withdrawn" }).success).toBe(false);
  });

  it("give the staff its id, its repository, whether it counts and whether its criterion is still in the snapshot", () => {
    expect(ProjectStaffContestation.parse(staff)).toEqual(staff);
    expect(ProjectStaffContestation.parse({ ...staff, counted: false, inSnapshot: false })).toMatchObject({ counted: false, inSnapshot: false });
    expect(ProjectStaffContestation.safeParse({ ...staff, repoId: "r1" }).success).toBe(false);
    const view = { applies: true, closesAt: AT, openByRepo: { [REPO]: 1 }, contestations: [staff] };
    expect(ProjectContestations.parse(view)).toEqual(view);
    const none = { applies: false, closesAt: null, openByRepo: {}, contestations: [] };
    expect(ProjectContestations.parse(none)).toEqual(none);
    // A repository is listed with a positive count only.
    expect(ProjectContestations.safeParse({ ...view, openByRepo: { [REPO]: 0 } }).success).toBe(false);
  });

  it("flags each criterion of the members' table contestable or not", () => {
    const row = { criterionId: "rendu.tests", section: "rendu", description: "Tests", max: 10, points: 8, state: "validated", locked: false };
    expect(StudentCriteriaRow.parse({ ...row, contestable: true }).contestable).toBe(true);
    expect(StudentCriteriaRow.safeParse(row).success).toBe(false);
  });
});

describe("the owner's answer (ADR-139 §13, decision 9)", () => {
  const ok = (body: object) => ProjectContestationResolveBody.safeParse(body).success;

  it("accepts a bare acceptance, a refusal with a reply, new points with a reply and an optional rationale", () => {
    expect(ProjectContestationResolveBody.parse({ verdict: "accepted" })).toEqual({ verdict: "accepted", reply: "" });
    expect(ok({ verdict: "refused", reply: "The log says otherwise." })).toBe(true);
    expect(ok({ verdict: "accepted", reply: "Test 3 was wrong.", points: 10 })).toBe(true);
    expect(ok({ verdict: "accepted", reply: "Test 3 was wrong.", points: -1, rationale: "Every test passes." })).toBe(true);
  });

  it("refuses a refusal without a reply, a refusal with points, new points without a reply, a rationale without points, an unknown key", () => {
    expect(ok({ verdict: "refused" })).toBe(false);
    expect(ok({ verdict: "refused", reply: "   " })).toBe(false);
    expect(ok({ verdict: "refused", reply: "No.", points: 2 })).toBe(false);
    expect(ok({ verdict: "accepted", points: 2 })).toBe(false);
    expect(ok({ verdict: "accepted", reply: "Yes.", rationale: "Why." })).toBe(false);
    expect(ok({ verdict: "accepted", criteria: {} })).toBe(false);
    expect(ok({ verdict: "accepted", reply: "x".repeat(2001) })).toBe(false);
    expect(ok({ verdict: "maybe", reply: "x" })).toBe(false);
  });

  it("answers the contestation as it stands, with the repository's entry only when points were written", () => {
    expect(ProjectContestationResolution.parse({ contestation: staff, repo: null })).toEqual({ contestation: staff, repo: null });
    expect(ProjectContestationResolution.safeParse({ contestation: staff }).success).toBe(false);
  });
});

describe("the routes' params and refusals", () => {
  it("name the project and the contestation, or the project and the criterion", () => {
    expect(ProjectContestationParams.parse({ id: ID, cid: REPO })).toEqual({ id: ID, cid: REPO });
    expect(ProjectContestationParams.safeParse({ id: ID, cid: "c1" }).success).toBe(false);
    expect(ProjectStudentCriterionParams.parse({ id: ID, criterionId: "rendu.tests" })).toEqual({ id: ID, criterionId: "rendu.tests" });
    expect(ProjectStudentCriterionParams.safeParse({ id: ID, criterionId: "" }).success).toBe(false);
    for (const code of ["contestation_closed", "contestation_exists", "not_contestable", "window_unavailable", "window_instant", "criterion_removed"]) {
      expect(ProjectErrorCode.safeParse(code).success, code).toBe(true);
    }
  });
});

describe("the two notification kinds (ADR-139 §13, F-NOTIF-17)", () => {
  it("carry the project's id and name, and a count for the staff's — never a reason, a verdict nor a reply", () => {
    const resolved = { kind: "project_contestation_resolved", projectId: ID, projectTitle: "Lab" };
    expect(NotificationPayload.parse({ ...resolved, verdict: "accepted", reply: "No." })).toEqual(resolved);
    const filed = { kind: "project_contestation_filed", projectId: ID, projectTitle: "Lab", count: 2 };
    expect(NotificationPayload.parse(filed)).toEqual(filed);
    expect(NotificationPayload.safeParse({ ...filed, count: 0 }).success).toBe(false);
  });
});
