import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { UsersRound } from "lucide-react";

import type { ProjectDetail, ProjectPatch, ProjectSummary } from "@quiz/contracts";

import { refusedWith } from "../api";
import { useClassroomGroupSets } from "../group/api";
import { GroupSetPicker, setLabel } from "../group/GroupSetPicker";
import { AppLink } from "../group/parts";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { classroomGroupSetsKey } from "../queryKeys";
import type { Navigate } from "../router";
import { Card, SectionHeading } from "../ui";
import { refusalMessage } from "./projectPage";

/** The DOM id of the draft's picker: where "Choose a group set first" sends the focus. */
export const GROUP_SET_FIELD = "project-group-set";

/**
 * The group set a group project follows (ADR-070 §4, §7; M3-16a): a
 * draft chooses it here (`PATCH groupSetId`), so a draft made without one,
 * or whose set was deleted, can be fixed; once published it is said, with
 * a link to the set's page that comes back here (`?from=project:<id>`),
 * and whether its groups still follow the set or stopped at the deadline.
 * The drift of a stopped copy and *Resync* are M3-16b's.
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
  const toast = useToast();
  const sets = useClassroomGroupSets(project.classroomId);
  const set = sets.data?.find((s) => s.id === project.groupSetId);
  const use = set?.usedBy.find((u) => u.id === project.id);
  const editable = project.editable.includes("groupSetId") && project.archivedAt === null;
  const refused =
    patch.variables?.groupSetId !== undefined && refusedWith(patch.error, "unknown_group_set")
      ? t("project.refusal.unknownGroupSet")
      : undefined;

  return (
    <section aria-labelledby="project-group-set-heading" className="space-y-3">
      <SectionHeading icon={UsersRound} title={<span id="project-group-set-heading">{t("project.groupSet")}</span>} />
      <Card className="space-y-3 px-4 py-4">
        {editable ? (
          <>
            <p className="text-[13px] text-fg-muted">{t("project.groupSet.desc")}</p>
            <GroupSetPicker
              id={GROUP_SET_FIELD}
              classroomId={project.classroomId}
              value={project.groupSetId}
              disabled={patch.isPending}
              onChange={(groupSetId) =>
                patch.mutate(
                  { groupSetId },
                  {
                    onError: (error) => {
                      // A set deleted meanwhile is said under the field; the list is read again.
                      if (refusedWith(error, "unknown_group_set")) {
                        void qc.invalidateQueries({ queryKey: classroomGroupSetsKey(project.classroomId) });
                      } else toast(refusalMessage(error, t), "error");
                    },
                  },
                )
              }
              message={refused}
            />
          </>
        ) : null}
        {set ? (
          <div className="text-sm">
            <AppLink
              route={{ view: "groupSet", classroomId: project.classroomId, id: set.id, from: `project:${project.id}` }}
              navigate={navigate}
              className="font-medium text-fg underline decoration-line-strong"
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
      </Card>
    </section>
  );
}
