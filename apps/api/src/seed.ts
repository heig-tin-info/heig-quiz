/**
 * Development seed (`pnpm seed`). Idempotent: run it as often as you like.
 *
 * It builds the world the application needs to be worth looking at — one
 * course, one classroom, one staff member, six students, two question pools
 * and four evaluations in every interesting state, including one that has
 * already run and been graded — around the personas of the development login.
 * It is NEVER run automatically: a database that fills itself is a database
 * nobody trusts.
 *
 * Everything past the organisation goes through the ordinary services
 * (`seed/demo.ts`), so a seeded row is a row the application itself would
 * have written. The demo CONTENT — French questions on C and electronics —
 * lives in `seed/content.ts`.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { PERSONAS, upsertPersona, type Persona } from "./auth/dev.js";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { createDb, type Db } from "./db/client.js";
import { classrooms, courseStaff, courses, enrollments } from "./db/schema.js";
import { UnavailableRunner } from "./modules/runner/unavailable.js";
import { MIGRATIONS_DIR } from "./paths.js";
import { seedDemoContent } from "./seed/demo.js";

const COURSE = { name: "Programmation C", code: "PRG1" };
const CLASSROOM = { name: "PRG1-2026", period: "2026-A" };
/** Léa gets the accommodation, so the extra-time path is always exercised. */
const TIME_BONUS: Record<string, number> = { lea: 25 };

/**
 * A Fastify-shaped stub carrying what the services below actually read: the
 * database, the clock, the runner and a logger. `boss: null` is a real
 * configuration, not a failure — the grading pass then runs inline
 * (`modules/grading/jobs.ts`), which is what lets the seed wait for it.
 */
function seedApp(db: Db, log: (msg: string) => void): FastifyInstance {
  const noop = () => {};
  return {
    db,
    boss: null,
    clock: systemClock,
    // No container engine is assumed: a `code` answer is graded as a
    // proposal with reason `runner_unavailable` (decision D14).
    runner: new UnavailableRunner("seed"),
    log: {
      info: noop,
      warn: noop,
      error: (obj: unknown) => log(`  ! ${String(obj)}`),
      debug: noop,
    },
  } as unknown as FastifyInstance;
}

export async function seed(db: Db, log: (msg: string) => void = console.log) {
  const app = seedApp(db, log);
  const now = systemClock.now();

  const [course] = await db
    .insert(courses)
    .values({ id: randomUUID(), name: COURSE.name, code: COURSE.code })
    .onConflictDoUpdate({ target: courses.code, set: { name: COURSE.name } })
    .returning();
  log(`course       ${course!.code} — ${course!.name}`);

  const teacher = await upsertPersona(app, PERSONAS.find((p) => p.key === "teacher")!);
  await db
    .insert(courseStaff)
    .values({ courseId: course!.id, userId: teacher.id })
    .onConflictDoNothing();
  await upsertPersona(app, PERSONAS.find((p) => p.key === "admin")!);
  log(`staff        ${teacher.email}`);

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
  log(`classroom    ${CLASSROOM.name}`);

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
  log(
    `roster       ${students.length} students (${students.filter((p) => TIME_BONUS[p.key]).length} with extra time)`,
  );

  const counts = await seedDemoContent(
    app,
    { courseId: course!.id, courseCode: course!.code, classroomId, teacherId: teacher.id },
    now,
  );
  log(
    `pools        +${counts.pools} pools, +${counts.categories} categories, +${counts.questions} published questions`,
  );
  log(`evaluations  +${counts.evaluations} (draft, scheduled, lobby, closed)`);
  log(
    `attempts     +${counts.attempts} attempts, ${counts.gradings} standing gradings on "Test 0 — bases du C"`,
  );
  log(`             results left UNRELEASED: the panel has proposals to validate`);
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
