/**
 * The personal data export (N-DATA-04, ADR-112): `GET /app/api/me/export`,
 * one JSON file of everything the platform shows its caller, gathered from
 * their own student views, plus three rows of their account that no teacher
 * controls. Every section is typed by the schema of the view it comes from,
 * and the server sends the record parsed through this schema, so a field
 * beyond a view's contract never travels.
 */
import { z } from "zod";

import { Account } from "./api.js";
import { DrillCalibrationLevel, DrillClassroom, StudentConceptMastery } from "./drill.js";
import { GithubAccount } from "./github.js";
import { GradebookStudent } from "./gradebook.js";
import { StudentGroupSets } from "./group.js";
import { StudentProject } from "./project.js";
import { StudentFeedback, StudentGrades } from "./results.js";
import { StudentClassroomPage } from "./student.js";

/** The route: a download built in the request, fetched with the session cookie by the Settings card. */
export const PERSONAL_DATA_EXPORT_PATH = "/app/api/me/export";

/** The file's name, by the date of its `generatedAt`: the server's attachment and the card's saved file alike. */
export const personalDataExportFileName = (generatedAt: string): string => `quiz-data-${generatedAt.slice(0, 10)}.json`;

/** Bumped whenever the shape of the record changes (ADR-112 §9). */
export const PERSONAL_DATA_EXPORT_VERSION = 1;

/**
 * One classroom of a claimed seat, archived ones included: its header as the
 * classroom page draws it, the caller's gradebook cells, the group sets
 * narrowed to the caller's own group (no other group, no `unplaced`,
 * ADR-112 §6), and their concept mastery.
 */
export const PersonalDataClassroom = z.object({
  classroom: StudentClassroomPage.shape.classroom,
  gradebook: GradebookStudent,
  groupSets: StudentGroupSets,
  mastery: StudentConceptMastery,
});
export type PersonalDataClassroom = z.infer<typeof PersonalDataClassroom>;

export const PersonalDataExport = z.object({
  version: z.literal(PERSONAL_DATA_EXPORT_VERSION),
  /** The server's clock (invariant 5). */
  generatedAt: z.iso.datetime(),
  account: Account,
  /** The account's verified e-mail addresses (ADR-112 §2). */
  emails: z.array(z.string()),
  github: GithubAccount.nullable(),
  /** The hours of activity still kept (eight days) and the last activity (ADR-107). */
  activity: z.object({
    hours: z.array(z.iso.datetime()),
    lastActiveAt: z.iso.datetime().nullable(),
  }),
  classrooms: z.array(PersonalDataClassroom),
  grades: StudentGrades,
  /** One feedback page per Grades row that opens one (ADR-112 §4). */
  feedback: z.array(StudentFeedback),
  projects: z.array(StudentProject),
  drill: z.object({
    classrooms: z.array(DrillClassroom),
    calibration: z.array(DrillCalibrationLevel),
  }),
});
export type PersonalDataExport = z.infer<typeof PersonalDataExport>;
