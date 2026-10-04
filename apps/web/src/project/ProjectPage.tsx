import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, ArchiveRestore, FolderGit2, Rocket, Trash2 } from "lucide-react";
import { useState } from "react";

import type { ClassroomDetail, ProjectDetail, ProjectPatch, ProjectSummary } from "@quiz/contracts";

import { api, ApiError, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { activitiesKey, classroomKey, classroomProjectsKey, projectKey } from "../queryKeys";
import type { Navigate } from "../router";
import {
  Alert,
  Badge,
  Button,
  Card,
  EditableTitle,
  EmptyState,
  isoDateTime,
  Menu,
  PageError,
  PageHeader,
  PageSkeleton,
  ParentLink,
  Skeleton,
  type MenuItem,
} from "../ui";
import { projectStateLabel, projectStateTone } from "./common";
import { ProjectCheckpoints } from "./ProjectCheckpoints";
import { ProjectRepos } from "./ProjectRepos";
import { ProjectSettings } from "./ProjectSettings";
import { projectRefetchInterval, refusalKey, statusKey, unassignedStudents, type UnassignedStudent } from "./projectPage";
import { RepoSheet } from "./RepoSheet";

/**
 * The staff's project page (F-PROJ-13, M3-12), `/projects/:id`: the header
 * — its name (renamed in place), its state, what is happening and the ONE
 * primary action the server names —, the settings still open to change
 * (F-PROJ-03), one row per student of the roster with their repository, and
 * the review checkpoints. A row opens its repository's sheet: the history
 * of its runs, its own deadline and its lock.
 *
 * The primary action is `primaryAction`, decided by the server and never
 * derived here: Publish is a button; Release and Sync are said in the
 * header until their routes exist (merge tasks M3-08b and M3-07 turn them
 * into the button); `none` leaves the header to its sentence. Archive,
 * Restore and Delete live in the overflow menu — a deletion names the
 * project, and says that nothing is deleted on GitHub (F-PROJ-16).
 *
 * The page refetches every 30 s while its tab is visible, and once a few
 * seconds after a response whose live state was not all read in time
 * (`liveStale`); SSE comes with M3-09. A view never waits for GitHub.
 */
export function ProjectPage({ id, navigate }: { id: string; navigate: Navigate }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  const [unassigned, setUnassigned] = useState<UnassignedStudent[] | null>(null);

  const detail = useQuery<ProjectDetail>({
    queryKey: projectKey(id),
    queryFn: () => api(`/app/api/projects/${id}`),
    refetchInterval: (q) => projectRefetchInterval(q.state.data),
  });
  const classroomId = detail.data?.classroomId ?? null;
  const room = useQuery<ClassroomDetail>({
    queryKey: classroomKey(classroomId),
    enabled: classroomId !== null,
    queryFn: () => api(`/app/api/classrooms/${classroomId}`),
  });

  /** What a write changed besides the page: the classroom's lists and the Activities. */
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: projectKey(id) }),
      classroomId ? qc.invalidateQueries({ queryKey: classroomProjectsKey(classroomId) }) : null,
      qc.invalidateQueries({ queryKey: activitiesKey }),
    ]);
  };
  const failed = (error: unknown) => {
    const key = refusalKey(error);
    toast(key ? t(key) : apiErrorMessage(error, t("error.save")), "error");
  };

  const patch = useMutation({
    mutationFn: (body: ProjectPatch) =>
      api<ProjectSummary>(`/app/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: refresh,
  });
  const publish = useMutation({
    mutationFn: () => api<ProjectSummary>(`/app/api/projects/${id}/publish`, { method: "POST" }),
    onSuccess: async () => {
      setUnassigned(null);
      await refresh();
      toast(t("project.published"), "success");
    },
    onError: (error) => {
      const students = unassignedStudents(error);
      if (students) setUnassigned(students);
      else failed(error);
    },
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
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return (
        <div className="space-y-6">
          <PageHeader
            eyebrow={<ParentLink onClick={() => navigate({ view: "activities" })}>{t("nav.activities")}</ParentLink>}
            title={t("project.notFound")}
          />
          <Card className="px-6 py-4">
            <EmptyState
              icon={FolderGit2}
              title={t("project.notFound")}
              action={
                <Button variant="secondary" onClick={() => navigate({ view: "activities" })}>
                  {t("project.backToActivities")}
                </Button>
              }
            >
              {t("project.notFound.body")}
            </EmptyState>
          </Card>
        </div>
      );
    }
    return (
      <PageError
        title={t("project.page")}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        retrying={detail.isFetching}
      />
    );
  }
  const project = detail.data!;
  const archived = project.archivedAt !== null;
  const fellBack = project.rows.some(({ repo }) =>
    [repo?.scores.final?.grade, repo?.scores.current?.grade, repo?.scores.frozen?.grade, repo?.scores.review?.grade].some(
      (g) => g?.fellBack,
    ),
  );

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
  const menuItems: MenuItem[] = [
    {
      label: t(archived ? "classrooms.unarchive" : "classrooms.archive"),
      icon: archived ? ArchiveRestore : Archive,
      onSelect: () => void onArchive(),
    },
    { label: t("project.delete"), icon: Trash2, danger: true, separator: true, onSelect: () => void onDelete() },
  ];

  const status = statusKey(project);
  const statusDate = isoDateTime(
    status === "project.status.scheduled"
      ? project.startAt
      : status === "project.status.released"
        ? project.releasedAt!
        : project.deadlineAt,
  );
  const counts = [
    t("project.counts.students", { n: project.counts.students }),
    t("project.counts.accepted", { n: project.counts.accepted }),
    t("project.counts.frozen", { n: project.counts.frozen, live: project.counts.live }),
    ...(project.counts.toVerify > 0 ? [t("project.counts.toVerify", { n: project.counts.toVerify })] : []),
    ...(project.counts.alerts > 0 ? [t("project.counts.alerts", { n: project.counts.alerts })] : []),
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          room.data ? (
            <ParentLink onClick={() => navigate({ view: "classroom", id: project.classroomId })}>
              {room.data.name}
            </ParentLink>
          ) : (
            <Skeleton className="h-4 w-24" />
          )
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
            <Badge tone={projectStateTone(project.state)}>{projectStateLabel(project.state, t)}</Badge>
            {archived ? <Badge tone="zinc">{t("classrooms.archived")}</Badge> : null}
          </span>
        }
        description={
          <>
            <p data-testid="project-status">{t(status, { date: statusDate })}</p>
            <p className="mt-0.5 tabular-nums text-fg-faint">{counts.join(" · ")}</p>
          </>
        }
        actions={
          project.primaryAction === "publish" ? (
            <Button onClick={() => publish.mutate()} loading={publish.isPending}>
              <Rocket /> {t("project.publish")}
            </Button>
          ) : null
        }
        menu={<Menu items={menuItems} />}
      />

      {unassigned ? (
        <Alert
          tone="danger"
          icon={AlertTriangle}
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
      {fellBack ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("project.fellBack.title")}>
          {t("project.fellBack.body")}
        </Alert>
      ) : null}

      <ProjectSettings project={project} patch={patch} />
      <ProjectRepos project={project} onOpen={setOpenRepo} navigate={navigate} />
      {project.gradingMode === "auto" ? <ProjectCheckpoints project={project} /> : null}

      {openRepo ? <RepoSheet project={project} repoId={openRepo} onClose={() => setOpenRepo(null)} /> : null}
    </div>
  );
}
