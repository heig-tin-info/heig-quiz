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
  teacherGrants,
  userEmails,
  userIdpClaims,
  users,
} from "../src/db/schema.js";
import { testDb } from "../src/test/db.js";
import type { ClassroomMapping } from "./import-classroom/mapping.js";
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

const DECIDED: ImportOptions = {
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
  const tables = [users, userEmails, userIdpClaims, githubAccounts, teacherGrants, courseStaff, enrollments, importIdMap, importRuns, auditLog];
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

    const seats = await w.db.select({ courseId: courseStaff.courseId, userId: courseStaff.userId }).from(courseStaff);
    expect(seats).toHaveLength(3);
    expect(seats).toEqual(expect.arrayContaining([
      { courseId: w.prog, userId: w.t1 },
      { courseId: w.prog, userId: SRC.a1 },
      { courseId: w.info, userId: w.t1 },
    ]));
    // The assistant's widening is listed, and the seat makes a teacher.
    expect(report.findings.staff?.some((l) => l.includes("assistant") && l.includes("PROG"))).toBe(true);
    expect((await userOf(w.db, eq(users.id, SRC.a1)))?.role).toBe("teacher");
    expect(report.findings.roles?.length).toBeGreaterThan(0);
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

  it("refuses an incomplete mapping, and an --apply without the open decisions", async () => {
    const w = await world();
    const partial = { classrooms: MAPPING.classrooms.slice(0, 2) };
    const report = await runImport(w.db, config, snapshot, partial, {
      apply: true,
      actorEmail: DECIDED.actorEmail,
      mappingSha256: DECIDED.mappingSha256,
    });
    expect(report.outcome).toBe("refused");
    expect(report.refusals).toEqual(expect.arrayContaining([
      expect.stringContaining('mapping incomplete: "Sandbox"'),
      expect.stringContaining("--assistants is an open decision"),
      expect.stringContaining("--missing-students is an open decision"),
    ]));
    expect(report.decisions).toEqual([
      "--assistants=staff (suggested, NOT decided)",
      "--missing-students=enroll (suggested, NOT decided)",
    ]);
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
