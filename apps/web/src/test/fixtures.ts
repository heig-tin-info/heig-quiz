import type {
  ClassroomDetail,
  ClassroomSummary,
  CourseSummary,
  Me,
  RosterEntry,
  StudentClassroom,
} from "@quiz/contracts";

/*
 * Payload fixtures, typed against @quiz/contracts on purpose: when the wire
 * format moves, these stop compiling and the page tests are told about it
 * instead of silently asserting on a shape the server no longer sends.
 *
 * Dates are offsets from one instant captured when this module loads, not
 * literals: no test asserts on a formatted date, and a hard-coded date would
 * quietly change which branch of a component renders.
 */

/** Reference instant of the fixtures, captured once per test file. */
export const NOW = new Date();
const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** ISO string `offsetMs` away from `NOW`. */
export const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

export function makeMe(overrides: Partial<Me> = {}): Me {
  return {
    id: "u-1",
    email: "marie.dupont@heig-vd.ch",
    givenName: "Marie",
    familyName: "Dupont",
    role: "teacher",
    lastLoginAt: at(-DAY),
    avatarUrl: null,
    hasUploadedAvatar: false,
    locale: "en",
    dateFormat: "iso",
    mcqPolicy: null,
    ...overrides,
  };
}

export function makeRosterEntry(overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    id: "e-1",
    nom: "Rochat",
    prenom: "Lucas",
    email: "lucas.rochat@heig-vd.ch",
    status: "claimed",
    conflictFlag: false,
    staff: false,
    timeBonusPercent: 0,
    note: null,
    lastLoginAt: at(-DAY),
    avatarUrl: null,
    userId: "u-2",
    ...overrides,
  };
}

export function makeClassroomSummary(overrides: Partial<ClassroomSummary> = {}): ClassroomSummary {
  return {
    id: "r1",
    name: "PRG1-2026",
    period: "2026-A",
    courseId: "c1",
    courseName: "Programmation C",
    courseCode: "PRG1",
    createdAt: at(-40 * DAY),
    archivedAt: null,
    students: 24,
    claimed: 20,
    ...overrides,
  };
}

export function makeCourseSummary(overrides: Partial<CourseSummary> = {}): CourseSummary {
  return {
    id: "c1",
    name: "Programmation C",
    code: "PRG1",
    createdAt: at(-400 * DAY),
    classrooms: [makeClassroomSummary()],
    staff: [
      {
        userId: "u-1",
        givenName: "Marie",
        familyName: "Dupont",
        email: "marie.dupont@heig-vd.ch",
        avatarUrl: null,
      },
    ],
    ...overrides,
  };
}

export function makeClassroomDetail(overrides: Partial<ClassroomDetail> = {}): ClassroomDetail {
  return {
    id: "r1",
    name: "PRG1-2026",
    period: "2026-A",
    archivedAt: null,
    course: { id: "c1", name: "Programmation C", code: "PRG1" },
    roster: [makeRosterEntry()],
    ...overrides,
  };
}

export function makeStudentClassroom(
  overrides: Partial<StudentClassroom> = {},
): StudentClassroom {
  return {
    id: "r1",
    name: "PRG1-2026",
    period: "2026-A",
    courseName: "Programmation C",
    courseCode: "PRG1",
    teachers: ["Marie Dupont"],
    timeBonusPercent: 0,
    ...overrides,
  };
}
