/**
 * The two readers of the gradebook (F-GBOOK-01..05, ADR-074).
 *
 * - {@link staffGradebook}: the staff's table of a classroom loaded through
 *   `staffAccess` — every column (released or not), every claimed student
 *   seat, each cell with its source, the staff marks, every student's mean
 *   over the RELEASED columns that count.
 * - {@link studentGradebook}: the caller's own cells of a classroom loaded
 *   through `readableClassroom`, the gradebook's student exit (05 §5.7):
 *   only what the kinds' student views let a student read, no source, no
 *   comment, no mark of a column not released, the mean only when the
 *   teacher publishes it (the key does not exist otherwise).
 *
 * A grade is read from the activity (`ActivityKind.gradebookEntries`), never
 * recomputed here; a staff mark wins over it (`resolveCell`).
 */
import type { GradebookStaff, GradebookStaffCell, GradebookStudent, GradebookStudentCell } from "@quiz/contracts";
import { cellGrade, gradebookMean, resolveCell, type CellOutcome, type MeanColumn } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import type { classrooms } from "../../db/schema.js";
import { gradebookEntries, studentGradebookEntries } from "../activity/service.js";
import type { GradebookBeneath } from "../activity/kind.js";
import type { ReadableClassroom } from "../guards.js";
import {
  cellKey,
  claimedSeats,
  inOrder,
  marksByCell,
  markOutcome,
  meanPublished,
  settingsOf,
  storedColumns,
  type MarkWithSetter,
} from "./columns.js";

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

/** `GET /app/api/classrooms/:id/gradebook`: the staff's table (F-GBOOK-01, F-GBOOK-02). */
export async function staffGradebook(db: Db, room: typeof classrooms.$inferSelect): Promise<GradebookStaff> {
  const [entries, stored, seats, marks, published] = await Promise.all([
    gradebookEntries(db, room.id),
    storedColumns(db, room.id),
    claimedSeats(db, room.id),
    marksByCell(db, room.id),
    meanPublished(db, room.id),
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
      if (entry.released) counted.push({ weight: settings.weight, counts: settings.counts, cell: outcome });
    }
    return { enrollmentId: seat.enrollmentId, email: seat.email, nom: seat.nom, prenom: seat.prenom, cells, mean: gradebookMean(counted) };
  });
  return {
    classroomId: room.id,
    archived: room.archivedAt !== null,
    meanPublished: published,
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
    })),
    rows,
  };
}

/** What a student's displayed cell counts as in their mean: a grade, an absence, or nothing. */
function outcomeOf(cell: GradebookStudentCell): CellOutcome {
  if (cell.kind === "grade" && cell.grade !== null) return { kind: "grade", grade: cell.grade };
  return cell.kind === "absent" ? { kind: "absent" } : { kind: "empty" };
}

/**
 * `GET /app/api/student/classrooms/:id/gradebook` (F-GBOOK-05): the caller's
 * own cells, through the student view of each kind. A staff seat, or no seat
 * (a teacher in the student view), has no cell and so no column: the same
 * shape, empty. The mean, when published, is computed from the cells AS
 * DISPLAYED — a grade withheld or only indicative is not in it.
 */
export async function studentGradebook(db: Db, scope: ReadableClassroom, userId: string, now: Date): Promise<GradebookStudent> {
  const { room, seat } = scope;
  const published = await meanPublished(db, room.id);
  const meanKey = (mean: number | null) => (published ? { mean } : {});
  if (seat === null || seat.staff) return { classroomId: room.id, columns: [], cells: {}, ...meanKey(null) };

  const [entries, stored, marks] = await Promise.all([
    studentGradebookEntries(db, userId, { enrollmentId: seat.id, userId }, room.id, now),
    storedColumns(db, room.id),
    marksByCell(db, room.id, seat.id),
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
    counted.push({ weight: settings.weight, counts: settings.counts, cell: outcome });
  }
  return {
    classroomId: room.id,
    columns: columns.map(({ entry, settings }) => ({
      kind: entry.kind,
      activityId: entry.activityId,
      mode: entry.mode,
      title: entry.title,
      date: iso(entry.date),
      ...(published ? { weight: settings.weight, counts: settings.counts } : {}),
    })),
    cells,
    ...meanKey(gradebookMean(counted)),
  };
}
