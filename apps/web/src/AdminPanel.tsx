import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CalendarClock, Library, ShieldCheck, Sparkles, Tags, Trash2, UserPlus, Users } from "lucide-react";
import { useState } from "react";

import {
  MAX_ACTIVE_SESSIONS_LIMIT,
  TeacherCodespaceGrant,
  type AdminTeacher,
  type TeacherCodespaceGrantPatch,
  type TeacherGrantCreate,
} from "@quiz/contracts";

import { api, apiErrorMessage } from "./api";
import { useConfirm } from "./confirm";
import { useT } from "./i18n";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorText,
  Field,
  IconButton,
  inputClass,
  inputSize,
  PageHeader,
  PersonAvatar,
  QueryError,
  RelativeTime,
  SectionHeading,
  Skeleton,
  Switch,
  T,
  TabPanel,
  TableHead,
  Tabs,
  useSortableTable,
  type Column,
} from "./ui";
import { SystemSection } from "./AdminSystem";
import { TasksSection } from "./AdminTasks";
import { LlmSection } from "./AdminLlm";
import { KioskSection } from "./AdminKiosk";
import { UsersSection } from "./AdminUsers";
import { ConceptsSection } from "./concepts/ConceptsSection";
import { adminTeachersKey } from "./queryKeys";
import { ADMIN_TABS, useSearchParam, type AdminTab } from "./router";

type SortKey = "email" | "name" | "lastLoginAt" | "courses" | "grantedAt";

/** Given and family name; both empty until the grantee first signs in. */
const nameOf = (r: AdminTeacher): [string, string] => [r.givenName ?? "", r.familyName ?? ""];

/**
 * Administration, one tab per concern, the open one in `?tab=`: the people
 * (the teacher grants, the kiosk stations where the platform has them —
 * `KioskSection`, ADR-051 — then every account), the system status
 * (F-ADMIN-07, next to the tasks it points to) and the scheduled tasks
 * (F-ADMIN-06), the LLM gateway (ADR-058), and the sorting of the existing
 * tags into concepts (`ConceptsSection`, ADR-081). The people stay first and the default: the page's one
 * primary action, "Grant", is there. A tab is one entry of `ADMIN_TABS`
 * (`router.ts`) and one panel below.
 */
export function AdminPage() {
  const t = useT();
  const [tabParam, setTab] = useSearchParam("tab", "people");
  const tab: AdminTab = (ADMIN_TABS as readonly string[]).includes(tabParam) ? (tabParam as AdminTab) : "people";
  return (
    <div className="space-y-6">
      <PageHeader title={t("admin.title")} />
      <Tabs<AdminTab>
        value={tab}
        onChange={setTab}
        idPrefix="admin"
        items={[
          { value: "people", label: t("admin.tab.people"), icon: Users },
          { value: "system", label: t("admin.tab.system"), icon: Activity },
          { value: "tasks", label: t("admin.tab.tasks"), icon: CalendarClock },
          { value: "llm", label: t("admin.tab.llm"), icon: Sparkles },
          { value: "concepts", label: t("admin.tab.concepts"), icon: Tags },
        ]}
      />
      <TabPanel idPrefix="admin" value={tab} className="space-y-6">
        {tab === "people" ? (
          <>
            <TeachersSection />
            <KioskSection />
            <UsersSection />
          </>
        ) : tab === "system" ? (
          <SystemSection onOpenTasks={() => setTab("tasks")} />
        ) : tab === "tasks" ? (
          <TasksSection />
        ) : tab === "llm" ? (
          <LlmSection />
        ) : (
          <ConceptsSection />
        )}
      </TabPanel>
    </div>
  );
}

/**
 * The teacher grants: the page's one primary action, "Grant".
 *
 * A grant is an e-mail address, issued before or after that person ever
 * signs in — the role is recomputed server-side at every login, so this
 * screen never has to know whether the account exists.
 */
function TeachersSection() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [email, setEmail] = useState("");

  const teachers = useQuery<AdminTeacher[]>({
    queryKey: adminTeachersKey,
    queryFn: () => api("/app/api/admin/teachers"),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: adminTeachersKey });
  const grant = useMutation({
    mutationFn: () =>
      api("/app/api/admin/teachers", {
        method: "POST",
        body: JSON.stringify({ email } satisfies TeacherGrantCreate),
      }),
    onSuccess: () => {
      setEmail("");
      invalidate();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/app/api/admin/teachers/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const rows = teachers.data ?? [];
  // ADR-047 §5: the grant's column exists only where the platform has the online workspace.
  const workspace = rows.some((r) => r.codespace !== null);
  const { sorted, sort, toggle } = useSortableTable<AdminTeacher, SortKey>(
    rows,
    (r, k) =>
      k === "name" ? `${r.familyName ?? ""} ${r.givenName ?? ""}`.trim() || r.email : (r[k] ?? ""),
    { key: "name", dir: 1 },
    (x, y) =>
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), undefined, { sensitivity: "base" }),
  );

  const columns: Column<SortKey>[] = [
    { key: "name", label: t("admin.col.person") },
    { key: "email", label: t("admin.email") },
    { key: "courses", label: t("admin.col.courses") },
    { key: "lastLoginAt", label: t("admin.col.lastSignIn") },
    { key: "grantedAt", label: t("admin.col.granted") },
    ...(workspace ? [{ key: "workspace", label: t("admin.col.workspace"), sortable: false as const }] : []),
    { key: "actions", label: t("common.actions"), sortable: false, srOnly: true },
  ];

  return (
    <section className="space-y-3">
        <SectionHeading
          icon={ShieldCheck}
          title={t("admin.teachers")}
          count={rows.length}
          description={t("admin.teachersHint")}
        />

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            grant.mutate();
          }}
        >
          <Field
            label={t("admin.email")}
            type="email"
            required
            className="w-72"
            placeholder="prenom.nom@heig-vd.ch"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" loading={grant.isPending} disabled={email.trim() === ""}>
            <UserPlus /> {t("admin.grant")}
          </Button>
          {grant.isError ? (
            <ErrorText className="basis-full">
              {apiErrorMessage(grant.error, t("error.save"))}
            </ErrorText>
          ) : null}
        </form>

        {teachers.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : teachers.isError ? (
          <QueryError
            title={t("admin.teachers")}
            error={teachers.error}
            onRetry={() => void teachers.refetch()}
            retrying={teachers.isFetching}
            fallback={t("error.server")}
          />
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState icon={ShieldCheck} title={t("admin.empty.title")}>
              {t("admin.empty.body")}
            </EmptyState>
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className={cx(T.table, "min-w-180")}>
              <TableHead columns={columns} sort={sort} onToggle={toggle} />
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.id} className={cx(T.row, T.rowHover)}>
                    <td className={`${T.td} font-semibold`}>
                      {r.signedUp ? (
                        <span className="flex items-center gap-2.5">
                          <PersonAvatar name={nameOf(r)} src={r.avatarUrl} />
                          {nameOf(r).join(" ").trim() || r.email}
                        </span>
                      ) : (
                        <Badge tone="amber">{t("admin.pending")}</Badge>
                      )}
                    </td>
                    <td className={`${T.td} text-fg-muted`}>{r.email}</td>
                    <td className={`${T.td} tabular-nums`}>
                      <span className="inline-flex items-center gap-1.5 text-fg-muted">
                        <Library className="size-3.5" /> {r.courses}
                      </span>
                    </td>
                    <td className={`${T.td} whitespace-nowrap text-fg-muted`}>
                      {r.lastLoginAt ? <RelativeTime iso={r.lastLoginAt} /> : "—"}
                    </td>
                    <td className={`${T.td} whitespace-nowrap text-fg-muted`}>
                      <RelativeTime iso={r.grantedAt} />
                    </td>
                    {workspace ? (
                      <td className={T.td}>
                        {r.codespace ? <WorkspaceGrant id={r.id} email={r.email} grant={r.codespace} /> : "—"}
                      </td>
                    ) : null}
                    <td className={`${T.td} text-right`}>
                      <IconButton
                        label={t("admin.revoke")}
                        danger
                        disabled={revoke.isPending}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: t("admin.revokeConfirm", { email: r.email }),
                              confirmLabel: t("admin.revoke"),
                              cancelLabel: t("common.cancel"),
                              danger: true,
                            })
                          ) {
                            revoke.mutate(r.id);
                          }
                        }}
                      >
                        <Trash2 />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
    </section>
  );
}

/**
 * A teacher's online workspace grant (ADR-047 §4, amended 2026-10-07): the
 * switch, and how many of the workspaces they carry may run at once —
 * written on change, the number when the field is left.
 */
function WorkspaceGrant({ id, email, grant }: { id: string; email: string; grant: TeacherCodespaceGrant }) {
  const t = useT();
  const qc = useQueryClient();
  const [quota, setQuota] = useState(String(grant.maxActiveSessions));
  const save = useMutation({
    mutationFn: (body: TeacherCodespaceGrantPatch) =>
      api<TeacherCodespaceGrant>(`/app/api/admin/teachers/${id}/codespace`, { method: "PATCH", body: JSON.stringify(body) }),
    onSettled: () => qc.invalidateQueries({ queryKey: adminTeachersKey }),
  });
  const commitQuota = () => {
    // The contract's own bounds (`TeacherCodespaceGrant`): anything else goes back to the saved value.
    const n = TeacherCodespaceGrant.shape.maxActiveSessions.safeParse(quota.trim() === "" ? NaN : Number(quota));
    if (!n.success) {
      setQuota(String(grant.maxActiveSessions));
      return;
    }
    if (n.data !== grant.maxActiveSessions) save.mutate({ maxActiveSessions: n.data });
  };
  return (
    <span className="flex items-center gap-3">
      <Switch
        checked={grant.enabled}
        disabled={save.isPending}
        label={t("admin.workspace.enable", { email })}
        onChange={(enabled) => save.mutate({ enabled })}
      />
      <input
        type="number"
        min={0}
        max={MAX_ACTIVE_SESSIONS_LIMIT}
        inputMode="numeric"
        aria-label={t("admin.workspace.quota", { email })}
        title={t("admin.workspace.quotaHint")}
        className={cx(inputClass, inputSize.sm, "w-16 text-right tabular-nums")}
        value={quota}
        disabled={save.isPending}
        onChange={(e) => setQuota(e.target.value)}
        onBlur={commitQuota}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitQuota();
        }}
      />
    </span>
  );
}
