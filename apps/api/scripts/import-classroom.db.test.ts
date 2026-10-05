/**
 * The heig-classroom import (M1-06) against the synthetic classroom database
 * of `fixtures/classroom-seed.sql`, into a Quiz database on PGlite migrated by
 * the real migrations.
 *
 * The fixture, in short: classrooms Prog-A (org #1001, owner Ada, assistant
 * Alan; Sam, Sue, Sid, a pending Syd and Ada's own seat) and Info1-MI (org
 * #1002, owner Ada; Sol, an anonymized student, Carol, a development
 * account), and Sandbox (org #1003,
 * owner Grace; Sky), which every mapping here drops.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { and, count, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import {
  auditLog,
  classrooms,
  courseStaff,
  courses,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  importIdMap,
  importRuns,
  legacyClassroomAuditLog,
  teacherGrants,
  userEmails,
  userIdpClaims,
  users,
} from "../src/db/schema.js";
import { testDb } from "../src/test/db.js";
import type { ClassroomMapping } from "./import-classroom/mapping.js";
import { sourcePreflight } from "./import-classroom/preflight.js";
import { REGISTRY, type Registry } from "./import-classroom/registry.js";
import { formatReport, runImport, type ImportOptions } from "./import-classroom/run.js";
import { readSnapshot, type SourceSnapshot } from "./import-classroom/source.js";

const config = {
  SUPER_ADMIN_EMAIL: "",
  STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch"],
} as unknown as AppConfig;

const SRC = {
  t1: "c1000000-0000-4000-8000-000000000002",
  t2: "c1000000-0000-4000-8000-000000000003",
  a1: "c1000000-0000-4000-8000-000000000004",
  s1: "c1000000-0000-4000-8000-000000000011",
  s3: "c1000000-0000-4000-8000-000000000013",
  s4: "c1000000-0000-4000-8000-000000000014",
  s5: "c1000000-0000-4000-8000-000000000015",
  s7: "c1000000-0000-4000-8000-000000000016",
  progA: "c3000000-0000-4000-8000-000000000001",
};

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

let source: PGlite;
let snapshot: SourceSnapshot;

beforeAll(async () => {
  source = new PGlite();
  await source.exec(readFileSync(new URL("./fixtures/classroom-seed.sql", import.meta.url), "utf8"));
  snapshot = await readSnapshot(async <T>(text: string) => (await source.query<T>(text)).rows);
});

/** A Quiz user with its verified addresses. */
async function quizUser(
  db: Db,
  sub: string,
  opts: { swissEduId?: string; emails?: string[]; role?: "student" | "teacher" | "admin"; givenName?: string },
) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    oidcSub: sub,
    email: opts.emails?.[0] ?? "",
    emailVerified: true,
    givenName: opts.givenName ?? "Quiz",
    swissEduId: opts.swissEduId ?? null,
    role: opts.role ?? "student",
  });
  for (const email of opts.emails ?? []) {
    await db.insert(userEmails).values({ userId: id, email, source: "login", verified: true });
  }
  return id;
}

/**
 * The Quiz side as teachers leave it before the import: two courses, one
 * classroom each, connected to GitHub (`links`: which org each is connected
 * to, by GitHub id; null for none), a few accounts and roster lines.
 */
async function world(links: { progA: number | null; mi: number | null } = { progA: 1001, mi: 1002 }) {
  const db = await testDb();
  const admin = await quizUser(db, "q-admin", { emails: ["quiz.admin@heig-vd.ch"], role: "admin" });
  const t1 = await quizUser(db, "q-t1", { swissEduId: "eid-t1@eduid.ch", emails: ["ada.lovelace@heig-vd.ch"], givenName: "Ada (Quiz)" });
  const s1 = await quizUser(db, "q-s1", { swissEduId: "eid-s1@eduid.ch", emails: ["s1.student@heig-vd.ch"] });
  const s2 = await quizUser(db, "q-s2", { emails: ["s2.student@heig-vd.ch"] });
  const other = await quizUser(db, "q-other", { emails: ["someone@heig-vd.ch"] });

  const prog = randomUUID();
  const info = randomUUID();
  await db.insert(courses).values([
    { id: prog, name: "Programmation", code: "PROG" },
    { id: info, name: "Informatique 1", code: "INFO1" },
  ]);
  const progA = randomUUID();
  const mi = randomUUID();
  await db.insert(classrooms).values([
    { id: progA, courseId: prog, name: "Prog-A" },
    { id: mi, courseId: info, name: "MI-2026" },
  ]);
  await db.insert(courseStaff).values({ courseId: prog, userId: t1 });
  const orgs = new Map<number, string>();
  for (const [githubOrgId, login] of [[1001, "heig-prog-a"], [1002, "heig-info1"]] as const) {
    const id = randomUUID();
    orgs.set(githubOrgId, id);
    await db.insert(githubOrganizations).values({ id, githubOrgId, login, installationId: githubOrgId + 100 });
  }
  for (const [classroomId, org] of [[progA, links.progA], [mi, links.mi]] as const) {
    if (org !== null) await db.insert(githubClassroomLinks).values({ classroomId, orgId: orgs.get(org)!, linkedBy: t1 });
  }

  // GitHub: Sam already linked to the same account (renamed since); Sue to
  // another one; Sid's account (5003) is already someone else's.
  await db.insert(githubAccounts).values([
    { userId: s1, githubUserId: 5001, login: "gh-s1-renamed" },
    { userId: s2, githubUserId: 7002, login: "sue-quiz" },
    { userId: other, githubUserId: 5003, login: "gh-s3" },
  ]);

  // The Quiz rosters: Sam claimed with an accommodation, Sue and Syd pending,
  // Sid absent; Sol pending in MI-2026.
  await db.insert(enrollments).values([
    { id: randomUUID(), classroomId: progA, nom: "One", prenom: "Sam", email: "s1.student@heig-vd.ch", userId: s1, claimedAt: new Date(), timeBonusPercent: 25, note: "keep" },
    { id: randomUUID(), classroomId: progA, nom: "Two", prenom: "Sue", email: "s2.student@heig-vd.ch" },
    { id: randomUUID(), classroomId: progA, nom: "Six", prenom: "Syd", email: "s6.student@heig-vd.ch" },
    { id: randomUUID(), classroomId: mi, nom: "Four", prenom: "Sol", email: "s4.student@heig-vd.ch" },
  ]);
  return { db, admin, t1, s1, s2, other, prog, info, progA, mi };
}

/** Every table the import may write, row by row: equal means nothing written. */
async function everything(db: Db) {
  const tables = [users, userEmails, userIdpClaims, githubAccounts, teacherGrants, courseStaff, enrollments, importIdMap, importRuns, auditLog, legacyClassroomAuditLog];
  return Promise.all(tables.map((t) => db.select().from(t).orderBy(sql`1`)));
}

async function userOf(db: Db, where: ReturnType<typeof eq>) {
  const [row] = await db.select().from(users).where(where);
  return row;
}

describe("import-classroom", () => {
  it("imports people and rosters, and writes nothing the second time", async () => {
    const w = await world();
    const dry = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, apply: false });
    expect(dry.outcome).toBe("rolled_back");
    expect(dry.refusals).toEqual([]);
    expect(Object.keys(dry.written).length).toBeGreaterThan(0);
    const before = await everything(w.db);
    expect(await everything(w.db)).toEqual(before);

    const first = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(first.outcome).toBe("applied");
    expect(first.written).toEqual(dry.written);
    expect(first.identity).toMatchObject({ swissEduId: 2, address: 1, created: 4, ambiguous: 0, excluded: 1, notReached: 3 });
    expect(formatReport(first)).toContain(`classroom ${w.progA}`);

    const afterFirst = await everything(w.db);
    const second = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(second.outcome).toBe("nothing_to_do");
    expect(second.identity).toMatchObject({ alreadyImported: 7, created: 0 });
    expect(await everything(w.db)).toEqual(afterFirst);
    expect(await w.db.select().from(importRuns)).toHaveLength(1);
  });

  it("matches, creates and never rewrites a matched account", async () => {
    const w = await world();
    await runImport(w.db, config, snapshot, MAPPING, DECIDED);

    // Matched: Ada keeps her Quiz sub and profile.
    const ada = await userOf(w.db, eq(users.id, w.t1));
    expect([ada?.oidcSub, ada?.givenName]).toEqual(["q-t1", "Ada (Quiz)"]);
    // Created: the placeholder sub, the classroom id kept.
    const sid = await userOf(w.db, eq(users.id, SRC.s3));
    expect(sid?.oidcSub).toBe("classroom:cr-sub-s3");
    expect(sid?.locale).toBe("fr");
    const anon = await userOf(w.db, eq(users.id, SRC.s7));
    expect(anon?.anonymizedAt).not.toBeNull();
    // ...without the address its anonymization left behind in classroom.
    expect(await w.db.select().from(userEmails).where(eq(userEmails.userId, SRC.s7))).toEqual([]);
    // A development account of classroom is not imported: its placeholder would be adoptable.
    expect(await userOf(w.db, eq(users.oidcSub, "classroom:dev:carol"))).toBeUndefined();
    expect(await w.db.select().from(userEmails).where(eq(userEmails.email, "carol@heig.test"))).toEqual([]);
    // Sue's institutional address, and her private one, now hers in Quiz.
    const sue = await w.db.select({ email: userEmails.email }).from(userEmails).where(eq(userEmails.userId, w.s2));
    expect(sue.map((r) => r.email).sort()).toEqual(["s2.private@mail.test", "s2.student@heig-vd.ch"]);
    // The id map records how.
    const how = await w.db.select({ sourceId: importIdMap.sourceId, how: importIdMap.how }).from(importIdMap).where(eq(importIdMap.sourceTable, "users"));
    expect(Object.fromEntries(how.map((h) => [h.sourceId, h.how]))).toMatchObject({
      [SRC.t1]: "swiss_edu_id",
      "c1000000-0000-4000-8000-000000000012": "address",
      [SRC.s3]: "created",
    });
  });

  it("does not import the people of a dropped classroom", async () => {
    const w = await world();
    const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    for (const id of [SRC.t2, SRC.s5]) expect(await userOf(w.db, eq(users.id, id))).toBeUndefined();
    expect(await userOf(w.db, eq(users.swissEduId, "eid-s5@eduid.ch"))).toBeUndefined();
    const grants = await w.db.select({ email: teacherGrants.email, createdBy: teacherGrants.createdBy }).from(teacherGrants);
    // Grace's grant stays behind; Ada's creator, the classroom admin, is not imported: the actor stands in.
    expect(grants).toEqual([{ email: "ada.lovelace@heig-vd.ch", createdBy: w.admin }]);
    expect(report.mapping.some((l) => l.includes('"Sandbox"') && l.includes("dropped"))).toBe(true);
  });

  it("merges into the existing rosters and staff, keeping Quiz's fields", async () => {
    const w = await world();
    const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    const roster = await w.db
      .select({ email: enrollments.email, userId: enrollments.userId, bonus: enrollments.timeBonusPercent, note: enrollments.note, staff: enrollments.staff })
      .from(enrollments)
      .where(eq(enrollments.classroomId, w.progA))
      .orderBy(enrollments.email);
    expect(roster).toEqual([
      { email: "ada.lovelace@heig-vd.ch", userId: w.t1, bonus: 0, note: null, staff: true },
      { email: "s1.student@heig-vd.ch", userId: w.s1, bonus: 25, note: "keep", staff: false },
      { email: "s2.student@heig-vd.ch", userId: w.s2, bonus: 0, note: null, staff: false },
      { email: "s3.student@heig-vd.ch", userId: SRC.s3, bonus: 0, note: null, staff: false },
      { email: "s6.student@heig-vd.ch", userId: null, bonus: 0, note: null, staff: false },
    ]);
    const mi = await w.db.select({ email: enrollments.email, userId: enrollments.userId }).from(enrollments).where(eq(enrollments.classroomId, w.mi)).orderBy(enrollments.email);
    expect(mi).toEqual([
      // The development account is left out: its line comes in pending.
      { email: "carol@heig.test", userId: null },
      { email: "s4.student@heig-vd.ch", userId: SRC.s4 },
      { email: "s7.student@heig-vd.ch", userId: SRC.s7 },
    ]);

    const seats = await w.db
      .select({ courseId: courseStaff.courseId, userId: courseStaff.userId, role: courseStaff.role })
      .from(courseStaff);
    expect(seats).toHaveLength(3);
    // The classroom's owner owns the course, an assistant seat stays one (D04 (c), ADR-068).
    expect(seats).toEqual(expect.arrayContaining([
      { courseId: w.prog, userId: w.t1, role: "owner" },
      { courseId: w.prog, userId: SRC.a1, role: "assistant" },
      { courseId: w.info, userId: w.t1, role: "owner" },
    ]));
    // The assistant's widening is listed, and the seat makes a teacher.
    expect(report.findings.staff?.some((l) => l.includes("assistant") && l.includes("PROG"))).toBe(true);
    expect((await userOf(w.db, eq(users.id, SRC.a1)))?.role).toBe("teacher");
    expect(report.findings.roles?.length).toBeGreaterThan(0);
  });

  it("makes the owner of a classroom an owner of its course, even from an assistant seat", async () => {
    const w = await world();
    await w.db
      .update(courseStaff)
      .set({ role: "assistant" })
      .where(and(eq(courseStaff.courseId, w.prog), eq(courseStaff.userId, w.t1)));
    await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    const [seat] = await w.db
      .select({ role: courseStaff.role })
      .from(courseStaff)
      .where(and(eq(courseStaff.courseId, w.prog), eq(courseStaff.userId, w.t1)));
    expect(seat?.role).toBe("owner");
  });

  it("carries the GitHub links Quiz does not contradict", async () => {
    const w = await world();
    const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    const links = await w.db.select({ userId: githubAccounts.userId, id: githubAccounts.githubUserId, login: githubAccounts.login }).from(githubAccounts);
    expect(links).toEqual(expect.arrayContaining([
      // New: Ada had none in Quiz.
      { userId: w.t1, id: 4001, login: "ada-gh" },
      // Same pair: skipped, Quiz's login kept.
      { userId: w.s1, id: 5001, login: "gh-s1-renamed" },
      // Sue's Quiz link wins.
      { userId: w.s2, id: 7002, login: "sue-quiz" },
      // Sid's GitHub account stays with whoever holds it in Quiz.
      { userId: w.other, id: 5003, login: "gh-s3" },
    ]));
    expect(links).toHaveLength(4);
    expect(report.findings.github).toHaveLength(2);
    const audited = await w.db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.action, "github.linked"), eq(auditLog.subjectId, w.t1)));
    expect(audited[0]?.n).toBe(1);
  });

  it("reports a duplicate identity and merges nothing", async () => {
    const w = await world();
    // A second Quiz account with Sam's swiss_edu_id.
    await quizUser(w.db, "q-s1-bis", { swissEduId: "eid-s1@eduid.ch" });
    const before = await everything(w.db);
    const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(report.outcome).toBe("refused");
    expect(report.refusals.some((r) => r.startsWith("ambiguous identity: Sam One"))).toBe(true);
    expect(await everything(w.db)).toEqual(before);
    // A dry run still shows the rest, the ambiguous account left out.
    const dry = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, apply: false });
    expect(dry.outcome).toBe("rolled_back");
    expect(dry.identity.ambiguous).toBe(1);
  });

  it("refuses a classroom not connected, or connected to another organization", async () => {
    const w = await world({ progA: null, mi: 1001 });
    const before = await everything(w.db);
    const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(report.outcome).toBe("refused");
    expect(report.refusals).toEqual(expect.arrayContaining([
      expect.stringMatching(/"Prog-A".*not connected to GitHub/),
      expect.stringMatching(/"Info1-MI".*connected to heig-prog-a #1001, not to the classroom's organization/),
    ]));
    expect(await everything(w.db)).toEqual(before);
  });

  it("refuses an incomplete mapping", async () => {
    const w = await world();
    const partial = { classrooms: MAPPING.classrooms.slice(0, 2) };
    const report = await runImport(w.db, config, snapshot, partial, { ...DECIDED, apply: true });
    expect(report.outcome).toBe("refused");
    expect(report.refusals).toEqual([expect.stringContaining('mapping incomplete: "Sandbox"')]);
  });

  it("creates nothing for a missing student or an assistant by default, and lists them", async () => {
    const w = await world();
    const { assistants: _a, missingStudents: _m, ...asked } = DECIDED;
    const report = await runImport(w.db, config, snapshot, MAPPING, asked);
    expect(report.outcome).toBe("applied");
    expect(report.decisions).toEqual([
      "--assistants=skip (default, product owner 2026-10-05)",
      "--missing-students=report (default, product owner 2026-10-05)",
    ]);
    expect(await w.db.select().from(enrollments).where(eq(enrollments.email, "s3.student@heig-vd.ch"))).toEqual([]);
    const seats = await w.db.select({ userId: courseStaff.userId }).from(courseStaff).where(eq(courseStaff.courseId, w.prog));
    expect(seats.map((s) => s.userId)).not.toContain(SRC.a1);
    expect(report.lists.missingStudents.some((l) => l.includes("s3.student@heig-vd.ch"))).toBe(true);
    expect(report.lists.skippedAssistants).toEqual([expect.stringContaining("Alan Turing")]);
    // They are listed on every run, until the rosters are fixed: a second run still names them, writes nothing.
    const again = await runImport(w.db, config, snapshot, MAPPING, asked);
    expect(again.outcome).toBe("nothing_to_do");
    expect(again.lists.missingStudents).toEqual(report.lists.missingStudents);
    // Not red lines: left out on purpose.
    expect(report.parity.redLines).toEqual([]);
    const enrolled = report.parity.tables.find((t) => t.table === "enrollments")!;
    expect(enrolled.leftOut).toBeGreaterThan(0);
    expect(enrolled.missing).toBe(0);
  });

  it("leaves assistants and missing students out when told to", async () => {
    const w = await world();
    const report = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, assistants: "skip", missingStudents: "report" });
    expect(report.outcome).toBe("applied");
    const seats = await w.db.select({ userId: courseStaff.userId }).from(courseStaff).where(eq(courseStaff.courseId, w.prog));
    expect(seats.map((s) => s.userId)).not.toContain(SRC.a1);
    const sid = await w.db.select().from(enrollments).where(eq(enrollments.email, "s3.student@heig-vd.ch"));
    expect(sid).toEqual([]);
    expect(report.findings.enrollments?.some((l) => l.includes("s3.student@heig-vd.ch") && l.includes("not added"))).toBe(true);
  });

  it("never writes the source", async () => {
    const counts = async () => (await source.query<{ n: number }>("SELECT count(*)::int AS n FROM users")).rows[0]?.n;
    const before = await counts();
    const w = await world();
    await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(await counts()).toBe(before);
    // The snapshot's transaction is read-only: a write inside it fails.
    await expect(
      readSnapshot(async <T>(text: string) => {
        const rows = (await source.query<T>(text)).rows;
        if (text.startsWith("SELECT id, oidc_sub")) await source.query("DELETE FROM sessions");
        return rows;
      }),
    ).rejects.toThrow(/read-only/);
  });
});

/** A copy of the snapshot, edited: the source's state changed, nothing else. */
function variant(edit: (s: SourceSnapshot) => void): SourceSnapshot {
  const copy = structuredClone(snapshot);
  edit(copy);
  return copy;
}

const A1 = "c7000000-0000-4000-8000-000000000001";
const HOUR = 3_600_000;

describe("import-classroom frame (M8-01a)", () => {
  it("reads the source's state for the pre-flight", () => {
    expect(snapshot.activity).toMatchObject({
      runningTasks: 0,
      unprocessedWebhooks: 0,
      queue: { readable: true, pending: [] },
    });
    expect(snapshot.assignments).toHaveLength(4);
    expect(snapshot.auditLog).toHaveLength(4);
  });

  it("carries the legacy audit, actors remapped best-effort, and nothing twice", async () => {
    const w = await world();
    const report = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(report.outcome).toBe("applied");
    const rows = await w.db.select().from(legacyClassroomAuditLog).orderBy(legacyClassroomAuditLog.sourceId);
    expect(rows.map((r) => r.action)).toEqual(["classroom.created", "grant.created", "staff.added", "deadline.applied"]);
    // Ada was reached (matched to her Quiz account), the root admin was not, the system has no actor.
    expect(rows.map((r) => r.actorUserId)).toEqual([w.t1, null, SRC.a1, null]);
    expect(rows[1]?.sourceActorUserId).toBe("c1000000-0000-4000-8000-000000000001");
    expect(report.parity.tables.find((t) => t.table === "legacy_classroom_audit_log")).toMatchObject({ source: 4, carried: 4, missing: 0 });
    const before = await everything(w.db);
    expect((await runImport(w.db, config, snapshot, MAPPING, DECIDED)).outcome).toBe("nothing_to_do");
    expect(await everything(w.db)).toEqual(before);
  });

  it("builds a clean parity report and never moves courses, classrooms, organizations or links", async () => {
    const w = await world();
    const count = async () =>
      Promise.all([courses, classrooms, githubOrganizations, githubClassroomLinks].map(async (t) => (await w.db.select().from(t)).length));
    const before = await count();
    const dry = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, apply: false });
    expect(dry.parity.redLines).toEqual([]);
    expect(dry.parity.tables.map((t) => t.table)).toEqual(["enrollments", "legacy_classroom_audit_log", "teacher_grants", "users"]);
    expect(dry.parity.tables.every((t) => t.missing === 0)).toBe(true);
    const applied = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(applied.parity.tables).toEqual(dry.parity.tables);
    expect(await count()).toEqual(before);
    // The report is plain data: it survives JSON.
    expect(JSON.parse(JSON.stringify(applied)).parity.redLines).toEqual([]);
  });

  it("overwrites an untouched row on re-import, and keeps one Quiz modified, listing it", async () => {
    const w = await world();
    await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    const sidId = SRC.s3;
    const sourceOf = (given: string, locale: "en" | "fr") =>
      variant((s) => {
        const u = s.users.find((x) => x.id === sidId)!;
        u.givenName = given;
        u.locale = locale;
      });

    // Untouched in Quiz: classroom's change reaches it.
    const second = await runImport(w.db, config, sourceOf("Sidney", "en"), MAPPING, DECIDED);
    expect(second.outcome).toBe("applied");
    expect(second.reimport.overwritten).toEqual({ users: 1 });
    expect(second.reimport.kept).toEqual([]);
    expect(await userOf(w.db, eq(users.id, sidId))).toMatchObject({ givenName: "Sidney", locale: "en" });
    // ...and the run after it, the source unchanged, writes nothing.
    expect((await runImport(w.db, config, sourceOf("Sidney", "en"), MAPPING, DECIDED)).outcome).toBe("nothing_to_do");

    // Modified in Quiz since (a teacher fixed the name): kept, listed, every time.
    await w.db.update(users).set({ givenName: "Sid (fixed in Quiz)" }).where(eq(users.id, sidId));
    const third = await runImport(w.db, config, sourceOf("Sidonie", "fr"), MAPPING, DECIDED);
    expect(third.outcome).toBe("nothing_to_do");
    expect(third.reimport.kept).toEqual([expect.objectContaining({ table: "users", sourceId: sidId, targetId: sidId })]);
    expect(third.findings.reimport?.[0]).toContain("modified in Quiz");
    expect(await userOf(w.db, eq(users.id, sidId))).toMatchObject({ givenName: "Sid (fixed in Quiz)", locale: "en" });
    expect((await runImport(w.db, config, sourceOf("Sidonie", "fr"), MAPPING, DECIDED)).reimport.kept).toHaveLength(1);
    // Quiz modified it but classroom's side did not change since the last import: nothing to report.
    expect((await runImport(w.db, config, sourceOf("Sidney", "en"), MAPPING, DECIDED)).reimport.kept).toEqual([]);
  });

  it("adopts a baseline for a row an earlier script version wrote, and keeps a row whose baseline no longer matches", async () => {
    const w = await world();
    await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    // An earlier import left no baseline: it equals classroom's, so the first re-import adopts it silently.
    await w.db.update(importIdMap).set({ importedHash: null, sourceHash: null, targetTable: null }).where(eq(importIdMap.sourceId, SRC.s3));
    const adopted = await runImport(w.db, config, snapshot, MAPPING, DECIDED);
    expect(adopted.reimport.kept).toEqual([]);
    expect(adopted.written).toEqual({ "import_classroom.id_map": 1 });
    const [map] = await w.db.select().from(importIdMap).where(eq(importIdMap.sourceId, SRC.s3));
    expect(map?.importedHash).not.toBeNull();

    const changed = variant((s) => {
      s.users.find((x) => x.id === SRC.s3)!.familyName = "Trois";
    });
    await w.db.delete(enrollments).where(eq(enrollments.userId, SRC.s3));
    await w.db.update(importIdMap).set({ importedHash: "stale" }).where(eq(importIdMap.sourceId, SRC.s3));
    const kept = await runImport(w.db, config, changed, MAPPING, DECIDED);
    expect(kept.reimport.kept).toHaveLength(1);
  });

  it("refuses a final apply on the source's state, lists it otherwise", async () => {
    const w = await world();
    const busy = variant((s) => {
      s.activity.unprocessedWebhooks = 2;
      s.activity.runningTasks = 1;
      s.activity.lastWebhookAt = new Date(NOW.getTime() - 60_000);
      s.activity.queue.pending = [{ name: "webhook.process", state: "active", n: 3 }];
    });
    // The first import (not final) goes ahead, the report says what would refuse the last one.
    const first = await runImport(w.db, config, busy, MAPPING, { ...DECIDED, apply: false });
    expect(first.refusals).toEqual([]);
    const states = Object.fromEntries(first.preflight.map((p) => [p.id, p.status]));
    expect(states).toMatchObject({ "source-stopped": "final_only", "queues-empty": "final_only", "webhooks-processed": "final_only", deadlines: "ok", "grade-run-links": "ok", "group-consistency": "ok" });
    expect(first.runbook.length).toBeGreaterThan(0);

    const before = await everything(w.db);
    const final = await runImport(w.db, config, busy, MAPPING, { ...DECIDED, final: true });
    expect(final.outcome).toBe("refused");
    expect(final.refusals).toEqual(expect.arrayContaining([
      expect.stringContaining("pre-flight source-stopped: 1 scheduled task(s) running"),
      expect.stringContaining("pre-flight queues-empty: queue webhook.process: 3 job(s) active"),
      expect.stringContaining("pre-flight webhooks-processed: 2 webhook delivery(ies) not processed"),
    ]));
    expect(await everything(w.db)).toEqual(before);
  });

  describe("pre-flight from the source alone", () => {
    const run = (edit: (s: SourceSnapshot) => void, final = true) => {
      const s = variant(edit);
      return sourcePreflight({
        snapshot: s,
        mappedClassroomIds: new Set(["c3000000-0000-4000-8000-000000000001", "c3000000-0000-4000-8000-000000000002"]),
        now: NOW,
        windowHours: 24,
        final,
      }).filter((p) => p.status !== "ok");
    };
    const deadline = (at: Date, applied: Date | null = null) => (s: SourceSnapshot) => {
      const a = s.assignments.find((x) => x.id === A1)!;
      a.deadlineAt = at;
      a.deadlineAppliedAt = applied;
    };

    it("finds nothing wrong in the fixture", () => {
      expect(run(() => {})).toEqual([]);
    });

    it("refuses a deadline inside the window", () => {
      expect(run(deadline(new Date(NOW.getTime() + 2 * HOUR)))[0]?.problems[0]).toContain("inside the 24 h window");
    });

    it("refuses a deadline overdue and not applied", () => {
      expect(run(deadline(new Date(NOW.getTime() - 10 * 60_000)))[0]?.problems[0]).toContain("not applied");
    });

    it("refuses a deadline applied whose grace is over but not frozen", () => {
      expect(run(deadline(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR)))[0]?.problems[0]).toContain("not frozen");
    });

    it("lets a deadline just past the window, and the dropped classroom's assignments, go", () => {
      expect(run(deadline(new Date(NOW.getTime() + 25 * HOUR)))).toEqual([]);
      expect(run((s) => { s.assignments.find((x) => x.id === "c7000000-0000-4000-8000-000000000004")!.deadlineAt = NOW; })).toEqual([]);
    });

    it("does not take an unreadable queue for an empty one", () => {
      expect(run((s) => { s.activity.queue.readable = false; })[0]?.problems[0]).toContain("not checked");
    });

    it("refuses dangling and foreign grade-run links, even before the final import", () => {
      const links = run((s) => {
        s.studentRepos.find((r) => r.id === "c8000000-0000-4000-8000-000000000001")!.frozenGradeRunId = "c9000000-0000-4000-8000-0000000000ff";
        s.studentRepos.find((r) => r.id === "c8000000-0000-4000-8000-000000000001")!.llmGradeRunId = "c9000000-0000-4000-8000-000000000002";
      }, false);
      expect(links).toEqual([expect.objectContaining({ id: "grade-run-links", status: "refused" })]);
      expect(links[0]?.problems).toEqual([expect.stringContaining("is not a grade run"), expect.stringContaining("belongs to another repository")]);
    });

    it("refuses a group, member or repository of another assignment, even before the final import", () => {
      const groups = run((s) => {
        s.groupMembers[0]!.assignmentId = A1;
        s.studentRepos.find((r) => r.id === "c8000000-0000-4000-8000-000000000002")!.assignmentId = A1;
      }, false);
      expect(groups).toEqual([expect.objectContaining({ id: "group-consistency", status: "refused" })]);
      expect(groups[0]?.problems.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("refuses --apply, even a first one, on a dangling grade-run link", async () => {
    const w = await world();
    const broken = variant((s) => {
      s.studentRepos[0]!.currentGradeRunId = "c9000000-0000-4000-8000-0000000000ff";
    });
    const before = await everything(w.db);
    const report = await runImport(w.db, config, broken, MAPPING, DECIDED);
    expect(report.outcome).toBe("refused");
    expect(report.refusals[0]).toContain("pre-flight grade-run-links");
    expect(await everything(w.db)).toEqual(before);
  });

  it("fails the run on a red line: a dry run reports it, an apply rolls back", async () => {
    const w = await world();
    const registry: Registry = {
      steps: [
        ...REGISTRY.steps,
        // A step that breaks the rule of D20/D22: it writes an organization.
        { name: "rogue", run: async (ctx) => { await ctx.db.insert(githubOrganizations).values({ id: randomUUID(), githubOrgId: 4242, login: "rogue" }); } },
      ],
      checks: [{ name: "custom", run: async () => [{ severity: "red", detail: "mismatch" }, { severity: "warn", detail: "odd" }] }],
    };
    const before = await everything(w.db);
    const dry = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, apply: false, registry });
    expect(dry.outcome).toBe("rolled_back");
    expect(dry.parity.redLines).toEqual([
      expect.stringContaining("github_organizations: 2 row(s) before the import, 3 after"),
      "custom: mismatch",
    ]);
    const applied = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, registry });
    expect(applied.outcome).toBe("red_lines");
    expect(await everything(w.db)).toEqual(before);
    expect(await w.db.select().from(githubOrganizations)).toHaveLength(2);
  });

  it("trips a red line on an UPDATE of a protected table, not only on an insert or delete", async () => {
    const w = await world();
    const registry: Registry = {
      steps: [
        ...REGISTRY.steps,
        { name: "rogue", run: async (ctx) => { await ctx.db.update(courses).set({ name: "Renamed by the import" }).where(eq(courses.id, w.prog)); } },
      ],
      checks: [],
    };
    const report = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, registry });
    expect(report.outcome).toBe("red_lines");
    expect(report.parity.redLines).toEqual([expect.stringContaining("courses: 2 row(s) before the import, 2 after (content changed)")]);
  });

  it("runs GitHub-bound checks after the commit only: 'not run' in a dry run", async () => {
    const w = await world();
    const seen: string[] = [];
    const registry: Registry = {
      steps: REGISTRY.steps,
      checks: [
        {
          name: "repositories exist on GitHub",
          githubBound: true,
          run: async (ctx) => {
            // After the commit: the import's rows are visible through the read transaction.
            seen.push(`${(await ctx.db.select().from(importRuns)).length} run(s)`);
            return [{ severity: "red", detail: "repository missing" }];
          },
        },
      ],
    };
    const dry = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, apply: false, registry });
    expect(seen).toEqual([]);
    expect(dry.parity.notRun).toEqual(["repositories exist on GitHub: not run (dry run)"]);
    expect(dry.parity.redLines).toEqual([]);

    const applied = await runImport(w.db, config, snapshot, MAPPING, { ...DECIDED, registry });
    expect(applied.outcome).toBe("applied");
    expect(seen).toEqual(["1 run(s)"]);
    // A red line found after the commit is reported (exit status 3), the data stays.
    expect(applied.parity.redLines).toEqual(["repositories exist on GitHub: repository missing"]);
    expect(applied.parity.notRun).toEqual([]);
    expect(await w.db.select().from(importRuns)).toHaveLength(1);
  });
});
