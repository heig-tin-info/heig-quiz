import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useMemo, useState } from "react";

import type { AdminUser } from "@quiz/contracts";

import { api } from "./api";
import { useT } from "./i18n";
import { adminUsersKey } from "./queryKeys";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  PersonAvatar,
  QueryError,
  RelativeTime,
  SearchInput,
  SectionHeading,
  Segmented,
  Skeleton,
  T,
  TableHead,
  useSortableTable,
  type Column,
  type Tone,
} from "./ui";

type SortKey = "name" | "role" | "lastLoginAt" | "createdAt" | "pools" | "questions" | "classrooms";

/** "Teachers" means everyone who reaches the teacher interface, admins included. */
type RoleFilter = "all" | "teachers" | "students";

/** Rows drawn before "Show all": a few hundred students stay one click away, not one scroll. */
const FIRST_ROWS = 50;

const ROLE_TONE: Record<AdminUser["role"], Tone> = {
  admin: "accent",
  teacher: "green",
  student: "zinc",
};

const ROLE_RANK: Record<AdminUser["role"], number> = { admin: 0, teacher: 1, student: 2 };

const displayName = (u: AdminUser) => `${u.givenName} ${u.familyName}`.trim();

/**
 * Every account on the platform (F-ADMIN-01): who they are, their role and
 * why they hold it, when they last signed in, and what they teach with.
 *
 * Read-only: the screen's one action stays "Grant", above. The server sends
 * the whole list in one response (a few hundred rows); searching, filtering
 * and sorting happen here.
 */
export function UsersSection() {
  const t = useT();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RoleFilter>("all");
  const [showAll, setShowAll] = useState(false);

  const users = useQuery<AdminUser[]>({
    queryKey: adminUsersKey,
    queryFn: () => api("/app/api/admin/users"),
  });

  const all = users.data ?? [];
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter(
      (u) =>
        (filter === "all" || (filter === "students") === (u.role === "student")) &&
        (needle === "" ||
          displayName(u).toLowerCase().includes(needle) ||
          u.email.toLowerCase().includes(needle)),
    );
  }, [all, query, filter]);

  const { sorted, sort, toggle } = useSortableTable<AdminUser, SortKey>(
    rows,
    (u, k) =>
      k === "name"
        ? `${u.familyName} ${u.givenName}`.trim() || u.email
        : k === "role"
          ? ROLE_RANK[u.role]
          : (u[k] ?? ""),
    // Staff first: the few rows an admin comes for, above the hundreds of
    // students; ties keep the server's order, by family name.
    { key: "role", dir: 1 },
    (x, y) =>
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), undefined, { sensitivity: "base" }),
  );
  const shown = showAll ? sorted : sorted.slice(0, FIRST_ROWS);

  const columns: Column<SortKey>[] = [
    { key: "name", label: t("admin.col.person") },
    { key: "role", label: t("admin.col.role") },
    { key: "lastLoginAt", label: t("admin.col.lastSignIn"), className: T.colHigh },
    { key: "createdAt", label: t("admin.col.created"), className: T.colLow },
    { key: "pools", label: t("admin.col.pools"), right: true, className: T.colMid },
    { key: "questions", label: t("admin.col.questions"), right: true, className: T.colMid },
    { key: "classrooms", label: t("admin.col.classrooms"), right: true, className: T.colMid },
  ];

  /** A student's footprint is not a zero, it is not a thing. */
  const count = (u: AdminUser, n: number) => (u.role === "student" ? "—" : n);

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Users}
        title={t("admin.users")}
        count={all.length}
        description={t("admin.usersHint")}
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          className="w-72"
          aria-label={t("admin.users.search")}
          placeholder={t("admin.users.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Segmented
          name="admin-users-role"
          size="sm"
          label={t("admin.col.role")}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("admin.users.filter.all") },
            { value: "teachers", label: t("admin.users.filter.teachers") },
            { value: "students", label: t("admin.users.filter.students") },
          ]}
        />
      </div>

      {users.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : users.isError ? (
        <QueryError
          title={t("admin.users")}
          error={users.error}
          onRetry={() => void users.refetch()}
          retrying={users.isFetching}
          fallback={t("error.server")}
        />
      ) : sorted.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={all.length === 0 ? t("admin.users.none") : t("admin.users.noMatch")}
          />
        </Card>
      ) : (
        <Card className={cx("overflow-x-auto", T.container)}>
          <table className={T.table}>
            <TableHead columns={columns} sort={sort} onToggle={toggle} />
            <tbody>
              {shown.map((u) => (
                <tr key={u.id} className={cx(T.row, T.rowHover)}>
                  <td className={T.td}>
                    <div className="flex items-center gap-2.5">
                      <PersonAvatar name={[u.givenName, u.familyName]} src={u.avatarUrl} />
                      <div className="min-w-0">
                        <div className="font-semibold">{displayName(u) || u.email}</div>
                        {displayName(u) ? (
                          <div className="text-xs text-fg-muted">{u.email}</div>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className={`${T.td} whitespace-nowrap`}>
                    <Badge tone={ROLE_TONE[u.role]}>
                      {t(`settings.role.${u.role}` as "settings.role.student")}
                    </Badge>
                    {u.reason ? (
                      <span className="ml-2 text-xs text-fg-muted">
                        {t(`admin.reason.${u.reason}` as "admin.reason.grant")}
                      </span>
                    ) : null}
                  </td>
                  <td className={cx(T.td, T.colHigh, "whitespace-nowrap text-fg-muted")}>
                    {u.lastLoginAt ? <RelativeTime iso={u.lastLoginAt} /> : t("admin.never")}
                  </td>
                  <td className={cx(T.td, T.colLow, "whitespace-nowrap text-fg-muted")}>
                    <RelativeTime iso={u.createdAt} />
                  </td>
                  <td className={cx(T.td, T.colMid, "text-right tabular-nums")}>
                    {count(u, u.pools)}
                  </td>
                  <td className={cx(T.td, T.colMid, "text-right tabular-nums")}>
                    {count(u, u.questions)}
                  </td>
                  <td className={cx(T.td, T.colMid, "text-right tabular-nums")}>
                    {count(u, u.classrooms)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length < sorted.length ? (
            <div className="border-t border-line px-3 py-2">
              <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                {t("common.showAll", { n: sorted.length })}
              </Button>
            </div>
          ) : null}
        </Card>
      )}
    </section>
  );
}
