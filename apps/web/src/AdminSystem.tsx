import { useQuery } from "@tanstack/react-query";
import { useRef, type ReactNode } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Database,
  GitCommitHorizontal,
  Radio,
  RefreshCw,
} from "lucide-react";

import type {
  CheckCause,
  CheckDetail,
  CheckStatus,
  CheckValue,
  DetailMeaning,
  ScheduledTaskKey,
  SystemCheck,
  SystemCheckKey,
  SystemSection,
  SystemStatus,
  SystemStatusQuery,
} from "@quiz/contracts";

import { api } from "./api";
import { formatBytes, formatDecimal, formatMs, useI18n, useT, type Dict } from "./i18n";
import { adminSystemKey } from "./queryKeys";
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
  Skeleton,
  type IconType,
  type Tone,
} from "./ui";

/**
 * Every check's name, every cause's sentence and every detail's meaning, in
 * both languages (invariant 1). The `satisfies` makes a key of the
 * registry, a cause or a meaning without its entries a compile error.
 */
const checkName = (key: SystemCheckKey) => `admin.system.check.${key}` as const satisfies keyof Dict;
const causeText = (cause: CheckCause) => `admin.system.cause.${cause}` as const satisfies keyof Dict;
const meaningText = (m: DetailMeaning) => `admin.system.detail.${m}` as const satisfies keyof Dict;
const taskName = (key: ScheduledTaskKey) => `admin.task.${key}` as const satisfies keyof Dict;

const STATUS: Record<CheckStatus, { tone: Tone; label: keyof Dict; icon: IconType }> = {
  ok: { tone: "green", label: "admin.system.status.ok", icon: CircleCheck },
  warn: { tone: "amber", label: "admin.system.status.warn", icon: CircleAlert },
  fail: { tone: "red", label: "admin.system.status.fail", icon: CircleX },
  unknown: { tone: "zinc", label: "admin.system.status.unknown", icon: CircleHelp },
};

const SECTIONS: { key: SystemSection; icon: IconType; title: keyof Dict }[] = [
  { key: "live", icon: Radio, title: "admin.system.section.live" },
  { key: "storage", icon: Database, title: "admin.system.section.storage" },
];

/**
 * What a row adds beyond its check, per check: a standing note, and a link
 * shown while the check is not OK. The one place a row differs by its key.
 */
type Extra = { note?: keyof Dict; link?: { label: keyof Dict; open: "tasks" } };
const EXTRAS: Partial<Record<SystemCheckKey, Extra>> = {
  // Open question 10 (docs/spec/06) stays open: the page says so.
  backup: { note: "admin.system.backupNote" },
  tasks: { link: { label: "admin.system.openTasks", open: "tasks" } },
};

/**
 * The server caches the status for 20 s; polling at 30 s while the tab is
 * visible keeps it current without a storm (TanStack pauses the interval in
 * a background tab).
 */
const POLL_MS = 30_000;

/**
 * The system status (N-OPS-03, F-ADMIN-07, ADR-055): ONE question — can an
 * exam run now, and does anything need me? A summary line, then the checks
 * as compact rows (status, name, value, cause), then what is deployed. No
 * chart, no log: a check says how bad things are, never who.
 *
 * No primary action: "Refresh" is secondary; the page's primary action
 * stays on the People tab.
 */
export function SystemSection({ onOpenTasks }: { onOpenTasks: () => void }) {
  const t = useT();
  const fresh = useRef(false);
  const status = useQuery<SystemStatus>({
    queryKey: adminSystemKey,
    queryFn: () => {
      const query: SystemStatusQuery = fresh.current ? { fresh: "1" } : {};
      fresh.current = false;
      return api(`/app/api/admin/system${query.fresh ? "?fresh=1" : ""}`);
    },
    refetchInterval: POLL_MS,
  });

  if (status.isLoading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (status.isError || !status.data) {
    return (
      <QueryError
        title={t("admin.tab.system")}
        error={status.error}
        onRetry={() => void status.refetch()}
        retrying={status.isFetching}
        fallback={t("error.server")}
      />
    );
  }

  const refresh = (
    <Button
      variant="secondary"
      size="sm"
      loading={status.isFetching}
      onClick={() => {
        fresh.current = true;
        void status.refetch();
      }}
    >
      {status.isFetching ? null : <RefreshCw />}
      {t("admin.system.refresh")}
    </Button>
  );
  const { checks, deployment, checkedAt } = status.data;
  const open = { tasks: onOpenTasks };
  return (
    <div className="space-y-8">
      <Summary checks={checks} checkedAt={checkedAt} action={refresh} />
      {SECTIONS.map((section) => (
        <section key={section.key} className="space-y-3">
          <SectionHeading icon={section.icon} title={t(section.title)} />
          <Card>
            <ul className="divide-y divide-line">
              {checks
                .filter((c) => c.section === section.key)
                .map((c) => (
                  <CheckRow key={c.key} check={c} open={open} />
                ))}
            </ul>
          </Card>
        </section>
      ))}
      <Deployment deployment={deployment} />
    </div>
  );
}

/** The answer in one line: ready, or how many checks need a look. */
function Summary({
  checks,
  checkedAt,
  action,
}: {
  checks: SystemCheck[];
  checkedAt: string;
  action: ReactNode;
}) {
  const t = useT();
  const failing = checks.filter((c) => c.status === "fail").length;
  const attention = failing + checks.filter((c) => c.status === "warn").length;
  const unknown = checks.filter((c) => c.status === "unknown").length;
  const tone = failing > 0 ? "danger" : attention > 0 ? "warning" : "success";
  const icon = failing > 0 ? CircleX : attention > 0 ? CircleAlert : CircleCheck;
  const title =
    attention === 0
      ? t("admin.system.ready")
      : attention === 1
        ? t("admin.system.attention.one")
        : t("admin.system.attention.other", { n: attention });
  return (
    <Alert tone={tone} icon={icon} title={title} action={action}>
      <span>
        {t("admin.system.checked")} <RelativeTime iso={checkedAt} />
        {unknown > 0
          ? ` · ${unknown === 1 ? t("admin.system.unknown.one") : t("admin.system.unknown.other", { n: unknown })}`
          : null}
      </span>
    </Alert>
  );
}

function CheckRow({ check, open }: { check: SystemCheck; open: Record<"tasks", () => void> }) {
  const t = useT();
  const s = STATUS[check.status];
  const extra = EXTRAS[check.key] ?? {};
  return (
    // On a phone the badge takes a line of its own: a column for it would
    // leave the name and its cause a third of the width.
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto]">
      <Badge tone={s.tone} icon={s.icon} className="col-span-2 mt-px justify-self-start sm:col-span-1">
        {t(s.label)}
      </Badge>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{t(checkName(check.key))}</p>
        {check.cause ? (
          <p className={cx("text-[13px]", check.status === "fail" ? "text-danger" : "text-fg-muted")}>
            {t(causeText(check.cause))}
          </p>
        ) : null}
        {check.failingSince ? (
          // The `health.checks` task's record (ADR-055 §5): how long, not just now.
          <p className="text-xs text-danger">
            {t("admin.system.failingSince")} <RelativeTime iso={check.failingSince} />
          </p>
        ) : null}
        {extra.note ? <p className="text-xs text-fg-faint">{t(extra.note)}</p> : null}
        {check.details.length > 0 ? (
          <ul className="space-y-0.5 pt-0.5">
            {check.details.map((d, i) => (
              <DetailLine key={i} detail={d} />
            ))}
          </ul>
        ) : null}
        {extra.link && check.status !== "ok" ? (
          <Button variant="ghost" size="sm" className="-ml-2" onClick={open[extra.link.open]}>
            {t(extra.link.label)}
          </Button>
        ) : null}
      </div>
      <div className="text-right">
        <p className="whitespace-nowrap text-[13px] font-semibold tabular-nums">
          {check.value ? <Value value={check.value} /> : "—"}
        </p>
        <p className="whitespace-nowrap text-xs text-fg-faint">
          <RelativeTime iso={check.checkedAt} />
        </p>
      </div>
    </li>
  );
}

/** One line under a check: its subject, why it is listed, its values. */
function DetailLine({ detail }: { detail: CheckDetail }) {
  const t = useT();
  const format = useFormat();
  const { subject } = detail;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-xs text-fg-muted">
      {subject.kind === "task" ? (
        <span className="font-medium text-fg">{t(taskName(subject.key))}</span>
      ) : (
        // Operator data (a table, a queue, a path, a dump), shown as is.
        <span lang="en" className="font-mono text-fg">
          {subject.name}
        </span>
      )}
      {detail.cause ? <span>{t(causeText(detail.cause))}</span> : null}
      {detail.values.map(({ meaning, value }, i) => (
        <span key={i} className="tabular-nums">
          {meaning ? t(meaningText(meaning), { v: format(value) }) : <Value value={value} />}
        </span>
      ))}
    </li>
  );
}

/** A value as the reader reads it: an instant as a distance, the rest as text. */
function Value({ value }: { value: CheckValue }) {
  const format = useFormat();
  return value.kind === "at" ? <RelativeTime iso={value.iso} /> : <>{format(value)}</>;
}

/** A measured value in the interface language, through the shared formatters. */
function useFormat(): (value: CheckValue) => string {
  const t = useT();
  const { locale } = useI18n();
  return (value) => {
    switch (value.kind) {
      case "count":
        return formatDecimal(value.n, 0, locale);
      case "duration":
        return formatMs(value.ms, t);
      case "bytes":
        return formatBytes(value.n, locale);
      case "share":
        return value.bytes
          ? t("admin.system.share.free", {
              part: formatBytes(value.part, locale),
              total: formatBytes(value.total, locale),
            })
          : t("admin.system.share.used", {
              part: formatDecimal(value.part, 0, locale),
              total: formatDecimal(value.total, 0, locale),
            });
      case "at":
        return isoDateTime(value.iso);
    }
  };
}

/** What runs: the commit, the schema, the process. */
function Deployment({ deployment: d }: { deployment: SystemStatus["deployment"] }) {
  const t = useT();
  const mono = (text: string) => <span className="font-mono">{text}</span>;
  const rows: [keyof Dict, ReactNode][] = [
    [
      "admin.system.deploy.commit",
      d.commitSha ? (
        <span className="flex flex-wrap items-baseline gap-x-2">
          {mono(d.commitSha.slice(0, 7))}
          {d.commitDate ? <span className="text-fg-muted">{isoDateTime(d.commitDate)}</span> : null}
        </span>
      ) : (
        "—"
      ),
    ],
    ["admin.system.deploy.migration", d.migration ? mono(d.migration) : "—"],
    ["admin.system.deploy.started", <RelativeTime iso={d.startedAt} />],
    ["admin.system.deploy.environment", mono(`${d.host} · ${d.nodeEnv}`)],
    ["admin.system.deploy.role", mono(d.workerMode)],
    ["admin.system.deploy.node", mono(d.node)],
  ];
  return (
    <section className="space-y-3">
      <SectionHeading icon={GitCommitHorizontal} title={t("admin.system.section.deployment")} />
      <Card>
        <dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-sm sm:grid-cols-[max-content_1fr]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-fg-muted">{t(label)}</dt>
              <dd className="-mt-2 min-w-0 wrap-break-word sm:mt-0">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </section>
  );
}
