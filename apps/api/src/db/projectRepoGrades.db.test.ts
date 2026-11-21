/**
 * `project_repo_grades` and its migration (`0151_project_repo_grades`, the
 * expand step of the database remediation's Phase 4) against the real
 * migrations: the backfill from `project_repos`' grading columns, read from
 * the shipped SQL as it really runs; the two triggers that keep both copies
 * equal through a rollback to an older image and the roll-forward after it;
 * and the verification query the migration documents, which must find no
 * difference.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "./client.js";
import { projectRepoGrades, projectRepos } from "./schema.js";
import { writeGrades } from "../modules/project/repoGrades.js";
import { testDatabase } from "../test/db.js";
import { seedLive } from "../test/live.js";
import { gradedProject, repoGradesRow } from "../test/project.js";

const MIGRATION = readFileSync(new URL("../../drizzle/0151_project_repo_grades.sql", import.meta.url), "utf8");

/** The migration's verification query, from its header comment: zero rows when the two copies agree. */
const VERIFY = (() => {
  const lines = MIGRATION.split("\n");
  const start = lines.findIndex((line) => line.startsWith("--   SELECT r.id"));
  const end = lines.findIndex((line, i) => i >= start && line.endsWith(";"));
  return lines
    .slice(start, end + 1)
    .map((line) => line.replace(/^-- {3}/, ""))
    .join("\n");
})();

/** `0151` undone: `project_repos` as the migration finds it in production. */
const UNDO = `
  DROP TRIGGER "project_repo_grades_from_legacy" ON "project_repos";
  DROP TABLE "project_repo_grades";
  DROP FUNCTION "project_repo_grades_to_legacy"();
  DROP FUNCTION "project_repo_grades_from_legacy"();`;

const NOW = new Date("2026-11-21T10:00:00Z");

let db: Db;
let client: PGlite;
let classroomId: string;
let teacherId: string;
let studentId: string;

/** A bare repository of its own project: no grading. */
async function repo(): Promise<string> {
  const project = await gradedProject(db, { classroomId, name: "Lab", createdBy: teacherId, released: false });
  const id = randomUUID();
  await db.insert(projectRepos).values({ id, projectId: project.id, userId: studentId, acceptedAt: NOW });
  return id;
}

/** The old columns as an older image reads them, the points as float8 and as text. */
async function legacy(repoId: string) {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT teacher_points, teacher_points::text AS teacher_points_text, teacher_max, teacher_comment, teacher_graded_by,
            grade_adjust_kind, grade_adjust_value, grade_adjust_base, grade_adjust_comment, grade_adjusted_by,
            released_points, released_max, released_grade, released_comment, released_adjustment_comment
       FROM project_repos WHERE id = $1`,
    [repoId],
  );
  return rows[0]!;
}

/** A new-table point column as stored, exactly. */
async function exact(repoId: string, column: string): Promise<string | null> {
  const { rows } = await client.query<{ v: string | null }>(`SELECT ${column}::text AS v FROM project_repo_grades WHERE repo_id = $1`, [repoId]);
  return rows[0]?.v ?? null;
}

const differences = async () => (await client.query<{ id: string }>(VERIFY)).rows.map((r) => r.id);

let released: string;
let adjusted: string;
let commentOnly: string;
let untouched: string;

beforeAll(async () => {
  ({ db, client } = await testDatabase());
  const seeded = await seedLive(db, { students: 1, questions: 0 });
  classroomId = seeded.classroomId;
  teacherId = seeded.teacherId;
  studentId = seeded.studentIds[0]!;

  // Production before the migration: the grading in `project_repos`' own columns.
  await client.exec(UNDO);
  [released, adjusted, commentOnly, untouched] = [await repo(), await repo(), await repo(), await repo()];
  await client.query(
    `UPDATE project_repos SET released_points = 13.75, released_max = 20, released_grade = 4.4,
            released_comment = 'Well done', released_adjustment_comment = 'Bonus for the report',
            grade_adjust_kind = 'relative', grade_adjust_value = 0.3, grade_adjust_base = 4.1,
            grade_adjust_comment = 'Bonus for the report', grade_adjusted_by = $2, grade_adjusted_at = $3
      WHERE id = $1`,
    [released, teacherId, NOW],
  );
  await client.query(
    `UPDATE project_repos SET teacher_points = 7.25, teacher_max = 10, teacher_comment = 'Seen', teacher_graded_by = $2,
            teacher_graded_at = $3, grade_adjust_kind = 'absolute', grade_adjust_value = 5, grade_adjust_base = 4.6,
            grade_adjust_comment = 'Pinned', grade_adjusted_by = $2, grade_adjusted_at = $3
      WHERE id = $1`,
    [adjusted, teacherId, NOW],
  );
  await client.query(`UPDATE project_repos SET released_comment = 'Only a comment' WHERE id = $1`, [commentOnly]);

  for (const statement of MIGRATION.split("--> statement-breakpoint")) await client.exec(statement);
});

describe("0151_project_repo_grades: the backfill", () => {
  it("copies every repository holding a value, exactly, and none other", async () => {
    expect(await repoGradesRow(db, released)).toEqual({
      repoId: released,
      teacherPoints: null,
      teacherMax: null,
      teacherComment: null,
      teacherGradedBy: null,
      teacherGradedAt: null,
      gradeAdjustKind: "relative",
      gradeAdjustValue: 0.3,
      gradeAdjustBase: 4.1,
      gradeAdjustComment: "Bonus for the report",
      gradeAdjustedBy: teacherId,
      gradeAdjustedAt: NOW,
      releasedPoints: 13.75,
      releasedMax: 20,
      releasedGrade: 4.4,
      releasedComment: "Well done",
      releasedAdjustmentComment: "Bonus for the report",
    });
    expect(await repoGradesRow(db, adjusted)).toMatchObject({ teacherPoints: 7.25, teacherMax: 10, teacherComment: "Seen", gradeAdjustKind: "absolute", gradeAdjustValue: 5 });
    expect(await repoGradesRow(db, commentOnly)).toMatchObject({ releasedComment: "Only a comment", releasedPoints: null });
    expect(await repoGradesRow(db, untouched)).toBeUndefined();
    // Exact decimals, not a float's expansion.
    expect([await exact(released, "released_points"), await exact(released, "grade_adjust_value")]).toEqual(["13.75", "0.3"]);
  });

  it("leaves the old columns as they were, and the verification query finds no difference", async () => {
    expect(await legacy(released)).toMatchObject({ released_points: 13.75, released_grade: 4.4, grade_adjust_value: 0.3 });
    expect(await differences()).toEqual([]);
  });
});

describe("0151_project_repo_grades: the code's writes reach the old columns", () => {
  it("copies a write of the new table, without rounding the exact value it keeps", async () => {
    const id = await repo();
    await db.transaction((tx) => writeGrades(tx, id, { teacherPoints: 1 / 3, teacherMax: 1, teacherComment: "A third", teacherGradedBy: teacherId, teacherGradedAt: NOW }));
    // The new table keeps the JavaScript number exactly; the old column holds the same double.
    expect((await repoGradesRow(db, id))!.teacherPoints).toBe(1 / 3);
    expect(await exact(id, "teacher_points")).toBe("0.3333333333333333");
    expect(await legacy(id)).toMatchObject({ teacher_points: 1 / 3, teacher_max: 1, teacher_comment: "A third", teacher_graded_by: teacherId });
    expect(await differences()).toEqual([]);

    // An older image rewriting another column leaves the exact value alone.
    await client.query(`UPDATE project_repos SET teacher_comment = 'A third, seen' WHERE id = $1`, [id]);
    expect(await exact(id, "teacher_points")).toBe("0.3333333333333333");
    expect((await repoGradesRow(db, id))!.teacherComment).toBe("A third, seen");
  });

  it("writes an adjustment whole, and clears it whole", async () => {
    const id = await repo();
    const adjustment = { gradeAdjustKind: "relative", gradeAdjustValue: -0.5, gradeAdjustBase: 5.5, gradeAdjustComment: "Late", gradeAdjustedBy: teacherId, gradeAdjustedAt: NOW } as const;
    await db.transaction((tx) => writeGrades(tx, id, adjustment));
    expect(await legacy(id)).toMatchObject({ grade_adjust_kind: "relative", grade_adjust_value: -0.5, grade_adjust_base: 5.5, grade_adjust_comment: "Late", grade_adjusted_by: teacherId });
    await expect(db.update(projectRepoGrades).set({ gradeAdjustComment: null }).where(eq(projectRepoGrades.repoId, id))).rejects.toThrow();

    const cleared = Object.fromEntries(Object.keys(adjustment).map((key) => [key, null]));
    await db.transaction((tx) => writeGrades(tx, id, cleared));
    // Nothing left: the row goes, the old columns are null again.
    expect(await repoGradesRow(db, id)).toBeUndefined();
    expect(await legacy(id)).toMatchObject({ grade_adjust_kind: null, grade_adjust_value: null, grade_adjusted_by: null });
    expect(await differences()).toEqual([]);
  });

  it("clears the old columns when the row is deleted, and goes with its repository", async () => {
    const id = await repo();
    await db.transaction((tx) => writeGrades(tx, id, { releasedPoints: 8, releasedMax: 10, releasedGrade: 4.5 }));
    await db.delete(projectRepoGrades).where(eq(projectRepoGrades.repoId, id));
    expect(await legacy(id)).toMatchObject({ released_points: null, released_max: null, released_grade: null });

    await db.transaction((tx) => writeGrades(tx, id, { releasedPoints: 8, releasedMax: 10, releasedGrade: 4.5 }));
    await db.delete(projectRepos).where(eq(projectRepos.id, id));
    expect(await repoGradesRow(db, id)).toBeUndefined();
  });
});

describe("0151_project_repo_grades: an older image's writes reach the new table (a rollback)", () => {
  it("creates the row, follows each change, and deletes the row once every value is cleared", async () => {
    const id = await repo();
    // The release of an older image: one statement on the old columns.
    await client.query(`UPDATE project_repos SET released_points = 7.5, released_max = 10, released_grade = 4.8, released_comment = 'Good' WHERE id = $1`, [id]);
    expect(await repoGradesRow(db, id)).toMatchObject({ releasedPoints: 7.5, releasedMax: 10, releasedGrade: 4.8, releasedComment: "Good", teacherPoints: null });

    // Its grade adjustment, whole.
    await client.query(
      `UPDATE project_repos SET grade_adjust_kind = 'absolute', grade_adjust_value = 5.2, grade_adjust_base = 4.8,
              grade_adjust_comment = 'Pinned', grade_adjusted_by = $2, grade_adjusted_at = $3 WHERE id = $1`,
      [id, teacherId, NOW],
    );
    expect(await repoGradesRow(db, id)).toMatchObject({ gradeAdjustKind: "absolute", gradeAdjustValue: 5.2, gradeAdjustedBy: teacherId, releasedPoints: 7.5 });
    expect(await differences()).toEqual([]);

    // The roll-forward reads what the older image wrote: the code's readers.
    await client.query(
      `UPDATE project_repos SET released_points = NULL, released_max = NULL, released_grade = NULL, released_comment = NULL,
              grade_adjust_kind = NULL, grade_adjust_value = NULL, grade_adjust_base = NULL, grade_adjust_comment = NULL,
              grade_adjusted_by = NULL, grade_adjusted_at = NULL WHERE id = $1`,
      [id],
    );
    expect(await repoGradesRow(db, id)).toBeUndefined();
    expect(await differences()).toEqual([]);
  });

  it("copies a repository an older image inserts with its grading (the import's shape)", async () => {
    const project = await gradedProject(db, { classroomId, name: "Imported", createdBy: teacherId, released: true });
    const id = randomUUID();
    await client.query(
      `INSERT INTO project_repos (id, project_id, user_id, accepted_at, teacher_points, released_points, released_max, released_grade)
       VALUES ($1, $2, $3, $4, 9.5, 9.5, 10, 5.8)`,
      [id, project.id, studentId, NOW],
    );
    expect(await repoGradesRow(db, id)).toMatchObject({ teacherPoints: 9.5, teacherMax: null, releasedPoints: 9.5, releasedGrade: 5.8 });
    expect(await differences()).toEqual([]);
  });

  it("does nothing for a write of the other columns", async () => {
    const id = await repo();
    await client.query(`UPDATE project_repos SET ci_status = 'pass' WHERE id = $1`, [id]);
    expect(await repoGradesRow(db, id)).toBeUndefined();
  });
});
