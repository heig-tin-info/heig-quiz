/**
 * The parity checks of the groups (docs/merge/02 §2.5, M8-01c): groups per
 * project and members per group. Each reads Quiz's rows back and answers
 * `red` per parent whose figure differs, one `info` line otherwise. The
 * group repositories are checked with the others (`checks-projects.ts`).
 *
 * A group or a member the import already carried BEFORE this run is exempt
 * (`Ctx.carriedBefore`): a set is live in Quiz (the staff move, add and
 * remove members, the roster's departures cascade), so a later difference is
 * Quiz's own edit, not a loss. What this run wrote must be there.
 */
import { inArray } from "drizzle-orm";

import { projectGroupMembers, projectGroups } from "../../src/db/schema.js";
import type { Ctx } from "./ctx.js";
import type { ImportCheck } from "./registry.js";
import { IN_CHUNK } from "./steps-repos.js";

type Found = Awaited<ReturnType<ImportCheck["run"]>>;

/** Compares, per parent, the source ids this run wrote with those Quiz now holds under it. */
async function perParent(
  ctx: Ctx,
  what: string,
  parent: string,
  wanted: Map<string, { name: string; ids: string[] }>,
  read: (parentIds: string[]) => Promise<{ parentId: string; id: string }[]>,
): Promise<Found> {
  const parentIds = [...wanted.keys()];
  const inQuiz = new Map<string, Set<string>>();
  for (let i = 0; i < parentIds.length; i += IN_CHUNK) {
    for (const row of await read(parentIds.slice(i, i + IN_CHUNK))) inQuiz.set(row.parentId, (inQuiz.get(row.parentId) ?? new Set()).add(row.id));
  }
  const findings: Found = [];
  let total = 0;
  for (const [parentId, { name, ids }] of wanted) {
    const got = ids.filter((id) => inQuiz.get(parentId)?.has(id)).length;
    total += ids.length;
    if (got !== ids.length) findings.push({ severity: "red", detail: `${parent} "${name}" (${parentId}): ${what}: source ${ids.length}, Quiz ${got}` });
  }
  if (findings.length === 0) findings.push({ severity: "info", detail: `${what}: ${total} across ${wanted.size} ${parent}(s), equal in Quiz` });
  return findings;
}

const groupsPerProject: ImportCheck = {
  name: "groups per project",
  async run(ctx) {
    const known = ctx.known.get("assignment_groups");
    const names = new Map(ctx.snapshot.assignments.map((a) => [a.id, a.name]));
    const wanted = new Map<string, { name: string; ids: string[] }>();
    for (const g of ctx.snapshot.groups) {
      if (!known?.has(g.id) || ctx.carriedBefore.groups.has(g.id)) continue;
      const entry = wanted.get(g.assignmentId) ?? { name: names.get(g.assignmentId) ?? g.assignmentId, ids: [] };
      wanted.set(g.assignmentId, { ...entry, ids: [...entry.ids, g.id] });
    }
    return perParent(ctx, "groups", "project", wanted, async (ids) =>
      (await ctx.db.select({ id: projectGroups.id, parentId: projectGroups.projectId }).from(projectGroups).where(inArray(projectGroups.projectId, ids))),
    );
  },
};

const membersPerGroup: ImportCheck = {
  name: "members per group",
  async run(ctx) {
    const known = ctx.known.get("assignment_group_members");
    const names = new Map(ctx.snapshot.groups.map((g) => [g.id, g.name]));
    const wanted = new Map<string, { name: string; ids: string[] }>();
    for (const m of ctx.snapshot.groupMembers) {
      if (!known?.has(m.id) || ctx.carriedBefore.members.has(m.id)) continue;
      const entry = wanted.get(m.groupId) ?? { name: names.get(m.groupId) ?? m.groupId, ids: [] };
      wanted.set(m.groupId, { ...entry, ids: [...entry.ids, m.id] });
    }
    return perParent(ctx, "members", "group", wanted, async (ids) =>
      (await ctx.db.select({ id: projectGroupMembers.id, parentId: projectGroupMembers.groupId }).from(projectGroupMembers).where(inArray(projectGroupMembers.groupId, ids))),
    );
  },
};

export const groupChecks: readonly ImportCheck[] = [groupsPerProject, membersPerGroup];
