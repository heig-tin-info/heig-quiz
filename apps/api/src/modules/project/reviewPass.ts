/**
 * The LLM pass of a project graded by criteria (ADR-106 §4): the
 * `project.review` job, one per repository and pass, after its evidence.
 * ONE structured call of purpose `project` through `app.llm`, billed to the
 * project's creator, for the llm criteria no one holds — not validated, not
 * a teacher's, not locked by a milestone, not already proposed by this pass
 * — and, for a milestone pass (§5), those its checkpoint tags only, their
 * rows locked. Everything sent is masked before it is cut (N-DATA-05,
 * `renderMaterial`): the classroom's roster and the repository's members —
 * names, e-mail addresses, GitHub logins — and the repository's owner and
 * name. Its proposals are `llm` rows in state `proposed`, their rationale
 * plain text. A failure (ADR-063 §2) is a 0-point proposal with its reason,
 * never a retry: `llm_budget`, `llm_not_configured`, `grader_error`; no
 * evidence, a 0-point proposal with the evidence's status.
 *
 * {@link runEvidencePass} is the `project.evidence` job of a pass: the
 * evidence, then this review, ok or not (§4: review follows evidence).
 */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import { snapshotSettings } from "@quiz/contracts";
import {
  awardedRange,
  clampAwarded,
  llmLeaves,
  maskNames,
  projectMaskTerms,
  renderMaterial,
  type CriteriaLeaf,
  type CriterionReason,
  type ProjectPerson,
} from "@quiz/domain";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import {
  enrollments,
  githubAccounts,
  projectCriteria,
  projectEvidence,
  projectRepoAccess,
  projectRepos,
  projects,
  users,
} from "../../db/schema.js";
import { PROJECT_REVIEW_QUEUE } from "../../jobs.js";
import { llmFailure, type ProjectReviewCriterion } from "../llm/service.js";
import { heldCriteria, writeCriterionGrades, type CriterionGradeInput } from "./criterionGrades.js";
import { runEvidence, type EvidenceJob } from "./evidence.js";
import { passScope } from "./milestone.js";
import { hintProjectStaff, type RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

/** The `project.review` job's data. */
export interface ReviewJob {
  repoId: string;
  /** The pass: the final pass's ledger row, or a Regrade's id. */
  passId: string;
  /** The evidence this pass stored. */
  evidenceId: string;
  /** A milestone pass's checkpoint (§5). */
  checkpointId?: string | undefined;
}

/** Review jobs a process runs at once, as `grading.llm`. */
export const REVIEW_CONCURRENCY = 2;

/**
 * The masking of one repository's material (ADR-106 §4): the classroom's
 * roster, as written on it and as its accounts say (names, e-mail, GitHub
 * login), the repository's own student (a staff seat's test repository
 * included), the accounts ever let into it, and the repository's owner and
 * name.
 */
async function masker(db: Db, repo: RepoRow, project: ProjectRow): Promise<(text: string) => string> {
  const roster = await db
    .select({
      prenom: enrollments.prenom,
      nom: enrollments.nom,
      email: enrollments.email,
      account: { givenName: users.givenName, familyName: users.familyName, email: users.email },
      login: githubAccounts.login,
    })
    .from(enrollments)
    .leftJoin(users, eq(users.id, enrollments.userId))
    .leftJoin(githubAccounts, eq(githubAccounts.userId, enrollments.userId))
    .where(eq(enrollments.classroomId, project.classroomId));
  const [owner] = await db
    .select({ givenName: users.givenName, familyName: users.familyName, email: users.email, login: githubAccounts.login })
    .from(users)
    .leftJoin(githubAccounts, eq(githubAccounts.userId, users.id))
    .where(eq(users.id, repo.userId));
  const granted = await db.select({ login: projectRepoAccess.githubLogin }).from(projectRepoAccess).where(eq(projectRepoAccess.repoId, repo.id));
  const people: ProjectPerson[] = [
    ...roster.flatMap((r) => [{ givenName: r.prenom, familyName: r.nom, email: r.email, login: r.login }, ...(r.account ? [r.account] : [])]),
    ...(owner ? [owner] : []),
    ...granted.map((g) => ({ givenName: "", familyName: "", email: "", login: g.login })),
  ];
  const terms = projectMaskTerms(people, repo.fullName?.split("/") ?? []);
  return (text) => maskNames(text, terms.people, terms.handles);
}

/** A criterion's llm proposal. */
const proposal = (leaf: CriteriaLeaf, passId: string, points: number, more: Pick<CriterionGradeInput, "rationale" | "reason">): CriterionGradeInput => ({
  criterionId: leaf.id,
  points,
  max: leaf.maxPoints,
  source: "llm",
  state: "proposed",
  passId,
  ...more,
});

/** A criterion's 0-point proposal with why. */
const zero = (leaf: CriteriaLeaf, passId: string, reason: CriterionReason) => proposal(leaf, passId, 0, { reason });

/** The model's proposals for `leaves`, clamped into each range, or 0 with the failure's reason. */
async function ask(
  app: FastifyInstance,
  leaves: CriteriaLeaf[],
  request: { context: string | null; material: string },
  billedTo: string,
  passId: string,
): Promise<CriterionGradeInput[]> {
  if (!app.llm) return leaves.map((leaf) => zero(leaf, passId, "llm_not_configured"));
  const criteria = leaves.map((leaf): ProjectReviewCriterion => {
    const [low, high] = awardedRange(leaf);
    return { id: leaf.id, description: leaf.description, prompt: leaf.prompt!, low, high };
  });
  try {
    const { grades } = await app.llm.reviewProject({ ...request, criteria }, billedTo);
    return leaves.map((leaf) => {
      const got = grades[leaf.id]!;
      return proposal(leaf, passId, Math.round(clampAwarded(leaf, got.points) * 100) / 100, { rationale: got.rationale });
    });
  } catch (err) {
    const reason = llmFailure(err);
    if (reason === "grader_error") app.log.error({ err }, "project review: llm call failed");
    return leaves.map((leaf) => zero(leaf, passId, reason));
  }
}

/**
 * The `project.review` job: the llm proposals of one repository for one
 * pass. Nothing when the repository, its snapshot or the milestone's
 * checkpoint is gone, or its project left `criteria` mode. The number of
 * rows written.
 */
export async function runReview(app: FastifyInstance, job: ReviewJob): Promise<number> {
  const db = app.db;
  const [row] = await db
    .select({ repo: projectRepos, project: projects, snapshot: projectCriteria.criteria })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(projectCriteria, eq(projectCriteria.projectId, projects.id))
    .where(eq(projectRepos.id, job.repoId));
  if (!row || row.project.gradingMode !== "criteria") return 0;
  const { repo, project, snapshot } = row;
  const scope = await passScope(db, project.id, snapshot.leaves, job.checkpointId);
  if (!scope) return 0;
  // Not held, nor already proposed by this pass (a job run twice): spares a needless call, the writer checks again.
  const held = await heldCriteria(db, repo.id, job.passId);
  const leaves = llmLeaves(scope.leaves, snapshotSettings(project, snapshot.schemaVersion)).filter((leaf) => !held.has(leaf.id));
  if (leaves.length === 0) return 0;
  const [evidence] = await db
    .select()
    .from(projectEvidence)
    .where(and(eq(projectEvidence.id, job.evidenceId), eq(projectEvidence.repoId, repo.id)));
  // No evidence to judge: no call, the evidence's status as the reason (a row a later run replaced: `grader_error`).
  const missing = !evidence ? "grader_error" : evidence.status === "ok" ? null : evidence.status;
  const inputs =
    missing === null && evidence
      ? await ask(
          app,
          leaves,
          { context: snapshot.grading.context, material: renderMaterial(evidence, snapshot.grading.sources, await masker(db, repo, project)) },
          project.createdBy,
          job.passId,
        )
      : leaves.map((leaf) => zero(leaf, job.passId, missing ?? "grader_error"));
  const now = app.clock.now();
  const written = await writeCriterionGrades(
    db,
    repo.id,
    inputs.map((input) => ({ ...input, ...scope.lock(now) })),
    now,
  );
  await hintProjectStaff(db, [project.id]);
  return written.length;
}

/**
 * The `project.evidence` job: the repository's evidence, then — for a pass
 * — its review, whatever the evidence came to: GitHub or the runner out of
 * reach is stored as an evidence (`github_unavailable`,
 * `runner_unavailable`, `collectEvidence`), so every criterion of the pass
 * gets its 0-point proposal with that reason. Without a queue
 * (`JOBS_DISABLED=1`, the tests) the review runs here.
 */
export async function runEvidencePass(app: FastifyInstance, config: AppConfig, job: EvidenceJob): Promise<void> {
  const outcome = await runEvidence(app, config, job.repoId, job.checkpointId);
  if (!outcome || !job.passId) return;
  const review: ReviewJob = { repoId: job.repoId, passId: job.passId, evidenceId: outcome.evidenceId, checkpointId: job.checkpointId };
  if (app.boss) await app.boss.send(PROJECT_REVIEW_QUEUE, review);
  else await runReview(app, review);
}
