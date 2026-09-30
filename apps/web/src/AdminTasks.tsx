import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, Play } from "lucide-react";

import type {
  AdminScheduledTask,
  ScheduledTaskKey,
  ScheduledTaskPatch,
  ScheduledTaskStatus,
} from "@quiz/contracts";

import { api, apiErrorMessage } from "./api";
import { useT, type Dict } from "./i18n";
import { useToast } from "./notify";
import { adminTasksKey } from "./queryKeys";
import {
  Badge,
  Button,
  Card,
  cx,
  QueryError,
  RelativeTime,
  SectionHeading,
  Select,
  Skeleton,
  Switch,
  T,
  type IconType,
  type Tone,
} from "./ui";

/**
 * Every task's name and one line of what it does, in both languages
 * (invariant 1): `admin.task.<key>` and `admin.task.<key>.desc`. The
 * `satisfies` makes a key of the catalog without its two entries a compile
 * error.
 */
const taskName = (key: ScheduledTaskKey) => `admin.task.${key}` as const satisfies keyof Dict;
const taskDesc = (key: ScheduledTaskKey) => `admin.task.${key}.desc` as const satisfies keyof Dict;

const STATUS: Record<ScheduledTaskStatus | "never", { tone: Tone; label: keyof Dict; icon?: IconType }> = {
  ok: { tone: "green", label: "admin.tasks.status.ok" },
  error: { tone: "red", label: "admin.tasks.status.error" },
  running: { tone: "zinc", label: "admin.tasks.status.running", icon: Loader2 },
  never: { tone: "zinc", label: "admin.tasks.status.never" },
};

/** The periods offered, in minutes: a minute to a week (the contract's bounds). */
const PERIODS = [1, 5, 10, 15, 30, 60, 120, 360, 720, 1440, 10080];

/**
 * A finished run raises the `admin` hint, which refreshes this list; the
 * poll is only a fallback while a run is under way (a hint missed while the
 * stream reconnects).
 */
const RUNNING_POLL_MS = 5_000;

/**
 * The scheduled tasks (F-ADMIN-06, D10): the minutes-scale housekeeping of
 * the server — what it is, whether it is on, how often it runs, how its last
 * run went. The clock of the live evaluations is not here, and cannot be
 * switched off from anywhere.
 *
 * No primary action: pausing, re-perioding and "Run now" are row-level, the
 * page's primary action stays on the People tab.
 */
export function TasksSection() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();

  const tasks = useQuery<AdminScheduledTask[]>({
    queryKey: adminTasksKey,
    queryFn: () => api("/app/api/admin/tasks"),
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.lastStatus === "running") ? RUNNING_POLL_MS : false,
  });

  const replace = (row: AdminScheduledTask) =>
    qc.setQueryData<AdminScheduledTask[]>(adminTasksKey, (rows) =>
      rows?.map((r) => (r.key === row.key ? row : r)),
    );

  const configure = useMutation({
    mutationFn: ({ key, patch }: { key: ScheduledTaskKey; patch: ScheduledTaskPatch }) =>
      api<AdminScheduledTask>(`/app/api/admin/tasks/${key}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: replace,
    onError: (err) => toast(apiErrorMessage(err, t("error.save")), "error"),
  });

  const run = useMutation({
    mutationFn: (key: ScheduledTaskKey) =>
      api<AdminScheduledTask>(`/app/api/admin/tasks/${key}/run`, { method: "POST" }),
    onSuccess: (row) => {
      replace(row);
      const name = t(taskName(row.key));
      if (row.lastStatus === "error") toast(t("admin.tasks.runFailed", { name }), "error");
      else if (row.lastStatus === "running") toast(t("admin.tasks.started", { name }), "progress");
      else toast(t("admin.tasks.ran", { name }), "success");
    },
    onError: (err) => toast(apiErrorMessage(err, t("error.server")), "error"),
    onSettled: () => qc.invalidateQueries({ queryKey: adminTasksKey }),
  });

  const rows = tasks.data ?? [];

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={CalendarClock}
        title={t("admin.tasks")}
        count={tasks.data ? rows.length : undefined}
        description={t("admin.tasksHint")}
      />
      {tasks.isLoading ? (
        <Skeleton className="h-60 w-full" />
      ) : tasks.isError ? (
        <QueryError
          title={t("admin.tasks")}
          error={tasks.error}
          onRetry={() => void tasks.refetch()}
          retrying={tasks.isFetching}
          fallback={t("error.server")}
        />
      ) : (
        <Card className={cx("overflow-x-auto", T.container)}>
          <table className={cx(T.table, "min-w-160")}>
            <thead className={T.head}>
              <tr>
                <th className={T.th}>{t("admin.tasks.col.task")}</th>
                <th className={T.th}>{t("admin.tasks.col.enabled")}</th>
                <th className={T.th}>{t("admin.tasks.col.every")}</th>
                <th className={T.th}>{t("admin.tasks.col.lastRun")}</th>
                <th className={cx(T.th, T.colMid)}>{t("admin.tasks.col.nextRun")}</th>
                <th className={T.th}>
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const name = t(taskName(r.key));
                const status = STATUS[r.lastStatus ?? "never"];
                const periods = PERIODS.includes(r.intervalMinutes)
                  ? PERIODS
                  : [...PERIODS, r.intervalMinutes].sort((a, b) => a - b);
                const busy = configure.isPending && configure.variables?.key === r.key;
                return (
                  <tr key={r.key} className={T.row}>
                    <td className={cx(T.td, "min-w-44 max-w-80")}>
                      <div className="font-semibold">{name}</div>
                      <div className="text-xs text-fg-muted">{t(taskDesc(r.key))}</div>
                    </td>
                    <td className={T.td}>
                      <Switch
                        checked={r.enabled}
                        disabled={busy}
                        label={t("admin.tasks.enable", { name })}
                        onChange={(enabled) => configure.mutate({ key: r.key, patch: { enabled } })}
                      />
                    </td>
                    <td className={T.td}>
                      <Select
                        size="sm"
                        width="w-40"
                        aria-label={t("admin.tasks.period", { name })}
                        disabled={busy}
                        value={r.intervalMinutes}
                        onChange={(e) =>
                          configure.mutate({
                            key: r.key,
                            patch: { intervalMinutes: Number(e.target.value) },
                          })
                        }
                      >
                        {periods.map((m) => (
                          <option key={m} value={m}>
                            {m === r.defaultIntervalMinutes
                              ? t("admin.tasks.defaultPeriod", { period: period(t, m) })
                              : period(t, m)}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className={T.td}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Badge tone={status.tone} icon={status.icon}>{t(status.label)}</Badge>
                        {r.lastRunAt ? (
                          <span className="whitespace-nowrap text-xs text-fg-muted">
                            <RelativeTime iso={r.lastRunAt} />
                            {r.lastDurationMs !== null ? ` · ${duration(t, r.lastDurationMs)}` : null}
                          </span>
                        ) : null}
                      </div>
                      {r.lastMessage ? (
                        // Operator data, in English like a log line (F-ADMIN-06).
                        <div
                          lang="en"
                          title={r.lastMessage}
                          className={cx(
                            "mt-1 max-w-72 truncate font-mono text-xs",
                            r.lastStatus === "error" ? "text-danger" : "text-fg-muted",
                          )}
                        >
                          {r.lastMessage}
                        </div>
                      ) : null}
                      {r.lastStatus === "error" && r.lastOkAt ? (
                        <div className="mt-0.5 text-xs text-fg-faint">
                          {t("admin.tasks.lastOk")} <RelativeTime iso={r.lastOkAt} />
                        </div>
                      ) : null}
                    </td>
                    <td className={cx(T.td, T.colMid, "whitespace-nowrap text-fg-muted")}>
                      {!r.enabled ? (
                        t("admin.tasks.paused")
                      ) : r.nextRunAt ? (
                        <RelativeTime iso={r.nextRunAt} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={cx(T.td, "text-right")}>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={run.isPending && run.variables === r.key}
                        disabled={r.lastStatus === "running"}
                        aria-label={t("admin.tasks.runNamed", { name })}
                        onClick={() => run.mutate(r.key)}
                      >
                        {run.isPending && run.variables === r.key ? null : <Play />}
                        {t("admin.tasks.run")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

type Translate = ReturnType<typeof useT>;

/** 10 → "10 min", 360 → "6 h", 1440 → "1 d". */
function period(t: Translate, minutes: number): string {
  if (minutes % 1440 === 0) return t("admin.tasks.every.days", { n: minutes / 1440 });
  if (minutes % 60 === 0) return t("admin.tasks.every.hours", { n: minutes / 60 });
  return t("admin.tasks.every.minutes", { n: minutes });
}

/** 12 → "12 ms", 30004 → "30 s". */
function duration(t: Translate, ms: number): string {
  return ms < 1000 ? t("admin.tasks.ms", { n: ms }) : t("dur.s", { n: Math.round(ms / 1000) });
}
