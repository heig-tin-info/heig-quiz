import { Globe, History, Library, Lock, Plus, Users } from "lucide-react";
import { useState } from "react";

import type { Me, PoolSummary } from "@quiz/contracts";

import { useMe } from "../api";
import { useT, type TFunction } from "../i18n";
import type { Route } from "../router";
import {
  Badge,
  Button,
  Card,
  type Column,
  cx,
  EmptyState,
  PageHeader,
  PersonAvatar,
  pressable,
  QueryError,
  RelativeTime,
  Skeleton,
  Spinner,
  T,
  TableHead,
  usePersistentChoice,
  useSortableTable,
  ViewSwitch,
} from "../ui";
import { PoolFormModal } from "./PoolFormModal";
import { PoolIcon } from "./PoolIcon";
import { usePools } from "./api";

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
 * Nothing else is offered here: a pool's name, icon, members, leaving it and
 * deleting it are its Settings tab's (`PoolSettings.tsx`), as a course's and
 * a classroom's are theirs. A card is one door, with no menu beside it.
 */

const VIEW_KEY = "quiz-pools-view";
const VIEWS = ["cards", "list"] as const;
type PoolsView = (typeof VIEWS)[number];

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
  const mine = me != null && pool.ownerId === me.id;
  const attribution = poolAttribution(pool, mine, t);

  return (
    // A column, so the date strip is at the BOTTOM of every card and not
    // wherever its own text ended: three cards side by side with three rules
    // at three heights read as three different objects.
    <Card className="flex h-full flex-col overflow-hidden">
      {/* The card IS the door, so the whole of it is one button. */}
      <button
        type="button"
        onClick={() => navigate({ view: "pool", id: pool.id })}
        className="flex w-full flex-1 items-start gap-3 p-4 text-left transition-colors hover:bg-surface-2/50"
      >
        <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-field bg-surface-2 text-fg-muted">
          <PoolIcon icon={pool.icon} color={pool.color} className="size-8.75" />
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
      {/* The last change, said by its icon rather than by the same word on
          every card, and set to the right where a date is read. Outside the
          door: the date carries its own tooltip and focus. */}
      <div className="flex items-center justify-end gap-1.5 border-t border-line px-4 py-2 text-xs text-fg-faint">
        <History aria-hidden className="size-3.5" />
        <span className="sr-only">{t("pools.updated")}</span>
        <RelativeTime iso={pool.updatedAt} />
      </div>
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
  const mine = me != null && pool.ownerId === me.id;

  return (
    <tr
      {...pressable(() => navigate({ view: "pool", id: pool.id }), "row")}
      onClick={() => navigate({ view: "pool", id: pool.id })}
      className={cx(T.row, T.rowHover, "cursor-pointer")}
    >
      <td className={T.td}>
        <span className="flex min-w-0 items-center gap-2.5">
          <PoolIcon
            icon={pool.icon}
            color={pool.color}
            className="size-4 shrink-0 text-fg-muted"
          />
          <span className="min-w-0 truncate font-semibold">{pool.name}</span>
        </span>
      </td>
      <td className={`${T.td} text-right tabular-nums`}>{pool.questionCount}</td>
      <td className={`${T.td} ${T.colMid} text-right tabular-nums`}>{pool.usedCount}</td>
      <td className={T.td}>
        <VisibilityBadge pool={pool} />
      </td>
      <td className={`${T.td} ${T.colMid}`}>
        {/* The avatar stands alone, so it carries the name (DESIGN.md ›
            PersonAvatar); the accent disc is the reader's own, as in the shell. */}
        <PersonAvatar
          name={[pool.ownerGivenName, pool.ownerFamilyName]}
          src={pool.ownerAvatarUrl}
          label={pool.ownerName}
          tone={mine ? "accent" : "muted"}
        />
      </td>
      {/* The role HELD, never the one Super Powers lend: an admin passing
          through a colleague's pool is not its owner (ADR-013). */}
      <td className={`${T.td} ${T.colLow}`}>{t(`share.role.${pool.heldRole}`)}</td>
      <td className={`${T.td} ${T.colHigh} whitespace-nowrap text-fg-muted`}>
        <RelativeTime iso={pool.updatedAt} />
      </td>
    </tr>
  );
}

type PoolSort = "name" | "questions" | "used" | "visibility" | "owner" | "role" | "updated";

/**
 * What each column of the table reading is ordered ON. The visibility ranks
 * on the ENUM and not on the badge's sentence: what a teacher groups here is
 * private / shared / public, and "shared with 2" would scatter that group by
 * its member count. The owner ranks by name, the one the avatar's label says;
 * the role by its rank, owner first, so a teacher's own shelf leads.
 */
function poolRank(pool: PoolSummary, key: PoolSort): string | number {
  switch (key) {
    case "questions":
      return pool.questionCount;
    case "used":
      return pool.usedCount;
    case "visibility":
      return pool.visibility;
    case "owner":
      return pool.ownerName;
    case "role":
      return ROLE_RANK[pool.heldRole];
    case "updated":
      return pool.updatedAt;
    default:
      return pool.name;
  }
}

const ROLE_RANK: Record<PoolSummary["heldRole"], number> = { owner: 0, contributor: 1, reader: 2 };

export function PoolsPage({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const [view, setView] = usePersistentChoice(VIEW_KEY, VIEWS, "cards");

  // Everything the caller reaches: an admin's own shelf, or every pool of
  // the instance while their Super Powers are on (ADR-054) — the server's
  // call, not a switch here.
  const pools = usePools();
  const rows = pools.data ?? [];
  /* No initial sort: the server hands the shelf over in its own order, and
     the reader picks another one by clicking a label. */
  const { sorted, sort, toggle } = useSortableTable<PoolSummary, PoolSort>(
    rows,
    poolRank,
    null,
  );
  const columns: Column<PoolSort>[] = [
    { key: "name", label: t("pools.name") },
    { key: "questions", label: t("pools.questionsColumn"), right: true },
    { key: "used", label: t("pools.usedColumn"), right: true, className: T.colMid },
    { key: "visibility", label: t("pools.visibility") },
    { key: "owner", label: t("pools.owner"), className: T.colMid },
    { key: "role", label: t("pools.role"), className: T.colLow },
    { key: "updated", label: t("pools.updatedColumn"), className: T.colHigh },
  ];


  return (
    <div className="space-y-6">
      <PageHeader
        help="pools"
        title={t("pools.title")}
        description={t("pools.subtitle")}
        primary={
          // Not while the list is empty: the empty state below carries the
          // same action, and two accent fills of one action is noise.
          rows.length > 0
            ? { icon: Plus, label: t("pools.new"), onClick: () => setCreating(true), coach: "pools.new" }
            : undefined
        }
      />

      {rows.length > 0 && !pools.isError ? (
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          <ViewSwitch name="pools-view" views={["cards", "list"]} value={view} onChange={setView} />
        </div>
      ) : null}

      {pools.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : pools.isError ? (
        <QueryError title={t("pools.title")} query={pools} />
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
              <TableHead columns={columns} sort={sort} onToggle={toggle} />
              <tbody>
                {sorted.map((pool) => (
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
