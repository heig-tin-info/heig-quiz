/**
 * The personal data export (N-DATA-04, ADR-112): one file of everything the
 * platform shows its caller, gathered from their own student views.
 *
 * It is a COMPOSITION, never an exit of its own (invariant 4): every section
 * is the answer of the view that owns it, called through its module's
 * service, for the caller's own id, on a scope its own finders loaded
 * (invariant 6). Nothing here applies a feedback policy, a release or a
 * visibility rule; nothing reads another module's table. The one exception
 * is three rows of the account that no teacher controls (ADR-112 §2): the
 * verified addresses, the hours of activity and the last activity.
 *
 * Reached only behind `ownSessionGuard` (the caller's own portal session),
 * so the scopes are loaded as {@link PORTAL} and with the student payload
 * forced: Super Powers widen nothing, every finder is keyed by the caller's
 * own seats.
 */
import {
  PERSONAL_DATA_EXPORT_VERSION,
  PersonalDataExport,
  type ConceptLang,
  type PersonalDataClassroom,
  type StudentFeedback,
  type StudentGroupSets,
  type StudentProject,
} from "@quiz/contracts";

import { accountOf } from "../../auth/account.js";
import { githubAccountOf } from "../../auth/githubLink.js";
import { PORTAL } from "../../auth/session.js";
import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import type { users } from "../../db/schema.js";
import { knownEmails } from "../../identity.js";
import { studentCalibration, studentConceptMastery, studentDrillClassrooms } from "../drill/service.js";
import { studentGradebook } from "../gradebook/service.js";
import { studentGroupSets } from "../group/service.js";
import { findOwnAttempt, findReadableClassroom, findStudentProjectView, type Caller } from "../guards.js";
import { studentGrades } from "../live/service.js";
import { studentClassroomHeader, studentClassrooms } from "../org/service.js";
import { ownActivity } from "../presence/service.js";
import { studentProject, studentProjectCards } from "../project/service.js";
import { studentFeedback } from "../results/service.js";

/**
 * Who asks — one person, seen twice: `caller` (their id and reach, for the
 * finders) and `user` (their account row, for the identity section). Both
 * come from the same request; the export never reads anyone else.
 */
export interface ExportCaller {
  caller: Caller;
  user: typeof users.$inferSelect;
}

/**
 * ADR-112 §6: of each set, the caller's own group alone — another group's
 * members and the students in no group are classmates' data, not theirs.
 * A narrowing of the view, never an addition to it.
 */
function ownGroupOnly(view: StudentGroupSets): StudentGroupSets {
  return {
    serverNow: view.serverNow,
    sets: view.sets.map(({ unplaced: _unplaced, ...set }) => ({
      ...set,
      groups: set.groups.filter((g) => g.id === set.myGroupId),
    })),
  };
}

export async function personalDataExport(
  db: Db,
  { caller, user }: ExportCaller,
  now: Date,
  { lang, codespace }: { lang: ConceptLang; codespace: boolean },
): Promise<PersonalDataExport> {
  const userId = caller.id;

  // Every claimed seat, archived classrooms included (ADR-112 §5), each
  // loaded through the student branch with the student payload forced.
  const classrooms: PersonalDataClassroom[] = [];
  for (const card of await studentClassrooms(db, userId, { includeArchived: true })) {
    const scope = await findReadableClassroom(db, caller, PORTAL, card.id, { studentView: true });
    if (scope === null) continue;
    const [classroom, gradebook, groupSets, mastery] = await Promise.all([
      studentClassroomHeader(db, scope),
      studentGradebook(db, scope, userId, now),
      studentGroupSets(db, scope.room.id, { seatId: scope.seat?.id ?? null, writer: false }, now),
      studentConceptMastery(db, scope.room, userId, now, lang),
    ]);
    classrooms.push({ classroom, gradebook, groupSets: ownGroupOnly(groupSets), mastery });
  }

  // ADR-112 §4: an attempt only through the feedback view, the one its
  // Grades row opens — never the player's attempt view.
  const grades = await studentGrades(db, userId, now);
  const feedback: StudentFeedback[] = [];
  for (const row of grades.flatMap((g) => g.rows)) {
    if (row.kind !== "evaluation" || row.feedbackAttemptId === null) continue;
    const own = await findOwnAttempt(db, userId, row.feedbackAttemptId);
    if (own) feedback.push(await studentFeedback(db, own.evaluation, own.attempt, now));
  }

  const cards = await studentProjectCards(db, userId, now);
  const projects: StudentProject[] = [];
  for (const card of [...cards.open, ...cards.upcoming, ...cards.past]) {
    const scope = await findStudentProjectView(db, caller, PORTAL, card.id);
    if (scope) projects.push(await studentProject(db, scope, userId, now, { codespace }));
  }

  const [account, emails, github, activity, drillClassrooms, calibration] = await Promise.all([
    accountOf(db, user),
    knownEmails(db, userId),
    githubAccountOf(db, userId),
    ownActivity(db, userId),
    studentDrillClassrooms(db, userId),
    studentCalibration(db, userId),
  ]);

  // Parsed through its contract: a field beyond a view's schema never travels (ADR-112 §9).
  return PersonalDataExport.parse({
    version: PERSONAL_DATA_EXPORT_VERSION,
    generatedAt: iso(now),
    account,
    emails,
    github,
    activity,
    classrooms,
    grades,
    feedback,
    projects,
    drill: { classrooms: drillClassrooms, calibration },
  } satisfies PersonalDataExport);
}

/** The audit payload of `privacy.export`: counts only, never a title, a grade or an address. */
export function exportCounts(file: PersonalDataExport): Record<string, number> {
  return {
    classrooms: file.classrooms.length,
    gradeRows: file.grades.reduce((n, g) => n + g.rows.length, 0),
    feedback: file.feedback.length,
    projects: file.projects.length,
    drillClassrooms: file.drill.classrooms.length,
    hours: file.activity.hours.length,
  };
}
