import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  CalendarClock,
  CalendarX2,
  ClipboardCheck,
  FolderGit2,
  LayoutDashboard,
  LockOpen,
  RefreshCw,
  Rocket,
  Send,
  Settings,
  Square,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import type {
  ProjectDetail,
  ProjectReleaseResult,
  ProjectReposAccess,
  ProjectSummary,
  ProjectSyncAccepted,
  ProjectSyncRequest,
} from "@quiz/contracts";
import { projectBeforePublication } from "@quiz/domain";

import { api, isNotFound, refusedWith } from "../api";
import { AppLink } from "../AppLink";
import { useConfirm } from "../confirm";
import { useClassroomOwner } from "../course/parts";
import { useT } from "../i18n";
import { useNoticeToasts } from "../notifications/notices";
import { useToast } from "../notify";
import { activitiesKey, classroomProjectsKey, projectKey } from "../queryKeys";
import { useSearchParam, type Navigate } from "../router";
import { useStudentWorkRefusal } from "../studentWork";
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
  TabPanel,
  Tabs,
  useNow,
  type MenuItem,
} from "../ui";
import { projectPhaseLabel, projectPhaseStyle } from "./common";
import { FIELD_ID } from "./newProject";
import { ProjectDraftForm } from "./ProjectDraftForm";
import { publicationRefusal, type PlacedRefusal } from "./ProjectDraftPublication";
import { GradingTab } from "./grading/GradingTab";
import { ProjectGroupSet } from "./ProjectGroupSet";
import { projectNotices, projectNoticeToast } from "./projectNotices";
import { SyncButton } from "./parts";
import { SyncDialog } from "./SyncDialog";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectRail } from "./ProjectRail";
import { ProjectRepos } from "./ProjectRepos";
import { ProjectSettings } from "./ProjectSettings";
import { ProjectWorkspace } from "./ProjectWorkspace";
import {
  offersClose,
  offersSync,
  projectRefetchInterval,
  projectStatus,
  refusalMessage,
  repoFilterOf,
  releaseRefusal,
  groupSetPageOf,
  unassignedStudents,
  type RepoFilter,
  type WriteProject,
  type UnassignedStudent,
} from "./projectPage";
import { useProjectPatch, useProjectRefresh, useRenameProject } from "./useProjectPatch";

/**
 * The staff's project page (F-PROJ-13, M3-12), `/projects/:id`, in two
 * faces: before publication one configures, after it one watches.
 *
 * A DRAFT, and a SCHEDULED project (ADR-127), is a form (`ProjectDraftForm`, F-PROJ-01, F-PROJ-03): the work
 * handed out, the publication and the deadline, the groups, "Advanced
 * options" and the lifecycle rail, every field written as it is set. No
 * tiles and no table: nobody can accept a draft (ADR-077 §1). With no Source
 * tile, Sync (the source is ahead) is a secondary button of the header.
 *
 * A PUBLISHED or LOCKED project is a dashboard in tabs (F-PROJ-13 as amended
 * 2026-10-13), the active one in the URL (`?tab=`). The header — its name
 * (renamed in place), its state, what is happening and the ONE primary
 * action the server names — stands above them all. Summary: the group set,
 * four tiles (the acceptance as a ring, the deadline edited in place, the
 * progress, the source and its sync), the lifecycle rail with the review
 * checkpoints and the live workspace; a tile's sub-figure opens Repositories
 * filtered by it (`?filter=`, so Back from a row's page finds it). Repositories:
 * one row per student of the roster with their
 * repository (per group in a group project, M3-16b, with its drift and
 * *Resync*). Grading, in `criteria` mode only: the statistics of the
 * validated repositories and the read-only matrix of their criteria, a row
 * opening the grading screen (`grading/GradingTab`). Settings: what is
 * still open to change (F-PROJ-03). A row opens its repository's page
 * (`RepoPage`, ADR-137): its members, its commits, its runs, its scores and
 * the teacher's, its own deadline and its lock. See DESIGN.md › The project
 * page (staff).
 *
 * The primary action is `primaryAction`, decided by the server and never
 * derived here: Publish (the start is now) or Schedule (a date to come,
 * ADR-127) for a draft — a refused date said under its field —; a
 * scheduled project has none, its header offering Publish now and Cancel
 * the schedule as secondary buttons (back to a draft, nothing confirmed:
 * Schedule undoes it). Publish and Release are buttons — Release disabled, with a
 * line saying why, while a confirmed resync of the groups is owed
 * (`groupSyncPending`, M3-16b), and confirmed first,
 * since it makes the final scores the students' and the gradebook's
 * (F-PROJ-14), and worded as a release again once a score moved after the
 * release (the snapshot is rewritten, nobody is notified again); Sync when
 * the source is ahead (F-PROJ-12, M3-07: the distribution repository is
 * updated and the students get a pull request each), offered as a
 * secondary button beside Publish or Release while the source is ahead
 * (`offersSync`); Open repositories (ADR-145), an `online_seb` project's
 * once its work is over and released, confirmed first with what becomes
 * readable and that a clone cannot be taken back — closing them again is
 * the Repositories tab's secondary; `none` leaves the header to its sentence. *Close
 * project* (#1147), the course owner's while the project is published and
 * its deadline ahead (`offersClose`), is a `danger-quiet` button of the header, as
 * the live evaluation's Close, confirmed first with what follows. Archive,
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
  const [tabParam, setTab] = useSearchParam("tab", "summary");
  /** The tile sub-figure narrowing the repositories' table, or null for all of them. */
  const [filterParam, setFilterParam] = useSearchParam("filter", "");
  const filter = repoFilterOf(filterParam);
  const setFilter = (next: RepoFilter | null) => setFilterParam(next ?? "");
  const [unassigned, setUnassigned] = useState<UnassignedStudent[] | null>(null);
  /** Publish refused `409 no_group_set`: said above the page, pointing at the picker, until a set is chosen. */
  const [noSet, setNoSet] = useState(false);
  /** Schedule or Publish refused over a date (`start_past`, `deadline_past`): said under that field of the form. */
  const [dateRefused, setDateRefused] = useState<PlacedRefusal | null>(null);
  /** Why the last release was refused, said above the page until the next attempt succeeds. */
  const [releaseRefused, setReleaseRefused] = useState<string | null>(null);

  const detail = useQuery<ProjectDetail>({
    queryKey: projectKey(id),
    queryFn: () => api(`/app/api/projects/${id}`),
    refetchInterval: (q) => projectRefetchInterval(q.state.data),
  });
  const classroomId = detail.data?.classroomId ?? null;
  const crumbs = useClassroomCrumbs(classroomId);
  /** Close project is the course owner's (#1147), like the release: null while the role is not known yet. */
  const owner = useClassroomOwner(classroomId);
  const now = useNow();
  // F-PROJ-21 (M3-09c): what each re-read found changed, counted per kind.
  useNoticeToasts(detail, (prev, next) => projectNotices(prev, next).map((n) => projectNoticeToast(n, t)));

  /** What a write changed besides the page: the classroom's lists and the Activities. */
  const refresh = useProjectRefresh(id, classroomId);
  const failed = (error: unknown) => toast(refusalMessage(error, t), "error");

  const patch = useProjectPatch(id, classroomId, (body) => {
    if (body.groupSetId) setNoSet(false);
    setDateRefused(null);
  });
  const renaming = useRenameProject(id, classroomId);
  /** The page's one write: a refusal is a toast, unless the caller said it in place (`WriteProject`). */
  const write: WriteProject = (body, onError) =>
    patch.mutate(body, {
      onError: (error) => {
        if (onError?.(error) !== true) failed(error);
      },
    });
  /**
   * Publish (from a draft or a scheduled project, F-PROJ-03) and Schedule
   * (ADR-127) refuse alike: the students in no group and the missing set
   * above the page, a date under its field, the rest as a toast.
   */
  const opening = (move: "publish" | "schedule", done: "project.published" | "project.scheduledToast") => ({
    mutationFn: () => api<ProjectSummary>(`/app/api/projects/${id}/${move}`, { method: "POST" }),
    onSuccess: async () => {
      setUnassigned(null);
      setNoSet(false);
      setDateRefused(null);
      await refresh();
      toast(t(done), "success");
    },
    onError: (error: unknown) => {
      const students = unassignedStudents(error);
      const placed = publicationRefusal(error, t);
      if (students) setUnassigned(students);
      else if (refusedWith(error, "no_group_set")) setNoSet(true);
      else if (placed) {
        setDateRefused(placed);
        document.getElementById(placed.place === "start" ? FIELD_ID.start : FIELD_ID.deadline)?.focus();
      } else failed(error);
    },
  });
  const publish = useMutation(opening("publish", "project.published"));
  const schedule = useMutation(opening("schedule", "project.scheduledToast"));
  /** Back to a draft (ADR-127): reversible by Schedule, so nothing is confirmed. */
  const unschedule = useMutation({
    mutationFn: () => api<ProjectSummary>(`/app/api/projects/${id}/unschedule`, { method: "POST" }),
    onSuccess: async () => {
      await refresh();
      toast(t("project.unscheduledToast"), "success");
    },
    onError: failed,
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
  /** The Sync dialog (ADR-132 §10): every Sync button opens it; its own primary sends the sync. */
  const [syncOpen, setSyncOpen] = useState(false);
  const syncNow = useMutation({
    mutationFn: (message: string) =>
      api<ProjectSyncAccepted>(`/app/api/projects/${id}/sync`, { method: "POST", body: JSON.stringify({ message } satisfies ProjectSyncRequest) }),
    onSuccess: async () => {
      setSyncOpen(false);
      await refresh();
      toast(t("project.sync.started"), "success");
    },
    onError: failed,
  });
  /** ADR-145: an `online_seb` project's repositories opened to their students, read-only; the job invites them. */
  const openRepos = useMutation({
    mutationFn: () => api<ProjectReposAccess>(`/app/api/projects/${id}/repos/open`, { method: "POST" }),
    onSuccess: async () => {
      await refresh();
      toast(t("project.repos.openedToast"), "success");
    },
    onError: failed,
  });
  /** #1147: the deadline brought to the server's now; the ticker applies it as any deadline. */
  const closeNow = useMutation({
    mutationFn: () => api<ProjectSummary>(`/app/api/projects/${id}/close`, { method: "POST" }),
    onSuccess: async () => {
      await refresh();
      toast(t("project.closedToast"), "success");
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
  });
  const refused = useStudentWorkRefusal();

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
        danger: true,
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
      // A project holding students' grades is never deleted (ADR-141): its archive, confirmed, is offered instead.
      remove.mutate(undefined, {
        onError: refused("project", { archive: archived ? undefined : () => void onArchive(), otherwise: failed }),
      });
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
  /** ADR-145 §5: one-way in practice — what becomes readable, a clone kept, the sittings still to come on this source. */
  const onOpenRepos = async () => {
    const access = project.reposAccess!;
    const opened =
      access.openable === 1 ? t("project.repos.open.confirm.body.one") : t("project.repos.open.confirm.body", { n: access.openable });
    const closed =
      access.nothingToOpen === 1
        ? t("project.repos.open.confirm.none.one")
        : t("project.repos.open.confirm.none", { n: access.nothingToOpen });
    if (
      await confirm({
        title: t("project.repos.open.confirm.title"),
        message: (
          <span className="flex flex-col gap-2">
            <span>{opened}</span>
            {access.nothingToOpen > 0 ? <span>{closed}</span> : null}
            {access.sameSource.length > 0 ? (
              <span className="font-medium text-fg">{t("project.repos.open.confirm.sameSource", { names: access.sameSource.join(", ") })}</span>
            ) : null}
          </span>
        ),
        confirmLabel: t("project.repos.open"),
      })
    ) {
      openRepos.mutate();
    }
  };
  const onCloseNow = async () => {
    if (
      await confirm({
        title: t("project.close.confirm.title", { name: project.name }),
        message: t(
          project.deadlineStrategy === "commit" ? "project.close.confirm.body.commit" : "project.close.confirm.body.lock",
          { n: project.graceMinutes },
        ),
        confirmLabel: t("project.close"),
        danger: true,
      })
    ) {
      closeNow.mutate();
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
  /** A draft or a scheduled project: the form, not the dashboard (ADR-127 §4). */
  const isDraft = projectBeforePublication(project.state);
  const scheduled = project.state === "scheduled" && !archived;
  const tabs: Parameters<typeof Tabs<ProjectTab>>[0]["items"] = [
    { value: "summary", label: t("project.tab.summary"), icon: LayoutDashboard },
    { value: "repositories", label: t("project.repos"), icon: FolderGit2, coach: "project.repos" },
    ...(project.gradingMode === "criteria"
      ? [{ value: "grading" as const, label: t("project.tab.grading"), icon: ClipboardCheck }]
      : []),
    { value: "settings", label: t("project.settings"), icon: Settings },
  ];
  /** A `?tab=` naming no tab of this project (Grading out of `criteria` mode, a hand edit) is the Summary. */
  const tab: ProjectTab = tabs.find((it) => it.value === tabParam)?.value ?? "summary";
  /** A sub-figure of the Summary opens Repositories narrowed to it; cleared, the table shows every row. */
  const pickFilter = (next: RepoFilter | null) => {
    setFilter(next);
    if (next !== null) setTab("repositories");
  };
  const syncButton = (variant: "primary" | "secondary", coach: "project.primary" | "project.sync") => (
    <SyncButton sync={sync} onSync={() => setSyncOpen(true)} syncing={syncNow.isPending} variant={variant} coach={coach} />
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
                pending={renaming.pendingName}
                onSave={renaming.rename}
                editLabel={t("project.rename", { name: project.name })}
                inputLabel={t("project.name")}
              />
            ) : (
              project.name
            )}
            {/* The same word as the list's badge: the server's phase (ADR-104). */}
            <Badge {...projectPhaseStyle(project.phase)}>{projectPhaseLabel(project.phase, t)}</Badge>
            {archived ? <Badge tone="zinc">{t("project.archivedBadge")}</Badge> : null}
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
            {/* ADR-127: a scheduled project has no primary; its two moves are secondary. */}
            {scheduled ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => unschedule.mutate()}
                  loading={unschedule.isPending}
                  disabled={publish.isPending}
                >
                  {unschedule.isPending ? null : <CalendarX2 />} {t("project.unschedule")}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => publish.mutate()}
                  loading={publish.isPending}
                  disabled={unschedule.isPending}
                >
                  {publish.isPending ? null : <Rocket />} {t("project.publishNow")}
                </Button>
              </>
            ) : null}
            {/* #1147: the evaluation's Close, mirrored in red ink: the fill is its confirmation's, never beside the primary. */}
            {owner === true && offersClose(project, now) ? (
              <Button variant="danger-quiet" onClick={() => void onCloseNow()} loading={closeNow.isPending}>
                {closeNow.isPending ? null : <Square />} {t("project.close")}
              </Button>
            ) : null}
            {project.primaryAction === "publish" ? (
              <Button
                data-coach="project.primary"
                onClick={() => publish.mutate()}
                loading={publish.isPending}
              >
                <Rocket /> {t("question.publish")}
              </Button>
            ) : project.primaryAction === "schedule" ? (
              <Button
                data-coach="project.primary"
                onClick={() => schedule.mutate()}
                loading={schedule.isPending}
              >
                <CalendarClock /> {t("project.schedule")}
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
            ) : project.primaryAction === "open_repos" ? (
              // ADR-145 §3: once the lab is over, the course owner opens the repositories to their students.
              <Button data-coach="project.primary" onClick={() => void onOpenRepos()} loading={openRepos.isPending}>
                {openRepos.isPending ? null : <LockOpen />} {t("project.repos.open")}
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
        />
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

      {isDraft ? (
        <ProjectDraftForm project={project} patch={patch} write={write} navigate={navigate} dateRefused={dateRefused} />
      ) : (
        <>
          <Tabs<ProjectTab> value={tab} onChange={setTab} items={tabs} idPrefix="project" label={t("project.page")} />
          <TabPanel idPrefix="project" value={tab} className="space-y-8">
            {tab === "summary" ? (
              <>
                {/* ADR-132 §10: after an update, Regrade is offered where it lives, the grading screen. */}
                {sync.gradedBefore > 0 ? (
                  <Alert
                    tone="warning"
                    icon={RefreshCw}
                    title={
                      sync.gradedBefore === 1
                        ? t("project.sync.gradedBefore.one")
                        : t("project.sync.gradedBefore", { n: sync.gradedBefore })
                    }
                    action={
                      <AppLink
                        route={{ view: "projectGrading", id: project.id }}
                        navigate={navigate}
                        className={buttonClass("secondary", "sm")}
                      >
                        {t("project.sync.gradedBefore.open")}
                      </AppLink>
                    }
                  >
                    {t("project.sync.gradedBefore.body")}
                  </Alert>
                ) : null}
                {project.groupMode ? <ProjectGroupSet project={project} patch={patch} navigate={navigate} /> : null}
                <ProjectOverview
                  project={project}
                  patch={patch}
                  filter={filter}
                  onFilter={pickFilter}
                  onSync={() => setSyncOpen(true)}
                  syncing={syncNow.isPending}
                />
                <ProjectRail project={project} />
                <ProjectWorkspace projectId={project.id} archived={archived} />
              </>
            ) : tab === "repositories" ? (
              <ProjectRepos
                project={project}
                onOpen={(rowId) => navigate({ view: "projectRepo", id: project.id, rowId, ...(filter ? { filter } : {}) })}
                navigate={navigate}
                filter={filter}
                onFilter={setFilter}
                owner={owner}
              />
            ) : tab === "grading" ? (
              <GradingTab project={project} navigate={navigate} owner={owner} />
            ) : (
              <ProjectSettings project={project} pending={patch.isPending} write={write} />
            )}
          </TabPanel>
        </>
      )}

      {syncOpen ? (
        <SyncDialog project={project} onSync={(message) => syncNow.mutate(message)} syncing={syncNow.isPending} onClose={() => setSyncOpen(false)} />
      ) : null}
    </div>
  );
}

/** The tabs of a published or locked project's page (F-PROJ-13 as amended 2026-10-13). */
type ProjectTab = "summary" | "repositories" | "grading" | "settings";
