import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, ArchiveRestore, ClipboardCheck, Rocket, Send, Trash2 } from "lucide-react";
import { useState } from "react";

import type {
  ProjectDetail,
  ProjectPatch,
  ProjectReleaseResult,
  ProjectSummary,
  ProjectSyncAccepted,
} from "@quiz/contracts";

import { api, isNotFound, refusedWith } from "../api";
import { AppLink } from "../AppLink";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useNoticeToasts } from "../notifications/notices";
import { useToast } from "../notify";
import { activitiesKey, classroomGroupSetsKey, classroomProjectsKey, projectKey } from "../queryKeys";
import type { Navigate } from "../router";
import { Trail, useClassroomCrumbs } from "../Trail";
import {
  Alert,
  Badge,
  Button,
  buttonClass,
  EditableTitle,
  isoDateTime,
  Menu,
  PageError,
  PageHeader,
  PageSkeleton,
  QueryError,
  Skeleton,
  type MenuItem,
} from "../ui";
import { projectPhaseLabel, projectPhaseStyle } from "./common";
import { FIELD_ID } from "./newProject";
import { ProjectDraftForm } from "./ProjectDraftForm";
import { ProjectGroupSet } from "./ProjectGroupSet";
import { projectNotices, projectNoticeToast } from "./projectNotices";
import { SyncButton } from "./parts";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectRail } from "./ProjectRail";
import { ProjectRepos } from "./ProjectRepos";
import { ProjectSettings } from "./ProjectSettings";
import { ProjectWorkspace } from "./ProjectWorkspace";
import {
  hasFellBack,
  offersSync,
  projectRefetchInterval,
  projectStatus,
  refusalMessage,
  releaseRefusal,
  groupSetPageOf,
  unassignedStudents,
  type RepoFilter,
  type WriteProject,
  type UnassignedStudent,
} from "./projectPage";
import { RepoSheet } from "./RepoSheet";

/**
 * The staff's project page (F-PROJ-13, M3-12), `/projects/:id`, in two
 * faces: before publication one configures, after it one watches.
 *
 * A DRAFT is a form (`ProjectDraftForm`, F-PROJ-01, F-PROJ-03): the work
 * handed out, the publication and the deadline, the groups, "Advanced
 * options" and the lifecycle rail, every field written as it is set. No
 * tiles and no table: nobody can accept a draft (ADR-077 §1). With no Source
 * tile, Sync (the source is ahead) is a secondary button of the header.
 *
 * A PUBLISHED project is a dashboard. The header — its name (renamed in place), its state, what is happening and
 * the ONE primary action the server names —, four tiles (the acceptance as a
 * ring, the deadline edited in place, the progress, the source and its sync;
 * their sub-figures filter the table), the lifecycle rail with the review
 * checkpoints, one row per student of the roster with their repository (per
 * group in a group project, M3-16b, with its drift and *Resync*), the live
 * workspace, and the settings still open to change (F-PROJ-03) in a folded
 * card at the bottom. A row opens its repository's sheet:
 * the history of its runs, its scores and the teacher's, its own deadline and
 * its lock. See DESIGN.md › The project page (staff).
 *
 * The primary action is `primaryAction`, decided by the server and never
 * derived here: Publish and Release are buttons — Release disabled, with a
 * line saying why, while a confirmed resync of the groups is owed
 * (`groupSyncPending`, M3-16b), and confirmed first,
 * since it makes the final scores the students' and the gradebook's
 * (F-PROJ-14), and worded as a release again once a score moved after the
 * release (the snapshot is rewritten, nobody is notified again); Sync when
 * the source is ahead (F-PROJ-12, M3-07: the distribution repository is
 * updated and the students get a pull request each), offered as a
 * secondary button beside Publish or Release while the source is ahead
 * (`offersSync`); `none` leaves the header to its sentence. Archive,
 * Restore and Delete live in the overflow menu — a deletion names the
 * project, and says that nothing is deleted on GitHub (F-PROJ-16).
 *
 * The page refetches every 30 s while its tab is visible, and every few
 * seconds after a response whose live state was not all read in time
 * (`liveStale`) or while a sync runs; SSE comes with M3-09. A view never
 * waits for GitHub.
 */
export function ProjectPage({ id, navigate }: { id: string; navigate: Navigate }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  /** The tile sub-figure narrowing the repositories' table, or null for all of them. */
  const [filter, setFilter] = useState<RepoFilter | null>(null);
  const [unassigned, setUnassigned] = useState<UnassignedStudent[] | null>(null);
  /** Publish refused `409 no_group_set`: said above the page, pointing at the picker, until a set is chosen. */
  const [noSet, setNoSet] = useState(false);
  /** Why the last release was refused, said above the page until the next attempt succeeds. */
  const [releaseRefused, setReleaseRefused] = useState<string | null>(null);

  const detail = useQuery<ProjectDetail>({
    queryKey: projectKey(id),
    queryFn: () => api(`/app/api/projects/${id}`),
    refetchInterval: (q) => projectRefetchInterval(q.state.data),
  });
  const classroomId = detail.data?.classroomId ?? null;
  const crumbs = useClassroomCrumbs(classroomId);
  // F-PROJ-21 (M3-09c): what each re-read found changed, counted per kind.
  useNoticeToasts(detail, (prev, next) => projectNotices(prev, next).map((n) => projectNoticeToast(n, t)));

  /** What a write changed besides the page: the classroom's lists and the Activities. */
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: projectKey(id) }),
      classroomId ? qc.invalidateQueries({ queryKey: classroomProjectsKey(classroomId) }) : null,
      // A set named, or another one, changes what the sets say they are used by.
      classroomId ? qc.invalidateQueries({ queryKey: classroomGroupSetsKey(classroomId) }) : null,
      qc.invalidateQueries({ queryKey: activitiesKey }),
    ]);
  };
  const failed = (error: unknown) => toast(refusalMessage(error, t), "error");

  const patch = useMutation({
    mutationFn: (body: ProjectPatch) =>
      api<ProjectSummary>(`/app/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async (_, body) => {
      if (body.groupSetId) setNoSet(false);
      await refresh();
    },
  });
  /** The page's one write: a refusal is a toast, unless the caller said it in place (`WriteProject`). */
  const write: WriteProject = (body, onError) =>
    patch.mutate(body, {
      onError: (error) => {
        if (onError?.(error) !== true) failed(error);
      },
    });
  const publish = useMutation({
    mutationFn: () => api<ProjectSummary>(`/app/api/projects/${id}/publish`, { method: "POST" }),
    onSuccess: async () => {
      setUnassigned(null);
      setNoSet(false);
      await refresh();
      toast(t("project.published"), "success");
    },
    onError: (error) => {
      const students = unassignedStudents(error);
      if (students) setUnassigned(students);
      else if (refusedWith(error, "no_group_set")) setNoSet(true);
      else failed(error);
    },
  });
  const release = useMutation({
    mutationFn: () => api<ProjectReleaseResult>(`/app/api/projects/${id}/release`, { method: "POST" }),
    onSuccess: async (result) => {
      setReleaseRefused(null);
      await refresh();
      toast(t("project.released", { scored: result.scored, repos: result.repos }), "success");
    },
    // Worded with what the body carries (the counts, the students to verify), where the names can be read.
    onError: (error) => setReleaseRefused(releaseRefusal(error, detail.data!, t)),
  });
  const syncNow = useMutation({
    mutationFn: () => api<ProjectSyncAccepted>(`/app/api/projects/${id}/sync`, { method: "POST" }),
    onSuccess: async () => {
      await refresh();
      toast(t("project.sync.started"), "success");
    },
    onError: failed,
  });
  const archive = useMutation({
    mutationFn: (on: boolean) =>
      api<ProjectSummary>(`/app/api/projects/${id}/${on ? "archive" : "unarchive"}`, { method: "POST" }),
    onSuccess: async (_, on) => {
      await refresh();
      toast(t(on ? "project.archived" : "project.unarchived"), "success");
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: () => api<void>(`/app/api/projects/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await Promise.all([
        classroomId ? qc.invalidateQueries({ queryKey: classroomProjectsKey(classroomId) }) : null,
        qc.invalidateQueries({ queryKey: activitiesKey }),
      ]);
      toast(t("project.deleted"), "success");
      navigate(classroomId ? { view: "classroom", id: classroomId } : { view: "activities" });
    },
    onError: failed,
  });

  if (detail.isLoading) return <PageSkeleton header="title-and-bar" body="summary-and-block" />;
  if (detail.isError) {
    // A project that does not exist, or is not the caller's (invariant 6:
    // the same 404), said as the classroom says it.
    if (isNotFound(detail.error)) {
      return (
        <QueryError title={t("project.notFound")} query={detail} />
      );
    }
    return (
      <PageError title={t("project.page")} query={detail} />
    );
  }
  const project = detail.data!;
  const archived = project.archivedAt !== null;

  const onArchive = async () => {
    if (archived) {
      archive.mutate(false);
      return;
    }
    if (
      await confirm({
        title: t("project.archiveConfirm.title", { name: project.name }),
        message: t("project.archiveConfirm.body"),
        confirmLabel: t("classrooms.archive"),
      })
    ) {
      archive.mutate(true);
    }
  };
  const onDelete = async () => {
    if (
      await confirm({
        title: t("project.deleteConfirm.title", { name: project.name }),
        message: t("project.deleteConfirm.body"),
        typeToConfirm: project.name,
        confirmLabel: t("common.delete"),
        danger: true,
      })
    ) {
      remove.mutate();
    }
  };
  /** The release, and the release again once a score moved: the same route, the confirmation says which. */
  const again = project.releasedAt !== null;
  const onRelease = async () => {
    if (
      await confirm({
        title: t(again ? "project.release.again.confirm.title" : "project.release.confirm.title"),
        message: t(again ? "project.release.again.confirm.body" : "project.release.confirm.body", {
          n: project.counts.live,
        }),
        confirmLabel: t(again ? "project.release.again" : "project.release.confirmLabel"),
      })
    ) {
      release.mutate();
    }
  };
  const menuItems: MenuItem[] = [
    {
      label: t(archived ? "classrooms.unarchive" : "classrooms.archive"),
      icon: archived ? ArchiveRestore : Archive,
      onSelect: () => void onArchive(),
    },
    { label: t("project.delete"), icon: Trash2, danger: true, separator: true, onSelect: () => void onDelete() },
  ];

  const status = projectStatus(project);
  /** Release is the server's primary, held while a confirmed resync is not applied (`409 group_sync_pending` otherwise). */
  const releaseWaits = project.primaryAction === "release" && project.groupSyncPending;
  /** The set's page, coming back here (`?fromProject=<id>`): where the students in no group are placed. */
  const setPage = groupSetPageOf(project);
  const { sync } = project;
  const isDraft = project.state === "draft";
  const syncButton = (variant: "primary" | "secondary", coach: "project.primary" | "project.sync") => (
    <SyncButton sync={sync} onSync={() => syncNow.mutate()} syncing={syncNow.isPending} variant={variant} coach={coach} />
  );

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Trail navigate={navigate} items={[...crumbs, { label: project.name }]} />
        }
        title={
          <span className="flex flex-wrap items-baseline gap-3">
            {project.editable.includes("name") ? (
              <EditableTitle
                value={project.name}
                pending={patch.isPending ? patch.variables?.name : undefined}
                onSave={(name) => patch.mutate({ name })}
                editLabel={t("project.rename", { name: project.name })}
                inputLabel={t("project.name")}
              />
            ) : (
              project.name
            )}
            {/* The same word as the list's badge: the server's phase (ADR-104). */}
            <Badge {...projectPhaseStyle(project.phase)}>{projectPhaseLabel(project.phase, t)}</Badge>
            {archived ? <Badge tone="zinc">{t("classrooms.archived")}</Badge> : null}
          </span>
        }
        help="project"
        description={
          <>
            <p data-testid="project-status">{t(status.key, { date: isoDateTime(status.date) })}</p>
            {/* ADR-070's R2 (M3-16b): the release waits for a confirmed resync of the groups. */}
            {releaseWaits ? (
              <p className="mt-0.5 text-fg-muted" data-testid="project-release-waits">
                {t("project.release.waitsResync")}
              </p>
            ) : null}
          </>
        }
        actions={
          <span className="flex flex-wrap items-center gap-2">
            {/* A draft has no Source tile: Sync, when the source is ahead and is not the primary, sits beside Publish. */}
            {isDraft && project.primaryAction !== "sync" && offersSync(project) && !archived
              ? syncButton("secondary", "project.sync")
              : null}
            {project.primaryAction === "publish" ? (
              <Button
                data-coach="project.primary"
                onClick={() => publish.mutate()}
                loading={publish.isPending}
              >
                <Rocket /> {t("question.publish")}
              </Button>
            ) : project.primaryAction === "grade" ? (
              // ADR-106 §8: graded by criteria, every repository frozen, some still to validate.
              <Button data-coach="project.primary" onClick={() => navigate({ view: "projectGrading", id: project.id })}>
                <ClipboardCheck /> {t("project.grading.open")}
              </Button>
            ) : project.primaryAction === "release" ? (
              <Button
                data-coach="project.primary"
                onClick={() => void onRelease()}
                loading={release.isPending}
                disabled={releaseWaits}
              >
                <Send /> {t(again ? "project.release.again" : "project.release")}
              </Button>
            ) : project.primaryAction === "sync" ? (
              syncButton("primary", "project.primary")
            ) : null}
          </span>
        }
        menu={<Menu items={menuItems} />}
      />

      {releaseRefused ? (
        <Alert tone="danger" icon={AlertTriangle} title={t("project.release.refused")}>
          {releaseRefused}
        </Alert>
      ) : null}
      {noSet ? (
        <Alert
          tone="danger"
          icon={AlertTriangle}
          title={t("project.noGroupSet.title")}
          action={
            <Button variant="secondary" size="sm" onClick={() => document.getElementById(FIELD_ID.groupSet)?.focus()}>
              {t("project.groupSet.pick")}
            </Button>
          }
        >
          {t("project.noGroupSet.body")}
        </Alert>
      ) : null}
      {unassigned ? (
        <Alert
          tone="danger"
          icon={AlertTriangle}
          action={
            setPage ? (
              <AppLink route={setPage} navigate={navigate} className={buttonClass("secondary", "sm")}>
                {t("project.unassigned.open")}
              </AppLink>
            ) : undefined
          }
          title={
            unassigned.length > 0
              ? t("project.unassigned.title", { n: unassigned.length })
              : t("project.unassigned.none")
          }
        >
          {unassigned.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              {unassigned.map((s) => (
                <li key={s.enrollmentId}>
                  {s.nom} {s.prenom}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1">{t("project.unassigned.body")}</p>
        </Alert>
      ) : null}
      {hasFellBack(project) ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("project.fellBack.title")}>
          {t("project.fellBack.body")}
        </Alert>
      ) : null}

      {isDraft ? (
        <ProjectDraftForm project={project} patch={patch} write={write} navigate={navigate} />
      ) : (
        <>
          {project.groupMode ? <ProjectGroupSet project={project} patch={patch} navigate={navigate} /> : null}
          <ProjectOverview
            project={project}
            patch={patch}
            filter={filter}
            onFilter={setFilter}
            onSync={() => syncNow.mutate()}
            syncing={syncNow.isPending}
          />
          <ProjectRail project={project} />
          <ProjectRepos project={project} onOpen={setOpenRepo} navigate={navigate} filter={filter} onFilter={setFilter} />
          <ProjectWorkspace projectId={project.id} archived={archived} />
          <ProjectSettings project={project} pending={patch.isPending} write={write} />
        </>
      )}

      {openRepo ? <RepoSheet project={project} repoId={openRepo} onClose={() => setOpenRepo(null)} /> : null}
    </div>
  );
}
