import type { UseQueryResult } from "@tanstack/react-query";
import { Globe, Library, Plus } from "lucide-react";
import { useState } from "react";

import type { Me, PoolSummary } from "@quiz/contracts";

import { useMe } from "../api";
import { useT } from "../i18n";
import { useSearchParam, type Route } from "../router";
import {
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
  Tabs,
  usePersistentChoice,
  useSortableTable,
  ViewSwitch,
} from "../ui";
import { PoolCard, VisibilityBadge } from "./PoolCard";
import { PoolCatalogue } from "./PoolCatalogue";
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

type PoolsTab = "mine" | "explore";

/** "My pools": the shelf, as cards or as a table (ADR-095). */
function PoolShelf({
  pools,
  navigate,
  onCreate,
}: {
  pools: UseQueryResult<PoolSummary[]>;
  navigate: (r: Route) => void;
  onCreate: () => void;
}) {
  const t = useT();
  const me = useMe();
  const [view, setView] = usePersistentChoice(VIEW_KEY, VIEWS, "cards");
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
    <>
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
            <Button onClick={onCreate}>
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
    </>
  );
}

export function PoolsPage({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  // "My pools" or the catalogue of public pools (ADR-095).
  const [tabParam, setTab] = useSearchParam("tab", "mine");
  const tab: PoolsTab = tabParam === "explore" ? "explore" : "mine";

  // Everything the caller reaches: an admin's own shelf, or every pool of
  // the instance while their Super Powers are on (ADR-054) — the server's
  // call, not a switch here.
  const pools = usePools();
  const rows = pools.data ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        help="pools"
        title={t("pools.title")}
        description={t("pools.subtitle")}
        primary={
          // Not while the list is empty: the empty state below carries the
          // same action, and two accent fills of one action is noise. Nor on
          // the catalogue, which creates nothing.
          tab === "mine" && rows.length > 0
            ? { icon: Plus, label: t("pools.new"), onClick: () => setCreating(true), coach: "pools.new" }
            : undefined
        }
      />

      <Tabs<PoolsTab>
        value={tab}
        onChange={setTab}
        idPrefix="pools"
        items={[
          { value: "mine", label: t("pools.tab.mine"), icon: Library },
          { value: "explore", label: t("pools.tab.explore"), icon: Globe },
        ]}
      />

      {tab === "explore" ? (
        <PoolCatalogue navigate={navigate} />
      ) : (
        <PoolShelf pools={pools} navigate={navigate} onCreate={() => setCreating(true)} />
      )}
      {creating ? <PoolFormModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
