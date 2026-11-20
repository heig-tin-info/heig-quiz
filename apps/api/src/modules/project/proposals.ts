/**
 * An assistant's proposals on the contestations of a project's criteria
 * (ADR-139 §14, Lot 2), as on an exam's (`modules/grading/proposals.ts`):
 * an MCP client with a token of scope `quiz`, at the consent that lets it,
 * reads the project's OPEN contestations — masked as ADR-106 §4 and ADR-119
 * §7 mask a repository's material, capped — and PROPOSES the owner's answer:
 * a verdict, a reply, the criterion's new points and their rationale.
 * Nothing is applied until the course owner confirms it in the portal,
 * through the resolve path of Lot 1b, the criterion's row in force it
 * recorded still in force (`proposal_stale` otherwise).
 *
 * Nothing of a proposal reaches a member: the student payloads read
 * `studentProjectContestationOf`, which names none of these columns.
 */
import { and, asc, count, eq, isNotNull } from "drizzle-orm";

import type {
  AssistantProjectContestation,
  AssistantProjectContestations,
  ContestationProposalView,
  ProjectContestationResolveBody,
} from "@quiz/contracts";
import { clipText, CONTESTATION_EXPORT_PAGE, contestationPage, currentCriterionRows, proposalStale } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { projectContestations, projectRepos, projects } from "../../db/schema.js";
import {
  answered,
  assertAcceptable,
  currentGradeId,
  NO_PROJECT_PROPOSAL,
  projectProposalViewOf,
  snapshotLeaves,
  stale,
  type ProjectContestationRecord,
} from "./contestations.js";
import { criteriaStandings } from "./criterionGrades.js";
import { LIVE } from "./deadline.js";
import { ProjectError } from "./errors.js";
import type { RepoRow } from "./repos.js";
import { masker } from "./reviewPass.js";
import type { ProjectRow } from "./views.js";

const noProposal = () => new ProjectError("no_proposal", "No proposal stands on this contestation");

/**
 * An assistant's proposal on an OPEN contestation of a criterion (`409
 * not_open` otherwise), validated as the owner's answer would be: an
 * acceptance only while the criterion is in the snapshot (`409
 * criterion_removed`), new points within its awarded range (`422
 * points_out_of_range`). It overwrites the one standing, and records the
 * criterion's row in force — the one its confirmation compares.
 */
export async function proposeProjectResolution(
  db: Db,
  input: {
    project: ProjectRow;
    contestation: ProjectContestationRecord;
    repo: RepoRow;
    body: ProjectContestationResolveBody;
    userId: string;
    now: Date;
  },
): Promise<ProjectContestationRecord> {
  const { project, contestation, repo, body } = input;
  if (contestation.state !== "open") throw answered();
  assertAcceptable((await snapshotLeaves(db, project.id)).get(contestation.criterionId), body.verdict, body.points);
  const current = await currentGradeId(db, repo, contestation.criterionId);
  const [row] = await db
    .update(projectContestations)
    .set({
      proposedVerdict: body.verdict,
      proposedReply: body.reply,
      proposedPoints: body.points ?? null,
      proposedRationale: body.rationale ?? null,
      proposedBy: input.userId,
      proposedAt: input.now,
      gradeAtProposalId: current,
    })
    .where(and(eq(projectContestations.id, contestation.id), eq(projectContestations.state, "open")))
    .returning();
  if (!row) throw answered();
  return row;
}

/** Drops the proposal standing on a contestation; `404 no_proposal` when none stood. */
export async function discardProjectProposal(db: Db, contestationId: string): Promise<void> {
  const cleared = await db
    .update(projectContestations)
    .set(NO_PROJECT_PROPOSAL)
    .where(and(eq(projectContestations.id, contestationId), isNotNull(projectContestations.proposedAt)))
    .returning({ id: projectContestations.id });
  if (cleared.length === 0) throw noProposal();
}

/**
 * Whether the proposal the owner read (`read`, its `proposedAt`) may be
 * confirmed now: open (`409 not_open`), a proposal standing (`404
 * no_proposal`), that very proposal — not one an assistant wrote since —
 * and the criterion's row in force the one it recorded (`409
 * proposal_stale`). The confirmation's own write checks it again. Answers
 * that row's id.
 */
export async function assertProjectConfirmable(db: Db, contestation: ProjectContestationRecord, repo: RepoRow, read: string): Promise<string | null> {
  if (contestation.state !== "open") throw answered();
  if (contestation.proposedAt === null) throw noProposal();
  if (contestation.proposedAt.toISOString() !== new Date(read).toISOString()) throw stale();
  const current = await currentGradeId(db, repo, contestation.criterionId);
  if (proposalStale(contestation.gradeAtProposalId, current)) throw stale();
  return current;
}

/** The owner's answer a proposal stands for. */
export function confirmationBody(row: ProjectContestationRecord): ProjectContestationResolveBody {
  return {
    verdict: row.proposedVerdict!,
    reply: row.proposedReply ?? "",
    ...(row.proposedPoints === null ? {} : { points: row.proposedPoints }),
    ...(row.proposedRationale === null ? {} : { rationale: row.proposedRationale }),
  };
}

/**
 * A proposal as an assistant reads it back: its reply and rationale masked
 * (a member of the staff may have written them from the portal, with a name).
 */
const maskedProposal = (proposal: ContestationProposalView | null, text: (value: string | null) => string | null): ContestationProposalView | null =>
  proposal && { ...proposal, reply: text(proposal.reply) ?? "", rationale: text(proposal.rationale) };

/**
 * `GET /app/api/projects/:id/contestations/open` (ADR-139 §14): the OPEN
 * contestations on the project's live repositories, oldest first, one page
 * from `offset` (`contestationPage`), each with an opaque id — never the
 * repository, a name, an address or a login: the reason, the rationale and
 * the reason of the criterion's row masked by the repository's masker
 * (ADR-106 §4, ADR-119 §7), then capped — the criterion as the snapshot
 * holds it, its row in force, the proposal standing.
 */
export async function assistantProjectContestations(db: Db, project: ProjectRow, offset: number): Promise<AssistantProjectContestations> {
  const open = and(eq(projectRepos.projectId, project.id), eq(projectContestations.state, "open"), LIVE);
  const [[counted], rows, leaves] = await Promise.all([
    db
      .select({ n: count() })
      .from(projectContestations)
      .innerJoin(projectRepos, eq(projectRepos.id, projectContestations.repoId))
      .innerJoin(projects, eq(projects.id, projectRepos.projectId))
      .where(open),
    db
      .select({ contestation: projectContestations, repo: projectRepos })
      .from(projectContestations)
      .innerJoin(projectRepos, eq(projectRepos.id, projectContestations.repoId))
      .innerJoin(projects, eq(projects.id, projectRepos.projectId))
      .where(open)
      .orderBy(asc(projectContestations.filedAt), asc(projectContestations.id))
      .offset(offset)
      .limit(CONTESTATION_EXPORT_PAGE),
    snapshotLeaves(db, project.id),
  ]);
  const total = counted?.n ?? 0;
  const standings = await criteriaStandings(db, rows.map((r) => r.repo));
  // One masker per repository, whatever the number of its contestations.
  const maskers = new Map<string, Promise<(text: string) => string>>();
  const entries: AssistantProjectContestation[] = [];
  for (const { contestation, repo } of rows) {
    if (!maskers.has(repo.id)) maskers.set(repo.id, masker(db, repo, project));
    const mask = await maskers.get(repo.id)!;
    const text = (value: string | null) => (value === null ? null : clipText(mask(value)));
    const leaf = leaves.get(contestation.criterionId);
    const current = currentCriterionRows(standings.get(repo.id)?.rows ?? []).get(contestation.criterionId);
    entries.push({
      id: contestation.id,
      filedAt: iso(contestation.filedAt),
      reason: text(contestation.reason)!,
      criterion: {
        id: contestation.criterionId,
        description: leaf?.description ?? contestation.criterionDescription,
        section: leaf?.sectionPath ?? [],
        max: leaf?.maxPoints ?? contestation.maxAtFiling,
        bonus: leaf ? (leaf.bonusPoints ?? null) : contestation.bonusAtFiling,
        prompt: leaf?.prompt === undefined ? null : clipText(leaf.prompt),
        inSnapshot: leaf !== undefined,
      },
      pointsAtFiling: contestation.pointsAtFiling,
      grading: current
        ? { points: current.points, state: current.state, source: current.source, rationale: text(current.rationale), reason: text(current.reason) }
        : null,
      proposal: maskedProposal(projectProposalViewOf(contestation, current?.id ?? null), text),
    });
  }
  const { take, next } = contestationPage(entries.map((e) => JSON.stringify(e).length), offset, total);
  return { projectId: project.id, name: project.name, total, offset, next, contestations: entries.slice(0, take) };
}
