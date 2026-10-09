/**
 * The project and group steps of the heig-classroom import (M8-01b, M8-01c) against the
 * synthetic classroom database of `test/fixtures/classroom-seed.sql`, part 3.
 *
 * The fixture's projects: Alpha (Prog-A, published; a milestone dispatched
 * and one never confirmed; Sam's, Sue's and Sid's repositories, Sid's still
 * pending), Pair Beta (Prog-A, a group project: a group repository, an
 * individual one live and one pending), Lab 1 (Info1-MI, applied, frozen,
 * `commit` strategy, final review dispatched, released: Sol's repository with
 * its ledger row, Sol Seven's without, and a development account's), and a
 * draft of the dropped Sandbox. Part 4 of the fixture (M8-01c) adds Pair
 * Gamma (Prog-A, group project, deadline past): Beta's "Team 1" reused (Sam and
 * Sue), a "Team 2" of two lines missing from the Quiz roster, and Team 1's
 * repository, made by Sue.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import {
  botCommits,
  classrooms,
  groupSets,
  githubAccounts,
  projectGroupMembers,
  projectGroups,
  projectRepoAccess,
  studentGroupMembers,
  studentGroups,
  courseStaff,
  courses,
  enrollments,
  gradeDispatches,
  githubClassroomLinks,
  githubOrganizations,
  importIdMap,
  importRuns,
  legacyClassroomAuditLog,
  projectCheckpoints,
  projectGradeRuns,
  projectRepos,
  projectSyncPrs,
  projects,
  pushReceipts,
  reverts,
  userEmails,
  users,
} from "./db/schema.js";
import { testDb } from "./test/db.js";
import type { ClassroomMapping } from "./import-classroom/mapping.js";
import { sourcePreflight } from "./import-classroom/preflight.js";
import { REGISTRY, type Registry } from "./import-classroom/registry.js";
import { runImport, type ImportOptions } from "./import-classroom/run.js";
import { readSnapshot, type SourceSnapshot } from "./import-classroom/source.js";
import { repoMembers, seatRepos } from "./modules/project/groupRepos.js";

const config = { SUPER_ADMIN_EMAIL: "", STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch"] } as unknown as AppConfig;

const MAPPING: ClassroomMapping = {
  classrooms: [
    { source: { name: "Prog-A" }, target: { course: "PROG", classroom: "Prog-A" } },
    { source: { id: "c3000000-0000-4000-8000-000000000002" }, target: { course: "INFO1", classroom: "MI-2026" } },
    { source: { name: "Sandbox" }, drop: true, note: "test classroom" },
  ],
};

const NOW = new Date("2026-10-05T08:00:00Z");
const DECIDED: ImportOptions = {
  now: NOW,
  apply: true,
  actorEmail: "quiz.admin@heig-vd.ch",
  mappingSha256: "0".repeat(64),
  assistants: "staff",
  missingStudents: "enroll",
};

const ID = {
  alpha: "c7000000-0000-4000-8000-000000000001",
  beta: "c7000000-0000-4000-8000-000000000002",
  lab1: "c7000000-0000-4000-8000-000000000003",
  sandbox: "c7000000-0000-4000-8000-000000000004",
  gamma: "c7000000-0000-4000-8000-000000000005",
  groupBeta: "ca000000-0000-4000-8000-000000000001",
  gammaTeam1: "ca000000-0000-4000-8000-000000000002",
  gammaTeam2: "ca000000-0000-4000-8000-000000000003",
  repoGamma: "c8000000-0000-4000-8000-00000000000a",
  repoSam: "c8000000-0000-4000-8000-000000000001",
  repoGroup: "c8000000-0000-4000-8000-000000000002",
  repoSol: "c8000000-0000-4000-8000-000000000003",
  repoSue: "c8000000-0000-4000-8000-000000000004",
  repoSidPending: "c8000000-0000-4000-8000-000000000005",
  repoSueInBeta: "c8000000-0000-4000-8000-000000000006",
  repoSidInBeta: "c8000000-0000-4000-8000-000000000007",
  repoSolSeven: "c8000000-0000-4000-8000-000000000008",
  repoCarol: "c8000000-0000-4000-8000-000000000009",
  midterm: "cf000000-0000-4000-8000-000000000001",
  finalCheck: "cf000000-0000-4000-8000-000000000002",
  ada: "c1000000-0000-4000-8000-000000000002",
};
const sha = (c: string) => c.repeat(40);

let source: PGlite;
let snapshot: SourceSnapshot;

beforeAll(async () => {
  source = new PGlite();
  await source.exec(readFileSync(new URL("./test/fixtures/classroom-seed.sql", import.meta.url), "utf8"));
  snapshot = await readSnapshot(async <T>(text: string) => (await source.query<T>(text)).rows);
});

/** A copy of the snapshot, edited: the source's state changed, nothing else. */
function variant(edit: (s: SourceSnapshot) => void): SourceSnapshot {
  const copy = structuredClone(snapshot);
  edit(copy);
  return copy;
}
const edited = (id: string, edit: (a: SourceSnapshot["assignments"][number]) => void) =>
  variant((s) => edit(s.assignments.find((a) => a.id === id)!));

async function quizUser(db: Db, sub: string, opts: { swissEduId?: string; email: string; role?: "student" | "teacher" | "admin" }) {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: sub, email: opts.email, emailVerified: true, givenName: "Quiz", swissEduId: opts.swissEduId ?? null, role: opts.role ?? "student" });
  await db.insert(userEmails).values({ userId: id, email: opts.email, source: "login", verified: true });
  return id;
}

/** The Quiz side before the import: two classrooms connected to their organizations, Ada, Sam and Sue already there. */
async function world() {
  const db = await testDb();
  await quizUser(db, "q-admin", { email: "quiz.admin@heig-vd.ch", role: "admin" });
  const t1 = await quizUser(db, "q-t1", { swissEduId: "eid-t1@eduid.ch", email: "ada.lovelace@heig-vd.ch" });
  const s1 = await quizUser(db, "q-s1", { swissEduId: "eid-s1@eduid.ch", email: "s1.student@heig-vd.ch" });
  const s2 = await quizUser(db, "q-s2", { email: "s2.student@heig-vd.ch" });
  const prog = randomUUID();
  const info = randomUUID();
  await db.insert(courses).values([{ id: prog, name: "Programmation", code: "PROG" }, { id: info, name: "Informatique 1", code: "INFO1" }]);
  const progA = randomUUID();
  const mi = randomUUID();
  await db.insert(classrooms).values([{ id: progA, courseId: prog, name: "Prog-A" }, { id: mi, courseId: info, name: "MI-2026" }]);
  await db.insert(courseStaff).values({ courseId: prog, userId: t1 });
  const orgs = new Map<number, string>();
  for (const [githubOrgId, login] of [[1001, "heig-prog-a"], [1002, "heig-info1"]] as const) {
    const id = randomUUID();
    orgs.set(githubOrgId, id);
    await db.insert(githubOrganizations).values({ id, githubOrgId, login, installationId: githubOrgId + 100 });
  }
  for (const [classroomId, org] of [[progA, 1001], [mi, 1002]] as const) {
    await db.insert(githubClassroomLinks).values({ classroomId, orgId: orgs.get(org)!, linkedBy: t1 });
  }
  await db.insert(enrollments).values([
    { id: randomUUID(), classroomId: progA, nom: "One", prenom: "Sam", email: "s1.student@heig-vd.ch", userId: s1, claimedAt: new Date() },
    { id: randomUUID(), classroomId: progA, nom: "Two", prenom: "Sue", email: "s2.student@heig-vd.ch" },
  ]);
  return { db, t1, s1, s2, prog, info, progA, mi, orgs };
}

/** Every table the project steps write, row by row: equal means nothing written. */
async function everything(db: Db) {
  const tables = [users, importIdMap, importRuns, legacyClassroomAuditLog, projects, projectCheckpoints, projectRepos, projectSyncPrs, projectGradeRuns, botCommits, gradeDispatches, reverts, pushReceipts, groupSets, studentGroups, studentGroupMembers, projectGroups, projectGroupMembers, projectRepoAccess];
  return Promise.all(tables.map((t) => db.select().from(t).orderBy(sql`1`)));
}

const one = async <T>(rows: Promise<T[]>) => (await rows)[0];

describe("import-classroom projects (M8-01b)", () => {
  it("imports the projects, checkpoints and repositories with every field, and carries everything or says why not", async () => {
    const w = await world();
    const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(report.outcome).toBe("applied");
    expect(report.parity.redLines).toEqual([]);

    // Four projects of the two carried classrooms; the dropped one's draft is not.
    const all = await w.db.select().from(projects).orderBy(projects.slug);
    expect(all.map((p) => p.slug)).toEqual(["alpha", "beta", "gamma", "lab-1"]);
    const alpha = all[0]!;
    expect(alpha).toMatchObject({
      id: ID.alpha,
      classroomId: w.progA,
      orgId: w.orgs.get(1001),
      name: "Project Alpha",
      state: "published",
      graceMinutes: 30,
      sourceRepoId: 111,
      sourceFullName: "heig-prog-a/alpha-src",
      distributionRepoId: 211,
      distributionFullName: "heig-prog-a/alpha-squashed",
      sourceStrategy: "squash",
      deadlineStrategy: "lock",
      gradingMode: "auto",
      publishMode: "manual",
      groupMode: false,
      groupSetId: null,
      branches: ["main"],
      protectedFiles: ["README.md"],
      sourceAheadSha: sha("d"),
      sourceHeads: null,
      gradingScale: { kind: "score_is_grade", rounding: "nearest" },
      deadlineAppliedAt: null,
      releasedAt: null,
      createdBy: w.t1,
      reminderSentAt: null,
    });
    expect(alpha.syncedAt).toEqual(new Date("2026-09-19T12:00:00Z"));
    expect(alpha.sourcePushedAt).toEqual(new Date("2026-09-18T09:00:00Z"));
    // A group project names its set (M8-01c: the set has the project's id).
    expect(all[1]).toMatchObject({ id: ID.beta, groupMode: true, groupSetId: ID.beta, orgId: w.orgs.get(1001) });
    // Released: the release, its author remapped, the freeze NOT on the project (it is the repositories').
    expect(all[3]).toMatchObject({
      id: ID.lab1,
      classroomId: w.mi,
      orgId: w.orgs.get(1002),
      deadlineStrategy: "commit",
      releasedAt: new Date("2026-09-16T10:00:00Z"),
      releasedBy: w.t1,
      deadlineAppliedAt: new Date("2026-09-15T08:00:00Z"),
    });

    // Checkpoints: a dispatched one keeps its time, or it would fire again.
    const checkpoints = await w.db.select().from(projectCheckpoints).orderBy(projectCheckpoints.name);
    expect(checkpoints.map((c) => [c.id, c.name, c.offsetDays, c.dispatchedAt?.toISOString() ?? null])).toEqual([
      [ID.finalCheck, "final-check", -11, null],
      [ID.midterm, "midterm", null, "2026-10-01T08:00:30.000Z"],
    ]);

    // Repositories: individual and group (Carol's, a development account, is not), the freeze on the repositories, the score of a released project at the import.
    const repos = await w.db.select().from(projectRepos).orderBy(projectRepos.id);
    expect(repos.map((r) => r.id)).toEqual([
      ID.repoSam, ID.repoGroup, ID.repoSol, ID.repoSue, ID.repoSidPending, ID.repoSueInBeta, ID.repoSidInBeta, ID.repoSolSeven, ID.repoGamma,
    ]);
    const byId = new Map(repos.map((r) => [r.id, r]));
    expect(byId.get(ID.repoSam)).toMatchObject({
      projectId: ID.alpha,
      userId: w.s1,
      groupId: null,
      githubRepoId: 9001,
      fullName: "heig-prog-a/alpha-s1",
      defaultBranch: "main",
      provisionStatus: "ok",
      invitationStatus: "accepted",
      rulesetId: 5001,
      lastCommitSha: sha("2"),
      ciStatus: "pass",
      currentGradeRunId: "c9000000-0000-4000-8000-000000000001",
      frozenGradeRunId: null,
      deadlineAppliedAt: null,
      frozenAt: null,
      teacherPoints: null,
      releasedPoints: null,
      archivedAt: null,
      staffLock: null,
      deadlineAt: null,
    });
    expect(byId.get(ID.repoSam)!.acceptedAt).toEqual(new Date("2026-09-02T08:00:00Z"));
    // Sol: the project's freeze lands on the repository; the deadline commit is read from the bot commit; the review run fills the review slot.
    expect(byId.get(ID.repoSol)).toMatchObject({
      projectId: ID.lab1,
      deadlineAppliedAt: new Date("2026-09-15T08:00:00Z"),
      frozenAt: new Date("2026-09-15T08:30:00Z"),
      deadlineCommittedAt: new Date("2026-09-15T08:00:05Z"),
      lockedAt: new Date("2026-09-15T08:00:10Z"),
      frozenGradeRunId: "c9000000-0000-4000-8000-000000000002",
      reviewGradeRunId: "c9000000-0000-4000-8000-000000000003",
      teacherPoints: null,
      teacherMax: null,
      releasedPoints: 5.5,
      releasedMax: 6,
    });
    // A teacher's score wins and keeps no maximum of its own (the CI's is read); the released score says the same.
    expect(byId.get(ID.repoSolSeven)).toMatchObject({ teacherPoints: 4.5, teacherMax: null, releasedPoints: 4.5, releasedMax: 6, deadlineCommittedAt: null });
    // Not released: the score and its comment stay the staff's.
    expect(byId.get(ID.repoSue)).toMatchObject({ teacherPoints: 5, teacherComment: "Good work", teacherGradedBy: w.t1, releasedPoints: null, releasedComment: null });
    // A repository still pending, no GitHub id.
    expect(byId.get(ID.repoSidPending)).toMatchObject({ provisionStatus: "pending", githubRepoId: null, fullName: null });
    // Sam's and Sue's repositories sit on the Quiz accounts the import matched.
    expect(byId.get(ID.repoSue)!.userId).toBe(w.s2);

    // classroom's sync pull request is the row of the default branch.
    const prs = await w.db.select().from(projectSyncPrs).orderBy(projectSyncPrs.prNumber);
    expect(prs.map((p) => [p.repoId, p.branch, p.prNumber, p.state, p.updatedAt])).toEqual([
      [ID.repoSol, "main", 3, "merged", NOW],
      [ID.repoSam, "main", 7, "open", NOW],
    ]);

    // Runs: `llm` is `review`, nothing to verify, no parse detail, the group repositories' runs carried.
    const runs = await w.db.select().from(projectGradeRuns).orderBy(projectGradeRuns.workflowRunId);
    expect(runs.map((r) => [r.workflowRunId, r.kind, r.points, r.max, r.parseStatus, r.toVerify, r.parseDetail, r.afterDeadline])).toEqual([
      [70001, "ci", 4, 6, "ok", false, null, false],
      [70002, "ci", 5, 6, "ok", false, null, false],
      [70003, "review", 5.5, 6, "ok", false, null, false],
      [70004, "ci", 3, 6, "ok", false, null, false],
      [70005, "ci", 2, 6, "ok", false, null, false],
      [70006, "ci", null, null, "malformed", false, null, true],
      [70007, "ci", 4.5, 6, "ok", false, null, false],
    ]);
    expect(runs[3]).toMatchObject({ testsPassed: 6, testsTotal: 10 });
    expect(runs[5]).toMatchObject({ runAttempt: 2 });

    // Bot commits, the restore (heads unknown, never counted as a push's) and the receipts (keyed on GitHub's repository id).
    expect((await w.db.select().from(botCommits)).map((b) => [b.repoId, b.kind]).sort()).toEqual([[ID.repoSam, "revert"], [ID.repoGroup, "sync"], [ID.repoSol, "deadline"], [ID.repoGamma, "deadline"]]);
    expect(await w.db.select().from(reverts).orderBy(reverts.createdAt)).toEqual([
      expect.objectContaining({ repoId: ID.repoGamma, revertSha: sha("b"), files: ["README.md"], headSha: null, coveredSha: null, branch: null }),
      expect.objectContaining({ repoId: ID.repoSam, revertSha: sha("3"), files: ["README.md"], headSha: null, coveredSha: null, branch: null }),
    ]);
    const receipts = await w.db.select().from(pushReceipts).orderBy(pushReceipts.receivedAt);
    expect(receipts.map((r) => [r.githubRepoId, r.headSha, r.isBot, r.forced])).toEqual([
      [9003, sha("4"), false, false],
      [9001, sha("3"), true, false],
      [9010, sha("7"), false, false],
      [9001, sha("1"), false, false],
      [9001, sha("2"), false, true],
      [9002, sha("6"), false, false],
    ]);

    // The ledger: the three rows as they are, `milestone` read as `checkpoint`, the unconfirmed one unconfirmed.
    const ledger = await w.db.select().from(gradeDispatches).orderBy(gradeDispatches.createdAt);
    const real = ledger.filter((d) => d.sha !== sha("e"));
    expect(real.map((d) => [d.repoId, d.trigger, d.checkpointId, d.dispatchedAt?.toISOString() ?? null])).toEqual([
      [ID.repoSol, "deadline", null, "2026-09-15T09:00:05.000Z"],
      [ID.repoGamma, "deadline", null, "2026-09-20T09:00:05.000Z"],
      [ID.repoSam, "checkpoint", ID.midterm, null],
      [ID.repoSue, "checkpoint", ID.midterm, "2026-10-01T08:00:30.000Z"],
    ]);

    // Parity: everything carried or left out with a reason, never lost.
    const tables = Object.fromEntries(report.parity.tables.map((t) => [t.table, t]));
    expect(tables["assignments"]).toMatchObject({ source: 4, carried: 4, leftOut: 0, missing: 0 });
    expect(tables["assignment_milestones"]).toMatchObject({ source: 2, carried: 2, missing: 0 });
    expect(tables["student_repos"]).toMatchObject({ source: 10, carried: 9, leftOut: 1, missing: 0 });
    expect(report.parity.findings.filter((f) => f.check === "student_repos left out").map((f) => f.detail)).toEqual([
      expect.stringContaining("its student is not imported"),
    ]);
    expect(tables["student_repos.sync_pr_number"]).toMatchObject({ source: 2, carried: 2, missing: 0 });
    expect(tables["grade_runs"]).toMatchObject({ source: 7, carried: 7, leftOut: 0, missing: 0 });
    expect(tables["bot_commits"]).toMatchObject({ source: 4, carried: 4, leftOut: 0, missing: 0 });
    expect(tables["grade_dispatches"]).toMatchObject({ source: 4, carried: 4, leftOut: 0, missing: 0 });
    expect(tables["reverts"]).toMatchObject({ source: 2, carried: 2, missing: 0 });
    // The pending repository's receipt (no GitHub id) is left out; the group repositories' are carried.
    expect(tables["push_receipts"]).toMatchObject({ source: 7, carried: 6, leftOut: 1, missing: 0 });
    expect(report.findings.projects?.some((l) => l.includes("1 push receipt(s) dropped"))).toBe(true);
    // The id map carries the permalinks' ids.
    const mapped = await w.db.select({ t: importIdMap.sourceTable }).from(importIdMap);
    expect(mapped.filter((m) => m.t === "assignments")).toHaveLength(4);
    expect(mapped.filter((m) => m.t === "student_repos")).toHaveLength(9);
    expect(mapped.filter((m) => m.t === "assignment_groups")).toHaveLength(3);

    // The checks that read Quiz back said so, each with its evidence.
    const checks = report.parity.findings.filter((f) => f.severity === "info" && !f.check.includes("left out")).map((f) => f.check);
    expect(checks).toEqual(expect.arrayContaining(["repositories per project", "teacher points", "frozen grades", "grade-run links", "latest push receipt", "groups per project", "members per group"]));
    // Never a course, classroom, organization or link.
    expect(report.parity.redLines).toEqual([]);
  });

  it("writes nothing the second time", async () => {
    const w = await world();
    expect((await runImport(w.db, config, snapshot, MAPPING, DECIDED)).outcome).toBe("applied");
    const before = await everything(w.db);
    const second = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(second.outcome).toBe("nothing_to_do");
    expect(second.written).toEqual({});
    expect(await everything(w.db)).toEqual(before);
    expect(second.parity.redLines).toEqual([]);
  });

  it("keeps the individual repositories of a group project, live or not, and says so", async () => {
    const w = await world();
    const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    const lines = report.findings.projects?.filter((l) => l.includes("individual repository inside a group project")) ?? [];
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.includes("Sue"))).toContain("live");
    expect(lines.find((l) => l.includes("Sid"))).toContain("not live");
  });

  describe("the review ledger", () => {
    const ledgerOf = async (db: Db, repoId: string) => db.select().from(gradeDispatches).where(eq(gradeDispatches.repoId, repoId));

    it("records a confirmed synthetic row for a repository frozen after a dispatch whose row is lost, once", async () => {
      const w = await world();
      const first = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      // Sol Seven: frozen run, no row in classroom, the assignment's review dispatched at 09:00.
      expect(await ledgerOf(w.db, ID.repoSolSeven)).toEqual([
        expect.objectContaining({ trigger: "deadline", checkpointId: null, sha: sha("e"), dispatchedAt: new Date("2026-09-15T09:00:00Z") }),
      ]);
      expect(first.written["grade_dispatches (synthetic)"]).toBe(1);
      expect(first.findings.projects?.some((l) => l.includes("synthetic row"))).toBe(true);
      // The repository that had its row keeps it alone; the development account's, not carried, none.
      expect(await ledgerOf(w.db, ID.repoSol)).toHaveLength(1);
      expect(await ledgerOf(w.db, ID.repoCarol)).toEqual([]);
      // Neither a repository without a frozen run (Sam's has none for the final review).
      expect((await ledgerOf(w.db, ID.repoSam)).map((d) => d.trigger)).toEqual(["checkpoint"]);
      // A second run records no second one.
      expect((await runImport(w.db, config, snapshot, MAPPING, DECIDED)).outcome).toBe("nothing_to_do");
    });

    it("records none where classroom never dispatched, or the project is not graded", async () => {
      const w = await world();
      await runImport(w.db, config, edited(ID.lab1, (a) => { a.llmDispatchedAt = null; }), MAPPING, DECIDED);
      expect(await ledgerOf(w.db, ID.repoSolSeven)).toEqual([]);
      const none = await world();
      await runImport(none.db, config, edited(ID.lab1, (a) => { a.gradingMode = "none"; }), MAPPING, DECIDED);
      expect(await ledgerOf(none.db, ID.repoSolSeven)).toEqual([]);
    });

    it("imports an unconfirmed row as it is, and lists it", async () => {
      const w = await world();
      const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      expect((await ledgerOf(w.db, ID.repoSam))[0]?.dispatchedAt).toBeNull();
      expect(report.findings.projects?.some((l) => l.includes("not confirmed in classroom"))).toBe(true);
    });
  });

  describe("the reminder", () => {
    const reminders = async (db: Db) => Object.fromEntries((await db.select({ id: projects.id, at: projects.reminderSentAt }).from(projects)).map((p) => [p.id, p.at]));

    it("marks a project whose deadline is past or within 24 h as sent at the import time, and leaves a far one owed", async () => {
      const w = await world();
      const soon = edited(ID.alpha, (a) => { a.deadlineAt = new Date(NOW.getTime() + 2 * 3_600_000); });
      const report = await runImport(w.db, config, soon, MAPPING, DECIDED);
      // Alpha in two hours, Lab 1 and Gamma long past: marked; Beta in December: owed.
      expect(await reminders(w.db)).toEqual({ [ID.alpha]: NOW, [ID.lab1]: NOW, [ID.gamma]: NOW, [ID.beta]: null });
      expect(report.findings.projects?.some((l) => l.includes("3 project reminder(s) marked sent"))).toBe(true);
      expect((await runImport(w.db, config, soon, MAPPING, DECIDED)).outcome).toBe("nothing_to_do");
    });

    it("copies classroom's own marker as it is, and never undoes one Quiz sent", async () => {
      const w = await world();
      const marked = new Date("2026-12-14T08:00:00Z");
      await runImport(w.db, config, edited(ID.beta, (a) => { a.reminderSentAt = marked; }), MAPPING, DECIDED);
      expect((await reminders(w.db))[ID.beta]).toEqual(marked);
      // Quiz's tick sent Alpha's reminder (a day before its deadline); a later import leaves it.
      const sent = new Date("2026-11-30T08:00:00Z");
      await w.db.update(projects).set({ reminderSentAt: sent }).where(eq(projects.id, ID.alpha));
      await runImport(w.db, config, edited(ID.alpha, (a) => { a.reminderSentAt = new Date("2026-11-29T08:00:00Z"); }), MAPPING, DECIDED);
      expect((await reminders(w.db))[ID.alpha]).toEqual(sent);
    });
  });

  describe("re-import", () => {
    it("overwrites an untouched project row from classroom, and keeps one Quiz modified, listing it", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      const renamed = (name: string, graceMinutes: number) => edited(ID.alpha, (a) => { a.name = name; a.graceMinutes = graceMinutes; });

      const second = await runImport(w.db, config, renamed("Alpha, renamed", 45), MAPPING, DECIDED);
      expect(second.outcome).toBe("applied");
      expect(second.reimport.overwritten).toEqual({ assignments: 1 });
      expect(second.reimport.kept).toEqual([]);
      expect(await one(w.db.select().from(projects).where(eq(projects.id, ID.alpha)))).toMatchObject({ name: "Alpha, renamed", graceMinutes: 45 });
      expect((await runImport(w.db, config, renamed("Alpha, renamed", 45), MAPPING, DECIDED)).outcome).toBe("nothing_to_do");

      // A teacher changed it in Quiz: kept, listed, and the repositories under it untouched.
      await w.db.update(projects).set({ graceMinutes: 60 }).where(eq(projects.id, ID.alpha));
      const third = await runImport(w.db, config, renamed("Alpha, again", 50), MAPPING, DECIDED);
      expect(third.reimport.kept).toEqual([expect.objectContaining({ table: "assignments", sourceId: ID.alpha, targetId: ID.alpha })]);
      expect(third.findings.reimport?.[0]).toContain("modified in Quiz");
      expect(await one(w.db.select().from(projects).where(eq(projects.id, ID.alpha)))).toMatchObject({ name: "Alpha, renamed", graceMinutes: 60 });
      expect(third.parity.redLines).toEqual([]);
    });

    it("keeps a repository Quiz graded since, and the parity checks do not take it for a loss", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      // Sue's repository: Quiz's teacher re-scored it; classroom's changed too.
      await w.db.update(projectRepos).set({ teacherPoints: 5.5, teacherMax: 6 }).where(eq(projectRepos.id, ID.repoSue));
      const report = await runImport(
        w.db,
        config,
        variant((s) => { s.studentRepos.find((r) => r.id === ID.repoSue)!.teacherPoints = 4; }),
        MAPPING,
        DECIDED,
      );
      expect(report.reimport.kept).toEqual([expect.objectContaining({ table: "student_repos", sourceId: ID.repoSue })]);
      expect(await one(w.db.select().from(projectRepos).where(eq(projectRepos.id, ID.repoSue)))).toMatchObject({ teacherPoints: 5.5, teacherMax: 6 });
      expect(report.parity.redLines).toEqual([]);
    });
  });

  describe("the parity report is a red line when", () => {
    /** The registry's steps, then one that damages what was carried. */
    const damaging = (damage: (db: Db) => Promise<unknown>): Registry => ({
      steps: [...REGISTRY.steps, { name: "rogue", run: async (ctx) => { await damage(ctx.db as unknown as Db); } }],
      checks: REGISTRY.checks,
    });

    it("a repository is dropped", async () => {
      const w = await world();
      const registry = damaging((db) => db.delete(projectRepos).where(eq(projectRepos.id, ID.repoSam)));
      const dry = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, apply: false, registry });
      expect(dry.outcome).toBe("rolled_back");
      expect(dry.parity.redLines).toEqual([expect.stringMatching(/^repositories per project: project "Project Alpha".*repositories: source 3, Quiz 2/)]);
      const before = await everything(w.db);
      const applied = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, registry });
      expect(applied.outcome).toBe("red_lines");
      expect(await everything(w.db)).toEqual(before);
    });

    it("a group repository is dropped", async () => {
      const w = await world();
      const registry = damaging((db) => db.delete(projectRepos).where(eq(projectRepos.id, ID.repoGroup)));
      const dry = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, apply: false, registry });
      expect(dry.outcome).toBe("rolled_back");
      expect(dry.parity.redLines).toEqual(
        [expect.stringMatching(/^repositories per project: project "Pair Beta".*source 3, Quiz 2/)],
      );
      expect((await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, registry })).outcome).toBe("red_lines");
    });

    it("a group or a member is dropped", async () => {
      const w = await world();
      const registry = damaging(async (db) => {
        await db.delete(projectGroupMembers).where(eq(projectGroupMembers.groupId, ID.gammaTeam2));
        await db.delete(projectGroups).where(eq(projectGroups.id, ID.groupBeta));
      });
      const dry = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, apply: false, registry });
      expect(dry.parity.redLines).toEqual(
        expect.arrayContaining([expect.stringContaining('groups: source 1, Quiz 0'), expect.stringContaining('members: source 2, Quiz 0')]),
      );
    });

    it("a teacher score moves, a frozen grade goes, a grade-run link breaks, a receipt is lost", async () => {
      const w = await world();
      const registry = damaging(async (db) => {
        await db.update(projectRepos).set({ teacherPoints: 1 }).where(eq(projectRepos.id, ID.repoSue));
        await db.update(projectRepos).set({ frozenGradeRunId: null }).where(eq(projectRepos.id, ID.repoSol));
        await db.delete(projectGradeRuns).where(eq(projectGradeRuns.repoId, ID.repoSam));
        await db.delete(pushReceipts).where(eq(pushReceipts.headSha, sha("2")));
      });
      const report = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, apply: false, registry });
      expect(report.parity.redLines).toEqual(
        expect.arrayContaining([
          expect.stringContaining("teacher points: project \"Project Alpha\""),
          expect.stringContaining("frozen grades: project \"Lab 1\""),
          expect.stringContaining(`grade-run links: repository ${ID.repoSam}: its current grade run`),
          expect.stringContaining(`latest push receipt: repository ${ID.repoSam}`),
        ]),
      );
    });

    it("a source row cannot be carried: Quiz already holds the project's slug", async () => {
      const w = await world();
      await w.db.insert(projects).values({
        id: randomUUID(), classroomId: w.progA, orgId: w.orgs.get(1001)!, name: "Made in Quiz", slug: "alpha",
        startAt: NOW, deadlineAt: NOW, sourceRepoId: 1, sourceFullName: "heig-prog-a/x", branches: ["main"], protectedFiles: [],
        gradingScale: { kind: "linear", scoreMax: 6 } as never, createdBy: w.t1,
      });
      const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      expect(report.outcome).toBe("red_lines");
      expect(report.parity.redLines).toEqual([expect.stringMatching(/^assignments: 1 source row\(s\) neither carried nor left out/)]);
      expect(report.findings.projects?.some((l) => l.includes('already holds the slug "alpha"'))).toBe(true);
      // Its children say why they were not carried, and Quiz's own project was not touched.
      expect(await w.db.select().from(projectRepos).where(eq(projectRepos.projectId, ID.alpha))).toEqual([]);
    });
  });

  describe("groups (M8-01c)", () => {
    const lines = async (db: Db, classroomId: string) => new Map((await db.select().from(enrollments).where(eq(enrollments.classroomId, classroomId))).map((e) => [e.email, e.id]));
    const membersOf = async (db: Db, groupId: string) => (await db.select().from(projectGroupMembers).where(eq(projectGroupMembers.groupId, groupId))).map((m) => m.enrollmentId).sort();
    const setMembersOf = async (db: Db, groupId: string) => (await db.select().from(studentGroupMembers).where(eq(studentGroupMembers.groupId, groupId))).map((m) => m.enrollmentId).sort();

    it("imports a group assignment as a set, its copy, the group repository and the accounts invited on it", async () => {
      const w = await world();
      const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      expect(report.outcome).toBe("applied");
      expect(report.parity.redLines).toEqual([]);
      const room = await lines(w.db, w.progA);
      const [sam, sue, sid, syd] = ["s1.student@heig-vd.ch", "s2.student@heig-vd.ch", "s3.student@heig-vd.ch", "s6.student@heig-vd.ch"].map((e) => room.get(e)!) as [string, string, string, string];

      // One set per group project, named after it, in the project's classroom, ids kept.
      const sets = await w.db.select().from(groupSets).orderBy(groupSets.name);
      expect(sets).toEqual([
        expect.objectContaining({ id: ID.beta, classroomId: w.progA, name: "Pair Beta", maxSize: 2, openUntil: null, createdBy: w.t1, createdAt: new Date("2026-08-21T08:00:00Z") }),
        expect.objectContaining({ id: ID.gamma, classroomId: w.progA, name: "Pair Gamma", maxSize: 3, createdBy: w.t1 }),
      ]);
      expect((await w.db.select().from(studentGroups).orderBy(studentGroups.setId, studentGroups.position)).map((g) => [g.id, g.setId, g.name, g.position])).toEqual([
        [ID.groupBeta, ID.beta, "Team 1", 0],
        [ID.gammaTeam1, ID.gamma, "Team 1", 0],
        [ID.gammaTeam2, ID.gamma, "Team 2", 1],
      ]);
      // The project names its set; the other projects none.
      const named = Object.fromEntries((await w.db.select({ id: projects.id, set: projects.groupSetId, stopped: projects.groupsStoppedAt }).from(projects)).map((p) => [p.id, p]));
      expect(named[ID.beta]).toMatchObject({ set: ID.beta, stopped: null });
      expect(named[ID.gamma]).toMatchObject({ set: ID.gamma, stopped: NOW });
      expect([named[ID.alpha]!.set, named[ID.lab1]!.set]).toEqual([null, null]);

      // The project's copy: slug, the set's group it follows; Gamma's deadline is past: stopped.
      const copy = await w.db.select().from(projectGroups).orderBy(projectGroups.id);
      expect(copy.map((g) => [g.id, g.projectId, g.name, g.slug, g.sourceGroupId, g.stoppedAt])).toEqual([
        [ID.groupBeta, ID.beta, "Team 1", "team-1", ID.groupBeta, null],
        [ID.gammaTeam1, ID.gamma, "Team 1", "team-1", ID.gammaTeam1, NOW],
        [ID.gammaTeam2, ID.gamma, "Team 2", "team-2", ID.gammaTeam2, NOW],
      ]);
      // Members by roster line, in the set and in the copy; the lines the roster lacked were added (`enroll`).
      expect(await membersOf(w.db, ID.groupBeta)).toEqual([sam, sue].sort());
      expect(await setMembersOf(w.db, ID.groupBeta)).toEqual([sam, sue].sort());
      expect(await membersOf(w.db, ID.gammaTeam1)).toEqual([sam, sue].sort());
      expect(await membersOf(w.db, ID.gammaTeam2)).toEqual([sid, syd].sort());
      expect(await setMembersOf(w.db, ID.gammaTeam2)).toEqual([sid, syd].sort());
      expect((await w.db.select().from(projectGroupMembers)).every((m) => m.departingAt === null)).toBe(true);
      // A classroom that reused its groups across assignments gets one set per assignment, same membership (Beta's "Team 1" and Gamma's).
      expect(await setMembersOf(w.db, ID.groupBeta)).toEqual(await setMembersOf(w.db, ID.gammaTeam1));

      // The group repositories sit on their copy groups, under the member who made them.
      const repos = Object.fromEntries((await w.db.select().from(projectRepos)).map((r) => [r.id, r]));
      expect(repos[ID.repoGroup]).toMatchObject({ projectId: ID.beta, groupId: ID.groupBeta, userId: w.s1, githubRepoId: 9002 });
      expect(repos[ID.repoGamma]).toMatchObject({ projectId: ID.gamma, groupId: ID.gammaTeam1, userId: w.s2, githubRepoId: 9010, frozenGradeRunId: "c9000000-0000-4000-8000-000000000007" });

      // The accounts invited: Sam and Sue on Gamma's, Sam only on Beta's (Sue keeps her live individual repository there).
      const accounts = await w.db.select().from(githubAccounts);
      expect(accounts.find((a) => a.userId === w.s1)).toMatchObject({ githubUserId: 5001, login: "gh-s1" });
      const access = await w.db.select().from(projectRepoAccess).orderBy(projectRepoAccess.githubUserId);
      expect(access.map((a) => [a.repoId, a.enrollmentId, a.githubUserId, a.githubLogin, a.invitedAt.toISOString(), a.revokingAt, a.revokedAt])).toEqual(
        expect.arrayContaining([
          [ID.repoGroup, sam, 5001, "gh-s1", "2026-09-11T08:00:00.000Z", null, null],
          [ID.repoGamma, sam, 5001, "gh-s1", "2026-09-07T08:00:00.000Z", null, null],
          [ID.repoGamma, sue, 5002, "gh-s2", "2026-09-07T08:00:00.000Z", null, null],
        ]),
      );
      expect(access).toHaveLength(3);

      // Parity: what was carried, tallied; the checks' evidence.
      const tables = Object.fromEntries(report.parity.tables.map((t) => [t.table, t]));
      expect(tables["assignment_groups"]).toMatchObject({ source: 3, carried: 3, missing: 0 });
      expect(tables["assignment_group_members"]).toMatchObject({ source: 6, carried: 6, missing: 0 });
      expect(tables["group repositories"]).toMatchObject({ source: 2, carried: 2, leftOut: 0, missing: 0 });
      expect(tables["group repository access"]).toMatchObject({ source: 3, carried: 3, leftOut: 0, missing: 0 });
      expect(report.findings.projects?.some((l) => l.includes("stopped following their set"))).toBe(true);
      expect(report.parity.findings.filter((f) => f.severity === "info").map((f) => f.detail)).toEqual(
        expect.arrayContaining(["groups: 3 across 2 project(s), equal in Quiz", "members: 6 across 3 group(s), equal in Quiz", "repositories: 9 across 4 project(s), equal in Quiz"]),
      );
    });

    it("stops the copy it creates once, never re-stops it, and keeps the stop out of the re-import baseline", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      const stoppedOf = async (id: string) => (await w.db.select({ at: projectGroups.stoppedAt }).from(projectGroups).where(eq(projectGroups.projectId, id))).map((g) => g.at);
      expect(await stoppedOf(ID.gamma)).toEqual([NOW, NOW]);
      // A staff resync lifts the stops in Quiz; a later run, with a source rename, must not stop the copy again.
      await w.db.update(projectGroups).set({ stoppedAt: null }).where(eq(projectGroups.projectId, ID.gamma));
      await w.db.update(projects).set({ groupsStoppedAt: null }).where(eq(projects.id, ID.gamma));
      const renamed = variant((s) => { s.groups.find((g) => g.id === ID.gammaTeam1)!.name = "Squad G"; });
      const later = await runImport(w.db, config, renamed, MAPPING, { ...DECIDED, now: new Date(NOW.getTime() + 60_000) });
      expect(await stoppedOf(ID.gamma)).toEqual([null, null]);
      expect((await one(w.db.select().from(projects).where(eq(projects.id, ID.gamma))))!.groupsStoppedAt).toBeNull();
      // The stop at creation was no edit: the rename applied, nothing was kept.
      expect(later.reimport.kept).toEqual([]);
      expect(later.reimport.overwritten).toEqual({ assignment_groups: 1, "assignment_groups (set)": 1 });
      expect((await one(w.db.select().from(projectGroups).where(eq(projectGroups.id, ID.gammaTeam1))))!.name).toBe("Squad G");
    });

    it("lists the members of a group the copy refused as left out, with the reason", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      // Beta's copy group is gone and unmapped, and Quiz now holds a group of the same name and slug in the copy.
      await w.db.delete(projectGroupMembers).where(eq(projectGroupMembers.groupId, ID.groupBeta));
      await w.db.delete(projectGroups).where(eq(projectGroups.id, ID.groupBeta));
      const memberIds = snapshot.groupMembers.filter((m) => m.groupId === ID.groupBeta).map((m) => m.id);
      await w.db.delete(importIdMap).where(and(eq(importIdMap.sourceTable, "assignment_groups"), eq(importIdMap.sourceId, ID.groupBeta)));
      await w.db.delete(importIdMap).where(and(eq(importIdMap.sourceTable, "assignment_group_members"), inArray(importIdMap.sourceId, memberIds)));
      await w.db.insert(projectGroups).values({ id: randomUUID(), projectId: ID.beta, name: "Team 1", slug: "team-1", position: 0, createdAt: NOW });
      const report = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, apply: false });
      expect(report.parity.redLines.filter((l) => /^assignment_group_members/.test(l))).toEqual([]);
      expect(report.parity.redLines.some((l) => /^assignment_groups/.test(l))).toBe(true);
      expect(report.parity.findings.some((f) => f.check === "assignment_group_members left out" && f.detail.includes("its group was not carried"))).toBe(true);
    });

    it("reports a member missing from the Quiz roster, places no one for them and records no access", async () => {
      const w = await world();
      const report = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, missingStudents: "report" });
      expect(report.outcome).toBe("applied");
      expect(report.parity.redLines).toEqual([]);
      // Sid and Syd are not on the Quiz roster: Team 2 is empty, in the set and in the copy.
      expect(await membersOf(w.db, ID.gammaTeam2)).toEqual([]);
      expect(await setMembersOf(w.db, ID.gammaTeam2)).toEqual([]);
      const reported = report.findings.projects?.filter((l) => l.includes("group member")) ?? [];
      expect(reported).toHaveLength(2);
      expect(reported.join("\n")).toContain("Sid Three");
      expect(reported.join("\n")).toContain("Syd Six");
      expect(report.lists.missingStudents.some((l) => l.includes("Three"))).toBe(true);
      const tables = Object.fromEntries(report.parity.tables.map((t) => [t.table, t]));
      expect(tables["assignment_group_members"]).toMatchObject({ source: 6, carried: 4, leftOut: 2, missing: 0 });
      // Nobody missing is invited; the others are.
      expect(await w.db.select().from(projectRepoAccess)).toHaveLength(3);
      expect((await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, missingStudents: "report" })).outcome).toBe("nothing_to_do");
    });

    it("records the repository under a member when its creator is not imported, and says so", async () => {
      const w = await world();
      const carol = "c1000000-0000-4000-8000-000000000017";
      const report = await runImport(w.db, config, variant((s) => { s.studentRepos.find((r) => r.id === ID.repoGroup)!.userId = carol; }), MAPPING, DECIDED);
      expect(report.parity.redLines).toEqual([]);
      expect((await one(w.db.select().from(projectRepos).where(eq(projectRepos.id, ID.repoGroup))))!.userId).toBe(w.s1);
      expect(report.findings.projects?.some((l) => l.includes("creator is not imported"))).toBe(true);
    });

    it("does not recreate a set or a group Quiz deleted since the previous run, and places no one under it", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      // Beta's project is archived, its set deleted (which clears the project's pointer); a staff deleted Gamma's Team 2.
      await w.db.update(projects).set({ groupSetId: null }).where(eq(projects.id, ID.beta));
      await w.db.delete(studentGroupMembers).where(eq(studentGroupMembers.setId, ID.beta));
      await w.db.delete(studentGroups).where(eq(studentGroups.setId, ID.beta));
      await w.db.delete(groupSets).where(eq(groupSets.id, ID.beta));
      await w.db.delete(projectGroupMembers).where(eq(projectGroupMembers.groupId, ID.gammaTeam2));
      await w.db.delete(studentGroupMembers).where(eq(studentGroupMembers.groupId, ID.gammaTeam2));
      await w.db.delete(projectGroups).where(eq(projectGroups.id, ID.gammaTeam2));
      await w.db.delete(studentGroups).where(eq(studentGroups.id, ID.gammaTeam2));
      // classroom adds a member to the deleted group and to Beta's.
      const again = variant((s) => {
        const m = s.groupMembers.find((x) => x.groupId === ID.gammaTeam1)!;
        s.groupMembers.push({ ...m, id: randomUUID(), groupId: ID.gammaTeam2, assignmentId: ID.gamma });
        s.groupMembers.push({ ...m, id: randomUUID(), groupId: ID.groupBeta, assignmentId: ID.beta });
      });
      const report = await runImport(w.db, config, again, MAPPING, DECIDED);
      expect(report.outcome).not.toBe("failed");
      expect(report.parity.redLines).toEqual([]);
      expect(await w.db.select().from(groupSets).where(eq(groupSets.id, ID.beta))).toEqual([]);
      expect(await w.db.select().from(projectGroups).where(eq(projectGroups.id, ID.gammaTeam2))).toEqual([]);
      expect((await one(w.db.select().from(projects).where(eq(projects.id, ID.beta))))!.groupSetId).toBeNull();
      expect(report.findings.projects?.filter((l) => l.includes("deleted in Quiz"))).toEqual(
        expect.arrayContaining([expect.stringContaining('group set of "Pair Beta"'), expect.stringContaining('group "Team 2"')]),
      );
    });

    it("leaves out a new group repository whose copy group Quiz deleted, listed, without aborting", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      await w.db.delete(projectGroupMembers).where(eq(projectGroupMembers.groupId, ID.gammaTeam2));
      await w.db.delete(projectGroups).where(eq(projectGroups.id, ID.gammaTeam2));
      const extra = randomUUID();
      const again = variant((s) => {
        const base = s.studentRepos.find((r) => r.id === ID.repoGamma)!;
        s.studentRepos.push({ ...base, id: extra, groupId: ID.gammaTeam2, githubRepoId: 9990, fullName: "heig-prog-a/pair-gamma-team-2", repoName: "pair-gamma-team-2", currentGradeRunId: null, frozenGradeRunId: null, llmGradeRunId: null } as typeof base);
      });
      const report = await runImport(w.db, config, again, MAPPING, DECIDED);
      expect(report.outcome).not.toBe("failed");
      expect(report.parity.redLines).toEqual([]);
      expect(await w.db.select().from(projectRepos).where(eq(projectRepos.id, extra))).toEqual([]);
      const tables = Object.fromEntries(report.parity.tables.map((t) => [t.table, t]));
      expect(tables["group repositories"]).toMatchObject({ source: 3, carried: 2, leftOut: 1, missing: 0 });
      expect(report.findings.projects?.some((l) => l.includes("Team 2") && l.includes("deleted in Quiz"))).toBe(true);
    });

    it("never stops a copy on a re-run because of the source: Quiz's own deadline decides", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      // A teacher moved Beta's deadline far ahead in Quiz; classroom's says it is past.
      await w.db.update(projects).set({ deadlineAt: new Date(NOW.getTime() + 30 * 86_400_000) }).where(eq(projects.id, ID.beta));
      const past = edited(ID.beta, (a) => { a.deadlineAt = new Date(NOW.getTime() - 3_600_000); });
      await runImport(w.db, config, past, MAPPING, { ...DECIDED, now: new Date(NOW.getTime() + 60_000) });
      expect((await w.db.select({ at: projectGroups.stoppedAt }).from(projectGroups).where(eq(projectGroups.projectId, ID.beta))).map((g) => g.at)).toEqual([null]);
      expect((await one(w.db.select().from(projects).where(eq(projects.id, ID.beta))))!.groupsStoppedAt).toBeNull();
    });

    it("takes a set's creator from the carried project, so a run without an actor does not abort", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      // The set of Beta is gone from the id map and from Quiz (as before M8-01c), its project is carried.
      await w.db.delete(studentGroupMembers).where(eq(studentGroupMembers.setId, ID.beta));
      await w.db.delete(studentGroups).where(eq(studentGroups.setId, ID.beta));
      await w.db.delete(groupSets).where(eq(groupSets.id, ID.beta));
      await w.db.delete(importIdMap).where(and(
        inArray(importIdMap.sourceTable, ["assignments (group set)", "assignment_groups (set)", "assignment_group_members (set)"]),
        inArray(importIdMap.sourceId, [ID.beta, ID.groupBeta, ...snapshot.groupMembers.filter((m) => m.groupId === ID.groupBeta).map((m) => m.id)]),
      ));
      const noOwner = variant((s) => { for (const c of s.classrooms) c.teacherId = randomUUID(); });
      const report = await runImport(w.db, config, noOwner, MAPPING, { ...DECIDED, apply: false, actorEmail: "nobody@heig-vd.ch" });
      // Not an abort (the set's NOT NULL creator is the project's), and a project an earlier run carried stays carried.
      expect(report.outcome).toBe("rolled_back");
      expect(report.parity.redLines).toEqual([]);
    });

    it("records no access for a member Quiz's staff added to a group", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      const zedUser = await quizUser(w.db, "q-zed2", { email: "zed2@heig-vd.ch" });
      await w.db.insert(githubAccounts).values({ userId: zedUser, githubUserId: 7777, login: "gh-zed" });
      const zed = randomUUID();
      await w.db.insert(enrollments).values({ id: zed, classroomId: w.progA, nom: "Zed", prenom: "Zed", email: "zed2@heig-vd.ch", userId: zedUser, claimedAt: new Date() });
      await w.db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: ID.beta, groupId: ID.groupBeta, enrollmentId: zed });
      expect((await runImport(w.db, config, snapshot, MAPPING, DECIDED)).outcome).toBe("nothing_to_do");
      expect(await w.db.select().from(projectRepoAccess).where(eq(projectRepoAccess.enrollmentId, zed))).toEqual([]);
    });

    it("never revokes or rewrites an access Quiz already holds", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      const [row] = await w.db.select().from(projectRepoAccess).where(eq(projectRepoAccess.repoId, ID.repoGamma)).limit(1);
      const revokedAt = new Date("2026-10-04T10:00:00Z");
      await w.db.update(projectRepoAccess).set({ revokedAt }).where(eq(projectRepoAccess.id, row!.id));
      const second = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      expect(second.outcome).toBe("nothing_to_do");
      expect((await one(w.db.select().from(projectRepoAccess).where(eq(projectRepoAccess.id, row!.id))))!.revokedAt).toEqual(revokedAt);
      // A revoked grant is said, not counted as carried.
      expect(second.parity.tables.find((t) => t.table === "group repository access")).toMatchObject({ source: 3, carried: 2, leftOut: 1, missing: 0 });
    });

    it("overwrites an untouched group row from classroom and keeps one Quiz renamed, listing it", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      const renamed = (name: string) => variant((s) => { s.groups.find((g) => g.id === ID.groupBeta)!.name = name; });
      const name = async (table: typeof projectGroups | typeof studentGroups, id: string) => (await one(w.db.select({ n: table.name }).from(table).where(eq(table.id, id))))!.n;

      const second = await runImport(w.db, config, renamed("Squad A"), MAPPING, DECIDED);
      expect(second.reimport.overwritten).toEqual({ assignment_groups: 1, "assignment_groups (set)": 1 });
      expect([await name(projectGroups, ID.groupBeta), await name(studentGroups, ID.groupBeta)]).toEqual(["Squad A", "Squad A"]);
      expect((await runImport(w.db, config, renamed("Squad A"), MAPPING, DECIDED)).outcome).toBe("nothing_to_do");

      // The staff renamed the copy's group in Quiz; classroom's changed again: the copy's row is kept, the set's follows.
      await w.db.update(projectGroups).set({ name: "Ours" }).where(eq(projectGroups.id, ID.groupBeta));
      const third = await runImport(w.db, config, renamed("Squad B"), MAPPING, DECIDED);
      expect(third.reimport.kept).toEqual([expect.objectContaining({ table: "assignment_groups", sourceId: ID.groupBeta })]);
      expect([await name(projectGroups, ID.groupBeta), await name(studentGroups, ID.groupBeta)]).toEqual(["Ours", "Squad B"]);
      expect(third.parity.redLines).toEqual([]);
    });

    it("shows the group repository to its members only, through the student view's seat lookup", async () => {
      const w = await world();
      await runImport(w.db, config, snapshot, MAPPING, DECIDED);
      const room = await lines(w.db, w.progA);
      const [sam, sue, sid] = ["s1.student@heig-vd.ch", "s2.student@heig-vd.ch", "s3.student@heig-vd.ch"].map((e) => room.get(e)!) as [string, string, string];
      // A student of the classroom in no group at all.
      const zed = randomUUID();
      const zedUser = await quizUser(w.db, "q-zed", { email: "zed@heig-vd.ch" });
      await w.db.insert(enrollments).values({ id: zed, classroomId: w.progA, nom: "Zed", prenom: "Zed", email: "zed@heig-vd.ch", userId: zedUser, claimedAt: new Date() });

      const [beta] = await w.db.select().from(projects).where(eq(projects.id, ID.beta));
      const [gamma] = await w.db.select().from(projects).where(eq(projects.id, ID.gamma));
      const seats = await seatRepos(w.db, [beta!, gamma!]);
      // Members read their group's repository, whoever created it; Sue keeps her live individual one in Beta.
      expect(seats.of(ID.beta, sam)?.id).toBe(ID.repoGroup);
      expect(seats.of(ID.gamma, sam)?.id).toBe(ID.repoGamma);
      expect(seats.of(ID.gamma, sue)?.id).toBe(ID.repoGamma);
      expect(seats.of(ID.beta, sue)?.id).toBe(ID.repoSueInBeta);
      // Sid's team has no repository yet; Zed is in none: nothing, in either project.
      expect([seats.of(ID.gamma, sid), seats.of(ID.gamma, zed), seats.of(ID.beta, zed)]).toEqual([null, null, null]);
      expect(seats.seat(ID.gamma, sam)).toMatchObject({ groupId: ID.gammaTeam1 });

      // Who reads the repository: the copy's members with an account, never the non-member nor the live individual holder of Beta.
      const gammaRepo = (await w.db.select().from(projectRepos).where(eq(projectRepos.id, ID.repoGamma)))[0]!;
      const betaRepo = (await w.db.select().from(projectRepos).where(eq(projectRepos.id, ID.repoGroup)))[0]!;
      expect((await repoMembers(w.db, gammaRepo, w.progA)).map((m) => m.enrollmentId).sort()).toEqual([sam, sue].sort());
      expect((await repoMembers(w.db, betaRepo, w.progA)).map((m) => m.enrollmentId)).toEqual([sam]);
    });
  });

  describe("pre-flight", () => {
    const run = (edit: (s: SourceSnapshot) => void) =>
      sourcePreflight({ snapshot: variant(edit), mappedClassroomIds: new Set(["c3000000-0000-4000-8000-000000000001", "c3000000-0000-4000-8000-000000000002"]), now: NOW, windowHours: 24, final: false })
        .filter((p) => p.status !== "ok");

    it("finds nothing wrong in the fixture", () => {
      expect(run(() => {})).toEqual([]);
    });

    it("refuses a project worked online, even before the final import, and writes nothing", async () => {
      const lines = run((s) => { s.assignments.find((a) => a.id === ID.alpha)!.workMode = "online_seb"; });
      expect(lines).toEqual([expect.objectContaining({ id: "work-mode", status: "refused" })]);
      const w = await world();
      const before = await everything(w.db);
      const report = await runImport(w.db, config, edited(ID.alpha, (a) => { a.workMode = "online"; }), MAPPING, DECIDED);
      expect(report.outcome).toBe("refused");
      expect(report.refusals[0]).toContain("pre-flight work-mode");
      expect(await everything(w.db)).toEqual(before);
    });

    it("lets a dropped classroom's online project go", () => {
      expect(run((s) => { s.assignments.find((a) => a.id === ID.sandbox)!.workMode = "online"; })).toEqual([]);
    });
  });
});
