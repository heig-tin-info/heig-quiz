import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  ProjectDetail,
  ProjectInvitationResent,
  ProjectRepoDeadline,
  ProjectRepoDeadlineState,
  ProjectRepoProtection,
  ProjectRepoScores,
  ProjectRepoView,
  ScoreOverride,
} from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { projectKey, projectRunsKey } from "../queryKeys";
import { deadlineRefusal, refusalMessage, type RepoEntry } from "./projectPage";

/**
 * The writes of a repository's page (ADR-137): its own deadline, its lock,
 * the teacher's score (`onScored` once written: the dialog closes), the
 * resend of its invitation and the re-enable of its protected files. Each
 * answer is laid over its row of the project's page, which is then read
 * again. A row with no repository has none to write: its routes are never
 * called.
 */
export function useRepoWrites(projectId: string, entry: RepoEntry, onScored: () => void) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const repoId = entry.repo?.id ?? "";
  const settle = (patch: (repo: ProjectRepoView) => ProjectRepoView) => {
    qc.setQueryData<ProjectDetail>(projectKey(projectId), (p) =>
      p ? { ...p, rows: p.rows.map((r) => (r.repo?.id === repoId ? { ...r, repo: patch(r.repo) } : r)) } : p,
    );
    void qc.invalidateQueries({ queryKey: projectKey(projectId) });
  };
  const failed = (error: unknown) => toast(refusalMessage(error, t), "error");
  const base = `/app/api/projects/${projectId}/repos/${repoId}`;
  const deadline = useMutation({
    mutationFn: (body: ProjectRepoDeadline) =>
      api<ProjectRepoDeadlineState>(`${base}/deadline`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (state) => {
      settle((r) => ({ ...r, ...state }));
      toast(t("project.repo.deadlineSaved"), "success");
    },
    onError: (error) => {
      // A past date, or the repositories open (ADR-145 §8), is said under the field, not toasted.
      if (deadlineRefusal(error, t) === undefined) failed(error);
    },
  });
  const lock = useMutation({
    mutationFn: (on: boolean) => api<ProjectRepoDeadlineState>(`${base}/${on ? "lock" : "unlock"}`, { method: "POST" }),
    onSuccess: (state, on) => {
      settle((r) => ({ ...r, ...state }));
      toast(t(on ? "project.repo.locked" : "project.repo.unlocked"), "success");
    },
    onError: failed,
  });
  const score = useMutation({
    mutationFn: (body: ScoreOverride) => api<ProjectRepoScores>(`${base}/score`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: ({ scores, released, changedAfterRelease }, body) => {
      settle((r) => ({ ...r, scores, released, flags: { ...r.flags, changedAfterRelease } }));
      toast(t(body.points === null ? "project.teacherScore.cleared" : "project.teacherScore.saved"), "success");
      onScored();
    },
    // The refusal is worded under the form (`FormError`), not toasted.
  });
  const resend = useMutation({
    mutationFn: () => api<ProjectInvitationResent>(`${base}/invite`, { method: "POST" }),
    onSuccess: ({ invitationStatus }) => {
      // A group's row is not written by a resend: the page's re-read says it.
      settle((r) => (entry.kind === "group" ? r : { ...r, invitationStatus }));
      toast(t(invitationStatus === "accepted" ? "project.invitation.alreadyAccepted" : "project.invitation.resent"), "success");
    },
    onError: failed,
  });
  const reenable = useMutation({
    mutationFn: () => api<ProjectRepoProtection>(`${base}/protection`, { method: "POST" }),
    onSuccess: () => {
      settle((r) => ({ ...r, flags: { ...r.flags, protectionSuspended: false } }));
      // The runs flagged meanwhile keep their mark: the history is read again with the page.
      void qc.invalidateQueries({ queryKey: projectRunsKey(projectId, repoId) });
      toast(t("project.protection.reenabled"), "success");
    },
    onError: failed,
  });
  return { deadline, lock, score, resend, reenable };
}

export type RepoWrites = ReturnType<typeof useRepoWrites>;
