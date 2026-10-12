/**
 * A project's grading criteria (ADR-106 §2): the source's `criteria.yml`,
 * read from the DISTRIBUTION repository's head through the App's REST API
 * — one file, never a clone — parsed by `parseCriteria`
 * (`@quiz/domain/criteriaParse`), and kept as a snapshot
 * (`project_criteria`). The source itself is read only while no
 * distribution exists (a draft whose build was interrupted).
 *
 * Read when the mode switches to `criteria` (`criteriaForSwitch`, audited
 * by the switch's own `project.grading_mode`), by the staff's reload, and —
 * only for a project in `criteria` mode — after a publication and after a
 * sync of the source (`project.criteria_reload`, counts only). Refused
 * `409 criteria_invalid` with closed error codes when the file is missing,
 * too large or invalid, or when the grading workflow needs the network
 * (§1); `409 checkpoint_untagged` when a checkpoint's name would tag no
 * criterion (§5). A refused file leaves the last snapshot as it is. Staff
 * only: neither the file, nor the source's name, ever reaches a student
 * (N-SEC-20).
 */
import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNull } from "drizzle-orm";

import { effectiveTestsCriterion, type CriteriaError, type ProjectCriteriaView } from "@quiz/contracts";
import {
  classifyCriterion,
  criteriaTotals,
  projectFieldRefusal,
  untaggedCheckpoints,
  workflowNeedsNetwork,
  workflowTestsCriterion,
  type ParsedCriteria,
} from "@quiz/domain";
import { parseCriteria } from "@quiz/domain/criteriaParse";

import { audit, type AuditActor } from "../../audit.js";
import { iso } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { projectCheckpoints, projectCriteria, projects } from "../../db/schema.js";
import { installationClient, ownerRepo, unless404 } from "../../github/app.js";
import { projectInstallation } from "../github/service.js";
import { ProjectError } from "./errors.js";
import { lifeOf, type ProjectRow } from "./views.js";

/** The file the platform reads, at the repository's root. */
export const CRITERIA_FILE = "criteria.yml";
/** The student repositories' grading workflow: its `tests-criterion` pre-fills the setting, its commands must not need the network. */
export const GRADING_WORKFLOW = ".github/workflows/grading.yml";
/** A criteria file is a few kilobytes; anything near this is not one. */
const MAX_BYTES = 256 * 1024;

/** A file that parsed: the snapshot to keep. */
export interface CriteriaSnapshot {
  fileSha: string;
  sourceSha: string;
  criteria: ParsedCriteria;
  /** The `tests-criterion` input of the workflow at the same commit, null when absent: the setting's pre-fill. */
  workflowTestsCriterion: string | null;
}

/** A file read: the snapshot, or the errors to show. */
export type CriteriaRead = ({ ok: true } & CriteriaSnapshot) | { ok: false; errors: CriteriaError[] };

/** Why a load was asked, besides the switch: the audit's `payload.trigger`. */
export type CriteriaTrigger = "reload" | "publish" | "sync";

const refused = (code: CriteriaError["code"], path = CRITERIA_FILE): CriteriaRead => ({ ok: false, errors: [{ path, code }] });

/**
 * `criteria.yml` at the head of the project's first branch, in its
 * distribution repository (its source's while it has none), parsed, and
 * the grading workflow beside it. A missing branch or file, one too large,
 * or a workflow that needs the network is a refusal like a parse error;
 * GitHub failing otherwise throws. `409 app_not_installed` when the App no
 * longer acts on the project's organization.
 */
export async function readCriteria(db: Db, config: AppConfig, project: ProjectRow): Promise<CriteriaRead> {
  const org = await projectInstallation(db, project.orgId);
  if (!org) throw new ProjectError("app_not_installed", "Quiz's GitHub App no longer acts on the project's organization");
  const { octokit } = await installationClient(config, org.installationId);
  const { owner, repo } = ownerRepo(project.distributionFullName ?? project.sourceFullName);
  const branch = project.branches[0]!;
  const head = await unless404(async () => {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner,
      repo,
      ref: `heads/${branch}`,
      request: { retries: 0 },
    });
    return data.object.sha;
  });
  if (head === null) return refused("branch_missing");
  const fileAt = (path: string) =>
    unless404(async () => {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path,
        ref: head,
        request: { retries: 0 },
      });
      if (Array.isArray(data) || data.type !== "file") return null;
      const text = Buffer.from(data.content ?? "", "base64").toString("utf8");
      return { sha: data.sha, text, tooLarge: (data.size ?? 0) > MAX_BYTES || text.length > MAX_BYTES };
    });
  const file = await fileAt(CRITERIA_FILE);
  if (file === null) return refused("missing_file");
  if (file.tooLarge) return refused("too_large");
  const parsed = parseCriteria(file.text);
  if (!parsed.ok) return parsed;
  const workflow = await fileAt(GRADING_WORKFLOW);
  const text = workflow === null || workflow.tooLarge ? null : workflow.text;
  if (text !== null && workflowNeedsNetwork(text)) return refused("workflow_needs_network", GRADING_WORKFLOW);
  return {
    ok: true,
    fileSha: file.sha,
    sourceSha: head,
    criteria: parsed.criteria,
    workflowTestsCriterion: text === null ? null : workflowTestsCriterion(text),
  };
}

/** `409 criteria_invalid`, the errors in its body. */
function criteriaInvalid(errors: CriteriaError[]): ProjectError {
  return new ProjectError("criteria_invalid", `${CRITERIA_FILE} is missing or invalid`, { errors });
}

/** The project's checkpoints a snapshot would leave untagged (ADR-106 §5). */
async function untagged(db: Db | Tx, projectId: string, snapshot: CriteriaSnapshot): Promise<string[]> {
  const rows = await db.select({ name: projectCheckpoints.name }).from(projectCheckpoints).where(eq(projectCheckpoints.projectId, projectId));
  return untaggedCheckpoints(
    rows.map((r) => r.name),
    snapshot.criteria.leaves,
  );
}

/**
 * The snapshot a project in (or entering) `criteria` mode may take: the
 * file read, or `409 criteria_invalid`; then `409 checkpoint_untagged`,
 * naming the checkpoints whose name would tag no criterion.
 */
async function acceptable(db: Db | Tx, projectId: string, read: CriteriaRead, criteriaMode: boolean): Promise<CriteriaSnapshot> {
  if (!read.ok) throw criteriaInvalid(read.errors);
  const names = criteriaMode ? await untagged(db, projectId, read) : [];
  if (names.length > 0) throw new ProjectError("checkpoint_untagged", "A checkpoint's name tags no criterion", { checkpoints: names });
  return read;
}

/**
 * Replaces the project's snapshot, and pre-fills a tests criterion never
 * set from the workflow's `tests-criterion` when it names a criterion of
 * the snapshot (ADR-106 §2) — a staff's choice is never overwritten.
 */
export async function storeCriteria(db: Db | Tx, projectId: string, snapshot: CriteriaSnapshot, now: Date): Promise<void> {
  const values = { fileSha: snapshot.fileSha, sourceSha: snapshot.sourceSha, criteria: snapshot.criteria, loadedAt: now };
  await db
    .insert(projectCriteria)
    .values({ projectId, ...values })
    .onConflictDoUpdate({ target: projectCriteria.projectId, set: values });
  const prefill = snapshot.workflowTestsCriterion;
  if (prefill !== null && snapshot.criteria.leaves.some((leaf) => leaf.id === prefill)) {
    await db
      .update(projects)
      .set({ testsCriterion: prefill })
      .where(and(eq(projects.id, projectId), isNull(projects.testsCriterion)));
  }
}

/** The audit of a reload, a publication's or a sync's: the file read and whether it was kept (counts, never the errors' text). */
async function auditReload(db: Db, projectId: string, read: CriteriaRead, kept: boolean, trigger: CriteriaTrigger, actor: AuditActor): Promise<void> {
  await audit(db, {
    ...actor,
    action: "project.criteria_reload",
    subjectType: "project",
    subjectId: projectId,
    payload: read.ok
      ? { trigger, ok: kept, fileSha: read.fileSha, sourceSha: read.sourceSha, criteria: read.criteria.leaves.length }
      : { trigger, ok: false, errors: read.errors.length },
  });
}

/** The ids of the project's snapshot, null without one. */
export async function snapshotIds(db: Db | Tx, projectId: string): Promise<string[] | null> {
  const [row] = await db.select({ criteria: projectCriteria.criteria }).from(projectCriteria).where(eq(projectCriteria.projectId, projectId));
  return row ? row.criteria.leaves.map((leaf) => leaf.id) : null;
}

/** `GET /app/api/projects/:id/criteria`: the snapshot, each criterion classified under the project's settings. */
export async function criteriaView(db: Db | Tx, project: ProjectRow): Promise<ProjectCriteriaView> {
  const [row] = await db.select().from(projectCriteria).where(eq(projectCriteria.projectId, project.id));
  if (!row) return { snapshot: null };
  const { leaves, sections, grading } = row.criteria;
  const { max, bonusMax } = criteriaTotals(leaves, {});
  const settings = { testsCriterion: effectiveTestsCriterion(project) };
  return {
    snapshot: {
      fileSha: row.fileSha,
      sourceSha: row.sourceSha,
      loadedAt: iso(row.loadedAt),
      grading,
      sections,
      leaves: leaves.map((leaf) => ({ ...leaf, kind: classifyCriterion(leaf, settings) })),
      max,
      bonusMax,
    },
  };
}

/**
 * `POST /app/api/projects/:id/criteria/reload` (the staff, any mode): the
 * file read again and the snapshot replaced, audited; a refusal
 * (`criteria_invalid`, `checkpoint_untagged` in `criteria` mode) leaves the
 * last snapshot.
 */
export async function reloadCriteria(db: Db, config: AppConfig, project: ProjectRow, actor: AuditActor, now: Date): Promise<ProjectCriteriaView> {
  const read = await readCriteria(db, config, project);
  let snapshot: CriteriaSnapshot;
  try {
    snapshot = await acceptable(db, project.id, read, project.gradingMode === "criteria");
  } catch (err) {
    await auditReload(db, project.id, read, false, "reload", actor);
    throw err;
  }
  await storeCriteria(db, project.id, snapshot, now);
  await auditReload(db, project.id, read, true, "reload", actor);
  // The row again: the load may have pre-filled the tests criterion.
  const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
  return criteriaView(db, row ?? project);
}

/**
 * The snapshot a patch switching the mode to `criteria` takes (ADR-106 §1),
 * read before the switch's transaction: null when the patch does not switch
 * it. The switch's own refusal is judged first (`projectFieldRefusal`), so a
 * published project answers `not_draft`, not the state of its file; then
 * `criteria_invalid` or `checkpoint_untagged`. Audited by the switch itself.
 */
export async function criteriaForSwitch(
  db: Db,
  config: AppConfig,
  project: ProjectRow,
  to: ProjectRow["gradingMode"] | undefined,
  now: Date,
): Promise<CriteriaSnapshot | null> {
  if (to !== "criteria" || project.gradingMode === "criteria") return null;
  const refusal = projectFieldRefusal(lifeOf(project), "gradingMode", now, to);
  if (refusal) throw new ProjectError(refusal, "gradingMode can no longer change");
  return acceptable(db, project.id, await readCriteria(db, config, project), true);
}

/**
 * After a publication or a sync, a project in `criteria` mode loads its
 * file again; best-effort — a failure, a file that no longer parses or one
 * that would leave a checkpoint untagged keeps the last snapshot (audited,
 * logged), never fails the act it follows.
 */
export async function refreshCriteria(
  db: Db,
  config: AppConfig,
  projectId: string,
  trigger: "publish" | "sync",
  actor: AuditActor,
  now: Date,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (project?.gradingMode !== "criteria") return;
    const read = await readCriteria(db, config, project);
    const snapshot = await acceptable(db, project.id, read, true).catch((err: unknown) => {
      if (err instanceof ProjectError) return null;
      throw err;
    });
    if (snapshot) await storeCriteria(db, project.id, snapshot, now);
    else log.warn({ project: projectId }, "criteria.yml refused: the last snapshot is kept");
    await auditReload(db, project.id, read, snapshot !== null, trigger, actor);
  } catch (err) {
    log.error({ err, project: projectId }, "loading criteria.yml failed: the last snapshot is kept");
  }
}
