import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { GitCompareArrows, RefreshCw, UsersRound } from "lucide-react";
import { useState } from "react";

import { ProjectGroupResync, type GroupConsequences, type ProjectDetail, type ProjectPatch, type ProjectSummary } from "@quiz/contracts";

import { api, refusedWith } from "../api";
import { AppLink } from "../AppLink";
import { useClassroomGroupSets } from "../group/api";
import { ConsequencesDialog } from "../group/ConsequencesDialog";
import { GroupSetPicker, setLabel } from "../group/GroupSetPicker";
import { needsConfirmation } from "../group/groupRules";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { classroomGroupSetsKey, projectKey } from "../queryKeys";
import type { Navigate } from "../router";
import { Alert, Button, Card, SectionHeading } from "../ui";
import { FIELD_ID } from "./newProject";
import { groupSetPageOf, offersResync, refusalMessage } from "./projectPage";

/**
 * The group set a group project follows (ADR-070 §4, §7; M3-16a): a
 * draft chooses it here (`PATCH groupSetId`), so a draft made without one,
 * or whose set was deleted, can be fixed; once published it is said, with
 * a link to the set's page that comes back here (`?fromProject=<id>`),
 * and whether its groups still follow the set or stopped at the deadline.
 *
 * The drift of a stopped copy (M3-16b, ADR-070 §4): an alert saying the
 * set changed since, with *Resync with the set* as a SECONDARY button —
 * never the page's primary, which stays the server's —, hidden once the
 * project is released or archived (the resync would be refused). Resync
 * asks the server first: `204` is nothing to resync, `409
 * needs_confirmation` opens the dialog naming the frozen repositories, the
 * arrivals without a repository and the rest, and Confirm sends the digest
 * back (a stale one names them again). A confirmed resync not applied yet
 * (`groupSyncPending`) is said under the set.
 */
export function ProjectGroupSet({
  project,
  patch,
  navigate,
}: {
  project: ProjectDetail;
  patch: UseMutationResult<ProjectSummary, Error, ProjectPatch>;
  navigate: Navigate;
}) {
  const t = useT();
  const qc = useQueryClient();
  const sets = useClassroomGroupSets(project.classroomId);
  const set = sets.data?.find((s) => s.id === project.groupSetId);
  const use = set?.usedBy.find((u) => u.id === project.id);
  const editable = project.editable.includes("groupSetId") && project.archivedAt === null;
  // A refused choice is said under the picker, in the page's words for it.
  const refused = patch.variables?.groupSetId !== undefined && patch.isError ? refusalMessage(patch.error, t) : undefined;
  const setPage = groupSetPageOf(project);
  const resync = useResync(project);

  return (
    <section aria-labelledby="project-group-set-heading" className="space-y-3">
      <SectionHeading icon={UsersRound} title={<span id="project-group-set-heading">{t("project.groupSet")}</span>} />
      <Card className="space-y-3 px-4 py-4">
        {editable ? (
          <>
            <p className="text-[13px] text-fg-muted">{t("project.groupSet.desc")}</p>
            <GroupSetPicker
              id={FIELD_ID.groupSet}
              classroomId={project.classroomId}
              value={project.groupSetId}
              disabled={patch.isPending}
              onChange={(groupSetId) =>
                patch.mutate(
                  { groupSetId },
                  {
                    onError: (error) => {
                      // A set deleted meanwhile: the list is read again.
                      if (refusedWith(error, "unknown_group_set")) {
                        void qc.invalidateQueries({ queryKey: classroomGroupSetsKey(project.classroomId) });
                      }
                    },
                  },
                )
              }
              message={refused}
            />
          </>
        ) : null}
        {set && setPage ? (
          <div className="text-sm">
            <AppLink
              route={setPage}
              navigate={navigate}
              className="font-medium text-fg underline decoration-line-strong underline-offset-2"
            >
              {editable ? t("project.groupSet.open") : setLabel(set, t)}
            </AppLink>
            {/* A draft's copy follows by construction; a published one says whether it still does. */}
            {project.state === "draft" ? null : (
              <p className="mt-0.5 text-[13px] text-fg-muted">
                {t(use?.follows === false ? "project.groupSet.stopped" : "project.groupSet.follows")}
              </p>
            )}
          </div>
        ) : editable ? null : (
          <p className="text-sm text-fg-muted">{t("project.groupSet.none")}</p>
        )}
        {project.groupSyncPending ? (
          <p className="text-[13px] text-fg-muted" role="status">
            {t("project.resync.pending")}
          </p>
        ) : null}
      </Card>
      {offersResync(project) ? (
        <Alert
          tone="warning"
          icon={GitCompareArrows}
          title={t("project.drift.title")}
          action={
            <Button variant="secondary" size="sm" loading={resync.asking} onClick={resync.ask}>
              <RefreshCw /> {t("project.resync")}
            </Button>
          }
        >
          <p>{t("project.drift.body")}</p>
        </Alert>
      ) : null}
      {resync.asked ? (
        <ConsequencesDialog
          kind="resync"
          consequences={resync.asked.consequences}
          changedSince={resync.asked.changedSince}
          confirming={resync.confirming}
          onConfirm={resync.confirm}
          onCancel={resync.cancel}
        />
      ) : null}
    </section>
  );
}

/**
 * `POST /projects/:id/groups/resync` (ADR-070 §4, §6): asked without a
 * digest, then confirmed with the one the server named. A 204 refetches
 * the page; any other refusal is said in its words (`released`,
 * `project_archived`, `classroom_archived`, `no_group_set`).
 */
function useResync(project: ProjectDetail) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [asked, setAsked] = useState<(GroupConsequences & { changedSince: boolean }) | null>(null);
  const send = useMutation({
    mutationFn: (confirm: string | undefined) =>
      api<void>(`/app/api/projects/${project.id}/groups/resync`, {
        method: "POST",
        body: JSON.stringify(ProjectGroupResync.parse(confirm === undefined ? {} : { confirm })),
      }),
    onSuccess: async (_, confirm) => {
      setAsked(null);
      await qc.invalidateQueries({ queryKey: projectKey(project.id) });
      toast(t(confirm === undefined ? "project.resync.nothing" : "project.resync.done"), "success");
    },
    onError: (error, confirm) => {
      const consequences = needsConfirmation(error);
      if (consequences) {
        setAsked({ ...consequences, changedSince: confirm !== undefined });
        return;
      }
      setAsked(null);
      toast(refusalMessage(error, t), "error");
      void qc.invalidateQueries({ queryKey: projectKey(project.id) });
    },
  });
  return {
    asked,
    asking: send.isPending && send.variables === undefined,
    confirming: send.isPending && send.variables !== undefined,
    ask: () => send.mutate(undefined),
    confirm: () => asked && send.mutate(asked.digest),
    cancel: () => setAsked(null),
  };
}
