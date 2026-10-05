import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { UsersRound } from "lucide-react";

import type { ProjectDetail, ProjectPatch, ProjectSummary } from "@quiz/contracts";

import { refusedWith } from "../api";
import { AppLink } from "../AppLink";
import { useClassroomGroupSets } from "../group/api";
import { GroupSetPicker, setLabel } from "../group/GroupSetPicker";
import { useT } from "../i18n";
import { classroomGroupSetsKey } from "../queryKeys";
import type { Navigate } from "../router";
import { Card, SectionHeading } from "../ui";
import { FIELD_ID } from "./newProject";
import { groupSetPageOf, refusalMessage } from "./projectPage";

/**
 * The group set a group project follows (ADR-070 §4, §7; M3-16a): a
 * draft chooses it here (`PATCH groupSetId`), so a draft made without one,
 * or whose set was deleted, can be fixed; once published it is said, with
 * a link to the set's page that comes back here (`?fromProject=<id>`),
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
  const sets = useClassroomGroupSets(project.classroomId);
  const set = sets.data?.find((s) => s.id === project.groupSetId);
  const use = set?.usedBy.find((u) => u.id === project.id);
  const editable = project.editable.includes("groupSetId") && project.archivedAt === null;
  // A refused choice is said under the picker, in the page's words for it.
  const refused = patch.variables?.groupSetId !== undefined && patch.isError ? refusalMessage(patch.error, t) : undefined;
  const setPage = groupSetPageOf(project);

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
      </Card>
    </section>
  );
}
