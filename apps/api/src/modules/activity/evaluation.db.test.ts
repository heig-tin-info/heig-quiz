/**
 * The evaluation kind of activity (ADR-035 §2): the classroom is the whole
 * scope of what it lists for staff and shows a student, and a student's
 * cards never leave the classroom asked for.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ActivityList } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { evaluations, users } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedLive, type Seeded } from "../../test/live.js";
import { evaluationActivity } from "./evaluation.js";
import { listForClassroom } from "./service.js";

const NOW = new Date("2026-09-30T09:00:00.000Z");

let db: Db;
let restore: () => void;
let student: string;
let a: Seeded;
let b: Seeded;

async function schedule(evaluationId: string, title: string): Promise<void> {
  await db
    .update(evaluations)
    .set({ state: "scheduled", title, opensAt: new Date(NOW.getTime() + 86_400_000) })
    .where(eq(evaluations.id, evaluationId));
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
  student = randomUUID();
  await db.insert(users).values({
    id: student,
    oidcSub: `test-${student}`,
    email: `student-${student.slice(0, 8)}@heig.test`,
    givenName: "Test",
    familyName: "student",
    role: "student",
  });
  // One student, two classrooms, one scheduled exam in each, and a draft in A.
  a = await seedLive(db, { studentIds: [student] });
  b = await seedLive(db, { studentIds: [student] });
  await schedule(a.evaluationId, "exam A");
  await schedule(b.evaluationId, "exam B");
  await db.insert(evaluations).values({
    id: randomUUID(),
    classroomId: a.classroomId,
    title: "draft A",
    mode: "exercise",
    state: "draft",
    settings: {},
    gradingScale: {},
    feedbackPolicy: {},
  });
  // An anonymous poll of A's teacher: in their Activities, never in a classroom.
  await db.insert(evaluations).values({
    id: randomUUID(),
    createdBy: a.teacherId,
    title: "poll",
    mode: "poll",
    state: "running",
    settings: {},
    gradingScale: {},
    feedbackPolicy: {},
  });
});
afterAll(() => restore());

describe("evaluationActivity", () => {
  it("lists one classroom's evaluations for its staff, drafts included, never an anonymous poll", async () => {
    const rows = ActivityList.parse(await listForClassroom(db, a.classroomId, NOW));
    expect(rows.map((r) => r.title).sort()).toEqual(["draft A", "exam A"]);
    expect(rows.every((r) => r.kind === "evaluation" && r.classroom?.id === a.classroomId)).toBe(true);
  });

  it("lists for a teacher what their seats and polls reach, each row of the evaluation kind", async () => {
    const rows = await evaluationActivity.listForTeacher(db, { id: a.teacherId, role: "teacher" }, NOW);
    expect(rows.map((r) => r.title).sort()).toEqual(["draft A", "exam A", "poll"]);
  });

  it("shows a student the cards of the classroom asked for, and no draft", async () => {
    const cards = await evaluationActivity.studentCards(db, student, a.classroomId, NOW);
    expect(cards.upcoming.map((c) => c.title)).toEqual(["exam A"]);
    expect([...cards.open, ...cards.past, ...cards.polls]).toEqual([]);
    const other = await evaluationActivity.studentCards(db, student, b.classroomId, NOW);
    expect(other.upcoming.map((c) => c.title)).toEqual(["exam B"]);
  });

  it("gives no gradebook entry before a release", async () => {
    expect(await evaluationActivity.gradebookEntries(db, student, a.classroomId)).toEqual([]);
  });
});
