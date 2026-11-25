import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { AlertTriangle, Laptop, RefreshCw } from "lucide-react";

import {
  COURSE_WORKSPACE_IMAGES_MAX,
  ProjectWorkspaceImageBody,
  projectWorkspaceImagePath,
  type CodespaceSessionState,
  type ProjectWorkModeBody,
  type ProjectWorkspace as Workspace,
  type ProjectWorkspaceSessions,
  type ProjectWorkspaceSyncAccepted,
} from "@quiz/contracts";
import { acceptsKiosk, workSettingFor, workSettingOf, type DeviceLevel, type WorkSetting } from "@quiz/domain";

import { api, isNotFound } from "../api";
import { useClassroom } from "../course/parts";
import { imageErrorText, useCourseWorkspaceImages } from "../course/workspaceImages";
import { AllowedDevices } from "../evaluation/AllowedDevices";
import { useT, type Dict } from "../i18n";
import { useToast } from "../notify";
import { projectKey, projectWorkspaceKey, projectWorkspaceSessionsKey } from "../queryKeys";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  isoDateTime,
  QueryError,
  RelativeTime,
  SectionHeading,
  Segmented,
  Select,
  SettingRow,
  Skeleton,
  T,
  TableHead,
  type Tone,
} from "../ui";
import { refusalMessage } from "./projectPage";

/** A workspace's state, as a badge: green while it runs, red when it failed, neutral otherwise. */
const STATE_TONE: Record<CodespaceSessionState, Tone> = {
  starting: "amber",
  running: "green",
  stopped: "zinc",
  closed: "zinc",
  failed: "red",
};

/** The workspace read, shared by the work-mode setting and the live section: one query, one cache entry. */
export function useWorkspace(projectId: string) {
  return useQuery<Workspace>({
    queryKey: projectWorkspaceKey(projectId),
    queryFn: () => api(`/app/api/projects/${projectId}/workspace`),
    // The 404 of a platform without the portal is an answer, not a failure to retry.
    retry: (count, error) => !isNotFound(error) && count < 2,
  });
}

/** The project's level's sub-texts: a project's own where the exam's speaks of an exam. */
const PROJECT_DESC = (level: DeviceLevel): keyof Dict =>
  level === "any" || level === "seb" ? `project.devices.${level}.desc` : `eval.devices.${level}.desc`;

/** The two places of the Segmented: the students' own tools, or the online workspace (at a device level). */
type Place = "own" | "online";

/**
 * Where the students work (ADR-047 as amended 2026-10-07, M6-06; ADR-089,
 * amendment of 2026-11-15, "One control"): a setting of the project, in the
 * page's Settings tab. A Segmented **Own tools | Online workspace**, and
 * under Online the exam's **Allowed devices**: Any is `online`, the three
 * others `online_seb` at that level (`workSettingFor`, the one mapping).
 * The station levels are offered only where the platform offers them to
 * projects (`kioskOffered`). Chosen by an owner of the course whose account
 * has the workspace grant, until a workspace was opened — the server says
 * which modes the caller may set, and why not the others: `allowed`,
 * `refusal`. Nothing at all when the feature is off (the route is then a 404).
 * Online, the workspace's image follows ({@link ImageSetting}).
 */
export function WorkModeSetting({
  projectId,
  classroomId,
  archived,
}: {
  projectId: string;
  /** The project's classroom: its course holds the images the project may pick. */
  classroomId: string;
  archived: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const workspace = useWorkspace(projectId);
  // Both writes answer the workspace as it now is.
  const answered = (next: Workspace) => qc.setQueryData(projectWorkspaceKey(projectId), next);
  const setMode = useMutation({
    mutationFn: (body: ProjectWorkModeBody) =>
      api<Workspace>(`/app/api/projects/${projectId}/workspace/mode`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (next) => {
      answered(next);
      // The page itself only: its mode shows in the header and the tabs.
      void qc.invalidateQueries({ queryKey: projectKey(projectId), exact: true });
    },
    onError: (error) => toast(refusalMessage(error, t), "error"),
  });
  // ADR-146 §4: `PUT /projects/:id/workspace/image`.
  const setImage = useMutation({
    mutationFn: (imageId: string | null) =>
      api<Workspace>(projectWorkspaceImagePath(projectId), {
        method: "PUT",
        body: JSON.stringify(ProjectWorkspaceImageBody.parse({ imageId })),
      }),
    onSuccess: answered,
    onError: (error) => toast(imageErrorText(error, t, COURSE_WORKSPACE_IMAGES_MAX), "error"),
  });

  if (isNotFound(workspace.error)) return null;
  const ws = workspace.data;
  if (workspace.isLoading) return <Skeleton className="my-3 h-16 w-full" />;
  if (workspace.isError || !ws) {
    return (
      <div className="py-3">
        <QueryError title={t("project.workspace")} query={workspace} />
      </div>
    );
  }
  const changeable = !archived && ws.allowed.length > 1;
  // What the screen shows: the pending choice while it is written, else the stored one.
  const shown: WorkSetting = setMode.isPending && setMode.variables ? workSettingOf(setMode.variables) : ws;
  const place: Place = shown.mode === "free" ? "own" : "online";
  const online = ws.allowed.some((m) => m !== "free");
  const options = (["own", "online"] as const)
    .filter((p) => !changeable || (p === "own" ? ws.allowed.includes("free") : online))
    .map((value) => ({ value, label: t(`project.workspace.place.${value}`) }));
  // A level is a choice of the workspace's two modes: open only while both are the caller's to set.
  const levelsOpen = changeable && ws.allowed.includes("online") && ws.allowed.includes("online_seb");
  const pick = (next: ProjectWorkModeBody) => setMode.mutate(next);
  // ADR-089 amendment point 7: a station sitting takes a workspace per student, the holder's quota caps them.
  const quota = place === "online" && ws.quota && ws.quota.seats > ws.quota.max && acceptsKiosk(shown.devices) ? ws.quota : null;

  return (
    <div>
      {/* Aligned right like the other options' controls (ADR-119 §9); the row wraps it under its title on a phone. */}
      <SettingRow
        title={<span id="project-work-mode">{t("project.workspace.mode")}</span>}
        desc={
          <>
            {t(shown.mode === "free" ? "project.workspace.mode.desc.free" : "project.workspace.mode.desc.online")}
            {shown.mode === "online_seb" ? <span className="block">{t("project.workspace.mode.desc.supervised")}</span> : null}
            {ws.refusal && !archived ? (
              <span className="mt-1 block text-fg-faint" data-testid="workspace-refusal">
                {t(`project.workspace.refusal.${ws.refusal}`)}
              </span>
            ) : null}
          </>
        }
      >
        <Segmented
          name="workMode"
          labelledBy="project-work-mode"
          value={place}
          disabled={!changeable || setMode.isPending}
          wrap
          // Online from own tools starts at Any (`online`); the level is chosen below.
          onChange={(p) => pick(workSettingFor(p === "online", "any"))}
          options={options}
        />
      </SettingRow>
      {place === "online" ? (
        <AllowedDevices
          level={shown.devices}
          kioskOffered={ws.kioskOffered}
          disabled={!levelsOpen || setMode.isPending}
          onPick={(level) => pick(workSettingFor(true, level))}
          descOf={PROJECT_DESC}
        />
      ) : null}
      {place === "online" ? <ImageSetting classroomId={classroomId} current={ws.image} archived={archived} setImage={setImage} /> : null}
      {quota ? (
        <p className="-mt-1 flex items-start gap-1.5 pb-3 text-[13px] text-warning" data-testid="workspace-quota">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("project.workspace.quota", { seats: quota.seats, max: quota.max })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The image the project's workspaces run (ADR-146 §4): the default
 * (`quiz-base`) or one of its course's images whose admission was ready —
 * a digest in service. Changed by whoever manages the course's images (an
 * owner with the workspace grant, the list's `canManage`), at any time: a
 * change applies to the workspaces started afterwards. Shown to the others
 * only when the project runs a course image, as a fact; a refusal (`409
 * image_not_ready`) is a toast, the stored choice kept.
 */
function ImageSetting({
  classroomId,
  current,
  archived,
  setImage,
}: {
  classroomId: string;
  current: Workspace["image"];
  archived: boolean;
  /** `WorkModeSetting`'s write of the image, beside its write of the mode. */
  setImage: UseMutationResult<Workspace, Error, string | null>;
}) {
  const t = useT();
  const classroom = useClassroom(classroomId, { retry: false });
  const list = useCourseWorkspaceImages(classroom.data?.course.id);
  const canManage = list.data?.canManage === true;
  if (!canManage && current === null) return null;
  const ready = (list.data?.images ?? []).filter((image) => image.digestReference !== null);
  // The image in force stays an option even when it no longer is ready.
  const options = [
    { value: "", label: t("project.workspace.image.default") },
    ...ready.map((image) => ({ value: image.id, label: image.name })),
    ...(current && !ready.some((image) => image.id === current.id) ? [{ value: current.id, label: current.name }] : []),
  ];
  const value = setImage.isPending ? (setImage.variables ?? "") : (current?.id ?? "");
  return (
    <SettingRow
      title={<span id="project-workspace-image">{t("project.workspace.image")}</span>}
      desc={t("project.workspace.image.desc")}
    >
      <Select
        aria-labelledby="project-workspace-image"
        width="w-56"
        value={value}
        disabled={!canManage || archived || setImage.isPending}
        onChange={(e) => setImage.mutate(e.target.value || null)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

/**
 * The project's online workspace, live (ADR-047, M6-06), on the staff's
 * page under the repositories: the last update the portal received with a
 * *Resync*, the sync's error, and the workspaces open now, live from the
 * portal. Drawn only while students work online (the mode itself is a
 * setting, `WorkModeSetting`), and nothing at all when the feature is off
 * (404). A secondary surface: the page's primary action stays the header's.
 */
export function ProjectWorkspace({ projectId, archived }: { projectId: string; archived: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const workspace = useWorkspace(projectId);
  const resync = useMutation({
    mutationFn: () =>
      api<ProjectWorkspaceSyncAccepted>(`/app/api/projects/${projectId}/workspace/sync`, { method: "POST" }),
    onSuccess: () => {
      toast(t("project.workspace.resynced"), "success");
      void qc.invalidateQueries({ queryKey: projectWorkspaceKey(projectId) });
    },
    onError: (error) => toast(refusalMessage(error, t), "error"),
  });

  const ws = workspace.data;
  if (!ws || ws.mode === "free") return null;

  return (
    <section aria-labelledby="project-workspace" className="space-y-3" data-testid="project-workspace">
      <SectionHeading icon={Laptop} title={<span id="project-workspace">{t("project.workspace")}</span>} />
      <Card className="px-4">
        <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-[13px]">
          <span className="text-fg-muted" data-testid="workspace-sync">
            {ws.syncedAt
              ? t("project.workspace.synced", { date: isoDateTime(ws.syncedAt) })
              : t("project.workspace.notSynced")}
          </span>
          <Button variant="secondary" size="sm" onClick={() => resync.mutate()} loading={resync.isPending} disabled={archived}>
            <RefreshCw /> {t("project.workspace.resync")}
          </Button>
        </div>
      </Card>
      {/* The portal's own words are a technical detail, on hover: the sentence is ours. */}
      {ws.syncError ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("project.workspace.syncError")}>
          <span title={ws.syncError} data-testid="workspace-sync-error">
            {t("project.workspace.syncError.body")}
          </span>
        </Alert>
      ) : null}
      <WorkspaceSessions projectId={projectId} />
    </section>
  );
}

/** The project's open workspaces, live from the portal: a portal out of reach is a line, never an error page. */
function WorkspaceSessions({ projectId }: { projectId: string }) {
  const t = useT();
  const sessions = useQuery<ProjectWorkspaceSessions>({
    queryKey: projectWorkspaceSessionsKey(projectId),
    queryFn: () => api(`/app/api/projects/${projectId}/workspace/sessions`),
    refetchInterval: 60_000,
  });
  const title = <h3 className="text-sm font-medium text-fg">{t("project.workspace.sessions")}</h3>;
  if (sessions.isLoading) return <Skeleton className="h-16 w-full" />;
  if (sessions.isError || !sessions.data) {
    return (
      <QueryError title={t("project.workspace.sessions")} query={sessions} />
    );
  }
  const { reachable, sessions: rows } = sessions.data;
  if (!reachable || rows.length === 0) {
    return (
      <div className="space-y-2">
        {title}
        <p className="text-[13px] text-fg-muted" data-testid="workspace-sessions-note">
          {t(reachable ? "project.workspace.sessions.empty" : "project.workspace.sessions.unreachable")}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {title}
      <Card className={cx(T.container, "overflow-x-auto")}>
        <table className={cx(T.table, "min-w-140")}>
          <TableHead
            columns={[
              { key: "student", label: t("project.workspace.col.student") },
              { key: "state", label: t("project.workspace.col.state") },
              { key: "lastSeen", label: t("project.workspace.col.lastSeen") },
              { key: "lastPush", label: t("project.workspace.col.lastPush") },
            ]}
          />
          <tbody>
            {rows.map((s) => (
              <tr key={s.sessionId} className={T.row}>
                <td className={`${T.td} font-semibold`}>
                  {s.user ? s.user.name : <span className="font-normal text-fg-muted">{t("project.workspace.unknownStudent")}</span>}
                </td>
                <td className={T.td}>
                  <Badge tone={STATE_TONE[s.state]}>{t(`project.workspace.state.${s.state}`)}</Badge>
                </td>
                <td className={`${T.td} whitespace-nowrap text-fg-muted`}>
                  <RelativeTime iso={s.lastSeenAt} />
                </td>
                <td className={`${T.td} whitespace-nowrap text-fg-muted`}>
                  {s.lastPushAt ? <RelativeTime iso={s.lastPushAt} /> : "—"}
                  {s.rejectedPush && (
                    // The relay never forces (ADR-078 §6): a push behind a commit of Quiz's App waits for the student's pull.
                    <div className="mt-1 space-y-0.5" data-testid="workspace-push-rejected">
                      <Badge tone="amber" icon={AlertTriangle}>
                        {t("project.workspace.pushRejected", { branch: s.rejectedPush.ref.replace(/^refs\/heads\//, "") })}
                      </Badge>
                      {/* Our sentence; GitHub's words only as the technical detail on hover. */}
                      <p className="max-w-72 whitespace-normal text-[12px]" title={s.rejectedPush.reason}>
                        {t("project.workspace.pushRejected.hint")}
                      </p>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
