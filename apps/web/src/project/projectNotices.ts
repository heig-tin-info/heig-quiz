/*
 * The staff's project page notices (F-PROJ-21, merge task M3-09c), pure:
 * what two consecutive reads of `ProjectDetail` say happened in between,
 * counted per kind — never one notice per repository. `ProjectPage.tsx`
 * toasts them through `useNoticeToasts`.
 *
 * Four kinds, each from its own difference:
 *   - `accepted`     a repository the previous read did not have: a student
 *                    (or a group) accepted the project (F-PROJ-05);
 *   - `pushed`       a repository whose last student commit changed;
 *   - `scored`       a repository whose current score comes from another
 *                    run: a score was captured (F-PROJ-10); the frozen and
 *                    review slots filling at the freeze are not a capture;
 *   - `reviewAsked`  a repository whose final review was asked since
 *                    (`review.askedAt`, F-PROJ-11).
 *
 * Not here, on purpose: the deadline applied and the release notify the
 * staff and the students through the bell (`project_deadline_applied`,
 * `project_grade_final`, F-NOTIF-13), which already toasts; the protected
 * files restored have no datum on the page (the `protectionSuspended` flag
 * and the bell cover the cap); a sync shows its own last-sync line (M3-07).
 */
import type { ProjectDetail, ProjectRepoView } from "@quiz/contracts";

import type { Dict, TFunction } from "../i18n";
import type { Notice } from "../notifications/notices";

export type ProjectNoticeKind = "accepted" | "pushed" | "scored" | "reviewAsked";

export interface ProjectNotice {
  kind: ProjectNoticeKind;
  count: number;
}

/** The order the notices are said in: what the staff act on first. */
const KINDS: readonly ProjectNoticeKind[] = ["accepted", "pushed", "scored", "reviewAsked"];

const reposOf = (p: ProjectDetail): Map<string, ProjectRepoView> =>
  new Map(p.rows.flatMap(({ repo }) => (repo ? [[repo.id, repo] as const] : [])));

const pushed = (was: ProjectRepoView, now: ProjectRepoView): boolean =>
  now.lastCommit !== null && now.lastCommit.sha !== was.lastCommit?.sha;

const scored = (was: ProjectRepoView, now: ProjectRepoView): boolean =>
  now.scores.current !== null && now.scores.current.runId !== was.scores.current?.runId;

const reviewAsked = (was: ProjectRepoView, now: ProjectRepoView): boolean =>
  now.review.askedAt !== null && now.review.askedAt !== was.review.askedAt;

/** The notices of the read `next` after the read `prev`: one per kind with its count, none when nothing moved. */
export function projectNotices(prev: ProjectDetail, next: ProjectDetail): ProjectNotice[] {
  const before = reposOf(prev);
  const counts: Record<ProjectNoticeKind, number> = { accepted: 0, pushed: 0, scored: 0, reviewAsked: 0 };
  for (const repo of reposOf(next).values()) {
    const was = before.get(repo.id);
    if (was === undefined) {
      // A repository just made carries the distribution's commits, not a push.
      counts.accepted += 1;
      continue;
    }
    if (pushed(was, repo)) counts.pushed += 1;
    if (scored(was, repo)) counts.scored += 1;
    if (reviewAsked(was, repo)) counts.reviewAsked += 1;
  }
  return KINDS.filter((kind) => counts[kind] > 0).map((kind) => ({ kind, count: counts[kind] }));
}

const KEY: Record<ProjectNoticeKind, { one: keyof Dict; other: keyof Dict }> = {
  accepted: { one: "project.notice.accepted.one", other: "project.notice.accepted" },
  pushed: { one: "project.notice.pushed.one", other: "project.notice.pushed" },
  scored: { one: "project.notice.scored.one", other: "project.notice.scored" },
  reviewAsked: { one: "project.notice.reviewAsked.one", other: "project.notice.reviewAsked" },
};

/** A notice worded for the toast: its count in the reader's language, keyed by kind so a later one of the same kind replaces it. */
export function projectNoticeToast({ kind, count }: ProjectNotice, t: TFunction): Notice {
  return { key: `project-notice:${kind}`, message: t(count === 1 ? KEY[kind].one : KEY[kind].other, { n: count }) };
}
