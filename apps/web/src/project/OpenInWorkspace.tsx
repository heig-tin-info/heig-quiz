import { Laptop, Loader2 } from "lucide-react";

import { workspaceDistributionPath, workspaceReviewPath, type ProjectDetail, type ProjectRepoView } from "@quiz/contracts";
import { distributionReviewRefusal, staffReviewRefusal, type StaffReviewRefusalCode } from "@quiz/domain";

import { useClassroom } from "../course/parts";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { usePortalLaunch } from "../portalLaunch";
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
 * derivation of it. The row carries no deletion time, only
 * `flags.deleted`, and the rule asks only whether one is set: a deleted row
 * stands for it with the epoch. The flag is also raised when GitHub just
 * reported the repository missing, so it hides the action more often than
 * the server refuses it, never less.
 */
function reviewFacts(repo: ProjectRepoView) {
  return {
    provisionStatus: repo.provisionStatus,
    fullName: repo.fullName,
    deletedAt: repo.flags.deleted ? new Date(0) : null,
    githubRepoId: repo.githubRepoId,
    deadlineAppliedAt: repo.deadlineAppliedAt,
  };
}

/**
 * The staff's review action of each repository of the page (ADR-129 §11,
 * F-PROJ-27), or null when the platform offers none: no portal (the
 * workspace read's 404), or the project's quota holder holds no enabled
 * workspace grant (`ProjectWorkspace.review`). Reads the page's workspace
 * and classroom, already in the cache. The project's payload does not carry
 * its classroom's archive: while that read loads or fails, the classroom
 * counts as not archived, and the route refuses anyway (`review_archived`).
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
        holderGranted: true,
        classroomArchived,
        projectArchived: project.archivedAt !== null,
        repo: reviewFacts(repo),
        workMode: ws.mode,
      }),
    );
}

/** The launch (ADR-129 §5): a refusal is worded by its code, anything else is the page's toast. */
function useReviewLaunch(projectId: string, repoId: string) {
  const t = useT();
  const toast = useToast();
  return usePortalLaunch(workspaceReviewPath(projectId, repoId), (error) => toast(refusalMessage(error, t), "error"));
}

/**
 * The row's control: an icon, the action's name in its tooltip; held with
 * the reason in its tooltip while the exam may run. Clicking it never also
 * opens the row's page.
 */
export function OpenInWorkspaceIcon({ projectId, repo, action }: { projectId: string; repo: ProjectRepoView; action: ReviewAction }) {
  const t = useT();
  const { busy, launch } = useReviewLaunch(projectId, repo.id);
  if (action === "absent") return null;
  return (
    <IconButton
      label={t("project.repo.openInWorkspace")}
      disabledReason={action === "examOpen" ? t("project.repo.openInWorkspace.examOpen") : null}
      aria-busy={busy}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        launch();
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Laptop />}
    </IconButton>
  );
}

/**
 * An owner's *Open in workspace* on the distribution repository (ADR-147
 * §9): what the students receive, read-only, in the project's image, in
 * any state of the project, a draft and a scheduled one included. Absent
 * unless the workspace read says the caller may (`distributionReview`: an
 * owner, the quota holder granted) and THE rule of `@quiz/domain`
 * (`distributionReviewRefusal`) lets the page's facts through: a built
 * distribution, nothing archived. An icon beside the link, never the page's
 * primary action.
 */
export function OpenDistributionIcon({ project }: { project: ProjectDetail }) {
  const t = useT();
  const toast = useToast();
  const workspace = useWorkspace(project.id);
  const classroom = useClassroom(project.classroomId, { retry: false });
  const { busy, launch } = usePortalLaunch(workspaceDistributionPath(project.id), (error) => toast(refusalMessage(error, t), "error"));
  if (!workspace.data?.distributionReview) return null;
  const refusal = distributionReviewRefusal({
    holderGranted: true,
    classroomArchived: (classroom.data?.archivedAt ?? null) !== null,
    projectArchived: project.archivedAt !== null,
    distributionBuilt: project.distribution !== null,
  });
  if (refusal !== null) return null;
  return (
    <IconButton label={t("project.distribution.openInWorkspace")} aria-busy={busy} disabled={busy} onClick={launch}>
      {busy ? <Loader2 className="animate-spin" /> : <Laptop />}
    </IconButton>
  );
}

/**
 * The repository page's control (ADR-137): a secondary button of its
 * header, the one fact the teacher needs before clicking in its tooltip —
 * or, held while the exam may run, the reason.
 */
export function OpenInWorkspaceButton({ projectId, repo, action }: { projectId: string; repo: ProjectRepoView; action: ReviewAction }) {
  const t = useT();
  const { busy, launch } = useReviewLaunch(projectId, repo.id);
  if (action === "absent") return null;
  const button = (
    <HeldButton
      variant="secondary"
      loading={busy}
      onClick={launch}
      disabledReason={action === "examOpen" ? t("project.repo.openInWorkspace.examOpen") : null}
    >
      {busy ? null : <Laptop />} {t("project.repo.openInWorkspace")}
    </HeldButton>
  );
  return action === "examOpen" ? button : <Tip label={t("project.repo.openInWorkspace.desc")}>{button}</Tip>;
}
