import type { ProjectCommit } from "@quiz/contracts";

/**
 * One row of the commit graph (ADR-119 §8), as `git log --graph` lays it
 * out: the commit sits in lane `col`; `through` are the lanes that pass
 * by it untouched, `incoming` those that end on it from above (its
 * children: several when branches converge on it), `outgoing` the lanes
 * its parents continue in below (several for a merge).
 */
export interface GraphRow {
  commit: ProjectCommit;
  col: number;
  through: number[];
  incoming: number[];
  outgoing: number[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** The most lanes any row uses. */
  lanes: number;
}

const time = (c: ProjectCommit) => (c.authoredAt === null ? 0 : Date.parse(c.authoredAt));

/**
 * The commits children first (a parent never above a child), newer first
 * among those ready — the order `git log --topo-order --date-order` draws.
 */
export function topoOrder(commits: readonly ProjectCommit[]): ProjectCommit[] {
  const known = new Set(commits.map((c) => c.sha));
  const children = new Map<string, number>();
  for (const c of commits) for (const p of c.parents) if (known.has(p)) children.set(p, (children.get(p) ?? 0) + 1);
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const ready = commits.filter((c) => !children.has(c.sha));
  const order: ProjectCommit[] = [];
  while (ready.length > 0) {
    // The newest ready commit; the listing's order breaks a tie.
    let best = 0;
    for (let i = 1; i < ready.length; i++) if (time(ready[i]!) > time(ready[best]!)) best = i;
    const [next] = ready.splice(best, 1);
    order.push(next!);
    for (const p of next!.parents) {
      if (!known.has(p)) continue;
      const left = children.get(p)! - 1;
      children.set(p, left);
      if (left === 0) ready.push(bySha.get(p)!);
    }
  }
  return order;
}

/**
 * The lanes of each row. A lane holds the sha it waits for; a commit takes
 * the lane that waits for it (the leftmost free one for a branch head),
 * frees every other lane waiting for it (a convergence), hands its lane to
 * its first parent and opens one for each other parent (a merge) unless a
 * lane already waits for it. A parent outside the listing (a cut history)
 * ends its line.
 */
export function graphLayout(commits: readonly ProjectCommit[]): GraphLayout {
  const known = new Set(commits.map((c) => c.sha));
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 0;
  const free = (skip: number) => {
    const i = lanes.findIndex((sha, k) => sha === null && k !== skip);
    return i < 0 ? lanes.length : i;
  };
  for (const commit of topoOrder(commits)) {
    const before = [...lanes];
    let col = lanes.indexOf(commit.sha);
    if (col < 0) col = free(-1);
    const incoming = before.flatMap((sha, i) => (sha === commit.sha ? [i] : []));
    const through = before.flatMap((sha, i) => (sha !== null && sha !== commit.sha ? [i] : []));
    for (const i of incoming) lanes[i] = null;
    const parents = commit.parents.filter((p) => known.has(p));
    const outgoing: number[] = [];
    parents.forEach((p, n) => {
      const waiting = n === 0 ? -1 : lanes.indexOf(p);
      const lane = n === 0 ? col : waiting >= 0 ? waiting : free(col);
      lanes[lane] = p;
      outgoing.push(lane);
    });
    if (parents.length === 0) lanes[col] = null;
    while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop();
    width = Math.max(width, col + 1, before.length, lanes.length);
    rows.push({ commit, col, through, incoming, outgoing });
  }
  return { rows, lanes: width };
}
