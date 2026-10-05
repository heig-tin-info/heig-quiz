/**
 * The project steps of the heig-classroom import (M8-01b) against the
 * synthetic classroom database of `fixtures/classroom-seed.sql`, part 3.
 *
 * The fixture's projects: Alpha (Prog-A, published; a milestone dispatched
 * and one never confirmed; Sam's, Sue's and Sid's repositories, Sid's still
 * pending), Pair Beta (Prog-A, a group project: a group repository, an
 * individual one live and one pending), Lab 1 (Info1-MI, applied, frozen,
 * `commit` strategy, final review dispatched, released: Sol's repository with
 * its ledger row, Sol Seven's without, and a development account's), and a
 * draft of the dropped Sandbox.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import {
  botCommits,
  classrooms,
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
} from "../src/db/schema.js";
import { testDb } from "../src/test/db.js";
import type { ClassroomMapping } from "./import-classroom/mapping.js";
import { sourcePreflight } from "./import-classroom/preflight.js";
import { REGISTRY, type Registry } from "./import-classroom/registry.js";
import { runImport, type ImportOptions } from "./import-classroom/run.js";
import { readSnapshot, type SourceSnapshot } from "./import-classroom/source.js";

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
  await source.exec(readFileSync(new URL("./fixtures/classroom-seed.sql", import.meta.url), "utf8"));
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
  const tables = [users, importIdMap, importRuns, legacyClassroomAuditLog, projects, projectCheckpoints, projectRepos, projectSyncPrs, projectGradeRuns, botCommits, gradeDispatches, reverts, pushReceipts];
  return Promise.all(tables.map((t) => db.select().from(t).orderBy(sql`1`)));
}

const one = async <T>(rows: Promise<T[]>) => (await rows)[0];

describe("import-classroom projects (M8-01b)", () => {
  it("imports the projects, checkpoints and repositories with every field, and carries everything or says why not", async () => {
    const w = await world();
    const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(report.outcome).toBe("applied");
    expect(report.parity.redLines).toEqual([]);

    // Three projects of the two carried classrooms; the dropped one's draft is not.
    const all = await w.db.select().from(projects).orderBy(projects.slug);
    expect(all.map((p) => p.slug)).toEqual(["alpha", "beta", "lab-1"]);
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
    // A group project comes without its group set: M8-01c's.
    expect(all[1]).toMatchObject({ id: ID.beta, groupMode: true, groupSetId: null, orgId: w.orgs.get(1001) });
    // Released: the release, its author remapped, the freeze NOT on the project (it is the repositories').
    expect(all[2]).toMatchObject({
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

    // Repositories: individual only, the freeze on the repositories, the score of a released project at the import.
    const repos = await w.db.select().from(projectRepos).orderBy(projectRepos.id);
    expect(repos.map((r) => r.id)).toEqual([
      ID.repoSam, ID.repoSol, ID.repoSue, ID.repoSidPending, ID.repoSueInBeta, ID.repoSidInBeta, ID.repoSolSeven,
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

    // Runs: `llm` is `review`, nothing to verify, no parse detail, the group repository's run left out.
    const runs = await w.db.select().from(projectGradeRuns).orderBy(projectGradeRuns.workflowRunId);
    expect(runs.map((r) => [r.workflowRunId, r.kind, r.points, r.max, r.parseStatus, r.toVerify, r.parseDetail, r.afterDeadline])).toEqual([
      [70001, "ci", 4, 6, "ok", false, null, false],
      [70002, "ci", 5, 6, "ok", false, null, false],
      [70003, "review", 5.5, 6, "ok", false, null, false],
      [70004, "ci", 3, 6, "ok", false, null, false],
      [70006, "ci", null, null, "malformed", false, null, true],
    ]);
    expect(runs[3]).toMatchObject({ testsPassed: 6, testsTotal: 10 });
    expect(runs[4]).toMatchObject({ runAttempt: 2 });

    // Bot commits, the restore (heads unknown, never counted as a push's) and the receipts (keyed on GitHub's repository id).
    expect((await w.db.select().from(botCommits)).map((b) => [b.repoId, b.kind]).sort()).toEqual([[ID.repoSam, "revert"], [ID.repoSol, "deadline"]]);
    expect(await w.db.select().from(reverts)).toEqual([
      expect.objectContaining({ repoId: ID.repoSam, revertSha: sha("3"), files: ["README.md"], headSha: null, coveredSha: null, branch: null }),
    ]);
    const receipts = await w.db.select().from(pushReceipts).orderBy(pushReceipts.receivedAt);
    expect(receipts.map((r) => [r.githubRepoId, r.headSha, r.isBot, r.forced])).toEqual([
      [9003, sha("4"), false, false],
      [9001, sha("3"), true, false],
      [9001, sha("1"), false, false],
      [9001, sha("2"), false, true],
    ]);

    // The ledger: the three rows as they are, `milestone` read as `checkpoint`, the unconfirmed one unconfirmed.
    const ledger = await w.db.select().from(gradeDispatches).orderBy(gradeDispatches.createdAt);
    const real = ledger.filter((d) => d.sha !== sha("e"));
    expect(real.map((d) => [d.repoId, d.trigger, d.checkpointId, d.dispatchedAt?.toISOString() ?? null])).toEqual([
      [ID.repoSol, "deadline", null, "2026-09-15T09:00:05.000Z"],
      [ID.repoSam, "checkpoint", ID.midterm, null],
      [ID.repoSue, "checkpoint", ID.midterm, "2026-10-01T08:00:30.000Z"],
    ]);

    // Parity: everything carried or left out with a reason, never lost.
    const tables = Object.fromEntries(report.parity.tables.map((t) => [t.table, t]));
    expect(tables["assignments"]).toMatchObject({ source: 3, carried: 3, leftOut: 0, missing: 0 });
    expect(tables["assignment_milestones"]).toMatchObject({ source: 2, carried: 2, missing: 0 });
    expect(tables["student_repos"]).toMatchObject({ source: 9, carried: 7, leftOut: 2, missing: 0 });
    expect(report.parity.findings.filter((f) => f.check === "student_repos left out").map((f) => f.detail)).toEqual([
      expect.stringContaining("group repository (M8-01c)"),
      expect.stringContaining("its student is not imported"),
    ]);
    expect(tables["student_repos.sync_pr_number"]).toMatchObject({ source: 2, carried: 2, missing: 0 });
    expect(tables["grade_runs"]).toMatchObject({ source: 6, carried: 5, leftOut: 1, missing: 0 });
    expect(tables["bot_commits"]).toMatchObject({ source: 3, carried: 2, leftOut: 1, missing: 0 });
    expect(tables["grade_dispatches"]).toMatchObject({ source: 3, carried: 3, leftOut: 0, missing: 0 });
    expect(tables["reverts"]).toMatchObject({ source: 1, carried: 1, missing: 0 });
    // The group repository's receipt, and the pending repository's (no GitHub id): left out.
    expect(tables["push_receipts"]).toMatchObject({ source: 6, carried: 4, leftOut: 2, missing: 0 });
    expect(report.findings.projects?.some((l) => l.includes("1 push receipt(s) dropped"))).toBe(true);
    // The id map carries the permalinks' ids.
    const mapped = await w.db.select({ t: importIdMap.sourceTable }).from(importIdMap);
    expect(mapped.filter((m) => m.t === "assignments")).toHaveLength(3);
    expect(mapped.filter((m) => m.t === "student_repos")).toHaveLength(7);

    // The checks that read Quiz back said so, each with its evidence.
    const checks = report.parity.findings.filter((f) => f.severity === "info" && !f.check.includes("left out")).map((f) => f.check);
    expect(checks).toEqual(expect.arrayContaining(["repositories per project", "teacher points", "frozen grades", "grade-run links", "latest push receipt"]));
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
      // Alpha in two hours, Lab 1 long past: marked; Beta in December: owed.
      expect(await reminders(w.db)).toEqual({ [ID.alpha]: NOW, [ID.lab1]: NOW, [ID.beta]: null });
      expect(report.findings.projects?.some((l) => l.includes("2 project reminder(s) marked sent"))).toBe(true);
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
