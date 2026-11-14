import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserX, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { adminPseudonymizePath, type AdminUser } from "@quiz/contracts";

import { PSEUDONYMIZE_REFUSAL_WORDS } from "./AccountAnonymize";
import { api, useMe, wordedRefusal } from "./api";
import { useConfirm } from "./confirm";
import { useT } from "./i18n";
import { useToast } from "./notify";
import { adminUsersKey } from "./queryKeys";
import {
  Badge,
  Button,
  Card,
  caseInsensitiveCompare,
  cx,
  EmptyState,
  isoDateTime,
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

type SortKey = "name" | "role" | "lastActivityAt" | "createdAt" | "pools" | "questions" | "classrooms";
type InactiveSortKey = "name" | "role" | "lastActivityAt" | "dormantSince";

/**
 * "Teachers" means everyone who reaches the teacher interface, admins
 * included. "Inactive" is the accounts a year or more without activity
 * (ADR-117 §6), staff included, with the lifecycle's columns.
 */
type RoleFilter = "all" | "teachers" | "students" | "inactive";

/** Rows drawn before "Show all": a few hundred students stay one click away, not one scroll. */
const FIRST_ROWS = 50;

const ROLE_TONE: Record<AdminUser["role"], Tone> = {
  admin: "accent",
  teacher: "green",
  student: "zinc",
};

const ROLE_RANK: Record<AdminUser["role"], number> = { admin: 0, teacher: 1, student: 2 };

const displayName = (u: AdminUser) => `${u.givenName} ${u.familyName}`.trim();

/** The sort value of the columns both tables share. */
const shared = (u: AdminUser, k: "name" | "role") =>
  k === "name" ? `${u.familyName} ${u.givenName}`.trim() || u.email : ROLE_RANK[u.role];

function Person({ u }: { u: AdminUser }) {
  return (
    <div className="flex items-center gap-2.5">
      <PersonAvatar name={[u.givenName, u.familyName]} src={u.avatarUrl} />
      <div className="min-w-0">
        <div className="font-semibold">{displayName(u) || u.email}</div>
        {displayName(u) ? <div className="text-xs text-fg-muted">{u.email}</div> : null}
      </div>
    </div>
  );
}

function RoleCell({ u, className }: { u: AdminUser; className?: string }) {
  const t = useT();
  return (
    <td className={cx(T.td, className, "whitespace-nowrap")}>
      <Badge tone={ROLE_TONE[u.role]}>{t(`settings.role.${u.role}` as "settings.role.student")}</Badge>
      {u.reason ? (
        <span className="ml-2 text-xs text-fg-muted">{t(`admin.reason.${u.reason}` as "admin.reason.grant")}</span>
      ) : null}
    </td>
  );
}

/**
 * The one act on an account (ADR-117 §6): any account, student or staff,
 * one at a time, only while Super Powers are on (ADR-054; the column is not
 * drawn otherwise), behind a typed confirmation (the account's address).
 * Every refusal is worded (`PSEUDONYMIZE_REFUSAL_WORDS`).
 */
function useAnonymize() {
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const anonymize = useMutation({
    mutationFn: (id: string) => api(adminPseudonymizePath(id), { method: "POST" }),
    onSuccess: () => {
      toast(t("admin.inactive.done"), "success");
      void qc.invalidateQueries({ queryKey: adminUsersKey });
    },
    onError: (error) => toast(wordedRefusal(error, PSEUDONYMIZE_REFUSAL_WORDS, t), "error"),
  });
  const ask = async (u: AdminUser) => {
    const ok = await confirm({
      title: t("admin.inactive.confirmTitle", { name: displayName(u) || u.email }),
      message: t("admin.inactive.confirmBody"),
      typeToConfirm: u.email,
      confirmLabel: t("account.anonymize.confirm"),
      danger: true,
    });
    if (ok) anonymize.mutate(u.id);
  };
  return { ask, pending: (id: string) => anonymize.isPending && anonymize.variables === id };
}

type Anonymize = ReturnType<typeof useAnonymize>;

function anonymizeColumn<K extends string>(t: ReturnType<typeof useT>): Column<K> {
  return { key: "actions", label: t("common.actions"), sortable: false, srOnly: true, className: T.stickyEnd };
}

function AnonymizeCell({ u, anonymize }: { u: AdminUser; anonymize: Anonymize }) {
  const t = useT();
  return (
    <td className={cx(T.td, T.stickyEnd, "text-right")}>
      <Button
        variant="danger-quiet"
        size="sm"
        aria-label={t("admin.inactive.anonymizeLabel", { name: displayName(u) || u.email })}
        loading={anonymize.pending(u.id)}
        onClick={() => void anonymize.ask(u)}
      >
        {/* The icon alone on a phone: the row's name and dates need the width. */}
        <UserX /> <span className="max-sm:sr-only">{t("admin.inactive.anonymize")}</span>
      </Button>
    </td>
  );
}

/** The first {@link FIRST_ROWS} rows, and the footer that draws the rest. */
function useFirstRows<R>(rows: readonly R[]) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  return { shown, footer: <ShowAllFooter hidden={rows.length - shown.length} total={rows.length} onShow={() => setAll(true)} /> };
}

function ShowAllFooter({ hidden, total, onShow }: { hidden: number; total: number; onShow: () => void }) {
  const t = useT();
  if (hidden <= 0) return null;
  return (
    <div className="border-t border-line px-3 py-2">
      <Button variant="ghost" size="sm" onClick={onShow}>
        {t("common.showAll", { n: total })}
      </Button>
    </div>
  );
}

/**
 * Every account on the platform (F-ADMIN-01): who they are, their role and
 * why they hold it, when they were last there (ADR-107: here only, never on
 * a roster), and what they teach with. With Super Powers on, each row
 * carries the one act on an account, "Anonymize…" (ADR-117 §6); the
 * "Inactive" filter is where the accounts to review are found, with the
 * lifecycle's columns. The screen's primary action stays "Grant", above.
 * The server sends the whole list in one response (a few hundred rows);
 * searching, filtering and sorting happen here.
 */
export function UsersSection() {
  const t = useT();
  const me = useMe();
  const superPowers = me.data?.session?.superPowersUntil != null;
  const anonymize = useAnonymize();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RoleFilter>("all");

  const users = useQuery<AdminUser[]>({
    queryKey: adminUsersKey,
    queryFn: () => api("/app/api/admin/users"),
  });

  const all = users.data ?? [];
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter(
      (u) =>
        (filter === "all" ||
          (filter === "inactive" ? u.inactive : (filter === "students") === (u.role === "student"))) &&
        (needle === "" ||
          displayName(u).toLowerCase().includes(needle) ||
          u.email.toLowerCase().includes(needle)),
    );
  }, [all, query, filter]);
  const action = superPowers ? anonymize : null;

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Users}
        title={t("admin.users")}
        count={all.length}
        description={filter === "inactive" ? t("admin.inactive.desc") : t("admin.usersHint")}
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
          label={t("admin.col.role")}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("admin.users.filter.all") },
            { value: "teachers", label: t("admin.users.filter.teachers") },
            { value: "students", label: t("admin.users.filter.students") },
            { value: "inactive", label: t("admin.users.filter.inactive") },
          ]}
        />
      </div>
      {filter === "inactive" && !superPowers ? (
        <p className="text-sm text-fg-muted">{t("admin.inactive.superPowers")}</p>
      ) : null}

      {users.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : users.isError ? (
        <QueryError title={t("admin.users")} query={users} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={
              all.length === 0
                ? t("admin.users.none")
                : filter === "inactive" && query.trim() === ""
                  ? t("admin.inactive.none")
                  : t("admin.users.noMatch")
            }
          />
        </Card>
      ) : filter === "inactive" ? (
        <InactiveTable rows={rows} anonymize={action} />
      ) : (
        <AllTable rows={rows} anonymize={action} />
      )}
    </section>
  );
}

function AllTable({ rows, anonymize }: { rows: AdminUser[]; anonymize: Anonymize | null }) {
  const t = useT();
  const { sorted, sort, toggle } = useSortableTable<AdminUser, SortKey>(
    rows,
    (u, k) => (k === "name" || k === "role" ? shared(u, k) : u[k]),
    // Staff first: the few rows an admin comes for, above the hundreds of
    // students; ties keep the server's order, by family name.
    { key: "role", dir: 1 },
    caseInsensitiveCompare,
  );
  const { shown, footer } = useFirstRows(sorted);

  const columns: Column<SortKey>[] = [
    { key: "name", label: t("admin.col.person") },
    { key: "role", label: t("admin.col.role") },
    // The last activity as the lifecycle reads it (ADR-107, ADR-117 §2): the
    // last request, sign-in or token use, the creation when none; the
    // sign-in itself in the cell's tooltip.
    { key: "lastActivityAt", label: t("admin.col.lastActivity"), className: T.colHigh },
    { key: "createdAt", label: t("admin.col.created"), className: T.colLow },
    { key: "pools", label: t("admin.col.pools"), right: true, className: T.colMid },
    { key: "questions", label: t("admin.col.questions"), right: true, className: T.colMid },
    { key: "classrooms", label: t("admin.col.classrooms"), right: true, className: T.colMid },
    ...(anonymize ? [anonymizeColumn<SortKey>(t)] : []),
  ];

  /** A student's footprint is not a zero, it is not a thing. */
  const count = (u: AdminUser, n: number) => (u.role === "student" ? "—" : n);

  return (
    <Card className={cx("overflow-x-auto", T.container)}>
      <table className={T.table}>
        <TableHead columns={columns} sort={sort} onToggle={toggle} />
        <tbody>
          {shown.map((u) => (
            <tr key={u.id} className={cx(T.row, T.rowHover)}>
              <td className={T.td}>
                <Person u={u} />
              </td>
              <RoleCell u={u} />
              <td
                className={cx(T.td, T.colHigh, "whitespace-nowrap text-fg-muted")}
                title={u.lastLoginAt ? t("admin.signedIn", { when: isoDateTime(u.lastLoginAt) }) : undefined}
              >
                <RelativeTime iso={u.lastActivityAt} />
              </td>
              <td className={cx(T.td, T.colLow, "whitespace-nowrap text-fg-muted")}>
                <RelativeTime iso={u.createdAt} />
              </td>
              <td className={cx(T.td, T.colMid, "text-right tabular-nums")}>{count(u, u.pools)}</td>
              <td className={cx(T.td, T.colMid, "text-right tabular-nums")}>{count(u, u.questions)}</td>
              <td className={cx(T.td, T.colMid, "text-right tabular-nums")}>{count(u, u.classrooms)}</td>
              {anonymize ? <AnonymizeCell u={u} anonymize={anonymize} /> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </Card>
  );
}

/**
 * The accounts a year or more without activity (ADR-117 §6), the longest
 * away first: when they were last there, since when the lifecycle's notice
 * made them dormant, and a `due` badge past the term.
 */
function InactiveTable({ rows, anonymize }: { rows: AdminUser[]; anonymize: Anonymize | null }) {
  const t = useT();
  const { sorted, sort, toggle } = useSortableTable<AdminUser, InactiveSortKey>(
    rows,
    (u, k) => (k === "name" || k === "role" ? shared(u, k) : (u[k] ?? "")),
    { key: "lastActivityAt", dir: 1 },
    caseInsensitiveCompare,
  );
  const { shown, footer } = useFirstRows(sorted);
  const columns: Column<InactiveSortKey>[] = [
    { key: "name", label: t("admin.col.person") },
    { key: "role", label: t("admin.col.role"), className: T.colMid },
    { key: "lastActivityAt", label: t("admin.col.lastActivity") },
    { key: "dormantSince", label: t("admin.inactive.col.dormant"), className: T.colMid },
    ...(anonymize ? [anonymizeColumn<InactiveSortKey>(t)] : []),
  ];

  return (
    <Card className={cx("overflow-x-auto", T.container)}>
      <table className={T.table}>
        <TableHead columns={columns} sort={sort} onToggle={toggle} />
        <tbody>
          {shown.map((u) => (
            <tr key={u.id} className={cx(T.row, T.rowHover)}>
              <td className={T.td}>
                <Person u={u} />
              </td>
              <RoleCell u={u} className={T.colMid} />
              <td className={cx(T.td, "whitespace-nowrap text-fg-muted")}>
                <RelativeTime iso={u.lastActivityAt} />
              </td>
              <td className={cx(T.td, T.colMid, "whitespace-nowrap text-fg-muted")}>
                {u.dormantSince ? <RelativeTime iso={u.dormantSince} /> : "—"}
                {u.due ? (
                  <span className="ml-2" title={t("admin.inactive.dueHint")}>
                    <Badge tone="amber">{t("admin.inactive.due")}</Badge>
                  </span>
                ) : null}
              </td>
              {anonymize ? <AnonymizeCell u={u} anonymize={anonymize} /> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </Card>
  );
}
