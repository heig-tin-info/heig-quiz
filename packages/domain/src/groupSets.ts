/**
 * Group sets (ADR-070; merge task M3-15a): the pure rules of a classroom's
 * groups and of a project's copy of them.
 *
 * - `groupSizes`, `formRandomGroups`: the random formation (§3) — the
 *   students in no group shuffled and cut into balanced groups, the
 *   remainder going to smaller or to larger ones, at the staff's choice;
 * - `copyFollows`: whether a project's copy still follows its set (§4);
 * - `groupSyncPlan`: the difference between a set and a following copy, as
 *   the operations that bring the copy in step (§4), each group following
 *   until its own stop (M3-15b-2); `splitPlan`: what of them waits for
 *   GitHub (the `group.sync` job) and the consequences the staff confirm
 *   (§6), `consequenceDelta` the ones a write adds;
 * - `freeName`, `freeSlug`, `defaultGroupName`, `defaultSetName`: the names.
 *
 * The randomness and the clock are injected by the caller (`crypto`, the
 * server's clock): every function here is deterministic.
 */
import { slugify } from "./repoName.js";
import { SCHOOL_TIME_ZONE, zoneOffset } from "./zone.js";

// ---------------------------------------------------------------- the random formation

/** Where the remainder of a random formation goes (ADR-070 §3). */
export const GROUP_REMAINDERS = ["smaller", "larger"] as const;
export type GroupRemainder = (typeof GROUP_REMAINDERS)[number];

/**
 * The sizes of the groups `n` students are cut into by `size`, the larger
 * first, summing to `n` and differing by at most one. **smaller** makes
 * ⌈n/size⌉ groups (some of size − 1), **larger** ⌊n/size⌋ (some of
 * size + 1). 23 by 3: smaller 3×7 + 2, larger 4×2 + 3×5; 10 by 4: smaller
 * 4, 3, 3, larger 5, 5. At the edges a size may lie further than one from
 * `size`: 5 by 3 larger is one group of 5; 7 by 5 smaller is 4, 3. Empty
 * when `n` is 0. `size` is an integer from 1 to `n` (the service refuses
 * the rest).
 */
export function groupSizes(n: number, size: number, remainder: GroupRemainder): number[] {
  if (n <= 0) return [];
  const count = remainder === "smaller" ? Math.ceil(n / size) : Math.max(1, Math.floor(n / size));
  const base = Math.floor(n / count);
  const extra = n % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** `randomInt(max)`: an integer in [0, max), as `crypto.randomInt`. */
export type RandomInt = (max: number) => number;

/**
 * `students` shuffled (Fisher–Yates on `randomInt`) and cut by
 * {@link groupSizes}: every student once, in exactly one group.
 */
export function formRandomGroups<T>(students: readonly T[], size: number, remainder: GroupRemainder, randomInt: RandomInt): T[][] {
  const deck = [...students];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  const groups: T[][] = [];
  let at = 0;
  for (const n of groupSizes(deck.length, size, remainder)) {
    groups.push(deck.slice(at, at + n));
    at += n;
  }
  return groups;
}

// ---------------------------------------------------------------- the follow

/**
 * A project's copy follows its set while its groups have not stopped
 * (ADR-070 §4): the project's deadline applied, or its archive, stops them
 * for good — a reopen or an unarchive never makes them follow again.
 */
export function copyFollows(project: { groupsStoppedAt: Date | null }): boolean {
  return project.groupsStoppedAt === null;
}

/** A set as {@link groupSyncPlan} reads it: its groups and who is in which. */
export interface SetState {
  groups: readonly { id: string; name: string; position: number }[];
  members: readonly { enrollmentId: string; groupId: string }[];
}

/**
 * A project's copy as {@link groupSyncPlan} reads it. `slugFixed`: the group
 * has a repository, named after its slug, which never changes again
 * (ADR-070 §4; M3-15b). `stopped`: the group no longer follows its set —
 * the first of its project's deadline and its repository's own was applied,
 * or the project was archived (the amendment of 2026-10-05; M3-15b-2).
 */
export interface CopyState {
  groups: readonly {
    id: string;
    name: string;
    slug: string;
    position: number;
    sourceGroupId: string | null;
    slugFixed?: boolean;
    stopped?: boolean;
  }[];
  members: readonly { enrollmentId: string; groupId: string }[];
}

/**
 * The operations that bring a following copy in step with its set, to be
 * applied in this order (they never break the copy's UNIQUE (project, name),
 * (project, slug) and (project, enrollment) when renames go through a
 * temporary name first):
 *   - `delete` — the copy groups whose set group is gone (their members
 *     leave with them, by cascade);
 *   - `update` — a copy group whose name or position differs from its set
 *     group's (the slug follows the name, unless it is fixed);
 *   - `create` — a set group the copy lacks;
 *   - `place` — a student into the copy group of `sourceGroupId`; `from`
 *     the copy group they leave (a move), null when in none;
 *   - `unplace` — the students (roster lines) in the copy who are in no
 *     group of the set.
 */
export interface GroupSyncPlan {
  delete: string[];
  update: { id: string; name: string; slug: string; position: number }[];
  create: { sourceGroupId: string; name: string; slug: string; position: number }[];
  place: { enrollmentId: string; sourceGroupId: string; from: string | null }[];
  unplace: string[];
}

/**
 * The difference of `set` and `copy` (ADR-070 §4), for a copy that follows
 * ({@link copyFollows}). A copy group follows the set group it was made
 * from (`sourceGroupId`); one without a source, or whose source is gone, is
 * deleted. Names follow the set's; in the copy a name or a slug that
 * clashes is disambiguated (`freeName`, `freeSlug`), and a kept group's
 * slug never changes unless its name does — nor ever once fixed (a group
 * with a repository: its slug is reserved first, its name alone follows).
 *
 * **A stopped group** (`stopped`) keeps what it holds: never deleted,
 * renamed nor moved, its name and slug reserved; nobody leaves it and
 * nobody joins it — a move with one stopped end is held whole, the student
 * staying where the copy has them (M3-15b-2). Empty when in step.
 */
export function groupSyncPlan(set: SetState, copy: CopyState): GroupSyncPlan {
  const plan: GroupSyncPlan = { delete: [], update: [], create: [], place: [], unplace: [] };
  const setIds = new Set(set.groups.map((g) => g.id));
  const bySource = new Map<string, CopyState["groups"][number]>();
  for (const g of copy.groups) {
    if (g.sourceGroupId !== null && setIds.has(g.sourceGroupId) && !bySource.has(g.sourceGroupId)) bySource.set(g.sourceGroupId, g);
    else if (!g.stopped) plan.delete.push(g.id);
  }

  // The names and slugs of the copy once in step: the stopped groups and
  // those whose name stays keep theirs first, the others take the first
  // free ones.
  const ordered = [...set.groups].sort((a, b) => a.position - b.position);
  const names = new Set<string>();
  const slugs = new Set<string>();
  for (const g of copy.groups) {
    if (!g.stopped) continue;
    names.add(g.name);
    slugs.add(g.slug);
  }
  for (const g of ordered) {
    const kept = bySource.get(g.id);
    if (kept?.slugFixed) slugs.add(kept.slug);
    if (kept && kept.name === g.name) {
      names.add(kept.name);
      slugs.add(kept.slug);
    }
  }
  for (const g of ordered) {
    const kept = bySource.get(g.id);
    if (kept?.stopped) continue;
    if (kept && kept.name === g.name) {
      if (kept.position !== g.position) plan.update.push({ id: kept.id, name: kept.name, slug: kept.slug, position: g.position });
      continue;
    }
    const name = freeName(g.name, names);
    const slug = kept?.slugFixed ? kept.slug : freeSlug(slugify(name) || "group", slugs);
    names.add(name);
    slugs.add(slug);
    if (kept) plan.update.push({ id: kept.id, name, slug, position: g.position });
    else plan.create.push({ sourceGroupId: g.id, name, slug, position: g.position });
  }

  const sourceOf = new Map(copy.groups.map((g) => [g.id, g.sourceGroupId]));
  const stopped = new Set(copy.groups.filter((g) => g.stopped).map((g) => g.id));
  const deleted = new Set(plan.delete);
  const inCopy = new Map(copy.members.map((m) => [m.enrollmentId, m.groupId]));
  const inSet = new Set<string>();
  for (const m of set.members) {
    inSet.add(m.enrollmentId);
    const current = inCopy.get(m.enrollmentId);
    if (current !== undefined && !deleted.has(current) && sourceOf.get(current) === m.groupId) continue;
    // Held: out of a stopped group, or into one.
    if ((current !== undefined && stopped.has(current)) || bySource.get(m.groupId)?.stopped) continue;
    plan.place.push({ enrollmentId: m.enrollmentId, sourceGroupId: m.groupId, from: current === undefined || deleted.has(current) ? null : current });
  }
  for (const m of copy.members) {
    if (!inSet.has(m.enrollmentId) && !deleted.has(m.groupId) && !stopped.has(m.groupId)) plan.unplace.push(m.enrollmentId);
  }
  return plan;
}

/**
 * A step's consequence on GitHub (ADR-070 §6): roster line `enrollmentId`
 * losing the repository of copy group `groupId`, or joining it.
 */
export interface PlanConsequence {
  groupId: string;
  enrollmentId: string;
  kind: "lose" | "join";
}

/** A plan's moves that wait for the `group.sync` job, as {@link splitPlan} sets them apart. */
export type DeferredSteps = Pick<GroupSyncPlan, "place" | "unplace">;

/**
 * `plan` split between what the set's own transaction applies and what
 * waits for GitHub (ADR-070 §4, M3-15b-2):
 *   - `now` — every operation that touches no copy group with a repository
 *     (`slugFixed`): the deletions, renames, positions and creations, the
 *     moves between groups without one, and the departure of a student of
 *     `exempt` (a staff seat, whose accounts were revoked when it became
 *     one);
 *   - `later` — the moves out of a group with a repository or into one,
 *     for the job: a departure waits for GitHub's revocation, an arrival is
 *     written then invited;
 *   - `consequences` — what `later` does on GitHub, one per student and
 *     group: `lose` out of a group with a repository, `join` into one
 *     (product owner, 2026-10-05: even when GitHub will have nothing to do);
 *   - `repoGroupsDeleted` — the groups with a repository the plan would
 *     delete: never done, the set's write is refused (`409 has_repo`).
 */
export function splitPlan(
  copy: CopyState,
  plan: GroupSyncPlan,
  exempt: ReadonlySet<string> = new Set(),
): { now: GroupSyncPlan; later: DeferredSteps; consequences: PlanConsequence[]; repoGroupsDeleted: string[] } {
  const fixed = new Set(copy.groups.filter((g) => g.slugFixed).map((g) => g.id));
  const bySource = new Map(copy.groups.flatMap((g) => (g.sourceGroupId === null ? [] : [[g.sourceGroupId, g.id] as const])));
  const groupOf = new Map(copy.members.map((m) => [m.enrollmentId, m.groupId]));
  const now: GroupSyncPlan = { ...plan, place: [], unplace: [] };
  const later: DeferredSteps = { place: [], unplace: [] };
  const consequences: PlanConsequence[] = [];
  for (const p of plan.place) {
    const to = bySource.get(p.sourceGroupId);
    const losing = p.from !== null && fixed.has(p.from);
    const joining = to !== undefined && fixed.has(to);
    if (!losing && !joining) {
      now.place.push(p);
      continue;
    }
    later.place.push(p);
    if (losing) consequences.push({ groupId: p.from!, enrollmentId: p.enrollmentId, kind: "lose" });
    if (joining) consequences.push({ groupId: to, enrollmentId: p.enrollmentId, kind: "join" });
  }
  for (const e of plan.unplace) {
    const from = groupOf.get(e)!;
    if (exempt.has(e) || !fixed.has(from)) {
      now.unplace.push(e);
      continue;
    }
    later.unplace.push(e);
    consequences.push({ groupId: from, enrollmentId: e, kind: "lose" });
  }
  return { now, later, consequences, repoGroupsDeleted: plan.delete.filter((id) => fixed.has(id)) };
}

/** The key that identifies a consequence across two plans, and in a digest. */
export const consequenceKey = (c: PlanConsequence): string => `${c.groupId}:${c.enrollmentId}:${c.kind}`;

/**
 * The consequences of `after` that `before` did not have: what a write adds
 * (ADR-070 §6). A move already waiting for GitHub before the write is not
 * the write's to confirm again.
 */
export function consequenceDelta<T extends PlanConsequence>(before: readonly PlanConsequence[], after: readonly T[]): T[] {
  const known = new Set(before.map(consequenceKey));
  return after.filter((c) => !known.has(consequenceKey(c)));
}

/** True when `plan` changes nothing. */
export function isEmptyPlan(plan: GroupSyncPlan): boolean {
  return Object.values(plan).every((ops: unknown[]) => ops.length === 0);
}

// ---------------------------------------------------------------- names

/** The first of `nth(1)`, `nth(2)`… not in `taken`. */
function firstFree(taken: ReadonlySet<string>, nth: (k: number) => string): string {
  for (let k = 1; ; k++) if (!taken.has(nth(k))) return nth(k);
}

/** `base`, else `base 2`, `base 3`… — the first not in `taken`. */
export const freeName = (base: string, taken: ReadonlySet<string>): string => firstFree(taken, (k) => (k === 1 ? base : `${base} ${k}`));

/** `base`, else `base-2`, `base-3`… — the first not in `taken`. */
export const freeSlug = (base: string, taken: ReadonlySet<string>): string => firstFree(taken, (k) => (k === 1 ? base : `${base}-${k}`));

/** The languages a default name is written in: the creator's (ADR-070 §1, §2). */
export type NameLocale = "en" | "fr";

/** "Group k" (fr "Groupe k") with the first k whose name is not `taken` (ADR-070 §1). */
export function defaultGroupName(taken: ReadonlySet<string>, locale: NameLocale): string {
  const word = locale === "fr" ? "Groupe" : "Group";
  return firstFree(taken, (k) => `${word} ${k}`);
}

/**
 * A new set's name (ADR-070 §2): "Groups of 2026-10-04 14:30" (fr "Groupes
 * du 04.10.2026 14:30"), the instant on the school's wall clock.
 */
export function defaultSetName(at: Date, locale: NameLocale, timeZone: string = SCHOOL_TIME_ZONE): string {
  const local = new Date(at.getTime() + zoneOffset(at, timeZone));
  const two = (n: number) => String(n).padStart(2, "0");
  const [y, m, d] = [local.getUTCFullYear(), two(local.getUTCMonth() + 1), two(local.getUTCDate())];
  const time = `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`;
  return locale === "fr" ? `Groupes du ${d}.${m}.${y} ${time}` : `Groups of ${y}-${m}-${d} ${time}`;
}

/** A copy's name for a duplicated set (fr "(copie)"), as a duplicated question's (`pool/questionWrite.ts`). */
export function duplicateSetName(name: string, locale: NameLocale): string {
  return `${name} (${locale === "fr" ? "copie" : "copy"})`;
}
