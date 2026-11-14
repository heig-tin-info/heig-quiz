import { useMutation } from "@tanstack/react-query";
import { Laptop, Loader2 } from "lucide-react";

import { workspaceReviewPath, type ProjectDetail, type ProjectRepoView, type WorkspaceReview } from "@quiz/contracts";
import { staffReviewRefusal, type StaffReviewRefusalCode } from "@quiz/domain";
import { IconButton as IconDisc } from "@quiz/ui";

import { api } from "../api";
import { useClassroom } from "../course/parts";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { HeldButton, IconButton, Tip } from "../ui";
import { refusalMessage } from "./projectPage";
import { useWorkspace } from "./ProjectWorkspace";

/**
 * What the staff's *Open in workspace* is on one repository (ADR-129 §11):
 * offered, held while the exam may still run (`review_exam_open`), or
 * absent for every other refusal of the rule.
 */
export type ReviewAction = "open" | "examOpen" | "absent";

/** Of a refusal of the rule, what the page draws: only the exam's is said on the control itself. */
const actionOf = (refusal: StaffReviewRefusalCode | null): ReviewAction =>
  refusal === null ? "open" : refusal === "review_exam_open" ? "examOpen" : "absent";

/**
 * The repository's facts as the staff's page holds them, for THE rule of
 * `@quiz/domain` (`staffReviewRefusal`, ADR-129 §5), never a second
 * derivation of it. Two facts are read under another name:
 *   - `deletedAt`: `flags.deleted` (gone from GitHub, stored or just seen);
 *   - `githubRepoId`: the page does not carry GitHub's id. A repository is
 *     `ok` only once Accept recorded it, in the same write (`accept.ts`), so
 *     a provisioned row holds one; a row that would not gets the route's
 *     `409 review_repo_unavailable`, worded like any refusal.
 */
function reviewFacts(repo: ProjectRepoView) {
  return {
    provisionStatus: repo.provisionStatus,
    fullName: repo.fullName,
    deletedAt: repo.flags.deleted ? "deleted" : null,
    githubRepoId: repo.provisionStatus === "ok" ? Number.MAX_SAFE_INTEGER : null,
    deadlineAppliedAt: repo.deadlineAppliedAt,
  };
}

/**
 * The staff's review action of each repository of the page (ADR-129 §11,
 * F-PROJ-27), or null when the platform offers none: no portal (the
 * workspace read's 404), or the project's quota holder holds no enabled
 * workspace grant (`ProjectWorkspace.review`). Reads the page's workspace
 * and classroom, already in the cache.
 */
export function useReviewAction(project: ProjectDetail): ((repo: ProjectRepoView) => ReviewAction) | null {
  const workspace = useWorkspace(project.id);
  const classroom = useClassroom(project.classroomId, { retry: false });
  const ws = workspace.data;
  if (!ws?.review) return null;
  const classroomArchived = (classroom.data?.archivedAt ?? null) !== null;
  return (repo) =>
    actionOf(
      staffReviewRefusal({
        holderGranted: ws.review,
        classroomArchived,
        projectArchived: project.archivedAt !== null,
        repo: reviewFacts(repo),
        workMode: ws.mode,
      }),
    );
}

/**
 * The launch (ADR-129 §5): a POST under the CSRF check, then the page goes
 * to the portal's address it answers, in the same tab, as the student's
 * *Open workspace* does. A refusal is worded by its code; anything else is
 * the page's toast. Still busy once answered: the page is leaving.
 */
function useReviewLaunch(projectId: string, repoId: string) {
  const t = useT();
  const toast = useToast();
  const launch = useMutation({
    mutationFn: () => api<WorkspaceReview>(workspaceReviewPath(projectId, repoId), { method: "POST" }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (error) => toast(refusalMessage(error, t), "error"),
  });
  const busy = launch.isPending || launch.isSuccess;
  return { busy, open: () => (busy ? undefined : launch.mutate()) };
}

/**
 * The row's control: an icon, the action's name in its tooltip; held with
 * the reason in its tooltip while the exam may run. Clicking it never also
 * opens the row's sheet.
 */
export function OpenInWorkspaceIcon({ projectId, repo, action }: { projectId: string; repo: ProjectRepoView; action: ReviewAction }) {
  const t = useT();
  const { busy, open } = useReviewLaunch(projectId, repo.id);
  if (action === "absent") return null;
  const label = t("project.repo.openInWorkspace");
  if (action === "examOpen") {
    // The wrapper takes the hover and the focus a disabled button cannot (`HeldButton`'s way).
    return (
      <Tip label={t("project.repo.openInWorkspace.examOpen")}>
        <span tabIndex={0} className="rounded-full" onClick={(e) => e.stopPropagation()}>
          <IconDisc label={label} size="md" disabled>
            <Laptop />
          </IconDisc>
        </span>
      </Tip>
    );
  }
  return (
    <IconButton
      label={label}
      aria-busy={busy}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Laptop />}
    </IconButton>
  );
}

/** The sheet's control: a secondary button and the one fact the teacher needs before clicking. */
export function OpenInWorkspaceButton({ projectId, repo, action }: { projectId: string; repo: ProjectRepoView; action: ReviewAction }) {
  const t = useT();
  const { busy, open } = useReviewLaunch(projectId, repo.id);
  if (action === "absent") return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <HeldButton
        variant="secondary"
        size="sm"
        loading={busy}
        onClick={open}
        disabledReason={action === "examOpen" ? t("project.repo.openInWorkspace.examOpen") : null}
      >
        {busy ? null : <Laptop />} {t("project.repo.openInWorkspace")}
      </HeldButton>
      <p className="text-[13px] text-fg-muted">{t("project.repo.openInWorkspace.desc")}</p>
    </div>
  );
}
