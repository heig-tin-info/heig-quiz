/**
 * The parity checks of the projects (docs/merge/02 §2.5, M8-01b): what the
 * row counts of the tally cannot say. Each reads Quiz's rows back and compares
 * them with the source snapshot, over the repositories the import carried,
 * and answers `red` where a figure differs (a red line: exit status 3, an
 * `--apply` rolls back) and one `info` line otherwise, as the operator's
 * evidence.
 *
 * A repository the re-import KEPT (Quiz changed it since the previous
 * import, `reimport.kept`) is left out of the comparisons of values it would
 * legitimately fail (`carriedUnkept`); it is still a carried row for the
 * ones about its existence and links (`carried`). A score or a receipt
 * Quiz's own activity moved past the source is not a loss.
 */
import { inArray } from "drizzle-orm";

import { projectGradeRuns, projectRepos, pushReceipts } from "../../src/db/schema.js";
import type { Ctx } from "./ctx.js";
import type { ImportCheck } from "./registry.js";
import type { SourceStudentRepo } from "./source.js";
import { assignmentsInScope, repoLeftOut, reposInScope } from "./steps-projects.js";
import { IN_CHUNK, REPO_COLUMNS, latest } from "./steps-repos.js";

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

type Found = Awaited<ReturnType<ImportCheck["run"]>>;
type QuizRepo = Pick<typeof projectRepos.$inferSelect, keyof typeof REPO_COLUMNS>;

/** The repositories carried (mapped), those among them the re-import did not keep, and Quiz's row for each. */
async function carriedRows(ctx: Ctx) {
  const known = ctx.known.get("student_repos");
  const carried = reposInScope(ctx).filter((r) => repoLeftOut(ctx, r) === null && known?.has(r.id));
  const kept = new Set(ctx.report.reimport.kept.filter((k) => k.table === "student_repos").map((k) => k.sourceId));
  const rows = new Map<string, QuizRepo>();
  const ids = carried.map((r) => r.id);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    for (const row of await ctx.db.select(REPO_COLUMNS).from(projectRepos).where(inArray(projectRepos.id, ids.slice(i, i + IN_CHUNK)))) rows.set(row.id, row);
  }
  return { carried, carriedUnkept: carried.filter((r) => !kept.has(r.id)), rows };
}

/** Compares one figure per project, source against Quiz; red per project that differs, one info line when none does. */
function perProject(
  what: string,
  pick: "carried" | "carriedUnkept",
  figure: (repos: SourceStudentRepo[], quiz: Map<string, QuizRepo>) => [source: number, quiz: number],
): ImportCheck["run"] {
  return async (ctx) => {
    const found = await carriedRows(ctx);
    const names = new Map(assignmentsInScope(ctx).map((a) => [a.id, a.name]));
    const byProject = new Map<string, SourceStudentRepo[]>();
    for (const r of found[pick]) byProject.set(r.assignmentId, [...(byProject.get(r.assignmentId) ?? []), r]);
    const findings: Found = [];
    let total = 0;
    for (const [projectId, repos] of byProject) {
      const [source, quiz] = figure(repos, found.rows);
      total += source;
      if (!same(source, quiz)) findings.push({ severity: "red", detail: `project "${names.get(projectId)}" (${projectId}): ${what}: source ${source}, Quiz ${quiz}` });
    }
    if (findings.length === 0) findings.push({ severity: "info", detail: `${what}: ${total} across ${byProject.size} project(s), equal in Quiz` });
    return findings;
  };
}

/** Every carried repository is a row of its project (a kept one still exists). */
const repositoriesPerProject: ImportCheck = {
  name: "repositories per project",
  run: perProject("repositories", "carried", (repos, quiz) => [repos.length, repos.filter((r) => quiz.get(r.id)?.projectId === r.assignmentId).length]),
};

/** `sum(teacher_points)` per project, over the rows Quiz did not re-score. */
const teacherPoints: ImportCheck = {
  name: "teacher points",
  run: perProject("sum of teacher points", "carriedUnkept", (repos, quiz) => [
    repos.reduce((n, r) => n + (r.teacherPoints ?? 0), 0),
    repos.reduce((n, r) => n + (quiz.get(r.id)?.teacherPoints ?? 0), 0),
  ]),
};

/** The count of frozen grades (a frozen run set) per project, over the rows Quiz did not change. */
const frozenGrades: ImportCheck = {
  name: "frozen grades",
  run: perProject("frozen grades", "carriedUnkept", (repos, quiz) => [
    repos.filter((r) => r.frozenGradeRunId !== null).length,
    repos.filter((r) => quiz.get(r.id)?.frozenGradeRunId != null).length,
  ]),
};

/** Every grade-run link of a carried repository (kept or not) resolves to a run OF THAT repository (classroom's carry no foreign key). */
const gradeRunLinks: ImportCheck = {
  name: "grade-run links",
  run: async (ctx) => {
    const { rows } = await carriedRows(ctx);
    const owner = new Map<string, string>();
    const ids = [...rows.keys()];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      for (const r of await ctx.db
        .select({ id: projectGradeRuns.id, repoId: projectGradeRuns.repoId })
        .from(projectGradeRuns)
        .where(inArray(projectGradeRuns.repoId, ids.slice(i, i + IN_CHUNK)))) {
        owner.set(r.id, r.repoId);
      }
    }
    const findings: Found = [];
    let links = 0;
    for (const [id, row] of rows) {
      for (const [slot, run] of [["current", row.currentGradeRunId], ["frozen", row.frozenGradeRunId], ["review", row.reviewGradeRunId]] as const) {
        if (run === null) continue;
        links += 1;
        if (owner.get(run) !== id) findings.push({ severity: "red", detail: `repository ${id}: its ${slot} grade run ${run} does not resolve to one of its runs` });
      }
    }
    if (findings.length === 0) findings.push({ severity: "info", detail: `${links} grade-run link(s) of ${rows.size} repositor(ies), every one resolves` });
    return findings;
  },
};

/**
 * The latest push receipt of each repository equals the source's: the sha and
 * the time. A Quiz receipt LATER than the source's latest is Quiz's own
 * ingestion having moved on (a warning, no loss); anything else is red.
 */
const latestReceipts: ImportCheck = {
  name: "latest push receipt",
  run: async (ctx) => {
    const { carried } = await carriedRows(ctx);
    const repos = new Map(carried.filter((r) => r.githubRepoId !== null).map((r) => [r.id, r]));
    const sourceReceipts = new Map<string, SourceSnapshotReceipt[]>();
    for (const p of ctx.snapshot.pushReceipts) if (repos.has(p.studentRepoId)) sourceReceipts.set(p.studentRepoId, [...(sourceReceipts.get(p.studentRepoId) ?? []), p]);
    const githubIds = [...new Set([...repos.values()].map((r) => r.githubRepoId!))];
    const inQuiz = new Map<number, { id: string; sha: string; at: Date }[]>();
    for (let i = 0; i < githubIds.length; i += IN_CHUNK) {
      for (const p of await ctx.db
        .select({ id: pushReceipts.id, g: pushReceipts.githubRepoId, sha: pushReceipts.headSha, at: pushReceipts.receivedAt })
        .from(pushReceipts)
        .where(inArray(pushReceipts.githubRepoId, githubIds.slice(i, i + IN_CHUNK)))) {
        inQuiz.set(p.g, [...(inQuiz.get(p.g) ?? []), p]);
      }
    }
    const findings: Found = [];
    for (const [repoId, all] of sourceReceipts) {
      const want = latest(all, (p) => p.receivedAt)!;
      const got = latest(inQuiz.get(repos.get(repoId)!.githubRepoId!) ?? [], (p) => p.at);
      if (got && got.at.getTime() === want.receivedAt.getTime() && got.sha === want.headSha) continue;
      if (got && got.at > want.receivedAt) {
        findings.push({ severity: "warn", detail: `repository ${repoId}: Quiz's latest receipt (${got.sha}) is later than the source's (${want.headSha}): Quiz took pushes itself` });
      } else {
        findings.push({ severity: "red", detail: `repository ${repoId}: the latest receipt in Quiz is ${got ? `${got.sha} at ${got.at.toISOString()}` : "none"}, the source's ${want.headSha} at ${want.receivedAt.toISOString()}` });
      }
    }
    if (!findings.some((f) => f.severity === "red")) findings.push({ severity: "info", detail: `${sourceReceipts.size} repositor(ies) with receipts, the latest receipt equals the source's` });
    return findings;
  },
};

type SourceSnapshotReceipt = Ctx["snapshot"]["pushReceipts"][number];

export const projectChecks: readonly ImportCheck[] = [repositoriesPerProject, teacherPoints, frozenGrades, gradeRunLinks, latestReceipts];
