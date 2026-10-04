import type { QueryClient } from "@tanstack/react-query";

import type { HintEvent } from "@quiz/contracts";

/**
 * What a refresh hint (ADR-005) invalidates: the roots of the query keys of
 * `queryKeys.ts` each hint family can have made stale. Invalidation still
 * matches by prefix, so a root reaches every key under it.
 *
 * Generous by design — a root too many costs one refetch of an active query,
 * a root too few is a stale screen. `mutation` is the server's catch-all
 * (`app.ts`: any write under a pool, a course, a classroom, or on the
 * actor's own account) and names no family, so it refreshes everything, as
 * does a kind this table does not know: a server newer than the SPA must not
 * leave a screen stale.
 */
type HintKind = HintEvent["kinds"][number];

const EVALUATION_ROOTS = [
  "evaluations",
  // The Activities section (#190) lists every evaluation across classrooms.
  "activities",
  "evaluation",
  "dashboard",
  "attempt-inspect",
  "attempt",
  "grading",
  "results",
  "student",
  "poll",
  "classroom",
  // Templates are evaluations filed under their course (ADR-031).
  "course",
] as const;

export const HINT_ROOTS: Record<HintKind, readonly string[] | "all"> = {
  // A seat added or removed on a course's staff changes what that teacher
  // reaches: every open evaluation, grading or results screen of it too.
  courses: [...EVALUATION_ROOTS, "courses", "pools", "pool", "admin-teachers"],
  // An archived classroom takes its evaluations out of the Activities. The
  // GitHub setup return (M2-02) raises it too: the organizations the connect
  // sheet offers, and the classroom's link (under `classroom`).
  classrooms: ["courses", "course", "classroom", "student", "activities", "github"],
  // A roster line added or removed is a student of every group set (ADR-070 §2).
  roster: ["courses", "course", "classroom", "evaluations", "evaluation", "dashboard", "student", "group-sets"],
  pool: [
    "pools",
    "pool",
    "pool-members",
    "pool-candidates",
    "question",
    "poll-questions",
    "poll-pool-questions",
    "evaluation",
    "course",
    // A newly published version is a regrade target (`gradingItemVersionsKey`).
    "grading",
  ],
  evaluations: EVALUATION_ROOTS,
  grading: EVALUATION_ROOTS,
  results: EVALUATION_ROOTS,
  admin: ["admin-teachers", "me"],
  notifications: ["notifications", "notification-settings"],
  // The journal's copy was synchronised, or a page became visible (M4-02).
  journal: ["journal"],
  // A project's repository changed (M3-04): a classroom's projects
  // (`classroomProjectsKey`) and the project page with its runs and
  // checkpoints (`projectKey`, M3-12). A project archived, or naming another
  // set, changes the sets' "used by" (`groupSetsKey`, M3-16a).
  projects: ["classroom", "project", "group-sets"],
  // A classroom's group sets changed (ADR-070, M3-15a): the Groups tab and
  // every set's page (`groupSetsKey`, M3-16a). A copy that changed is
  // hinted `projects` besides.
  groups: ["group-sets"],
  mutation: "all",
};

/** The roots to invalidate for these kinds, or `"all"`. */
export function hintRoots(kinds: readonly string[]): ReadonlySet<string> | "all" {
  if (kinds.length === 0) return "all";
  const roots = new Set<string>();
  for (const kind of kinds) {
    const entry = Object.hasOwn(HINT_ROOTS, kind) ? HINT_ROOTS[kind as HintKind] : "all";
    if (entry === "all") return "all";
    for (const root of entry) roots.add(root);
  }
  return roots;
}

/** Invalidate what a hint of these kinds may have made stale. */
export function invalidateHint(qc: QueryClient, kinds: readonly string[]): Promise<void> {
  const roots = hintRoots(kinds);
  if (roots === "all") return qc.invalidateQueries();
  return qc.invalidateQueries({
    predicate: (query) => roots.has(String(query.queryKey[0])),
  });
}
