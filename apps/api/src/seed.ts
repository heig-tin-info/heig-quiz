/**
 * Development seed (`pnpm seed`). Idempotent: run it as often as you like.
 *
 * It builds the smallest world the application needs to be worth looking at
 * — one course, one classroom, one staff member, six students, one of them
 * with an accommodation — around the personas of the development login.
 * It is NEVER run automatically: a database that fills itself is a database
 * nobody trusts.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { PERSONAS, upsertPersona, type Persona } from "./auth/dev.js";
import { loadConfig } from "./config.js";
import { createDb, type Db } from "./db/client.js";
import { classrooms, courseStaff, courses, enrollments } from "./db/schema.js";
import { MIGRATIONS_DIR } from "./paths.js";

const COURSE = { name: "Programmation C", code: "PRG1" };
const CLASSROOM = { name: "PRG1-2026", period: "2026-A" };
/** Léa gets the accommodation, so the extra-time path is always exercised. */
const TIME_BONUS: Record<string, number> = { lea: 25 };

export async function seed(db: Db, log: (msg: string) => void = console.log) {
  // A tiny Fastify-shaped stub: `upsertPersona` only needs `db`.
  const app = { db } as unknown as FastifyInstance;

  const [course] = await db
    .insert(courses)
    .values({ id: randomUUID(), name: COURSE.name, code: COURSE.code })
    .onConflictDoUpdate({ target: courses.code, set: { name: COURSE.name } })
    .returning();
  log(`course ${course!.code} — ${course!.name}`);

  const teacher = await upsertPersona(app, PERSONAS.find((p) => p.key === "teacher")!);
  await db
    .insert(courseStaff)
    .values({ courseId: course!.id, userId: teacher.id })
    .onConflictDoNothing();
  await upsertPersona(app, PERSONAS.find((p) => p.key === "admin")!);
  log(`staff ${teacher.email}`);

  const [existing] = await db
    .select({ id: classrooms.id })
    .from(classrooms)
    .where(and(eq(classrooms.courseId, course!.id), eq(classrooms.name, CLASSROOM.name)))
    .limit(1);
  const classroomId = existing?.id ?? randomUUID();
  if (!existing) {
    await db.insert(classrooms).values({
      id: classroomId,
      courseId: course!.id,
      name: CLASSROOM.name,
      period: CLASSROOM.period,
    });
  }
  log(`classroom ${CLASSROOM.name}`);

  const students: Persona[] = PERSONAS.filter((p) => p.role === "student");
  for (const persona of students) {
    await db
      .insert(enrollments)
      .values({
        id: randomUUID(),
        classroomId,
        nom: persona.familyName,
        prenom: persona.givenName,
        email: persona.email,
        timeBonusPercent: TIME_BONUS[persona.key] ?? 0,
      })
      .onConflictDoUpdate({
        target: [enrollments.classroomId, enrollments.email],
        set: {
          nom: persona.familyName,
          prenom: persona.givenName,
          timeBonusPercent: TIME_BONUS[persona.key] ?? 0,
        },
      });
    // The account exists from the first dev login; creating it here means
    // the roster is already claimed when the teacher first opens it.
    await upsertPersona(app, persona);
  }
  log(`roster ${students.length} students (${students.filter((p) => TIME_BONUS[p.key]).length} with extra time)`);
}

// `tsx src/seed.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const handle = createDb(config.DATABASE_URL);
  await handle.migrate(MIGRATIONS_DIR);
  await seed(handle.db);
  await handle.close();
  console.log("seed done");
}
