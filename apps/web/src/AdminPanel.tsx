import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { useState } from "react";

import type { AdminTeacher } from "@quiz/contracts";

import { api, apiErrorMessage } from "./api";
import { useConfirm } from "./confirm";
import { useT } from "./i18n";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  QueryError,
  RelativeTime,
  SectionHeading,
  Skeleton,
  T,
  TableHead,
  useSortableTable,
  type Column,
} from "./ui";
import { adminTeachersKey } from "./queryKeys";

type SortKey = "email" | "name" | "lastLoginAt" | "courses" | "grantedAt";

/**
 * Administration: the teacher grants, and nothing else.
 *
 * A grant is an e-mail address, issued before or after that person ever
 * signs in — the role is recomputed server-side at every login, so this
 * screen never has to know whether the account exists.
 */
export function AdminPage() {
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
      api("/app/api/admin/teachers", { method: "POST", body: JSON.stringify({ email }) }),
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
    { key: "actions", label: t("common.actions"), sortable: false, srOnly: true },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t("admin.title")} />

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
            <p className="basis-full text-[13px] text-danger">
              {apiErrorMessage(grant.error, t("error.save"))}
            </p>
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
                        `${r.givenName ?? ""} ${r.familyName ?? ""}`.trim() || r.email
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
    </div>
  );
}
