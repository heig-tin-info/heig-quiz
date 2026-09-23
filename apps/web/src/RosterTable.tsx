import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  GraduationCap,
  Loader2,
  Pencil,
  Trash2,
  UserRoundX,
  X,
} from "lucide-react";
import { Fragment, useState } from "react";

import type { RosterEntry } from "@quiz/contracts";

import { api, ApiError, apiErrorMessage } from "./api";
import { useConfirm } from "./confirm";
import { useT } from "./i18n";
import {
  Badge,
  cx,
  IconButton,
  Initials,
  inputClass,
  inputSize,
  Menu,
  RelativeTime,
  SortHeader,
  T,
  useSortableTable,
} from "./ui";
import { classroomKey } from "./queryKeys";

function StudentAvatar({ entry }: { entry: RosterEntry }) {
  const [failed, setFailed] = useState(false);
  if (entry.avatarUrl && !failed) {
    return (
      <img
        src={entry.avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="size-7 shrink-0 rounded-full object-cover"
      />
    );
  }
  return <Initials name={[entry.prenom, entry.nom]} />;
}

function Row({ classroomId, entry }: { classroomId: string; entry: RosterEntry }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    nom: entry.nom,
    prenom: entry.prenom,
    email: entry.email,
    timeBonusPercent: String(entry.timeBonusPercent),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: classroomKey(classroomId) });
  const base = `/app/api/classrooms/${classroomId}/roster/${entry.id}`;
  const fullName = `${entry.prenom} ${entry.nom}`;

  const save = useMutation({
    mutationFn: () =>
      api(base, {
        method: "PATCH",
        body: JSON.stringify({
          nom: form.nom,
          prenom: form.prenom,
          email: form.email,
          timeBonusPercent: Number(form.timeBonusPercent) || 0,
        }),
      }),
    onSuccess: () => {
      setEditing(false);
      invalidate();
    },
  });
  const unclaim = useMutation({
    mutationFn: () => api(`${base}/unclaim`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api(base, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  if (editing) {
    const err =
      save.isError && save.error instanceof ApiError
        ? apiErrorMessage(save.error, t("roster.updateFailed"))
        : null;
    // Compact: an inline edit sits inside a table row, so it takes the 28 px
    // control height instead of the 34 px one a form field gets.
    const small = cx(inputClass, inputSize.sm, "w-full");
    return (
      <tr className={cx(T.row, "bg-surface-2/60")}>
        <td className={T.td}>
          <input
            className={small}
            aria-label={t("roster.col.lastName")}
            value={form.nom}
            onChange={(e) => setForm({ ...form, nom: e.target.value })}
            autoFocus
          />
        </td>
        <td className={T.td}>
          <input
            className={small}
            aria-label={t("roster.col.firstName")}
            value={form.prenom}
            onChange={(e) => setForm({ ...form, prenom: e.target.value })}
          />
        </td>
        {/* One cell per column, colSpan-free: a cell spanning a column the
            container has hidden leaves this row one column wider than every
            other one, and the table shears. */}
        <td className={cx(T.td, T.colHigh)}>
          <input
            className={small}
            aria-label={t("roster.col.email")}
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          {err ? <p className="mt-1 text-xs text-danger">{err}</p> : null}
          {form.email !== entry.email && entry.status === "claimed" ? (
            <p className="mt-1 text-xs text-warning">{t("roster.emailChangeWarning")}</p>
          ) : null}
        </td>
        <td className={T.td} />
        <td className={cx(T.td, T.colMid)}>
          <input
            className={cx(small, "text-right tabular-nums")}
            aria-label={t("roster.col.bonus")}
            type="number"
            min={0}
            max={300}
            value={form.timeBonusPercent}
            onChange={(e) => setForm({ ...form, timeBonusPercent: e.target.value })}
          />
        </td>
        <td className={cx(T.td, T.colLow)} />
        <td className={cx(T.td, "whitespace-nowrap text-right sticky right-0 bg-surface-2")}>
          <IconButton label={t("common.save")} onClick={() => save.mutate()} disabled={save.isPending}>
            <Check />
          </IconButton>
          <IconButton
            label={t("common.cancel")}
            onClick={() => {
              setEditing(false);
              setForm({
                nom: entry.nom,
                prenom: entry.prenom,
                email: entry.email,
                timeBonusPercent: String(entry.timeBonusPercent),
              });
            }}
          >
            <X />
          </IconButton>
        </td>
      </tr>
    );
  }

  const busy = unclaim.isPending || remove.isPending;

  // A failed action from the row menu: one line under the row it came from.
  const failure = unclaim.isError
    ? apiErrorMessage(unclaim.error, t("roster.revokeFailed"))
    : remove.isError
      ? apiErrorMessage(remove.error, t("roster.removeFailed"))
      : null;

  return (
    <Fragment>
      <tr className={cx(T.row, T.rowHover)}>
        <td className={`${T.td} font-semibold`}>
          <span className="flex items-center gap-2.5">
            <StudentAvatar entry={entry} />
            {entry.nom}
          </span>
        </td>
        <td className={T.td}>{entry.prenom}</td>
        <td className={cx(T.td, "text-fg-muted", T.colHigh)}>
          <a href={`mailto:${entry.email}`} className="hover:text-fg hover:underline">
            {entry.email}
          </a>
        </td>
        <td className={T.td}>
          <span className="inline-flex items-center gap-1">
            {entry.conflictFlag ? (
              <Badge tone="red" icon={AlertTriangle}>
                {t("roster.status.conflict")}
              </Badge>
            ) : entry.status === "claimed" ? (
              <Badge tone="green" icon={CheckCircle2}>
                {t("roster.status.claimed")}
              </Badge>
            ) : (
              <Badge tone="amber" icon={Clock}>
                {t("roster.status.pending")}
              </Badge>
            )}
            {entry.staff ? (
              <Badge tone="zinc" icon={GraduationCap}>
                {t("roster.status.staff")}
              </Badge>
            ) : null}
          </span>
        </td>
        {/* The accommodation, right-aligned and tabular like every number.
            Zero shows an em dash: a column of "0 %" reads as data when it is
            in fact the absence of any. */}
        <td className={cx(T.td, "text-right tabular-nums", T.colMid)}>
          {entry.timeBonusPercent > 0 ? (
            <span className="font-semibold text-accent">+{entry.timeBonusPercent}%</span>
          ) : (
            <span className="text-fg-faint">—</span>
          )}
        </td>
        <td className={cx(T.td, "whitespace-nowrap text-fg-muted", T.colLow)}>
          {entry.lastLoginAt ? <RelativeTime iso={entry.lastLoginAt} /> : "—"}
        </td>
        <td className={cx(T.td, "whitespace-nowrap text-right", T.stickyEnd)}>
          {/* The menu is gone by the time the request answers, so the row
              itself carries the fact that something is running. */}
          {busy ? (
            <Loader2
              className="mr-1 inline size-4 animate-spin text-fg-faint"
              aria-label={t("common.loading")}
            />
          ) : null}
          <Menu
            label={t("roster.rowActions", { name: fullName })}
            items={[
              { label: t("common.edit"), icon: Pencil, onSelect: () => setEditing(true) },
              ...(entry.status === "claimed" || entry.conflictFlag
                ? [
                    {
                      label: t("roster.revoke"),
                      icon: UserRoundX,
                      disabled: unclaim.isPending,
                      onSelect: async () => {
                        if (
                          await confirm({
                            title: t("roster.revokeConfirm", { name: fullName }),
                            message: t("roster.revokeBody"),
                            confirmLabel: t("roster.revoke"),
                            cancelLabel: t("common.cancel"),
                          })
                        ) {
                          unclaim.mutate();
                        }
                      },
                    },
                  ]
                : []),
              {
                label: t("roster.remove"),
                icon: Trash2,
                danger: true,
                separator: true,
                disabled: remove.isPending,
                onSelect: async () => {
                  if (
                    await confirm({
                      title: t("roster.removeConfirm", { name: fullName }),
                      message: t("roster.removeBody"),
                      confirmLabel: t("roster.remove"),
                      cancelLabel: t("common.cancel"),
                      danger: true,
                    })
                  ) {
                    remove.mutate();
                  }
                },
              },
            ]}
          />
        </td>
      </tr>
      {failure ? (
        <tr>
          <td colSpan={7} className="px-3 pb-2 text-[13px] text-danger">
            {failure}
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

type SortKey = "nom" | "prenom" | "email" | "status" | "timeBonusPercent" | "lastLoginAt";

export function RosterTable({
  classroomId,
  roster,
}: {
  classroomId: string;
  roster: RosterEntry[];
}) {
  const t = useT();
  const { sorted, sort, toggle } = useSortableTable<RosterEntry, SortKey>(
    roster,
    (r, k) => r[k] ?? "",
    { key: "nom", dir: 1 },
    (x, y) =>
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), undefined, { sensitivity: "base" }),
  );
  const Th = ({
    k,
    children,
    className,
  }: {
    k: SortKey;
    children: React.ReactNode;
    className?: string;
  }) => (
    <SortHeader k={k} sort={sort} onToggle={toggle} className={className}>
      {children}
    </SortHeader>
  );

  return (
    /* Seven columns never fit a phone. The three the teacher can read later
       leave in turn as the table's own container shrinks (`T` › column
       priority): the last sign-in, then the accommodation, then the e-mail.
       The name, the first name, the status and the row menu stay, and the
       menu is pinned to the right edge for the widths where even that four
       scrolls. */
    <div className={cx(T.container, "overflow-x-auto")}>
      <table className={T.table}>
        <thead>
          <tr className={T.head}>
            <Th k="nom">{t("roster.col.lastName")}</Th>
            <Th k="prenom">{t("roster.col.firstName")}</Th>
            <Th k="email" className={T.colHigh}>{t("roster.col.email")}</Th>
            <Th k="status">{t("roster.col.status")}</Th>
            <Th k="timeBonusPercent" className={T.colMid}>{t("roster.col.bonus")}</Th>
            <Th k="lastLoginAt" className={T.colLow}>{t("roster.col.lastSignIn")}</Th>
            <th className={cx(T.th, T.stickyEnd)}>
              <span className="sr-only">{t("common.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <Row key={r.id} classroomId={classroomId} entry={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
