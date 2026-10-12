/**
 * The one writer of `project_criterion_grades` (ADR-106 §4), modelled on
 * `writeGradings` (`modules/grading/service.ts`): the evidence job writes
 * the automatic rows through it, the review job (L-02c) the llm rows, the
 * grading screen (L-02e) the teacher's.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";

import { criteriaScore, currentCriterionRows, repoValidation, type ParsedCriteria, type RepoValidation } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { projectCriteria, projectCriterionGrades, projectRepos, projects } from "../../db/schema.js";
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

/**
 * The criteria of a repository a machine may not propose: a standing
 * validated or teacher's row — and, with `passId`, a row of that pass (a
 * job run twice proposes nothing again).
 */
export async function heldCriteria(db: Db | Tx, repoId: string, passId?: string): Promise<Set<string>> {
  const rows = await db
    .select({ criterionId: projectCriterionGrades.criterionId })
    .from(projectCriterionGrades)
    .where(
      and(
        eq(projectCriterionGrades.repoId, repoId),
        ne(projectCriterionGrades.state, "superseded"),
        or(
          eq(projectCriterionGrades.state, "validated"),
          eq(projectCriterionGrades.source, "manual"),
          passId === undefined ? sql`false` : eq(projectCriterionGrades.passId, passId),
        ),
      ),
    );
  return new Set(rows.map((r) => r.criterionId));
}

/**
 * A deadline moved later before the release (ADR-106 §5, §6): the
 * machine's standing proposals (`auto`, `llm`) of the reopened
 * repositories superseded, with no successor — the next freeze's pass
 * proposes again. A validated row and a teacher's stay. In the caller's
 * transaction, which holds the repositories' rows.
 */
export async function supersedeProposals(tx: Tx, repoIds: readonly string[]): Promise<number> {
  if (repoIds.length === 0) return 0;
  const rows = await tx
    .update(projectCriterionGrades)
    .set({ state: "superseded" })
    .where(
      and(
        inArray(projectCriterionGrades.repoId, [...repoIds]),
        eq(projectCriterionGrades.state, "proposed"),
        inArray(projectCriterionGrades.source, ["auto", "llm"]),
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
 * - A machine's `proposed` input supersedes only a machine's proposal, and
 *   is DROPPED when its criterion is held ({@link heldCriteria}: a standing
 *   validated or teacher's row) — read under the lock, so a teacher's row
 *   written while a model was being asked always wins (the callers' own
 *   check only spares a needless call).
 *
 * A criterion appears at most once per call. The rows written come back in
 * the order of `inputs`.
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
    await lockRepos(tx, [repoId]);
    return writeLocked(tx, repoId, all, now);
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

/** {@link writeCriterionGrades}'s supersede-and-insert, under the lock its caller holds. */
async function writeLocked(tx: Tx, repoId: string, all: readonly CriterionGradeInput[], now: Date): Promise<CriterionGradeRow[]> {
  const overrides = (i: CriterionGradeInput) => i.source === "manual" || i.state === "validated";
  const held = await heldCriteria(tx, repoId);
  const inputs = all.filter((i) => overrides(i) || !held.has(i.criterionId));
  if (inputs.length === 0) return [];
  const among = (override: boolean) => {
    const ids = inputs.filter((i) => overrides(i) === override).map((i) => i.criterionId);
    return ids.length === 0 ? sql`false` : inArray(projectCriterionGrades.criterionId, ids);
  };
  const superseded = await tx
    .update(projectCriterionGrades)
    .set({ state: "superseded" })
    .where(
      and(
        eq(projectCriterionGrades.repoId, repoId),
        ne(projectCriterionGrades.state, "superseded"),
        or(
          among(true),
          and(among(false), eq(projectCriterionGrades.state, "proposed"), ne(projectCriterionGrades.source, "manual")),
        ),
      ),
    )
    .returning({ id: projectCriterionGrades.id, criterionId: projectCriterionGrades.criterionId, createdAt: projectCriterionGrades.createdAt });
  const previous = new Map<string, { id: string; createdAt: Date }>();
  for (const row of superseded) {
    const held = previous.get(row.criterionId);
    if (!held || row.createdAt >= held.createdAt) previous.set(row.criterionId, row);
  }
  return tx
    .insert(projectCriterionGrades)
    .values(
      inputs.map((input) => ({
        ...input,
        id: randomUUID(),
        repoId,
        supersedesId: previous.get(input.criterionId)?.id ?? null,
        createdAt: now,
      })),
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
      validated.set(repoId, inputs.length === 0 ? 0 : (await writeLocked(tx, repoId, inputs, now)).length);
    }
    return validated;
  });
}
