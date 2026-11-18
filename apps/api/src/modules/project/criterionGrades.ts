/**
 * The one writer of `project_criterion_grades` (ADR-106 §4), modelled on
 * `writeGradings` (`modules/grading/service.ts`): the evidence job writes
 * the automatic rows through it, the review job (L-02c) the llm rows, the
 * grading screen (L-02e) the teacher's.
 *
 * **A milestone's lock** (§5, L-02d): a row a milestone pass wrote carries
 * `locked_by_checkpoint_id` and `locked_at`; its criterion is then held
 * against every machine proposal (the final pass, a Regrade), and every row
 * that supersedes it — a teacher's correction, a validation — inherits the
 * lock.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { criteriaScore, currentCriterionRows, holdsCriterion, regradePower, repoValidation, type ParsedCriteria, type RepoValidation } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { gradeDispatches, projectCriteria, projectCriterionGrades, projectRepos, projects } from "../../db/schema.js";
import { ProjectError } from "./errors.js";

export type CriterionGradeRow = typeof projectCriterionGrades.$inferSelect;

/** What a standing reads of a row: the domain's `CriterionGradeLike`. */
const STANDING_COLUMNS = {
  repoId: projectCriterionGrades.repoId,
  criterionId: projectCriterionGrades.criterionId,
  points: projectCriterionGrades.points,
  source: projectCriterionGrades.source,
  state: projectCriterionGrades.state,
  rationale: projectCriterionGrades.rationale,
  reason: projectCriterionGrades.reason,
  createdAt: projectCriterionGrades.createdAt,
  lockedAt: projectCriterionGrades.lockedAt,
  passId: projectCriterionGrades.passId,
};
type StandingRow = Pick<CriterionGradeRow, keyof typeof STANDING_COLUMNS>;

/** Where a repository of a project graded by criteria stands (ADR-106 §7, §8). */
export interface CriteriaStanding {
  snapshot: ParsedCriteria;
  /** Its rows, superseded ones included (the domain reads the current ones). */
  rows: StandingRow[];
  validation: RepoValidation;
  /** The `criteria` final-score source: null until validated. */
  score: { points: number; max: number } | null;
}

/**
 * The standing of each of `repos` whose project is graded by `criteria`
 * and holds a snapshot, by repository id, in two reads whatever the count:
 * the snapshots, then the rows. A repository of a project in another mode
 * is absent — its rows, if a switch left any, count for nothing (§10).
 */
export async function criteriaStandings(db: Db | Tx, repos: readonly { id: string; projectId: string }[]): Promise<Map<string, CriteriaStanding>> {
  const standings = new Map<string, CriteriaStanding>();
  const projectIds = [...new Set(repos.map((r) => r.projectId))];
  if (projectIds.length === 0) return standings;
  const snapshots = await db
    .select({ projectId: projectCriteria.projectId, criteria: projectCriteria.criteria })
    .from(projectCriteria)
    .innerJoin(projects, eq(projects.id, projectCriteria.projectId))
    .where(and(inArray(projectCriteria.projectId, projectIds), eq(projects.gradingMode, "criteria")));
  const byProject = new Map(snapshots.map((s) => [s.projectId, s.criteria]));
  const graded = repos.filter((r) => byProject.has(r.projectId));
  if (graded.length === 0) return standings;
  const rows = await db
    .select(STANDING_COLUMNS)
    .from(projectCriterionGrades)
    .where(inArray(projectCriterionGrades.repoId, graded.map((r) => r.id)));
  for (const repo of graded) {
    const snapshot = byProject.get(repo.projectId)!;
    const own = rows.filter((r) => r.repoId === repo.id);
    standings.set(repo.id, { snapshot, rows: own, validation: repoValidation(snapshot, own), score: criteriaScore(snapshot, own) });
  }
  return standings;
}

/**
 * Of `repos` (the caller's live student repositories), those of a project
 * graded by criteria that are not validated (ADR-106 §8): what the release
 * waits for and the page's primary action reads. None in another mode.
 */
export function unvalidatedRepos(
  project: { gradingMode: string },
  repos: readonly { id: string }[],
  standings: ReadonlyMap<string, CriteriaStanding>,
): string[] {
  return repos.filter((repo) => awaitsValidation(project.gradingMode, standings.get(repo.id))).map((repo) => repo.id);
}

/** One repository waits for its validation: graded by criteria, and not every criterion validated (a missing standing included). */
export function awaitsValidation(gradingMode: string, standing: CriteriaStanding | undefined): boolean {
  return gradingMode === "criteria" && standing?.validation.validated !== true;
}

/** A repository's standing rows, as a hold reads them (`holdsCriterion`). */
async function standingRows(db: Db | Tx, repoId: string) {
  return db
    .select({
      criterionId: projectCriterionGrades.criterionId,
      source: projectCriterionGrades.source,
      state: projectCriterionGrades.state,
      locked: sql<boolean>`${projectCriterionGrades.lockedByCheckpointId} is not null`,
      passId: projectCriterionGrades.passId,
    })
    .from(projectCriterionGrades)
    .where(and(eq(projectCriterionGrades.repoId, repoId), ne(projectCriterionGrades.state, "superseded")));
}

/**
 * The repository's pass holding the Regrade power (`regradePower`, ADR-132
 * §5), read from the database, never from a job: its latest pass that is
 * not a milestone's, when it is a Regrade claimed after the project's last
 * release; null otherwise. The project's row is share-locked: in a writer's
 * transaction, a release (which takes it for update) waits for the write,
 * or the write sees the release.
 */
async function regradePass(db: Db | Tx, repoId: string): Promise<string | null> {
  const [latest] = await db
    .select({ id: gradeDispatches.id, trigger: gradeDispatches.trigger, createdAt: gradeDispatches.createdAt, releasedAt: projects.releasedAt })
    .from(gradeDispatches)
    .innerJoin(projectRepos, eq(projectRepos.id, gradeDispatches.repoId))
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(and(eq(gradeDispatches.repoId, repoId), isNull(gradeDispatches.checkpointId)))
    .orderBy(desc(gradeDispatches.createdAt))
    .limit(1)
    .for("share", { of: projects });
  return latest && regradePower(latest, latest.releasedAt) ? latest.id : null;
}

/** What a hold weighs of an input (`holdsCriterion`): whether its pass holds the Regrade power, and its failure reason. */
const proposal = (input: Pick<CriterionGradeInput, "passId" | "reason">, power: string | null) => ({
  regrade: input.passId !== null && input.passId === power,
  reason: input.reason,
});

/**
 * The criteria of a repository on which a result of `passId` would not be
 * written (`holdsCriterion`): a standing teacher's or locked row (a
 * milestone's, §5), a validated one unless the pass holds the Regrade power
 * (ADR-132 §5), and a row of that pass (a job run twice proposes nothing
 * again). The callers' check only spares a needless call; the writer
 * decides again under its lock.
 */
export async function heldCriteria(db: Db | Tx, repoId: string, passId?: string): Promise<Set<string>> {
  const [rows, power] = await Promise.all([standingRows(db, repoId), passId === undefined ? null : regradePass(db, repoId)]);
  const result = proposal({ passId: passId ?? null, reason: null }, power);
  return new Set(rows.filter((r) => (passId !== undefined && r.passId === passId) || holdsCriterion(r, result)).map((r) => r.criterionId));
}

/**
 * A deadline moved later before the release (ADR-106 §5, §6; F-PROJ-09's
 * reopen): the final pass's rows of the reopened repositories — the
 * machine's (`auto`, `llm`) standing rows, proposed or validated, so their
 * validations are undone — superseded, with no successor: the next
 * freeze's pass proposes again. A teacher's row and a milestone's locked
 * row stay. In the caller's transaction, which holds the repositories'
 * rows.
 */
export async function supersedeProposals(tx: Tx, repoIds: readonly string[]): Promise<number> {
  if (repoIds.length === 0) return 0;
  const rows = await tx
    .update(projectCriterionGrades)
    .set({ state: "superseded" })
    .where(
      and(
        inArray(projectCriterionGrades.repoId, [...repoIds]),
        ne(projectCriterionGrades.state, "superseded"),
        inArray(projectCriterionGrades.source, ["auto", "llm"]),
        isNull(projectCriterionGrades.lockedByCheckpointId),
      ),
    )
    .returning({ id: projectCriterionGrades.id });
  return rows.length;
}

/** One criterion's new row. */
export interface CriterionGradeInput {
  criterionId: string;
  points: number;
  max: number;
  source: CriterionGradeRow["source"];
  state: "proposed" | "validated";
  rationale?: string | null;
  reason?: CriterionGradeRow["reason"];
  passId: string | null;
  createdBy?: string | null;
  /** A milestone pass's lock (§5); a row without one inherits the lock of the row it supersedes. */
  lockedByCheckpointId?: string | null;
  lockedAt?: Date | null;
}

/**
 * Writes one row per input for the repository, in one transaction under
 * the repository row's lock and two statements: the rows they replace
 * superseded (`UPDATE … RETURNING`), then one insert, each new row pointing
 * at the newest row its criterion lost.
 *
 * - A `manual` input — a teacher's row, in the state it carries — and a
 *   `validated` one supersede everything standing on their criterion,
 *   whatever its source or state.
 * - A machine's `proposed` input is DROPPED when a standing row holds its
 *   criterion (`holdsCriterion`: a teacher's or locked row; a validated one,
 *   unless the input is a result of the pass holding the Regrade power —
 *   whose failure, in turn, replaces no machine row, ADR-132 §5), and
 *   supersedes the rest — read under the lock, so a teacher's row written
 *   while a model was being asked always wins (the callers' own check only
 *   spares a needless call). A failure dropped so is recorded on its pass
 *   (`grade_dispatches.kept_failures`), for the staff's line (§6).
 *
 * A new row without a lock of its own keeps the lock of a row it
 * supersedes (§5): a teacher's correction or a validation of a locked row
 * stays locked. A criterion appears at most once per call. The rows written
 * come back in the order of `inputs`.
 */
export async function writeCriterionGrades(
  db: Db,
  repoId: string,
  all: readonly CriterionGradeInput[],
  now: Date,
): Promise<CriterionGradeRow[]> {
  if (new Set(all.map((i) => i.criterionId)).size !== all.length) {
    throw new Error("writeCriterionGrades: a criterion appears twice in one call");
  }
  if (all.length === 0) return [];
  return db.transaction(async (tx) => {
    // The project's row first, then the repository's: a release's order.
    const power = await regradePass(tx, repoId);
    await lockRepos(tx, [repoId]);
    return writeLocked(tx, repoId, all, now, power);
  });
}

/** The repositories' rows locked, in a stable order (two writers never wait on each other crosswise). */
async function lockRepos(tx: Tx, repoIds: readonly string[]) {
  return tx
    .select({ id: projectRepos.id, frozenAt: projectRepos.frozenAt })
    .from(projectRepos)
    .where(inArray(projectRepos.id, [...repoIds]))
    .orderBy(projectRepos.id)
    .for("update");
}

/** {@link writeCriterionGrades}'s supersede-and-insert, under the lock its caller holds; `power` the pass holding the Regrade power. */
async function writeLocked(tx: Tx, repoId: string, all: readonly CriterionGradeInput[], now: Date, power: string | null): Promise<CriterionGradeRow[]> {
  const overrides = (i: CriterionGradeInput) => i.source === "manual" || i.state === "validated";
  const standing = await standingRows(tx, repoId);
  const inputs = all.filter((i) => overrides(i) || !standing.some((r) => r.criterionId === i.criterionId && holdsCriterion(r, proposal(i, power))));
  // A failure that left a row standing, on its CI pass: what the staff's line names (ADR-132 §6).
  const kept = all.filter((i) => !inputs.includes(i) && i.reason && i.passId !== null);
  for (const passId of new Set(kept.map((i) => i.passId!))) {
    const failures = Object.fromEntries(kept.filter((i) => i.passId === passId).map((i) => [i.criterionId, i.reason]));
    await tx
      .update(gradeDispatches)
      .set({ keptFailures: sql`coalesce(${gradeDispatches.keptFailures}, '{}'::jsonb) || ${JSON.stringify(failures)}::jsonb` })
      .where(and(eq(gradeDispatches.id, passId), isNotNull(gradeDispatches.nonce)));
  }
  if (inputs.length === 0) return [];
  // Every standing row of a criterion kept is one its input replaces: the filter above, under the same lock, left no other.
  const superseded = await tx
    .update(projectCriterionGrades)
    .set({ state: "superseded" })
    .where(
      and(
        eq(projectCriterionGrades.repoId, repoId),
        ne(projectCriterionGrades.state, "superseded"),
        inArray(
          projectCriterionGrades.criterionId,
          inputs.map((i) => i.criterionId),
        ),
      ),
    )
    .returning({
      id: projectCriterionGrades.id,
      criterionId: projectCriterionGrades.criterionId,
      createdAt: projectCriterionGrades.createdAt,
      lockedByCheckpointId: projectCriterionGrades.lockedByCheckpointId,
      lockedAt: projectCriterionGrades.lockedAt,
    });
  // The newest row each criterion lost, and its lock: every standing row of a locked criterion carries it.
  const previous = new Map<string, (typeof superseded)[number]>();
  for (const row of superseded) {
    const held = previous.get(row.criterionId);
    if (!held || row.createdAt >= held.createdAt) previous.set(row.criterionId, row);
  }
  return tx
    .insert(projectCriterionGrades)
    .values(
      inputs.map((input) => {
        const lost = previous.get(input.criterionId);
        return {
          ...input,
          id: randomUUID(),
          repoId,
          supersedesId: lost?.id ?? null,
          lockedByCheckpointId: input.lockedByCheckpointId ?? lost?.lockedByCheckpointId ?? null,
          lockedAt: input.lockedAt ?? lost?.lockedAt ?? null,
          createdAt: now,
        };
      }),
    )
    .returning();
}

/**
 * Validate (ADR-106 §8), the writer's own transition: in ONE transaction
 * holding every repository's row, each re-read — frozen for good (`409
 * not_frozen`), and every criterion of `snapshot` with a current row (`409
 * criteria_incomplete` naming every repository and criterion without one:
 * nothing is validated) — then each current proposal superseded by a
 * validated copy (its points, source, rationale, reason and pass) through
 * the same supersede-and-insert. Answers, by repository, how many rows it
 * validated (0: nothing was left to validate).
 */
export async function validateProposals(
  db: Db,
  repoIds: readonly string[],
  snapshot: Pick<ParsedCriteria, "leaves">,
  now: Date,
): Promise<Map<string, number>> {
  return db.transaction(async (tx) => {
    const locked = await lockRepos(tx, repoIds);
    if (locked.length < repoIds.length || locked.some((r) => r.frozenAt === null)) {
      throw new ProjectError("not_frozen", "A repository is validated once its deadline and grace have passed");
    }
    const rows = await tx
      .select()
      .from(projectCriterionGrades)
      .where(and(inArray(projectCriterionGrades.repoId, [...repoIds]), ne(projectCriterionGrades.state, "superseded")));
    const standing = repoIds.map((repoId) => {
      const own = rows.filter((r) => r.repoId === repoId);
      return { repoId, own, validation: repoValidation(snapshot, own) };
    });
    const incomplete = standing.filter((s) => s.validation.missing.length > 0).map((s) => ({ repoId: s.repoId, missing: s.validation.missing }));
    if (incomplete.length > 0) {
      throw new ProjectError("criteria_incomplete", "A criterion without points is written by a teacher before the validation", { repos: incomplete });
    }
    const validated = new Map<string, number>();
    for (const { repoId, own, validation } of standing) {
      const current = currentCriterionRows(own);
      const inputs = validation.proposed.map((criterionId): CriterionGradeInput => {
        const { points, max, source, rationale, reason, passId, createdBy } = current.get(criterionId)!;
        return { criterionId, points, max, source, state: "validated", rationale, reason, passId, createdBy };
      });
      validated.set(repoId, inputs.length === 0 ? 0 : (await writeLocked(tx, repoId, inputs, now, null)).length);
    }
    return validated;
  });
}
