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
 *    `released_max`: the final score as it stood, null without one) and
 *    `projects.released_at / by`; the readers keep showing the LIVE final
 *    score, flagged "changed after release" when it differs
 *    (`changedAfterRelease`, `@quiz/domain`). A release again rewrites the
 *    snapshots, audited again, and is not a new notification:
 *    `project_grade_final` goes to the students whose repositories the
 *    release covered on the FIRST release only (`first`; M3-09b), after the
 *    commit. No withdrawal. A reopen after the release is accepted (the
 *    deadline's rules): the teacher's score then waits for the new freeze.
 *
 * Nothing here calls GitHub. Every write is audited (`project_repo.
 * grade_override`, `project.release`).
 */
import { eq } from "drizzle-orm";

import type { ProjectReleaseResult, ProjectRepoScores, ScoreOverride } from "@quiz/contracts";
import { scoresFinal, teacherScoreMax } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { projectRepos, projects } from "../../db/schema.js";
import { DomainError } from "../http.js";
import { notifyUsers } from "../notifications/service.js";
import { isLive, releaseCounts, repoForUpdate } from "./deadline.js";
import { releasableScore, repoScores, slotRuns, teacherRunMax } from "./detail.js";
import { ProjectError } from "./errors.js";
import { repoMembers } from "./groupRepos.js";
import { studentRepos, type RepoRow } from "./repos.js";

/** The teacher's score as the audit records it. */
const teacherScore = (repo: RepoRow) =>
  repo.teacherPoints === null ? null : { points: repo.teacherPoints, max: repo.teacherMax, comment: repo.teacherComment };

/**
 * `PATCH /app/api/projects/:id/repos/:rid/score` (F-PROJ-14): the teacher's
 * score, or its clearing (`points: null`), on a repository frozen for good.
 * Answers the repository's scores as they now stand ({@link repoScores}).
 */
export async function overrideScore(
  db: Db,
  projectId: string,
  repoId: string,
  body: ScoreOverride,
  actor: AuditActor,
  userId: string,
  now: Date,
): Promise<ProjectRepoScores> {
  return db.transaction(async (tx) => {
    const { project, repo } = await repoForUpdate(tx, projectId, repoId);
    if (project.gradingMode !== "auto") throw new ProjectError("grading_none", "The project is not graded");
    if (repo.frozenAt === null) throw new ProjectError("not_frozen", "A score can be set once the repository's deadline and grace have passed");
    const runs = await slotRuns(tx, [repo]);
    let values: Partial<RepoRow>;
    if (body.points === null) {
      values = { teacherPoints: null, teacherMax: null, teacherComment: null, teacherGradedBy: null, teacherGradedAt: null };
    } else {
      // The scored run's maximum is the score's; none (a run to verify
      // included, F-PROJ-08): the teacher gives their own (`teacherRunMax`,
      // the rule the page's `scores.scoreMax` reads too).
      const max = teacherScoreMax(body.points, body.max, teacherRunMax(repo, runs));
      if ("refusal" in max) throw new ProjectError(max.refusal);
      values = {
        teacherPoints: body.points,
        teacherMax: max.max,
        teacherComment: body.comment ?? null,
        teacherGradedBy: userId,
        teacherGradedAt: now,
      };
    }
    const [updated] = await tx.update(projectRepos).set(values).where(eq(projectRepos.id, repo.id)).returning();
    await audit(tx, {
      ...actor,
      action: "project_repo.grade_override",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { before: teacherScore(repo), after: teacherScore(updated!) },
    });
    return repoScores(project, updated!, runs);
  });
}

/**
 * `POST /app/api/projects/:id/release` (F-PROJ-14, D05): the final scores
 * made the students' and the gradebook's. Refused on an ungraded project
 * (`grading_none`), while a live repository is not frozen for good, or
 * none is (`not_frozen`), and while a LIVE repository's final score rests on
 * a run to verify (`to_verify`, F-PROJ-08: a score captured under a
 * suspended protection or on a restored head is released only once the
 * teacher's score settles it; the body names the repositories). A non-live
 * repository never freezes, so its score to verify is released as no score
 * (`releasableScore`) rather than deadlocking the release. The student repositories
 * (`studentRepos`) and the counts (`releaseCounts`) are the page's. Writes
 * every repository's snapshot and the project's `released_at`; idempotent
 * in effect, audited each time.
 */
export async function releaseProject(db: Db, projectId: string, actor: AuditActor, userId: string, now: Date): Promise<ProjectReleaseResult> {
  const { result, project, repos } = await db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw new DomainError("not_found", 404, "No such project");
    if (project.gradingMode !== "auto") throw new ProjectError("grading_none", "The project is not graded");
    const repos = await studentRepos(tx, project);
    const counts = releaseCounts(project, repos);
    if (!scoresFinal({ gradingMode: project.gradingMode, ...counts, unverified: 0 })) {
      throw new ProjectError("not_frozen", "The scores are final once every repository's deadline and grace have passed", counts);
    }
    const runs = await slotRuns(tx, repos);
    const finals = repos.map((repo) => ({ repo, final: repoScores(project, repo, runs).scores.final }));
    // Over the live repositories only: a non-live one (deleted, or of an
    // archived project) never freezes, so the teacher could never settle its
    // score to verify — it is released as no score (`releasableScore`).
    const unverified = finals.filter(({ repo, final }) => final?.toVerify === true && isLive(repo, project)).map(({ repo }) => repo.id);
    if (unverified.length > 0) {
      throw new ProjectError("to_verify", "A score to verify is released once the teacher's score settles it", { repos: unverified });
    }
    const first = project.releasedAt === null;
    let scored = 0;
    for (const { repo, final: live } of finals) {
      const final = releasableScore(project, repo, live);
      if (final) scored += 1;
      await tx
        .update(projectRepos)
        // The comment travels with the score (M3-09a): the student reads the pair the release wrote.
        .set({ releasedPoints: final?.points ?? null, releasedMax: final?.max ?? null, releasedComment: final ? repo.teacherComment : null })
        .where(eq(projectRepos.id, repo.id));
    }
    await tx.update(projects).set({ releasedAt: now, releasedBy: userId }).where(eq(projects.id, project.id));
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
