import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Laptop, RefreshCw } from "lucide-react";

import {
  WORK_MODES,
  type CodespaceSessionState,
  type ProjectWorkModeBody,
  type ProjectWorkspace as Workspace,
  type ProjectWorkspaceSessions,
  type ProjectWorkspaceSyncAccepted,
  type WorkMode,
} from "@quiz/contracts";

import { api, isNotFound } from "../api";
import { useT } from "../i18n";
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

/**
 * Where the students work (ADR-047 as amended 2026-10-07, M6-06): a setting
 * of the project, in the page's Settings tab. Chosen by an owner of the
 * course whose account has the workspace grant, until a workspace was
 * opened — the server says which modes the caller may set, and why not the
 * others: `allowed`, `refusal`. Nothing at all when the feature is off (the
 * route is then a 404).
 */
export function WorkModeSetting({ projectId, archived }: { projectId: string; archived: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const workspace = useWorkspace(projectId);
  const setMode = useMutation({
    mutationFn: (mode: WorkMode) =>
      api<Workspace>(`/app/api/projects/${projectId}/workspace/mode`, {
        method: "PUT",
        body: JSON.stringify({ mode } satisfies ProjectWorkModeBody),
      }),
    onSuccess: (next) => {
      qc.setQueryData(projectWorkspaceKey(projectId), next);
      // The page itself only: the answer IS the workspace now.
      void qc.invalidateQueries({ queryKey: projectKey(projectId), exact: true });
    },
    onError: (error) => toast(refusalMessage(error, t), "error"),
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
  const options = WORK_MODES.filter((m) => !changeable || ws.allowed.includes(m)).map((value) => ({
    value,
    label: t(`project.workspace.mode.${value}`),
  }));

  return (
    // Aligned right like the other options' controls (ADR-119 §9); the row wraps it under its title on a phone.
    <SettingRow
      title={<span id="project-work-mode">{t("project.workspace.mode")}</span>}
      desc={
        <>
          {t(`project.workspace.mode.desc.${ws.mode}`)}
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
        value={setMode.isPending && setMode.variables ? setMode.variables : ws.mode}
        disabled={!changeable || setMode.isPending}
        wrap
        onChange={(mode) => setMode.mutate(mode)}
        options={options}
      />
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
      <Card className="overflow-x-auto">
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
