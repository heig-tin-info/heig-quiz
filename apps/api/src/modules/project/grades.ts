/**
 * The teacher's score and the release (F-PROJ-14, F-GRADE-09, D05; merge
 * task M3-08b), ported from heig-classroom's grade override and "validate
 * the grades" (`modules/assignments/actions.ts`) under the product owner's
 * decisions of 2026-10-02:
 *
 * 1. **A teacher's score is written with its maximum** (`teacher_max`): the
 *    scored run's when the repository has one — the run the final score
 *    would otherwise come from, a maximum given beside it must equal it —,
 *    the teacher's own, required, otherwise (`teacherScoreMax` of
 *    `@quiz/domain`). After the repository's definitive freeze only (`409
 *    not_frozen`), on a graded project (`409 grading_none`). Null clears it.
 * 2. **The release waits until every LIVE repository is frozen** for good
 *    (`scoresFinal`, the page's own rule for its primary action): deleted,
 *    never-provisioned repositories and the repositories of a user who now
 *    holds a staff seat do not count. No partial release. And until no
 *    final score rests on a run to verify (F-PROJ-08; orchestrator,
 *    2026-10-04): the teacher's score settles each of those.
 * 3. **The release writes a snapshot per repository** (`released_points`,
 *    `released_max`: the final score as it stood, null without one;
 *    `released_grade`, its grade, which the readers of the snapshot read
 *    rather than recompute it, ADR-119 §11) and
 *    `projects.released_at / by`; the readers keep showing the LIVE final
 *    score, flagged "changed after release" when it differs
 *    (`changedAfterRelease`, `@quiz/domain`). A release again rewrites the
 *    snapshots, audited again, and is not a new notification:
 *    `project_grade_final` goes to the students whose repositories the
 *    release covered on the FIRST release only (`first`; M3-09b), after the
 *    commit. No withdrawal. A reopen after the release is accepted (the
 *    deadline's rules): the teacher's score then waits for the new freeze.
 *
 * 4. **The grade adjustment** (ADR-135): after the points' grade, a delta
 *    or a pinned grade with its justification, under the teacher's score's
 *    conditions and a grade to adjust (`409 no_grade`). The release writes
 *    the ADJUSTED grade (`released_grade`) and the adjustment's comment
 *    (`released_adjustment_comment`), never over the teacher's comment.
 *
 * Nothing here calls GitHub. Every write is audited (`project_repo.
 * grade_override`, `project_repo.grade_adjust`, `project.release`).
 */
import { eq } from "drizzle-orm";

import type { GradeAdjustmentWrite, ProjectReleaseResult, ProjectRepoScores, ScoreOverride } from "@quiz/contracts";
import { contestationClosesAt, projectGraded, scoresFinal, teacherScoreMax } from "@quiz/domain";

import { audit, type AuditAction, type AuditActor } from "../../audit.js";
import { iso } from "../../clock.js";
import type { Clock } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { projects } from "../../db/schema.js";
import { notFoundError } from "../http.js";
import { notifyUsers } from "../notifications/service.js";
import { unvalidatedRepos } from "./criterionGrades.js";
import { isLive, releaseCounts, repoForUpdate } from "./deadline.js";
import { baseGrade, releaseOf, repoScores, teacherRunMax } from "./detail.js";
import { ProjectError, requireReleasedOwner } from "./errors.js";
import { repoMembers } from "./groupRepos.js";
import { groupSyncOwed } from "./groupResync.js";
import { writeGrades, type RepoGrades } from "./repoGrades.js";
import { studentRepos, type RepoRow } from "./repos.js";
import { adjusterNames, finalOf, gradesOf, scoreFacts, type ScoreFacts } from "./scores.js";
import type { ProjectRow } from "./views.js";

/**
 * Who writes a repository's grade (ADR-135 §9): the audit's actor, the
 * account, the server's now, and whether that account owns the course
 * (`isCourseOwner`) — a released project's grade is the owner's alone.
 */
export interface GradeWriter {
  actor: AuditActor;
  userId: string;
  now: Date;
  owner: boolean;
}

/** One write of a repository's grade: its audit action, the columns it writes, and what the audit records of the grading before and after. */
interface GradeWrite {
  action: Extract<AuditAction, "project_repo.grade_override" | "project_repo.grade_adjust">;
  values: (project: ProjectRow, repo: RepoRow, facts: ScoreFacts) => Partial<RepoGrades>;
  record: (grades: RepoGrades, scores: ProjectRepoScores["scores"]) => unknown;
  payload?: Record<string, unknown>;
}

/**
 * THE writer of a repository's grade — the teacher's score, the grade
 * adjustment —, under the project's and the repository's locks: the owner
 * alone once the project is released (`403 owner_required`: the route's
 * loader chose the role from the project as it read it, and a release may
 * have committed since, so the rule is read again here, under the lock the
 * release takes too), a graded project (`409 grading_none`), a repository
 * frozen for good (`409 not_frozen`). Audited before and after. Answers the
 * repository's scores as they now stand ({@link repoScores}), its writer
 * named.
 */
async function writeRepoGrade(db: Db, projectId: string, repoId: string, writer: GradeWriter, write: GradeWrite): Promise<ProjectRepoScores> {
  return db.transaction(async (tx) => {
    const { project, repo } = await repoForUpdate(tx, projectId, repoId);
    requireReleasedOwner(project, writer);
    if (!projectGraded(project.gradingMode)) throw new ProjectError("grading_none", "The project is not graded");
    if (repo.frozenAt === null) throw new ProjectError("not_frozen", "A grade is written once the repository's deadline and grace have passed");
    const facts = await scoreFacts(tx, [repo]);
    // One upsert, in the transaction that holds the repository's lock: the columns of the write land together.
    const updated = await writeGrades(tx, repo.id, write.values(project, repo, facts));
    const before = repoScores(project, repo, facts);
    const after = repoScores(project, repo, { ...facts, grades: new Map([[repo.id, updated]]) }, await adjusterNames(tx, [repo]));
    await audit(tx, {
      ...writer.actor,
      action: write.action,
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { before: write.record(gradesOf(facts, repo.id), before.scores), after: write.record(updated, after.scores), ...write.payload },
    });
    return after;
  });
}

/**
 * `PATCH /app/api/projects/:id/repos/:rid/score` (F-PROJ-14): the teacher's
 * score, or its clearing (`points: null`), on a repository frozen for good
 * ({@link writeRepoGrade}).
 */
export function overrideScore(db: Db, projectId: string, repoId: string, body: ScoreOverride, writer: GradeWriter): Promise<ProjectRepoScores> {
  return writeRepoGrade(db, projectId, repoId, writer, {
    action: "project_repo.grade_override",
    record: (grades) => (grades.teacherPoints === null ? null : { points: grades.teacherPoints, max: grades.teacherMax, comment: grades.teacherComment }),
    values: (_project, repo, facts) => {
      if (body.points === null) return { teacherPoints: null, teacherMax: null, teacherComment: null, teacherGradedBy: null, teacherGradedAt: null };
      // The scored run's maximum is the score's; none (a run to verify
      // included, F-PROJ-08): the teacher gives their own (`teacherRunMax`,
      // the rule the page's `scores.scoreMax` reads too).
      const max = teacherScoreMax(body.points, body.max, teacherRunMax(repo, facts));
      if ("refusal" in max) throw new ProjectError(max.refusal);
      return { teacherPoints: body.points, teacherMax: max.max, teacherComment: body.comment ?? null, teacherGradedBy: writer.userId, teacherGradedAt: writer.now };
    },
  });
}

/**
 * `PUT` / `DELETE /app/api/projects/:id/repos/:rid/grade-adjustment`
 * (ADR-135): the repository's grade adjustment set — over the base grade of
 * now, which an absolute pin keeps to tell when it moved — or cleared
 * (`body` null), under the teacher's score's rules ({@link writeRepoGrade});
 * a set also needs a grade to adjust (`409 no_grade`: no final score, no
 * maximum, or the CI's share of a criteria project). The value's rule is
 * the contract's (`validGradeAdjustment`). Audited
 * `project_repo.grade_adjust`, with the grade it gave; no notification:
 * the student reads it at the next release.
 */
export function adjustRepoGrade(db: Db, projectId: string, repoId: string, body: GradeAdjustmentWrite | null, writer: GradeWriter): Promise<ProjectRepoScores> {
  return writeRepoGrade(db, projectId, repoId, writer, {
    action: "project_repo.grade_adjust",
    record: (_repo, { adjustment, final }) =>
      adjustment === null
        ? null
        : { kind: adjustment.kind, value: adjustment.value, comment: adjustment.comment, base: adjustment.base, grade: final?.grade?.grade ?? null },
    payload: { cleared: body === null },
    values: (project, repo, facts) => {
      if (body === null) {
        return { gradeAdjustKind: null, gradeAdjustValue: null, gradeAdjustBase: null, gradeAdjustComment: null, gradeAdjustedBy: null, gradeAdjustedAt: null };
      }
      const base = baseGrade(project, finalOf(repo, facts));
      if (base === null) throw new ProjectError("no_grade", "The repository has no grade to adjust");
      return {
        gradeAdjustKind: body.kind,
        gradeAdjustValue: body.value,
        gradeAdjustBase: base,
        gradeAdjustComment: body.comment,
        gradeAdjustedBy: writer.userId,
        gradeAdjustedAt: writer.now,
      };
    },
  });
}

/**
 * `POST /app/api/projects/:id/release` (F-PROJ-14, D05): the final scores
 * made the students' and the gradebook's. Refused on an ungraded project
 * (`grading_none`), while a live repository is not frozen for good, or
 * none is (`not_frozen`), while a confirmed *Resync with the set* is not
 * fully applied (`group_sync_pending`, ADR-070's R2: who is in which group,
 * hence whose score it is, is still moving), graded by criteria while a
 * live repository is not validated (`not_validated`, ADR-106 §8: the body
 * names them), and while a LIVE repository's final score rests on
 * a run to verify (`to_verify`, F-PROJ-08: a score captured under a
 * suspended protection or on a restored head is released only once the
 * teacher's score settles it; the body names the repositories). A non-live
 * repository never freezes, so its score to verify is released as no score
 * (`releasableScore`) rather than deadlocking the release. The student repositories
 * (`studentRepos`) and the counts (`releaseCounts`) are the page's. Writes
 * every repository's snapshot and the project's `released_at` — and, in
 * `criteria` mode, the contestation window's closing instant when none is
 * set yet (ADR-139 §13: its days after this release, none at 0; never moved
 * by a release again); idempotent
 * in effect, audited each time. `released_at` is read from `clock` once the
 * project's row is held: a Regrade claimed meanwhile (`claimRegrades`,
 * under its share lock) is stamped before it or sees it (ADR-132 §5).
 */
export async function releaseProject(db: Db, projectId: string, actor: AuditActor, userId: string, clock: Clock): Promise<ProjectReleaseResult> {
  const { result, project, repos } = await db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw notFoundError("project");
    const now = clock.now();
    if (!projectGraded(project.gradingMode)) throw new ProjectError("grading_none", "The project is not graded");
    if (groupSyncOwed(project)) throw new ProjectError("group_sync_pending", "A resync of the groups is still being applied on GitHub");
    const repos = await studentRepos(tx, project);
    const counts = releaseCounts(project, repos);
    if (!scoresFinal({ gradingMode: project.gradingMode, ...counts, unverified: 0 })) {
      throw new ProjectError("not_frozen", "The scores are final once every repository's deadline and grace have passed", counts);
    }
    const facts = await scoreFacts(tx, repos);
    // Graded by criteria (ADR-106 §8, F-PROJ-26): every live repository validated first.
    const unvalidated = unvalidatedRepos(
      project,
      repos.filter((repo) => isLive(repo, project)),
      facts.criteria,
    );
    if (unvalidated.length > 0) {
      throw new ProjectError("not_validated", "Every repository's criteria are validated before the release", { repos: unvalidated });
    }
    const finals = repos.map((repo) => ({ repo, scores: repoScores(project, repo, facts).scores }));
    // Over the live repositories only: a non-live one (deleted, or of an
    // archived project) never freezes, so the teacher could never settle its
    // score to verify — it is released as no score (`releasableScore`).
    const unverified = finals.filter(({ repo, scores }) => scores.final?.toVerify === true && isLive(repo, project)).map(({ repo }) => repo.id);
    if (unverified.length > 0) {
      throw new ProjectError("to_verify", "A score to verify is released once the teacher's score settles it", { repos: unverified });
    }
    const first = project.releasedAt === null;
    let scored = 0;
    for (const { repo, scores } of finals) {
      // The ADJUSTED grade and the adjustment's comment (ADR-135), beside the teacher's comment.
      const { final, grade, adjustmentComment } = releaseOf(project, repo, scores);
      if (final) scored += 1;
      // The comment travels with the score (M3-09a): the student reads the pair the release wrote.
      await writeGrades(tx, repo.id, {
        releasedPoints: final?.points ?? null,
        releasedMax: final?.max ?? null,
        releasedGrade: grade,
        releasedComment: final ? gradesOf(facts, repo.id).teacherComment : null,
        releasedAdjustmentComment: adjustmentComment,
      });
    }
    // ADR-139 §13: the release that finds no window, in `criteria` mode, opens one — the days later — once;
    // a release again rewrites `released_at` and never moves it.
    const opens = project.gradingMode === "criteria" && project.contestationClosesAt === null;
    const closesAt = opens ? contestationClosesAt(now, project.contestationDays) : project.contestationClosesAt;
    await tx.update(projects).set({ releasedAt: now, releasedBy: userId, contestationClosesAt: closesAt }).where(eq(projects.id, project.id));
    await audit(tx, {
      ...actor,
      action: "project.release",
      subjectType: "project",
      subjectId: project.id,
      payload: { first, repos: repos.length, scored },
    });
    return { result: { releasedAt: iso(now), first, repos: repos.length, scored }, project, repos };
  });
  // The FIRST release tells the students whose repositories it covered (the
  // snapshots written, a staff seat's never among them — `repoMembers`, the
  // one reader rule, N-SEC-20); a release again tells nobody (M3-08b,
  // decision 3). No score travels. A query or two per repository: a release
  // happens once per project.
  if (result.first) {
    const userIds: string[] = [];
    for (const repo of repos) userIds.push(...(await repoMembers(db, repo, project.classroomId)).map((m) => m.userId));
    await notifyUsers(db, userIds, { kind: "project_grade_final", projectId: project.id, projectTitle: project.name });
  }
  return result;
}
