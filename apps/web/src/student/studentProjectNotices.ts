/*
 * The student's project notices (F-PROJ-21, N-SEC-20; merge task M3-09c),
 * pure: what two consecutive reads of `StudentProject` — the ONE exit of a
 * project towards a student, already filtered — say happened to THEIR
 * repository in between. `StudentProjectPage.tsx` toasts them through
 * `useNoticeToasts`. The comparison reads nothing but the payload's fields,
 * so it can say nothing the page does not show: never a score before the
 * release, never a review dispatch, never a run after the deadline.
 *
 * Four kinds, each from its own difference:
 *   - `accepted`  their invitation went from pending to accepted: the
 *                 repository is theirs (F-PROJ-07);
 *   - `locked`    their repository went from open to locked: the deadline
 *                 was applied (F-PROJ-09);
 *   - `pushed`    the last commit changed, while the project is open;
 *   - `scored`    an indicative score appeared or changed, while the project
 *                 is open — the current score becoming the frozen one at the
 *                 deadline is the same score, not a capture.
 *
 * Once the deadline is applied or passed (the server's clock, `serverNow`),
 * the commit and the score the view stands on are the SELECTED run's, not a
 * push nor a run (F-PROJ-15): `pushed` and `scored` are not compared then.
 * The release reaches the student through the bell (`project_grade_final`,
 * F-NOTIF-13), which already toasts: no notice here.
 */
import type { StudentProject } from "@quiz/contracts";

import type { Dict, TFunction } from "../i18n";
import { pushed, type Notice } from "../notifications/notices";
import type { ToastTone } from "../notify";

export type StudentProjectNoticeKind = "accepted" | "locked" | "pushed" | "scored";

/** The notices of the read `next` after the read `prev`, in the order they are said; none when nothing moved. */
export function studentProjectNotices(prev: StudentProject, next: StudentProject): StudentProjectNoticeKind[] {
  const was = prev.repo;
  const repo = next.repo;
  // A repository not yet theirs, or one GitHub lost, has nothing to notice;
  // one appearing is their own Accept (or the bell's `project_repo_invited`).
  if (was === null || was.deleted || repo === null || repo.deleted) return [];
  const out: StudentProjectNoticeKind[] = [];
  if (was.invitation === "pending" && repo.invitation === "accepted") out.push("accepted");
  if (!was.locked && repo.locked) out.push("locked");
  const open = !repo.locked && Date.parse(next.deadlineAt) > Date.parse(next.serverNow);
  if (!open) return out;
  if (pushed(was.lastCommit, repo.lastCommit)) out.push("pushed");
  if (repo.score !== null && (was.score === null || was.score.points !== repo.score.points || was.score.max !== repo.score.max)) {
    out.push("scored");
  }
  return out;
}

const KEY: Record<StudentProjectNoticeKind, { key: keyof Dict; tone: ToastTone }> = {
  accepted: { key: "sproj.notice.accepted", tone: "success" },
  // The amber of a fact that refuses the next push: nothing went wrong.
  locked: { key: "sproj.notice.locked", tone: "warning" },
  pushed: { key: "sproj.notice.pushed", tone: "success" },
  scored: { key: "sproj.notice.scored", tone: "success" },
};

/** A notice worded for the toast, keyed by kind so a later one of the same kind replaces it. */
export function studentProjectNoticeToast(kind: StudentProjectNoticeKind, t: TFunction): Notice {
  return { key: `sproj-notice:${kind}`, message: t(KEY[kind].key), tone: KEY[kind].tone };
}
