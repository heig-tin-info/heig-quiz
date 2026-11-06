/**
 * What a project tells people through the notifications (F-NOTIF-13, D18,
 * ADR-030; merge task M3-09b): the audiences of the project kinds and the
 * day-before reminder of the deadline. Every send goes through `notifyUsers`
 * of the `notifications` module — one payload to an audience, best-effort,
 * AFTER the write it announces has committed.
 *
 * The student kinds (`project_scheduled`, `project_published`, `project_deadline_reminder`,
 * `project_repo_invited`, `project_grade_final`) reach claimed STUDENT seats
 * (`enrollments.staff = false`, ADR-018); the staff kinds
 * (`project_deadline_applied`, `project_provision_failed`) reach the course's
 * staff seats (`classroomStaffIds`, F-NOTIF-11). The payloads carry the
 * project's id and name and counts: never a score, a login or a student's
 * name (N-SEC-20).
 *
 * **The reminder** ({@link remindDeadlines}) mirrors F-NOTIF-06 on the
 * student's EFFECTIVE deadline: 24 hours before it (`DEADLINE_REMINDER_MS`),
 * once, claimed and sent in the same tick, never after it. Two claims, each
 * one conditional UPDATE whose returned rows are the only ones told, so two
 * processes never tell a student twice and a late scan catches up:
 *
 * - `projects.reminder_sent_at` claims the students under the project's
 *   deadline — every claimed student seat of the classroom, repository or
 *   not (they still have to Accept), except the members (individual or
 *   group, `project_group_members`) of a repository with its own deadline,
 *   of a deleted one, or of one the staff locked by hand;
 * - `project_repos.reminder_sent_at` claims the members of a repository with
 *   its own deadline, reminded of THAT one.
 *
 * A window under a day never reminds: as the evaluation reminder reads
 * `started_at`, both scans require the project's `start_at` to lie at least
 * 24 hours before the deadline they read — a project published, or a
 * repository given its own deadline, within a day of it tells nobody. A
 * moved deadline re-arms a claim only when the new deadline is more than a
 * day away (`reminderClaimAfterMove`, `@quiz/domain`). A repository whose
 * own deadline is taken back falls under the project's claim again: when
 * that claim fired already, its members were reminded of their own deadline
 * and are not reminded of the project's — a moved end never sends it again
 * (F-NOTIF-06). Drafts, scheduled projects (ADR-127), archived projects
 * and archived classrooms are skipped.
 */
import { and, eq, exists, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { NotificationPayload } from "@quiz/contracts";
import { DEADLINE_REMINDER_MS } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { classrooms, enrollments, githubAccounts, projectGroupMembers, projectRepos, projects } from "../../db/schema.js";
import { notifyUsers, type NotifyLog } from "../notifications/service.js";
import { classroomStaffIds, liveProject } from "../guards.js";
import { LIVE, ts } from "./deadline.js";
import { repoMembers } from "./groupRepos.js";

/** What the audiences need of a project. */
type ProjectRef = { id: string; name: string; classroomId: string };

/**
 * The claimed STUDENT seats of a classroom (ADR-018): who a student kind of a
 * project reaches, each with whether a GitHub account is linked (a stale link
 * still counts: the project page offers "Relink"). One read.
 */
export async function classroomStudents(db: Db, classroomId: string): Promise<{ userId: string; linked: boolean }[]> {
  const rows = await db
    .select({ userId: enrollments.userId, account: githubAccounts.userId })
    .from(enrollments)
    .leftJoin(githubAccounts, eq(githubAccounts.userId, enrollments.userId))
    .where(and(eq(enrollments.classroomId, classroomId), eq(enrollments.staff, false), isNotNull(enrollments.userId)));
  return rows.map((r) => ({ userId: r.userId!, linked: r.account !== null }));
}

/**
 * A student kind about a project to the classroom's students: those without
 * a linked GitHub account read another text, frozen at sending (M3-14d).
 */
async function tellStudents(
  db: Db,
  classroomId: string,
  payload: Extract<NotificationPayload, { kind: "project_published" | "project_scheduled" }>,
): Promise<void> {
  const students = await classroomStudents(db, classroomId);
  const ids = (linked: boolean) => students.filter((s) => s.linked === linked).map((s) => s.userId);
  await notifyUsers(db, ids(true), payload);
  await notifyUsers(db, ids(false), { ...payload, githubLinked: false });
}

/** `project_published`: the classroom's students, once per project (a project is published once). */
export async function announcePublished(db: Db, project: ProjectRef): Promise<void> {
  await tellStudents(db, project.classroomId, { kind: "project_published", projectId: project.id, projectTitle: project.name });
}

/**
 * `project_scheduled` (ADR-127): the classroom's students, told it opens at
 * its start — once per project EVER. The marker `scheduled_announced_at` is
 * claimed by a conditional UPDATE before anything is sent (evaluations'
 * ADR-030 §13), so a schedule cancelled and made again, a moved date or two
 * concurrent requests tell nobody a second time.
 */
export async function announceScheduled(db: Db, project: ProjectRef & { startAt: Date }, now: Date): Promise<void> {
  const claimed = await db
    .update(projects)
    .set({ scheduledAnnouncedAt: now })
    .where(and(eq(projects.id, project.id), isNull(projects.scheduledAnnouncedAt)))
    .returning({ id: projects.id });
  if (claimed.length === 0) return;
  await tellStudents(db, project.classroomId, {
    kind: "project_scheduled",
    projectId: project.id,
    projectTitle: project.name,
    startAt: project.startAt.toISOString(),
  });
}

/** A staff kind about `project`, to the course's staff seats. */
export async function tellProjectStaff(
  db: Db,
  project: ProjectRef,
  payload: Extract<NotificationPayload, { kind: "project_deadline_applied" | "project_provision_failed" }>,
  log?: NotifyLog,
): Promise<void> {
  await notifyUsers(db, await classroomStaffIds(db, project.classroomId), payload, log);
}

/** The project's `start_at` lies at least a day before `deadline`: the window is worth a reminder. */
const windowLongEnough = (deadline: typeof projects.deadlineAt | typeof projectRepos.deadlineAt) =>
  sql`${projects.startAt} <= ${deadline} - ${DEADLINE_REMINDER_MS}::bigint * interval '1 millisecond'`;

/**
 * The ticker's reminder step: claims and tells every reminder due at `now`.
 * Returns how many people were told (or tried), for the tick's account.
 */
export async function remindDeadlines(db: Db, now: Date, log?: NotifyLog): Promise<number> {
  const horizon = new Date(now.getTime() + DEADLINE_REMINDER_MS);
  let told = 0;

  // The students under the project's deadline, claimed on the project.
  const claimedProjects = await db
    .update(projects)
    .set({ reminderSentAt: now })
    .from(classrooms)
    .where(
      and(
        eq(classrooms.id, projects.classroomId),
        isNull(classrooms.archivedAt),
        eq(projects.state, "published"),
        isNull(projects.archivedAt),
        isNull(projects.reminderSentAt),
        sql`${projects.deadlineAt} > ${ts(now)}`,
        sql`${projects.deadlineAt} <= ${ts(horizon)}`,
        windowLongEnough(projects.deadlineAt),
      ),
    )
    .returning({ id: projects.id, name: projects.name, classroomId: projects.classroomId });
  for (const project of claimedProjects) {
    // Left out: a member of a repository with its own deadline (reminded of
    // THAT one, below), of a deleted one, or of one the staff locked by hand
    // — their own repository, or their group's (ADR-048). A holder of a LIVE
    // individual repository reads that one, never their group's
    // (`repoMembers`' rule): it alone decides their reminder.
    const own = alias(projectRepos, "own");
    const holdsOwn = db
      .select({ one: sql`1` })
      .from(own)
      .where(
        and(
          eq(own.projectId, project.id),
          eq(own.userId, enrollments.userId),
          isNull(own.groupId),
          eq(own.provisionStatus, "ok"),
          isNotNull(own.fullName),
          isNull(own.deletedAt),
        ),
      );
    const theirs = or(
      and(isNull(projectRepos.groupId), eq(projectRepos.userId, enrollments.userId)),
      and(
        isNotNull(projectRepos.groupId),
        notExists(holdsOwn),
        exists(
          db
            .select({ one: sql`1` })
            .from(projectGroupMembers)
            .where(and(eq(projectGroupMembers.groupId, projectRepos.groupId), eq(projectGroupMembers.enrollmentId, enrollments.id))),
        ),
      ),
    );
    const seats = await db
      .select({ userId: enrollments.userId })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.classroomId, project.classroomId),
          eq(enrollments.staff, false),
          isNotNull(enrollments.userId),
          notExists(
            db
              .select({ one: sql`1` })
              .from(projectRepos)
              .where(
                and(
                  eq(projectRepos.projectId, project.id),
                  theirs,
                  or(isNotNull(projectRepos.deadlineAt), isNotNull(projectRepos.deletedAt), eq(projectRepos.staffLock, true)),
                ),
              ),
          ),
        ),
      );
    const userIds = seats.map((s) => s.userId!);
    await notifyUsers(db, userIds, { kind: "project_deadline_reminder", projectId: project.id, projectTitle: project.name }, log);
    told += userIds.length;
  }

  // The members of a repository with its own deadline, claimed on the repository.
  const claimedRepos = await db
    .update(projectRepos)
    .set({ reminderSentAt: now })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectRepos.projectId),
        LIVE,
        liveProject(),
        sql`EXISTS (SELECT 1 FROM ${classrooms} WHERE ${classrooms.id} = ${projects.classroomId} AND ${classrooms.archivedAt} IS NULL)`,
        isNotNull(projectRepos.deadlineAt),
        isNull(projectRepos.reminderSentAt),
        sql`${projectRepos.staffLock} IS NOT TRUE`,
        sql`${projectRepos.deadlineAt} > ${ts(now)}`,
        sql`${projectRepos.deadlineAt} <= ${ts(horizon)}`,
        windowLongEnough(projectRepos.deadlineAt),
      ),
    )
    .returning();
  const refs = new Map(
    claimedRepos.length === 0
      ? []
      : (
          await db
            .select({ id: projects.id, name: projects.name, classroomId: projects.classroomId })
            .from(projects)
            .where(inArray(projects.id, [...new Set(claimedRepos.map((r) => r.projectId))]))
        ).map((p) => [p.id, p]),
  );
  for (const repo of claimedRepos) {
    const project = refs.get(repo.projectId)!;
    // Its readers (`repoMembers`, the one rule: a group's members, never its creator for having created it).
    // A staff seat's test repository reminds nobody: notifications go to student seats (ADR-077).
    const userIds = (await repoMembers(db, repo, project.classroomId)).filter((m) => !m.staff).map((m) => m.userId);
    await notifyUsers(db, userIds, { kind: "project_deadline_reminder", projectId: project.id, projectTitle: project.name }, log);
    told += userIds.length;
  }
  return told;
}
