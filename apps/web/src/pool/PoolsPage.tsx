import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Globe,
  LayoutGrid,
  Library,
  List,
  Lock,
  LogOut,
  Pencil,
  Plus,
  Shapes,
  Trash2,
  Users,
  UserPlus,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import type { Me, Pool, PoolSummary } from "@quiz/contracts";

import { api, useMe } from "../api";
import { useConfirm } from "../confirm";
import { useT, type TFunction } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  FormDialog,
  FormError,
  Menu,
  type MenuItem,
  PageHeader,
  pressable,
  QueryError,
  RelativeTime,
  Segmented,
  Skeleton,
  Spinner,
  T,
  Tip,
} from "../ui";
import { PoolIcon } from "./PoolIcon";
import { PoolIconPicker } from "./PoolIconPicker";
import { PoolShareSheet } from "./PoolShareSheet";
import { poolsKey } from "../queryKeys";

/**
 * The teacher's question pools.
 *
 * The four decisions of this screen:
 * - Type: the pool's ICON at 24 px over a 14 px bold name; the facts under it
 *   are 12–13 px and muted. A shelf is recognized by its spines, so the jump
 *   lives between the icon and everything else.
 * - Color: one accent, "New pool". The visibility badges are zinc except
 *   `public`, which is amber — the one state where a stranger reads your
 *   questions is the one worth a second glance.
 * - Space: 16 px inside a card, 16 between cards, 24 under the header.
 * - Finish: hairline cards on the canvas, hover on the door itself.
 *
 * Two readings of the same list, like the courses page: cards, where the icon
 * makes a pool recognizable at a glance, and a table, which answers "who owns
 * what, updated when" once a teacher has a dozen of them. The choice is a
 * habit, so it is remembered.
 *
 * Everything else a pool offers — renaming it, its icon, its members, leaving
 * it, deleting it — is in the overflow menu, gated by the caller's role: the
 * server decides what it accepts, and this only offers what it would accept.
 */

type PoolsView = "cards" | "list";

const VIEW_KEY = "quiz-pools-view";

function usePoolsView(): [PoolsView, (v: PoolsView) => void] {
  const [view, setView] = useState<PoolsView>(() =>
    localStorage.getItem(VIEW_KEY) === "list" ? "list" : "cards",
  );
  return [
    view,
    (v) => {
      localStorage.setItem(VIEW_KEY, v);
      setView(v);
    },
  ];
}

/** The visibility badge of a pool: what it says, and who else is on it. */
function VisibilityBadge({ pool }: { pool: PoolSummary }) {
  const t = useT();
  if (pool.visibility === "public") {
    return (
      <Badge tone="amber" icon={Globe}>
        {t("pools.visibility.public")}
      </Badge>
    );
  }
  if (pool.visibility === "shared") {
    return (
      <Badge tone="zinc" icon={Users}>
        {t(
          pool.memberCount === 0
            ? "pools.visibility.sharedNone"
            : pool.memberCount === 1
              ? "pools.visibility.sharedOne"
              : "pools.visibility.shared",
          { n: pool.memberCount },
        )}
      </Badge>
    );
  }
  return (
    <Badge tone="zinc" icon={Lock}>
      {t("pools.visibility.private")}
    </Badge>
  );
}

/** "Prof Démo · contributor": whose pool it is, and what I may do in it. */
function poolAttribution(pool: PoolSummary, mine: boolean, t: TFunction): string | null {
  const parts: string[] = [];
  if (!mine) parts.push(pool.ownerName);
  if (pool.role !== "owner") parts.push(t(`share.role.${pool.role}`));
  return parts.length > 0 ? parts.join(" · ") : null;
}

interface PoolActions {
  items: MenuItem[];
  dialogs: ReactNode;
}

/**
 * The menu of one pool, and the layers it opens. One hook, so the card and
 * the row offer exactly the same things in the same order.
 */
function usePoolActions(pool: PoolSummary, me: Me | null | undefined): PoolActions {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<"form" | "icon" | null>(null);
  const [sharing, setSharing] = useState(false);

  const owner = pool.role === "owner";
  /** The account the pool BELONGS to cannot leave it; a co-owner can. */
  const seat = me != null && pool.ownerId !== me.id;

  const remove = useMutation({
    mutationFn: () => api(`/app/api/pools/${pool.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: poolsKey }),
    onError: toastError("error.save"),
  });
  const leave = useMutation({
    mutationFn: () =>
      api(`/app/api/pools/${pool.id}/members/${me?.id ?? ""}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: poolsKey });
      toast(t("pools.leaveDone", { name: pool.name }), "success");
    },
    onError: toastError("error.save"),
  });

  const items: MenuItem[] = [];
  if (owner) {
    items.push(
      { label: t("pools.rename"), icon: Pencil, onSelect: () => setEdit("form") },
      { label: t("pools.changeIcon"), icon: Shapes, onSelect: () => setEdit("icon") },
      { label: t("pools.share"), icon: UserPlus, onSelect: () => setSharing(true) },
    );
  }
  if (seat) {
    items.push({
      label: t("pools.leave"),
      icon: LogOut,
      danger: true,
      separator: items.length > 0,
      onSelect: async () => {
        const ok = await confirm({
          title: t("pools.leave"),
          message: t("pools.leaveConfirm", { name: pool.name }),
          confirmLabel: t("pools.leaveAction"),
          cancelLabel: t("common.cancel"),
          danger: true,
        });
        if (ok) leave.mutate();
      },
    });
  }
  if (owner) {
    items.push({
      label: t("pools.delete"),
      icon: Trash2,
      danger: true,
      separator: true,
      onSelect: async () => {
        const ok = await confirm({
          title: t("pools.delete"),
          message: t("pools.deleteConfirm", { name: pool.name }),
          confirmLabel: t("common.delete"),
          cancelLabel: t("common.cancel"),
          danger: true,
        });
        if (ok) remove.mutate();
      },
    });
  }

  return {
    items,
    dialogs: (
      <>
        {edit ? (
          <PoolFormModal pool={pool} startAt={edit} onClose={() => setEdit(null)} />
        ) : null}
        {sharing ? <PoolShareSheet pool={pool} onClose={() => setSharing(false)} /> : null}
      </>
    ),
  };
}

/**
 * Creating a pool, and editing the two things that make it recognizable: its
 * name and its icon.
 *
 * The icon picker is the SAME dialog, one step further in — the tile in the
 * form opens it, picking one comes back. Not a second window over the first:
 * choosing an icon is part of naming a pool, not a decision of its own.
 */
export function PoolFormModal({
  pool,
  startAt = "form",
  onClose,
}: {
  /** Absent: create. Present: edit. */
  pool?: PoolSummary;
  /** "icon" opens straight on the picker (the "Change icon" menu item). */
  startAt?: "form" | "icon";
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(pool?.name ?? "");
  const [icon, setIcon] = useState<string | null>(pool?.icon ?? null);
  const [step, setStep] = useState<"form" | "icon">(startAt);

  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({ name: name.trim(), icon });
      return pool
        ? api<Pool>(`/app/api/pools/${pool.id}`, { method: "PATCH", body })
        : api<Pool>("/app/api/pools", { method: "POST", body });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: poolsKey });
      onClose();
    },
  });

  if (step === "icon") {
    return (
      <PoolIconPicker
        value={icon}
        onPick={(picked) => {
          setIcon(picked);
          setStep("form");
        }}
        // Opened straight on the picker: there is no form step to go back to
        // that the teacher asked for, so the way out is out.
        onClose={() => (startAt === "icon" && pool ? onClose() : setStep("form"))}
      />
    );
  }

  return (
    <FormDialog
      title={pool ? t("pools.rename") : t("pools.new")}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitLabel={pool ? t("common.save") : t("pools.newAction")}
      submitting={save.isPending}
      canSubmit={name.trim() !== ""}
      dense
      error={<FormError error={save.error} fallback={t("pools.createFailed")} />}
    >
      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg">{t("pools.icon")}</span>
          {/* The tile IS the trigger: the icon a pool will wear, and one
              click from the shelf it comes off. */}
          <Tip label={t("pools.icon.change")}>
            <button
              type="button"
              onClick={() => setStep("icon")}
              aria-label={t("pools.icon.change")}
              className="inline-flex size-8.5 items-center justify-center rounded-field border border-line-strong bg-surface text-fg-muted transition-colors hover:border-fg-faint hover:text-fg"
            >
              <PoolIcon icon={icon} className="size-4.5" />
            </button>
          </Tip>
        </div>
        <Field
          label={t("pools.name")}
          className="min-w-0"
          width="min-w-0 flex-1"
          autoFocus
          placeholder={t("pools.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
    </FormDialog>
  );
}

function PoolCard({
  pool,
  me,
  navigate,
}: {
  pool: PoolSummary;
  me: Me | null | undefined;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const { items, dialogs } = usePoolActions(pool, me);
  const mine = me != null && pool.ownerId === me.id;
  const attribution = poolAttribution(pool, mine, t);

  return (
    // A column, so the "Updated …" strip is at the BOTTOM of every card and
    // not wherever its own text ended: three cards side by side with three
    // rules at three heights read as three different objects.
    <Card className="relative flex h-full flex-col overflow-hidden">
      {/* The card IS the door, so the whole of it is one button and the menu
          sits beside it rather than inside it: a menu trigger nested in a
          clickable card is two controls claiming the same click. */}
      <button
        type="button"
        onClick={() => navigate({ view: "pool", id: pool.id })}
        className="flex w-full flex-1 items-start gap-3 p-4 pr-11 text-left transition-colors hover:bg-surface-2/50"
      >
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-fg-muted">
          <PoolIcon icon={pool.icon} className="size-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">{pool.name}</span>
          <span className="mt-0.5 block text-xs text-fg-muted">
            {t(pool.questionCount === 1 ? "pools.questions.one" : "pools.questions", {
              n: pool.questionCount,
            })}
          </span>
          <span className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <VisibilityBadge pool={pool} />
            {attribution ? (
              <span className="truncate text-xs text-fg-faint">{attribution}</span>
            ) : null}
          </span>
        </span>
      </button>
      <div className="border-t border-line px-4 py-2 text-xs text-fg-faint">
        {t("pools.updated")} <RelativeTime iso={pool.updatedAt} />
      </div>
      {items.length > 0 ? (
        <div className="absolute right-2 top-2">
          <Menu label={t("common.actions")} items={items} />
        </div>
      ) : null}
      {dialogs}
    </Card>
  );
}

function PoolRow({
  pool,
  me,
  navigate,
}: {
  pool: PoolSummary;
  me: Me | null | undefined;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const { items, dialogs } = usePoolActions(pool, me);
  const mine = me != null && pool.ownerId === me.id;

  return (
    <tr
      {...pressable(() => navigate({ view: "pool", id: pool.id }), "row")}
      onClick={() => navigate({ view: "pool", id: pool.id })}
      className={cx(T.row, T.rowHover, "cursor-pointer")}
    >
      <td className={T.td}>
        <span className="flex min-w-0 items-center gap-2.5">
          <PoolIcon icon={pool.icon} className="size-4 shrink-0 text-fg-muted" />
          <span className="min-w-0 truncate font-semibold">{pool.name}</span>
        </span>
      </td>
      <td className={`${T.td} text-right tabular-nums`}>{pool.questionCount}</td>
      <td className={T.td}>
        <VisibilityBadge pool={pool} />
      </td>
      <td className={`${T.td} ${T.colMid}`}>
        {mine ? <span className="text-fg-faint">—</span> : pool.ownerName}
      </td>
      <td className={`${T.td} ${T.colLow}`}>
        {pool.role === "owner" ? (
          <span className="text-fg-faint">—</span>
        ) : (
          t(`share.role.${pool.role}`)
        )}
      </td>
      <td className={`${T.td} ${T.colHigh} whitespace-nowrap text-fg-muted`}>
        <RelativeTime iso={pool.updatedAt} />
      </td>
      <td className={`${T.td} ${T.stickyEnd} w-10 text-right`}>
        {items.length > 0 ? <Menu label={t("common.actions")} items={items} /> : null}
        {dialogs}
      </td>
    </tr>
  );
}

export function PoolsPage({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const [view, setView] = usePoolsView();

  const pools = useQuery<PoolSummary[]>({
    queryKey: poolsKey,
    queryFn: () => api("/app/api/pools"),
  });
  const rows = pools.data ?? [];

  /** Two pictures of one list; the name stays for the pointer and the reader. */
  const viewOption = (value: PoolsView, icon: ReactNode, label: string) => ({
    value,
    label: (
      <span title={label} className="flex items-center">
        {icon}
        <span className="sr-only">{label}</span>
      </span>
    ),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        help="pools"
        title={t("pools.title")}
        description={t("pools.subtitle")}
        actions={
          // Not while the list is empty: the empty state below carries the
          // same action, and two accent fills of one action is noise.
          rows.length > 0 ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("pools.new")}
            </Button>
          ) : undefined
        }
      />

      {rows.length > 0 && !pools.isError ? (
        <div className="flex justify-end">
          <Segmented
            name="pools-view"
            value={view}
            onChange={setView}
            options={[
              viewOption("cards", <LayoutGrid className="size-4" />, t("view.cards")),
              viewOption("list", <List className="size-4" />, t("view.list")),
            ]}
          />
        </div>
      ) : null}

      {pools.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : pools.isError ? (
        <QueryError
          title={t("pools.title")}
          error={pools.error}
          onRetry={() => void pools.refetch()}
          retrying={pools.isFetching}
          fallback={t("error.server")}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Library}
          title={t("pools.empty.title")}
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("pools.new")}
            </Button>
          }
        >
          {t("pools.empty.body")}
        </EmptyState>
      ) : view === "list" ? (
        <Card className="overflow-hidden">
          <div className={cx(T.container, "overflow-x-auto")}>
            <table className={T.table}>
              <thead className={T.head}>
                <tr>
                  <th className={T.th}>{t("pools.name")}</th>
                  <th className={`${T.th} text-right`}>{t("pools.questionsColumn")}</th>
                  <th className={T.th}>{t("pools.visibility")}</th>
                  <th className={`${T.th} ${T.colMid}`}>{t("pools.owner")}</th>
                  <th className={`${T.th} ${T.colLow}`}>{t("pools.role")}</th>
                  <th className={`${T.th} ${T.colHigh}`}>{t("pools.updatedColumn")}</th>
                  <th className={`${T.th} w-10`}>
                    <span className="sr-only">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((pool) => (
                  <PoolRow key={pool.id} pool={pool} me={me.data} navigate={navigate} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((pool) => (
            <PoolCard key={pool.id} pool={pool} me={me.data} navigate={navigate} />
          ))}
        </div>
      )}

      {pools.isFetching && !pools.isLoading ? <Spinner className="py-2" /> : null}
      {creating ? <PoolFormModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
