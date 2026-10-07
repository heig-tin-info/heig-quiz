import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Laptop, RefreshCw } from "lucide-react";

import type {
  CodespaceSessionState,
  ProjectWorkModeBody,
  ProjectWorkspace as Workspace,
  ProjectWorkspaceSessions,
  ProjectWorkspaceSyncAccepted,
  WorkMode,
} from "@quiz/contracts";

import { api, ApiError } from "../api";
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
  Skeleton,
  T,
  type Tone,
} from "../ui";
import { refusalMessage } from "./projectPage";

const MODES: readonly WorkMode[] = ["free", "online", "online_seb"];

/** A workspace's state, as a badge: green while it runs, red when it failed, neutral otherwise. */
const STATE_TONE: Record<CodespaceSessionState, Tone> = {
  starting: "amber",
  running: "green",
  stopped: "zinc",
  closed: "zinc",
  failed: "red",
};

/**
 * The project's online workspace (ADR-047 as amended 2026-10-07, M6-06), on
 * the staff's project page: where the students work — chosen by an owner
 * of the course whose account has the workspace grant, until a workspace
 * was opened (the server says which modes the caller may set, and why not
 * the others: `allowed`, `refusal`) —, the last update the portal received
 * with a *Resync*, and the workspaces open now, live from the portal.
 *
 * Nothing at all when the feature is off: the route is then a 404, and so
 * is the section. A secondary surface: the page's primary action stays the
 * header's.
 */
export function ProjectWorkspace({ projectId, archived }: { projectId: string; archived: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const workspace = useQuery<Workspace>({
    queryKey: projectWorkspaceKey(projectId),
    queryFn: () => api(`/app/api/projects/${projectId}/workspace`),
    // The 404 of a platform without the portal is an answer, not a failure to retry.
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  const failed = (error: unknown) => toast(refusalMessage(error, t), "error");
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
    onError: failed,
  });
  const resync = useMutation({
    mutationFn: () =>
      api<ProjectWorkspaceSyncAccepted>(`/app/api/projects/${projectId}/workspace/sync`, { method: "POST" }),
    onSuccess: () => {
      toast(t("project.workspace.resynced"), "success");
      void qc.invalidateQueries({ queryKey: projectWorkspaceKey(projectId) });
    },
    onError: failed,
  });

  if (workspace.error instanceof ApiError && workspace.error.status === 404) return null;
  const heading = (
    <SectionHeading icon={Laptop} title={<span id="project-workspace">{t("project.workspace")}</span>} />
  );
  if (workspace.isLoading) {
    return (
      <section aria-labelledby="project-workspace" className="space-y-3">
        {heading}
        <Skeleton className="h-24 w-full" />
      </section>
    );
  }
  if (workspace.isError || !workspace.data) {
    return (
      <section aria-labelledby="project-workspace" className="space-y-3">
        {heading}
        <QueryError
          title={t("project.workspace")}
          error={workspace.error}
          onRetry={() => void workspace.refetch()}
          retrying={workspace.isFetching}
          fallback={t("error.server")}
        />
      </section>
    );
  }
  const ws = workspace.data;
  const changeable = !archived && ws.allowed.length > 1;
  const options = MODES.filter((m) => !changeable || ws.allowed.includes(m)).map((value) => ({
    value,
    label: t(`project.workspace.mode.${value}`),
  }));

  return (
    <section aria-labelledby="project-workspace" className="space-y-3" data-testid="project-workspace">
      {heading}
      <Card className="divide-y divide-line px-4">
        {/* Title and description above, the three long options below: they wrap on a phone instead of overflowing. */}
        <div className="space-y-2.5 py-3">
          <div>
            <p id="project-work-mode" className="text-sm font-medium text-fg">
              {t("project.workspace.mode")}
            </p>
            <p className="mt-0.5 text-[13px] text-fg-muted">{t(`project.workspace.mode.desc.${ws.mode}`)}</p>
            {ws.refusal && !archived ? (
              <p className="mt-1 text-[13px] text-fg-faint" data-testid="workspace-refusal">
                {t(`project.workspace.refusal.${ws.refusal}`)}
              </p>
            ) : null}
          </div>
          <Segmented
            name="workMode"
            labelledBy="project-work-mode"
            value={setMode.isPending && setMode.variables ? setMode.variables : ws.mode}
            disabled={!changeable || setMode.isPending}
            wrap
            onChange={(mode) => setMode.mutate(mode)}
            options={options}
          />
        </div>
        {ws.mode === "online" ? (
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
        ) : null}
      </Card>
      {ws.mode === "online" && ws.syncError ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("project.workspace.syncError")}>
          <span className="font-mono text-[12px]">{ws.syncError}</span>
        </Alert>
      ) : null}
      {ws.mode !== "free" ? <WorkspaceSessions projectId={projectId} /> : null}
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
      <QueryError
        title={t("project.workspace.sessions")}
        error={sessions.error}
        onRetry={() => void sessions.refetch()}
        retrying={sessions.isFetching}
        fallback={t("error.server")}
      />
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
          <thead className={T.head}>
            <tr>
              <th className={T.th}>{t("project.workspace.col.student")}</th>
              <th className={T.th}>{t("project.workspace.col.state")}</th>
              <th className={T.th}>{t("project.workspace.col.lastSeen")}</th>
              <th className={T.th}>{t("project.workspace.col.lastPush")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.sessionId} className={T.row}>
                <td className={`${T.td} font-semibold`}>
                  {s.user ? s.user.name : <span className="font-normal text-fg-muted">{s.email || t("project.workspace.unknownStudent")}</span>}
                </td>
                <td className={T.td}>
                  <Badge tone={STATE_TONE[s.state]}>{t(`project.workspace.state.${s.state}`)}</Badge>
                </td>
                <td className={`${T.td} whitespace-nowrap text-fg-muted`}>
                  <RelativeTime iso={s.lastSeenAt} />
                </td>
                <td className={`${T.td} whitespace-nowrap text-fg-muted`}>
                  {s.lastPushAt ? <RelativeTime iso={s.lastPushAt} /> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
