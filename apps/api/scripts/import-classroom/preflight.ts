/**
 * Pre-flight of the import (merge task M8-01a, docs/merge/02 §2.5): what can
 * be decided from the SOURCE database alone, as a pure function of the
 * snapshot, so each check is tested by editing a snapshot, not a database.
 *
 * Two kinds of check, because the import runs twice (D26: a first import
 * while heig-classroom still lives, then the final one at the cutover):
 *
 * - STATE checks (heig-classroom stopped, its queue empty, no unprocessed
 *   webhook, no deadline in the window, none overdue and unapplied) only
 *   refuse a `--final` apply. Without `--final` they are listed as
 *   `final_only`: what would refuse the final import.
 * - DATA checks (no dangling grade-run link, groups consistent with their
 *   assignment) refuse every `--apply`: what they find is wrong in the rows
 *   to carry, whatever the moment.
 *
 * What the database cannot say (the process is really stopped, classroom's
 * App no longer acts on a repository, backups) is the cutover runbook's
 * (M8-05): `RUNBOOK` lists it in every report.
 */
import type { SourceAssignment, SourceSnapshot } from "./source.js";

export type PreflightStatus = "ok" | "refused" | "final_only";

export interface PreflightLine {
  id: string;
  status: PreflightStatus;
  problems: string[];
}

/** A sign of life younger than this means heig-classroom is still running. */
export const QUIET_MINUTES = 10;
/** Default look-ahead for a deadline that would fall during the cutover. */
export const DEFAULT_WINDOW_HOURS = 24;

/** Checks no query can make: the cutover runbook's (M8-05). */
export const RUNBOOK: readonly string[] = [
  "heig-classroom's process is stopped (the activity check only sees recent signs of life)",
  "heig-classroom's GitHub App no longer acts on any repository: no restore, deadline commit or sync (M3-04)",
  "no live evaluation or live workspace session in Quiz during the switch (D20)",
  "Quiz's App is installed and subscribed to the events the projects need, on the teachers' organizations",
  "both databases are backed up, the target before the final import",
  "the teachers' roster fixes are done: the report's missing students and skipped assistants are settled",
];

export interface PreflightInput {
  snapshot: SourceSnapshot;
  /** The source classrooms the mapping carries (a dropped one is out of scope). */
  mappedClassroomIds: ReadonlySet<string>;
  now: Date;
  windowHours: number;
  /** The cutover import: a state check refuses instead of being listed. */
  final: boolean;
}

const minutesBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);
const iso = (d: Date) => d.toISOString();

function stopped({ snapshot, now }: PreflightInput): string[] {
  const a = snapshot.activity;
  const problems: string[] = [];
  if (a.runningTasks > 0) problems.push(`${a.runningTasks} scheduled task(s) running`);
  for (const [what, at] of [["scheduled task ran", a.lastTaskRunAt], ["webhook delivery received", a.lastWebhookAt]] as const) {
    if (at && now.getTime() - at.getTime() < QUIET_MINUTES * 60_000) {
      problems.push(`a ${what} ${Math.max(0, minutesBetween(at, now))} min ago (${iso(at)}), under ${QUIET_MINUTES} min`);
    }
  }
  return problems;
}

function queuesEmpty({ snapshot }: PreflightInput): string[] {
  const q = snapshot.activity.queue;
  if (!q.readable) return ["pgboss.job is absent or not readable by this role: the queue was not checked"];
  return q.pending.map((p) => `queue ${p.name}: ${p.n} job(s) ${p.state}`);
}

function webhooksProcessed({ snapshot }: PreflightInput): string[] {
  const n = snapshot.activity.unprocessedWebhooks;
  return n > 0 ? [`${n} webhook delivery(ies) not processed`] : [];
}

/** A published assignment of a carried classroom whose deadline or grace is near, or overdue and not applied. */
function deadlines({ snapshot, mappedClassroomIds, now, windowHours }: PreflightInput): string[] {
  const end = new Date(now.getTime() + windowHours * 3_600_000);
  const problems: string[] = [];
  const live = snapshot.assignments.filter(
    (a) => mappedClassroomIds.has(a.classroomId) && a.state === "published" && a.archivedAt === null && a.frozenAt === null,
  );
  const graceEnd = (a: SourceAssignment) => new Date(a.deadlineAt.getTime() + a.graceMinutes * 60_000);
  for (const a of live) {
    const at = `assignment "${a.name}" (${a.id})`;
    if (a.deadlineAppliedAt === null && a.deadlineAt <= now) {
      problems.push(`${at}: deadline ${iso(a.deadlineAt)} passed and not applied`);
    } else if (a.deadlineAppliedAt !== null && graceEnd(a) <= now) {
      problems.push(`${at}: deadline + grace ${iso(graceEnd(a))} passed and not frozen`);
    } else if (a.deadlineAt <= end && graceEnd(a) > now) {
      problems.push(`${at}: deadline ${iso(a.deadlineAt)} + ${a.graceMinutes} min grace falls inside the ${windowHours} h window`);
    }
  }
  return problems;
}

/** `student_repos.{current,frozen,llm}_grade_run_id` carry no foreign key in heig-classroom. */
function gradeRunLinks({ snapshot, mappedClassroomIds }: PreflightInput): string[] {
  const runs = new Map(snapshot.gradeRuns.map((r) => [r.id, r.studentRepoId]));
  const assignments = new Map(snapshot.assignments.map((a) => [a.id, a]));
  const problems: string[] = [];
  for (const repo of snapshot.studentRepos) {
    const assignment = assignments.get(repo.assignmentId);
    if (!assignment || !mappedClassroomIds.has(assignment.classroomId)) continue;
    for (const [column, id] of [
      ["current_grade_run_id", repo.currentGradeRunId],
      ["frozen_grade_run_id", repo.frozenGradeRunId],
      ["llm_grade_run_id", repo.llmGradeRunId],
    ] as const) {
      if (id === null) continue;
      const owner = runs.get(id);
      if (owner === undefined) problems.push(`repository ${repo.id}: ${column} ${id} is not a grade run`);
      else if (owner !== repo.id) problems.push(`repository ${repo.id}: ${column} ${id} belongs to another repository`);
    }
  }
  return problems;
}

/** Groups, their members and their repositories must agree on the assignment, and on the classroom's roster. */
function groupConsistency({ snapshot, mappedClassroomIds }: PreflightInput): string[] {
  const assignments = new Map(snapshot.assignments.map((a) => [a.id, a]));
  const groups = new Map(snapshot.groups.map((g) => [g.id, g]));
  const enrollments = new Map(snapshot.enrollments.map((e) => [e.id, e]));
  const carried = (assignmentId: string) => {
    const a = assignments.get(assignmentId);
    return a !== undefined && mappedClassroomIds.has(a.classroomId);
  };
  const problems: string[] = [];
  for (const g of snapshot.groups) {
    const a = assignments.get(g.assignmentId);
    if (carried(g.assignmentId) && a && !a.groupMode) problems.push(`group ${g.id}: its assignment ${a.id} is not in group mode`);
  }
  for (const m of snapshot.groupMembers) {
    if (!carried(m.assignmentId)) continue;
    const g = groups.get(m.groupId);
    const e = enrollments.get(m.enrollmentId);
    if (!g) problems.push(`member ${m.enrollmentId}: group ${m.groupId} does not exist`);
    else if (g.assignmentId !== m.assignmentId) problems.push(`member ${m.enrollmentId}: group ${g.id} belongs to another assignment than the member's`);
    if (!e) problems.push(`member ${m.enrollmentId} of group ${m.groupId}: no such enrollment`);
    else if (e.classroomId !== assignments.get(m.assignmentId)?.classroomId) {
      problems.push(`member ${e.id} of group ${m.groupId}: enrolled in another classroom than the assignment's`);
    }
  }
  for (const repo of snapshot.studentRepos) {
    if (repo.groupId === null || !carried(repo.assignmentId)) continue;
    const g = groups.get(repo.groupId);
    if (!g) problems.push(`repository ${repo.id}: group ${repo.groupId} does not exist`);
    else if (g.assignmentId !== repo.assignmentId) problems.push(`repository ${repo.id}: its group belongs to another assignment`);
  }
  return problems;
}

const STATE_CHECKS = { "source-stopped": stopped, "queues-empty": queuesEmpty, "webhooks-processed": webhooksProcessed, deadlines } as const;
const DATA_CHECKS = { "grade-run-links": gradeRunLinks, "group-consistency": groupConsistency } as const;

export function sourcePreflight(input: PreflightInput): PreflightLine[] {
  const line = (id: string, check: (i: PreflightInput) => string[], failure: PreflightStatus): PreflightLine => {
    const problems = check(input);
    return { id, status: problems.length === 0 ? "ok" : failure, problems };
  };
  return [
    ...Object.entries(STATE_CHECKS).map(([id, check]) => line(id, check, input.final ? "refused" : "final_only")),
    ...Object.entries(DATA_CHECKS).map(([id, check]) => line(id, check, "refused")),
  ];
}
