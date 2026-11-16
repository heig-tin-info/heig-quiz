/**
 * The two readers of the gradebook (F-GBOOK-01..05, ADR-074), and one
 * column's settings for an activity's own settings, or a template's
 * ({@link columnSettings}).
 *
 * - {@link staffGradebook}: the staff's table of a classroom loaded through
 *   `staffAccess` — every column (released or not), every claimed student
 *   seat, each cell with its source, the staff marks, every student's mean
 *   over the RELEASED columns that count, and the class means (#545): a
 *   released column's, over its cells' grades, and the overall one, over
 *   the students' means.
 * - {@link studentGradebook}: the caller's own cells of a classroom loaded
 *   through `readableClassroom`, the gradebook's student exit (05 §5.7):
 *   only what the kinds' student views let a student read, no source, no
 *   comment, no mark of a column not released, the mean only when the
 *   teacher publishes it (the key does not exist otherwise).
 *
 * A grade is read from the activity (`ActivityKind.gradebookEntries`), never
 * recomputed here; a staff mark wins over it (`resolveCell`). Both readers
 * compute the means with the course's components of the mean, read live
 * (`gradebookMeans`, ADR-131): none is the one-level mean of ADR-074.
 */
import type {
  GradebookColumnParams,
  GradebookColumnSettings,
  GradebookStaff,
  GradebookStaffCell,
  GradebookStudent,
  GradebookStudentCell,
} from "@quiz/contracts";
import { cellGrade, classMean, gradebookMeans, resolveCell, studentCounting, type CellOutcome, type MeanColumn } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { gradebookColumns, type classrooms } from "../../db/schema.js";
import { gradebookEntries, studentGradebookEntries } from "../activity/service.js";
import type { GradebookBeneath } from "../activity/kind.js";
import type { ReadableClassroom } from "../guards.js";
import {
  cellKey,
  claimedSeats,
  columnFactsOf,
  columnOf,
  inOrder,
  marksByCell,
  markOutcome,
  meanPublished,
  settingsOf,
  storedColumns,
  type ColumnScope,
  type MarkWithSetter,
} from "./columns.js";
import { courseComponents, listComponents } from "./components.js";

const NOTHING_BENEATH: GradebookBeneath = {
  outcome: { kind: "empty" },
  points: null,
  max: null,
  source: null,
  changedAfterRelease: false,
  hasGrade: false,
};

function staffCell(beneath: GradebookBeneath, mark: MarkWithSetter | undefined, outcome: CellOutcome): GradebookStaffCell {
  return {
    kind: outcome.kind,
    grade: cellGrade(outcome),
    points: mark ? mark.points : beneath.points,
    max: mark ? mark.max : beneath.max,
    source: mark ? "mark" : beneath.source,
    changedAfterRelease: mark ? false : beneath.changedAfterRelease,
    hasGrade: beneath.hasGrade,
    mark: mark
      ? { kind: mark.kind, points: mark.points, max: mark.max, comment: mark.comment, setBy: mark.setByName, setAt: iso(mark.setAt) }
      : null,
  };
}

/**
 * `GET …/gradebook/columns/:kind/:activityId` (ADR-131 §13): one column's
 * settings, from the draft on — stored, or its mode's defaults — with what
 * an activity's settings need beside them: the course's components, whether
 * the column is released, whether the mean is published. A staff read.
 * `GET /templates/:id/gradebook` too, `scope.room` null (§15): a template is
 * never released and publishes no mean, both false — true of it, and what
 * keeps a settings screen's warnings quiet.
 */
export async function columnSettings(
  db: Db,
  scope: ColumnScope,
  params: Pick<GradebookColumnParams, "kind" | "activityId">,
): Promise<GradebookColumnSettings> {
  const facts = await columnFactsOf(db, scope, params.kind, params.activityId);
  const [[row], components, published] = await Promise.all([
    db.select().from(gradebookColumns).where(columnOf(facts)),
    listComponents(db, scope.course.id),
    scope.room ? meanPublished(db, scope.room.id) : false,
  ]);
  const { weight, counts, componentId } = settingsOf(row, facts.mode);
  return { weight, counts, componentId, released: facts.released, meanPublished: published, components };
}

/** `GET /app/api/classrooms/:id/gradebook`: the staff's table (F-GBOOK-01, F-GBOOK-02). */
export async function staffGradebook(db: Db, room: typeof classrooms.$inferSelect): Promise<GradebookStaff> {
  const [entries, stored, seats, marks, published, components] = await Promise.all([
    gradebookEntries(db, room.id),
    storedColumns(db, room.id),
    claimedSeats(db, room.id),
    marksByCell(db, room.id),
    meanPublished(db, room.id),
    courseComponents(db, room.courseId),
  ]);
  const columns = inOrder(entries.map((entry) => ({ entry, settings: settingsOf(stored.get(entry.activityId), entry.mode) })));
  // The grades of a column are read once released: before, only the staff's marks stand there.
  const beneath = new Map(
    await Promise.all(
      columns.map(async ({ entry }) => [entry.activityId, entry.released ? await entry.staffCells(db, seats) : new Map<string, GradebookBeneath>()] as const),
    ),
  );
  const rows = seats.map((seat) => {
    const cells: GradebookStaff["rows"][number]["cells"] = {};
    const counted: MeanColumn[] = [];
    for (const { entry, settings } of columns) {
      const under = beneath.get(entry.activityId)?.get(seat.enrollmentId) ?? NOTHING_BENEATH;
      const mark = marks.get(cellKey(entry.activityId, seat.enrollmentId));
      const outcome = resolveCell(mark ? markOutcome(mark, entry) : null, under.outcome);
      cells[entry.activityId] = staffCell(under, mark, outcome);
      if (entry.released) counted.push({ weight: settings.weight, counts: settings.counts, componentId: settings.componentId, cell: outcome });
    }
    const means = gradebookMeans(counted, components);
    return { enrollmentId: seat.enrollmentId, email: seat.email, nom: seat.nom, prenom: seat.prenom, cells, mean: means.mean, componentMeans: means.components };
  });
  return {
    classroomId: room.id,
    archived: room.archivedAt !== null,
    meanPublished: published,
    components: components.map(({ id, name, weight }) => ({
      id,
      name,
      weight,
      classMean: classMean(rows.map((row) => row.componentMeans[id] ?? null)),
    })),
    columns: columns.map(({ entry, settings }) => ({
      kind: entry.kind,
      activityId: entry.activityId,
      mode: entry.mode,
      title: entry.title,
      date: iso(entry.date),
      released: entry.released,
      weight: settings.weight,
      counts: settings.counts,
      position: settings.position,
      componentId: settings.componentId,
      // The released grades only, as the screen shows them: a mark in a column not released is not one yet.
      classMean: entry.released ? classMean(rows.map((row) => row.cells[entry.activityId]!.grade)) : null,
    })),
    rows,
    classMean: classMean(rows.map((row) => row.mean)),
  };
}

/** What a student's displayed cell counts as in their mean: a grade, an absence, an excuse, or nothing. */
function outcomeOf(cell: GradebookStudentCell): CellOutcome {
  if (cell.kind === "grade" && cell.grade !== null) return { kind: "grade", grade: cell.grade };
  return cell.kind === "absent" || cell.kind === "excused" ? { kind: cell.kind } : { kind: "empty" };
}

/**
 * `GET /app/api/student/classrooms/:id/gradebook` (F-GBOOK-05): the caller's
 * own cells, through the student view of each kind. A staff seat, or no seat
 * (a teacher in the student view), has no cell and so no column: the same
 * shape, empty. The mean, when published, is computed from the cells AS
 * DISPLAYED — a grade withheld or only indicative is not in it.
 *
 * The components of the mean (ADR-131): the name of the component of each
 * column that counts, always — structure, like the `counts` flag; only the
 * components that hold one of those columns; their weights and the
 * student's own means of them only with the published mean, as the mean.
 */
export async function studentGradebook(db: Db, scope: ReadableClassroom, userId: string, now: Date): Promise<GradebookStudent> {
  const { room, seat } = scope;
  const published = await meanPublished(db, room.id);
  const meanKey = (mean: number | null) => (published ? { mean } : {});
  if (seat === null || seat.staff) return { classroomId: room.id, components: [], columns: [], cells: {}, ...meanKey(null) };

  const [entries, stored, marks, components] = await Promise.all([
    studentGradebookEntries(db, userId, room.id, now),
    storedColumns(db, room.id),
    marksByCell(db, room.id, seat.id),
    courseComponents(db, room.courseId),
  ]);
  const columns = inOrder(entries.map((entry) => ({ entry, settings: settingsOf(stored.get(entry.activityId), entry.mode) })));
  const cells: GradebookStudent["cells"] = {};
  const counted: MeanColumn[] = [];
  for (const { entry, settings } of columns) {
    // A mark is the teacher's word on a released column; its comment and points never reach the student.
    const mark = entry.markShown ? marks.get(cellKey(entry.activityId, seat.id)) : undefined;
    const shown = outcomeOf(entry.cell);
    const outcome = mark ? resolveCell(markOutcome(mark, entry), shown) : shown;
    const cell: GradebookStudentCell = mark
      ? { kind: outcome.kind, grade: cellGrade(outcome), points: null, max: null }
      : entry.cell;
    cells[entry.activityId] = cell;
    counted.push({ weight: settings.weight, counts: settings.counts, componentId: settings.componentId, cell: outcome });
  }
  const means = gradebookMeans(counted, components);
  const studentColumns = columns.map(({ entry, settings }) => {
    // The flag alone always (the tab draws practice apart); the weight with the mean only (ADR-074, 2026-10-13).
    // An excused cell counts in no mean: its column is not drawn with what counts (#969), as on the Grades page;
    // nor is a column in no component of a course that has some (ADR-131).
    const excused = cells[entry.activityId]!.kind === "excused";
    return {
      kind: entry.kind,
      activityId: entry.activityId,
      mode: entry.mode,
      title: entry.title,
      date: iso(entry.date),
      ...studentCounting(settings.counts && !excused, settings.componentId, components.length > 0),
      ...(published ? { weight: settings.weight } : {}),
    };
  });
  return {
    classroomId: room.id,
    components: components
      .filter(({ id }) => studentColumns.some((column) => column.componentId === id))
      .map(({ id, name, weight }) => ({ id, name, ...(published ? { weight, mean: means.components[id] ?? null } : {}) })),
    columns: studentColumns,
    cells,
    ...meanKey(means.mean),
  };
}
