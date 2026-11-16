/**
 * 5d. The classroom's gradebook (F-GBOOK, ADR-074; screens M5-04): the
 * staff's table with its writes — a mark (an absence `a1.0`, the teacher's
 * own score, `409 grade_exists` over a real grade until `override`, `403
 * owner_required` for an assistant replacing a released grade, `422
 * score_above_max`), a column's weight and whether it counts, the published
 * mean — and the student's own cells. All checked by `contract.test.ts`.
 *
 * It decides what the server decides, with the same pure rules (`resolveCell`,
 * `gradebookMeans`, `classMean` of `@quiz/domain`): a column not released shows no grade of
 * its activity (a staff mark stands there) and stays out of the mean; an
 * exam released and not taken is a derived absence; the student's cells are
 * the narrowed ones — `withheld` under the feedback policy `none`,
 * `indicative` (points, no grade) before the release.
 *
 * PRG1-2026 (`r1`) and PRG1-2024 (`r6`, archived: read-only) have six
 * columns — two exams, an exercise (not counted by default), a project, an
 * exam not released and an exam released under the policy `none` — over
 * their claimed students; every other classroom has none (the empty state).
 * The student persona is the claimed student of `ME_LINE`: a grade, a
 * derived absence, an indicative cell, a withheld one.
 *
 * The components of the mean of a course (ADR-131), with their routes: none
 * by default; `?components=1` gives PRG1 "Cours" and "Labo" at 50 % each,
 * the exams in Cours, the project in Labo, and the quick test, which counts,
 * in none — so it counts in no mean, the state the matrix warns about. EMB
 * never has any. The means are `gradebookMeans`', never the mock's own.
 * PRG1-2026's mean starts published; `?unpublished=1` starts it withheld.
 *
 * A column's settings from the draft on (ADR-131 §13): the mock's own
 * evaluations and projects are not the book's columns, so their settings
 * are kept apart (`STORED`), read and written by the same routes — the
 * `draft` exam reads its defaults, the `released` one asks before it moves
 * PRG1's published mean.
 *
 * Below `groups.ts`, whose `ME_LINE` it reads; it reads `evaluation.ts`'s
 * evaluations and `project.ts`'s projects, which its import evaluates first.
 */
import {
  GradebookColumnPatch,
  GradebookComponentCreate,
  GradebookComponentPatch,
  GradebookMarkPut,
  GradebookSettingsPatch,
  type GradebookColumn,
  type GradebookColumnSettings,
  type GradebookComponents,
  type GradebookMark,
  type GradebookStaff,
  type GradebookStaffCell,
  type GradebookStudent,
  type GradebookStudentCell,
} from "@quiz/contracts";
import {
  cellGrade,
  classMean,
  countsByDefault,
  evaluationColumnKind,
  gradebookMeans,
  gradeFromPoints,
  resolveCell,
  studentCounting,
  type CellOutcome,
  type GradebookMarkKind,
  type GradebookMeans,
  type MarkOutcome,
  type MeanColumn,
  type MeanComponent,
  WEIGHT_DEFAULT,
} from "@quiz/domain";

import { findEvaluation } from "./evaluation";
import { ME_LINE } from "./groups";
import { classroomRoster, courseOr404, rooms } from "./org";
import { projectColumnOf } from "./project";
import { D, flags, iso, MockPayload, on, refuse, role } from "./runtime";

/** What lies beneath a cell of an activity: the activity's own result for one student. */
type Beneath =
  | { kind: "grade"; grade: number; points: number; max: number }
  | { kind: "absent" }
  | { kind: "empty" };

interface MockMark {
  kind: GradebookMarkKind;
  points: number | null;
  max: number | null;
  comment: string | null;
  setAt: string;
}

interface MockColumn extends Omit<GradebookColumn, "classMean"> {
  /** The feedback policy `none`: released, but a student reads no grade. */
  withheld: boolean;
  /** The activity's result per student (a roster line), whatever the release says. */
  beneath: Map<string, Beneath>;
}

interface MockBook {
  meanPublished: boolean;
  columns: MockColumn[];
  /** By `${activityId}|${rosterLine}`. */
  marks: Map<string, MockMark>;
}

const BOOKS = new Map<string, MockBook>();
const SCALE = { rounding: "nearest" as const };

/** A stable pseudo-random in [0, 1): never the mock's shared RNG, whose sequence the other sections depend on. */
const noise = (a: number, b: number): number => {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

const colId = (n: number) => `9b000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A component of the mean as the mock keeps it: its order is the array's. */
type MockComponent = MeanComponent & { name: string };

/** PRG1's two components under `?components=1`. */
const COURS = "9c000000-0000-4000-8000-000000000001";
const LABO = "9c000000-0000-4000-8000-000000000002";

/** By course id. */
const COMPONENTS = new Map<string, MockComponent[]>();
const componentsOf = (courseId: string): MockComponent[] => {
  if (!COMPONENTS.has(courseId)) {
    COMPONENTS.set(
      courseId,
      flags.components && courseId === "c1"
        ? [
            { id: COURS, name: "Cours", weight: 50 },
            { id: LABO, name: "Labo", weight: 50 },
          ]
        : [],
    );
  }
  return COMPONENTS.get(courseId)!;
};

interface Spec {
  n: number;
  title: string;
  mode: GradebookColumn["mode"];
  kind: GradebookColumn["kind"];
  daysAgo: number;
  released: boolean;
  weight: number;
  withheld?: boolean;
  /** Its component under `?components=1`; none by default. */
  component?: string;
}

const SPECS: Spec[] = [
  { n: 1, title: "Examen 1 : numération, types et outils", mode: "exam", kind: "evaluation", daysAgo: 42, released: true, weight: 50, component: COURS },
  { n: 2, title: "Test 2 — Pointeurs", mode: "exam", kind: "evaluation", daysAgo: 28, released: true, weight: 100, component: COURS },
  { n: 3, title: "Exercices — Boucles", mode: "exercise", kind: "evaluation", daysAgo: 21, released: true, weight: 100 },
  { n: 4, title: "Labo 1 — Calculatrice", mode: "project", kind: "project", daysAgo: 14, released: true, weight: 40, component: LABO },
  { n: 5, title: "Test 3 — Tableaux", mode: "exam", kind: "evaluation", daysAgo: 3, released: false, weight: 100, component: COURS },
  // Counted, and left in no component: in no mean once the course has components.
  { n: 6, title: "Test éclair — Révision", mode: "exam", kind: "evaluation", daysAgo: 35, released: true, weight: 10, withheld: true },
];

/** The activity's own result of student `i` (an index into the classroom's students) in column `spec`. */
function beneathOf(spec: Spec, i: number, me: number): Beneath {
  const r = noise(spec.n, i);
  const grade = Math.round((2.5 + r * 3.5) * 10) / 10;
  const result = { kind: "grade" as const, grade, points: Math.round(((grade - 1) / 5) * 20 * 2) / 2, max: 20 };
  switch (spec.n) {
    case 1:
      return i % 11 === 5 ? { kind: "absent" } : result;
    // The student persona missed the second exam: their `a1.0`, derived.
    case 2:
      return i === me || i === 3 ? { kind: "absent" } : result;
    case 3:
      return r < 0.6 ? result : { kind: "empty" };
    case 4:
      return i % 9 === 2 ? { kind: "empty" } : result;
    default:
      return result;
  }
}

/** The claimed student seats of a classroom (the student persona's line always is one). */
const seatsOf = (roomId: string) => classroomRoster(roomId).filter((s) => s.status === "claimed" || s.id === ME_LINE);

function buildBook(roomId: string): MockBook | null {
  const room = rooms.find((r) => r.id === roomId);
  if (!room || (roomId !== "r1" && roomId !== "r6")) return null;
  const students = seatsOf(roomId);
  const me = students.findIndex((s) => s.id === ME_LINE);
  const columns: MockColumn[] = SPECS.map((spec) => ({
    kind: spec.kind,
    activityId: colId(spec.n + (roomId === "r6" ? 100 : 0)),
    mode: spec.mode,
    title: spec.title,
    date: iso(-spec.daysAgo * D),
    released: spec.released,
    weight: spec.weight,
    counts: countsByDefault(spec.mode),
    position: null,
    componentId: flags.components ? (spec.component ?? null) : null,
    withheld: spec.withheld ?? false,
    beneath: new Map(students.map((s, i) => [s.id, beneathOf(spec, i, me)])),
  }));
  const book: MockBook = { meanPublished: roomId === "r1" && !flags.unpublished, columns, marks: new Map() };
  const mark = (col: number, student: number, m: Omit<MockMark, "setAt" | "comment">) => {
    const line = students[student]?.id;
    if (line) book.marks.set(`${columns[col]!.activityId}|${line}`, { comment: null, setAt: iso(-D), ...m });
  };
  // A staff absence on the exercise, a score for a student who never handed the project in, and one in the column not released.
  mark(2, 4, { kind: "absent", points: null, max: null });
  mark(3, 2, { kind: "score", points: 8, max: 10 });
  mark(4, 1, { kind: "score", points: 15, max: 20 });
  // An excused student (#969): named, and in no mean.
  mark(0, 5, { kind: "excused", points: null, max: null });
  return book;
}

const bookOf = (roomId: string): MockBook | null => {
  if (!BOOKS.has(roomId)) {
    const book = buildBook(roomId);
    if (book) BOOKS.set(roomId, book);
  }
  return BOOKS.get(roomId) ?? null;
};

const key = (column: MockColumn, line: string) => `${column.activityId}|${line}`;

/** The outcome a stored mark gives a cell. */
const markOutcome = (m: MockMark): MarkOutcome =>
  m.kind === "score" ? { kind: "score", grade: gradeFromPoints(m.points ?? 0, m.max ?? 1, SCALE) } : { kind: m.kind };

/** What lies beneath a cell as a student reads it: nothing before the release. */
const shown = (column: MockColumn, line: string): Beneath =>
  column.released ? (column.beneath.get(line) ?? { kind: "empty" }) : { kind: "empty" };

const outcomeOfBeneath = (b: Beneath): CellOutcome => (b.kind === "grade" ? { kind: "grade", grade: b.grade } : { kind: b.kind });

function staffCell(column: MockColumn, line: string, book: MockBook): GradebookStaffCell {
  const under = shown(column, line);
  const stored = book.marks.get(key(column, line));
  const outcome = resolveCell(stored ? markOutcome(stored) : null, outcomeOfBeneath(under));
  const mark: GradebookMark | null = stored
    ? {
        kind: stored.kind,
        points: stored.points,
        max: stored.max,
        comment: stored.comment,
        setBy: "Ada Lovelace",
        setAt: stored.setAt,
      }
    : null;
  const underPoints = under.kind === "grade" ? { points: under.points, max: under.max } : { points: null, max: null };
  return {
    kind: outcome.kind,
    grade: cellGrade(outcome),
    points: stored ? stored.points : underPoints.points,
    max: stored ? stored.max : underPoints.max,
    source: stored ? "mark" : under.kind === "grade" ? (column.kind === "project" ? "teacher" : "results") : under.kind === "absent" ? "derived" : null,
    changedAfterRelease: false,
    hasGrade: under.kind === "grade",
    mark,
  };
}

/** What a displayed cell counts as in the mean: a grade, an absence, an excuse, or nothing. */
const displayed = (cell: { kind: string; grade: number | null }): CellOutcome =>
  cell.kind === "grade" && cell.grade !== null
    ? { kind: "grade", grade: cell.grade }
    : cell.kind === "absent" || cell.kind === "excused"
      ? { kind: cell.kind }
      : { kind: "empty" };

/** A student's means over the released columns, with the course's components (ADR-131), as the server's. */
const meansOf = (columns: MockColumn[], outcomes: Map<string, CellOutcome>, components: readonly MeanComponent[]): GradebookMeans =>
  gradebookMeans(
    columns
      .filter((c) => c.released)
      .map((c): MeanColumn => ({ weight: c.weight, counts: c.counts, componentId: c.componentId, cell: outcomes.get(c.activityId) ?? { kind: "empty" } })),
    components,
  );

function staffTable(room: (typeof rooms)[number], book: MockBook): GradebookStaff {
  const students = seatsOf(room.id);
  const components = componentsOf(room.courseId);
  const rows = students
      .slice()
      .sort((a, b) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`))
      .map((s) => {
        const cells: GradebookStaff["rows"][number]["cells"] = {};
        const outcomes = new Map<string, CellOutcome>();
        for (const column of book.columns) {
          const cell = staffCell(column, s.id, book);
          cells[column.activityId] = cell;
          outcomes.set(
            column.activityId,
            displayed(cell),
          );
        }
        const means = meansOf(book.columns, outcomes, components);
        return { enrollmentId: s.id, email: s.email, nom: s.nom, prenom: s.prenom, cells, mean: means.mean, componentMeans: means.components };
      });
  return {
    classroomId: room.id,
    archived: room.archivedAt !== null,
    meanPublished: book.meanPublished,
    components: components.map((c) => ({ ...c, classMean: classMean(rows.map((row) => row.componentMeans[c.id] ?? null)) })),
    columns: book.columns.map(({ withheld: _w, beneath: _b, ...column }) => ({
      ...column,
      classMean: column.released ? classMean(rows.map((row) => row.cells[column.activityId]!.grade)) : null,
    })),
    rows,
    classMean: classMean(rows.map((row) => row.mean)),
  };
}

function parsed<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { message: string } } },
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new MockPayload(400, { error: "validation", message: result.error.message });
  return result.data;
}

/** The classroom of a staff route, with its book: a student, an unknown classroom or one without a gradebook is a 404. */
function staffBook(id: string) {
  const room = rooms.find((r) => r.id === id);
  if (role === "student" || !room) throw new MockPayload(404, { error: "not_found", message: "Not found" });
  const book = bookOf(id);
  return { room, book: book ?? { meanPublished: false, columns: [], marks: new Map() } satisfies MockBook };
}

/** The staff table of a classroom, as its GET answers: what the assistant's results reader reads (`assist.ts`). */
export function staffGradebookOf(id: string): GradebookStaff {
  const { room, book } = staffBook(id);
  return staffTable(room, book);
}

const writable = (room: (typeof rooms)[number]) => {
  if (room.archivedAt) throw refuse(409, "classroom_archived", "The classroom is archived: its gradebook is read-only");
};

const columnOr404 = (book: MockBook, activityId: string): MockColumn => {
  const column = book.columns.find((c) => c.activityId === activityId);
  if (!column) throw new MockPayload(404, { error: "not_found", message: "Not found" });
  return column;
};

const lineOr404 = (room: (typeof rooms)[number], eid: string): string => {
  if (!seatsOf(room.id).some((s) => s.id === eid)) {
    throw new MockPayload(404, { error: "not_found", message: "Not found" });
  }
  return eid;
};

on("GET", "/app/api/classrooms/:id/gradebook", (m) => staffGradebookOf(m.groups!.id!));

on("PATCH", "/app/api/classrooms/:id/gradebook", (m, raw) => {
  const { room, book } = staffBook(m.groups!.id!);
  writable(room);
  book.meanPublished = parsed(GradebookSettingsPatch, raw).meanPublished;
  return staffTable(room, book);
});

/** A column's stored settings. */
type SettingsRow = Pick<GradebookColumn, "weight" | "counts" | "componentId">;

/**
 * The settings of the activities the book draws no column of — the mock's
 * own evaluations and projects, drafts included (ADR-131 §13) — by activity
 * id, from their first write; their mode's defaults before it.
 */
const STORED = new Map<string, SettingsRow>();

/**
 * `columnFacts` of the server: an exam or an exercise of the classroom in
 * any state, a graded project of it not archived; anything else, a poll
 * included, is the 404 of a missing column.
 */
function columnFacts(roomId: string, kind: string, activityId: string): { mode: GradebookColumn["mode"]; released: boolean } {
  if (kind === "evaluation") {
    const e = findEvaluation(activityId);
    if (e && e.classroomId === roomId && e.mode !== "poll") return { mode: evaluationColumnKind(e.mode), released: e.releasedAt !== null };
  } else {
    const p = projectColumnOf(activityId);
    if (p && p.classroomId === roomId) return { mode: "project", released: p.released };
  }
  throw new MockPayload(404, { error: "not_found", message: "Not found" });
}

/** An activity's column settings, from the draft on: the book's column itself, else the stored row or its mode's defaults; `stored` once written. */
function settingsOf(roomId: string, book: MockBook, kind: string, activityId: string): { row: SettingsRow; released: boolean; stored: boolean } {
  const column = book.columns.find((c) => c.activityId === activityId);
  if (column) return { row: column, released: column.released, stored: true };
  const facts = columnFacts(roomId, kind, activityId);
  const row = STORED.get(activityId);
  return {
    row: row ?? { weight: WEIGHT_DEFAULT, counts: countsByDefault(facts.mode), componentId: null },
    released: facts.released,
    stored: row !== undefined,
  };
}

on("GET", "/app/api/classrooms/:id/gradebook/columns/:kind/:activityId", (m) => {
  const { room, book } = staffBook(m.groups!.id!);
  const { row, released } = settingsOf(room.id, book, m.groups!.kind!, m.groups!.activityId!);
  return {
    weight: row.weight,
    counts: row.counts,
    componentId: row.componentId,
    released,
    meanPublished: book.meanPublished,
    components: componentList(room.courseId),
  } satisfies GradebookColumnSettings;
});

on("PATCH", "/app/api/classrooms/:id/gradebook/columns/:kind/:activityId", (m, raw) => {
  const { room, book } = staffBook(m.groups!.id!);
  writable(room);
  const activityId = m.groups!.activityId!;
  const { row, stored } = settingsOf(room.id, book, m.groups!.kind!, activityId);
  const patch = parsed(GradebookColumnPatch, raw);
  // Another course's component is the 404 of a missing one (ADR-131 §2).
  if (patch.componentId && !componentsOf(room.courseId).some((c) => c.id === patch.componentId)) {
    throw new MockPayload(404, { error: "not_found", message: "Component not found" });
  }
  if (patch.weight !== undefined) row.weight = patch.weight;
  if (patch.counts !== undefined) row.counts = patch.counts;
  if (patch.componentId !== undefined) row.componentId = patch.componentId;
  // The first write materializes the row, as the server's does.
  if (!stored) STORED.set(activityId, row);
  return staffTable(room, book);
});

on("PUT", "/app/api/classrooms/:id/gradebook/columns/:kind/:activityId/marks/:eid", (m, raw) => {
  const { room, book } = staffBook(m.groups!.id!);
  writable(room);
  const column = columnOr404(book, m.groups!.activityId!);
  const line = lineOr404(room, m.groups!.eid!);
  const body = parsed(GradebookMarkPut, raw);
  if (body.kind === "score" && body.points > body.max) {
    throw refuse(422, "score_above_max", "The score is above its maximum");
  }
  const over = column.beneath.get(line)?.kind === "grade" && column.released;
  const replacing = book.marks.has(key(column, line));
  if (over && !replacing && !body.override) {
    throw refuse(409, "grade_exists", "A grade already stands in this cell; send it again with override");
  }
  book.marks.set(key(column, line), {
    kind: body.kind,
    points: body.kind === "score" ? body.points : null,
    max: body.kind === "score" ? body.max : null,
    comment: body.comment ?? null,
    setAt: iso(0),
  });
  return staffTable(room, book);
});

on("DELETE", "/app/api/classrooms/:id/gradebook/columns/:kind/:activityId/marks/:eid", (m) => {
  const { room, book } = staffBook(m.groups!.id!);
  writable(room);
  const column = columnOr404(book, m.groups!.activityId!);
  book.marks.delete(key(column, lineOr404(room, m.groups!.eid!)));
  return staffTable(room, book);
});

// ---------------------------------------------------------------- the student's own cells

/** One student cell, narrowed as the server narrows it: no source, no comment, no unreleased grade. */
function studentCell(column: MockColumn, line: string, book: MockBook): GradebookStudentCell {
  const under = column.beneath.get(line) ?? { kind: "empty" as const };
  if (!column.released) {
    // Not released: the points the feedback page already shows, never a grade.
    return under.kind === "grade"
      ? { kind: "indicative", grade: null, points: under.points, max: under.max }
      : { kind: "empty", grade: null, points: null, max: null };
  }
  const stored = book.marks.get(key(column, line));
  const outcome = resolveCell(stored ? markOutcome(stored) : null, outcomeOfBeneath(under));
  // The policy `none` withholds the activity's grade, not a mark of the teacher's.
  if (column.withheld && !stored && under.kind === "grade") {
    return { kind: "withheld", grade: null, points: null, max: null };
  }
  return { kind: outcome.kind, grade: cellGrade(outcome), points: null, max: null };
}

on("GET", "/app/api/student/classrooms/:id/gradebook", (m) => {
  const room = rooms.find((r) => r.id === m.groups!.id);
  if (!room) throw new MockPayload(404, { error: "not_found", message: "Not found" });
  const book = bookOf(room.id);
  const published = book?.meanPublished ?? false;
  // A teacher in the student view holds no seat to read: the same shape, empty.
  if (!book || role !== "student") {
    return { classroomId: room.id, components: [], columns: [], cells: {}, ...(published ? { mean: null } : {}) } satisfies GradebookStudent;
  }
  const cells: GradebookStudent["cells"] = {};
  const outcomes = new Map<string, CellOutcome>();
  const columns = book.columns.filter((c) => c.kind === "evaluation" || c.released);
  for (const column of columns) {
    const cell = studentCell(column, ME_LINE, book);
    cells[column.activityId] = cell;
    outcomes.set(
      column.activityId,
      displayed(cell),
    );
  }
  const components = componentsOf(room.courseId);
  const means = meansOf(columns, outcomes, components);
  // What the student reads of each column: whether it counts, and where (ADR-131 §7); an excused cell counts in no mean (#969), as on the server.
  const counting = new Map(
    columns.map((c) => [c.activityId, studentCounting(c.counts && cells[c.activityId]?.kind !== "excused", c.componentId, components.length > 0)]),
  );
  return {
    classroomId: room.id,
    // Only the components that hold one of the student's columns that count; their weight and mean with the published mean only.
    components: components
      .filter((component) => [...counting.values()].some((it) => it.componentId === component.id))
      .map((component) => ({
        id: component.id,
        name: component.name,
        ...(published ? { weight: component.weight, mean: means.components[component.id] ?? null } : {}),
      })),
    columns: columns.map((c) => ({
      kind: c.kind,
      activityId: c.activityId,
      mode: c.mode,
      title: c.title,
      date: c.date,
      ...counting.get(c.activityId)!,
      ...(published ? { weight: c.weight } : {}),
    })),
    cells,
    ...(published ? { mean: means.mean } : {}),
  } satisfies GradebookStudent;
});

// ---------------------------------------------------------------- the course's components (ADR-131)

/** The components as their routes answer them: each with whether a column of a classroom of the course is in it. */
function componentList(courseId: string): GradebookComponents {
  return componentsOf(courseId).map((component) => ({
    ...component,
    // A draft's stored row holds its component too (ADR-131 §13).
    inUse:
      rooms.filter((r) => r.courseId === courseId).some((r) => bookOf(r.id)?.columns.some((c) => c.componentId === component.id)) ||
      [...STORED.values()].some((row) => row.componentId === component.id),
  }));
}

/** The course of a components route: the 404 of a missing course for a student; a write is its owners' (`?assistant=1`: refused). */
const componentCourse = (id: string, write = false): string => {
  if (role === "student") throw new MockPayload(404, { error: "not_found", message: "Not found" });
  const course = courseOr404(id);
  if (write && flags.assistant) throw refuse(403, "owner_required", "Only an owner of this course may do that");
  return course.id;
};

const componentOr404 = (courseId: string, componentId: string) => {
  const component = componentsOf(courseId).find((c) => c.id === componentId);
  if (!component) throw new MockPayload(404, { error: "not_found", message: "Component not found" });
  return component;
};

/** Another component of the course already has the name, whatever its case. */
const nameTaken = (courseId: string, name: string, except?: string) => {
  if (componentsOf(courseId).some((c) => c.id !== except && c.name.toLowerCase() === name.toLowerCase())) {
    throw refuse(409, "component_name_taken", "Another component of the course has this name");
  }
};

on("GET", "/app/api/courses/:id/gradebook/components", (m) => componentList(componentCourse(m.groups!.id!)));

on("POST", "/app/api/courses/:id/gradebook/components", (m, raw) => {
  const courseId = componentCourse(m.groups!.id!, true);
  const body = parsed(GradebookComponentCreate, raw);
  nameTaken(courseId, body.name);
  componentsOf(courseId).push({ id: crypto.randomUUID(), name: body.name, weight: body.weight });
  return componentList(courseId);
});

on("PATCH", "/app/api/courses/:id/gradebook/components/:componentId", (m, raw) => {
  const courseId = componentCourse(m.groups!.id!, true);
  const component = componentOr404(courseId, m.groups!.componentId!);
  const body = parsed(GradebookComponentPatch, raw);
  if (body.name !== undefined) {
    nameTaken(courseId, body.name, component.id);
    component.name = body.name;
  }
  if (body.weight !== undefined) component.weight = body.weight;
  return componentList(courseId);
});

on("DELETE", "/app/api/courses/:id/gradebook/components/:componentId", (m) => {
  const courseId = componentCourse(m.groups!.id!, true);
  const component = componentOr404(courseId, m.groups!.componentId!);
  if (componentList(courseId).find((c) => c.id === component.id)!.inUse) {
    throw refuse(409, "component_in_use", "A column of the course is in this component");
  }
  const all = componentsOf(courseId);
  all.splice(all.indexOf(component), 1);
  return componentList(courseId);
});
