import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, List, SearchX, Tags } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { PoolTagUsage } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { poolTagUsageKey } from "../queryKeys";
import {
  Button,
  Card,
  type Column,
  cx,
  EmptyState,
  QueryError,
  SearchInput,
  Segmented,
  Skeleton,
  T,
  TableHead,
  usePersistentChoice,
  useSortableTable,
} from "../ui";
import { squarify } from "./treemap";

/**
 * The pool's "Tags" tab: every tag of the vocabulary with how many live
 * questions wear it and how many courses use one of them — a bare count
 * over every course, never a name (`PoolTagUsage`).
 *
 * The ONE thing it is for: find a tag and go to its questions. A row (or a
 * cell of the heat) opens the Questions tab filtered on that tag
 * (`onOpenTag`). The filter field matches the name and the description, and
 * applies to both readings.
 *
 * Two readings of the same list, a habit remembered per browser like the
 * question list's (`usePersistentChoice`): the table, and the "heat" — a
 * squarified treemap where a cell's area is the tag's share of the summed
 * question counts. No colour yet: neutral surface and hairline, the area is
 * the message. A tag no question wears has no area, so it is absent from the
 * heat and present in the table.
 */
type TagsView = "list" | "heat";
const TAGS_VIEW_KEY = "quiz-pool-tags-view";
const TAGS_VIEWS: readonly TagsView[] = ["list", "heat"];

/** Most-used first, then by name: the order before a header is clicked. */
const byUse = (a: PoolTagUsage, b: PoolTagUsage) =>
  b.questions - a.questions || a.tag.localeCompare(b.tag);

export function TagsTab({ poolId, onOpenTag }: { poolId: string; onOpenTag: (tag: string) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [view, setView] = usePersistentChoice(TAGS_VIEW_KEY, TAGS_VIEWS, "list");
  const usage = useQuery<PoolTagUsage[]>({
    queryKey: poolTagUsageKey(poolId),
    queryFn: () => api(`/app/api/pools/${poolId}/tags/usage`),
  });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = [...(usage.data ?? [])].sort(byUse);
    return needle === ""
      ? all
      : all.filter(
          (row) =>
            row.tag.toLowerCase().includes(needle) ||
            row.description.toLowerCase().includes(needle),
        );
  }, [usage.data, q]);

  const viewOption = (value: TagsView, icon: ReactNode, label: string) => ({
    value,
    label: (
      <span title={label} className="flex items-center gap-1.5">
        {icon}
        <span>{label}</span>
      </span>
    ),
  });

  let body: ReactNode;
  if (usage.isLoading) {
    body = <Skeleton className="h-64 w-full" />;
  } else if (usage.isError || !usage.data) {
    body = (
      <QueryError
        title={t("pool.tab.tags")}
        error={usage.error}
        onRetry={() => void usage.refetch()}
        retrying={usage.isFetching}
        fallback={t("error.server")}
      />
    );
  } else if (usage.data.length === 0) {
    body = (
      <Card>
        <EmptyState icon={Tags} title={t("pool.tags.empty.title")}>
          {t("pool.tags.empty.body")}
        </EmptyState>
      </Card>
    );
  } else if (shown.length === 0) {
    body = (
      <Card>
        <EmptyState
          icon={SearchX}
          title={t("pool.tags.noMatch.title")}
          action={
            <Button variant="secondary" onClick={() => setQ("")}>
              {t("pool.tags.clearFilter")}
            </Button>
          }
        >
          {t("pool.tags.noMatch.body", { q: q.trim() })}
        </EmptyState>
      </Card>
    );
  } else if (view === "heat") {
    body = <TagHeat rows={shown} onOpenTag={onOpenTag} />;
  } else {
    body = <TagTable rows={shown} onOpenTag={onOpenTag} />;
  }

  const total = usage.data?.length ?? 0;
  // Nothing to filter or to draw two ways: an empty pool or a failed read
  // shows its state alone.
  if (!usage.isLoading && total === 0) return body;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          className="w-full sm:w-72"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("pool.tags.filter")}
          aria-label={t("pool.tags.filter")}
        />
        <div className="ml-auto flex items-center gap-3">
          {total > 0 ? (
            <span aria-live="polite" className="text-xs tabular-nums text-fg-faint">
              {q.trim() === ""
                ? t(total === 1 ? "pool.tags.count.one" : "pool.tags.count", { n: total })
                : t("pool.tags.countOf", { n: shown.length, total })}
            </span>
          ) : null}
          <Segmented
            name="pool-tags-view"
            size="sm"
            label={t("pool.tags.view")}
            value={view}
            onChange={setView}
            options={[
              viewOption("list", <List className="size-4" />, t("view.list")),
              viewOption("heat", <LayoutDashboard className="size-4" />, t("pool.tags.view.heat")),
            ]}
          />
        </div>
      </div>
      {body}
    </div>
  );
}

type TagKey = "tag" | "questions" | "courses";

/** The table: tag, description, questions, courses; a row opens the tag's questions. */
function TagTable({ rows, onOpenTag }: { rows: PoolTagUsage[]; onOpenTag: (tag: string) => void }) {
  const t = useT();
  // `null`: the rows stand most-used first (`byUse`) until a header is clicked.
  const { sorted, sort, toggle } = useSortableTable<PoolTagUsage, TagKey>(
    rows,
    (row, key) => row[key],
    null,
  );
  const columns: Column<TagKey>[] = [
    { key: "tag", label: t("pool.tags.col.tag") },
    { key: "description", label: t("pool.tags.col.description"), sortable: false, className: T.colHigh },
    { key: "questions", label: t("pool.tags.col.questions"), right: true, className: "w-28" },
    { key: "courses", label: t("pool.tags.col.courses"), right: true, className: "w-28" },
  ];
  return (
    <Card className={cx(T.container, "overflow-x-auto")}>
      <table className={T.table}>
        <TableHead columns={columns} sort={sort} onToggle={toggle} />
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.tag}
              className={cx(T.row, T.rowHover, "cursor-pointer")}
              onClick={() => onOpenTag(row.tag)}
            >
              <td className={T.td}>
                <button
                  type="button"
                  title={t("pool.tags.open", { tag: row.tag })}
                  className="inline-flex h-6 max-w-[16rem] items-center rounded-full border border-line bg-surface-2 px-2.5 text-xs font-semibold text-fg transition-colors hover:border-line-strong"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTag(row.tag);
                  }}
                >
                  <span className="truncate">#{row.tag}</span>
                </button>
              </td>
              <td className={cx(T.td, T.colHigh, "text-fg-muted")}>
                {row.description === "" ? "—" : <span className="line-clamp-2">{row.description}</span>}
              </td>
              <td className={cx(T.td, "text-right tabular-nums")}>{row.questions}</td>
              <td className={cx(T.td, "text-right tabular-nums")}>{row.courses}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** The box before it is measured (and in a test, where nothing has a size). */
const HEAT_BOX = { w: 1000, h: 416 };

/**
 * The heat: one cell per tag a question wears, its area the tag's share of
 * the summed counts. The box is the page's width and a fixed height per
 * breakpoint; it is measured, so the cells are laid out on its real aspect
 * (squares stay squares) and placed in percent of it. Cells are buttons; one
 * too small for its name keeps it in its accessible name and its `title`,
 * and shows the count alone.
 */
function TagHeat({ rows, onOpenTag }: { rows: PoolTagUsage[]; onOpenTag: (tag: string) => void }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(HEAT_BOX);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (width > 0 && height > 0) setBox({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const cells = useMemo(() => squarify(rows, (r) => r.questions, box.w, box.h), [rows, box]);
  if (cells.length === 0) {
    return (
      <Card>
        <EmptyState icon={LayoutDashboard} title={t("pool.tags.heat.empty")} />
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {/* The hairlines between cells are the box's own fill showing through a
          1 px gap; the layer is 1 px wider and taller than the box, so the
          last row and column end on its border instead of doubling it. */}
      <div
        ref={boxRef}
        className="relative h-72 w-full overflow-hidden rounded-card border border-line bg-line sm:h-104"
      >
        <div className="absolute inset-0 -right-px -bottom-px">
          {cells.map(({ item, x, y, w, h }) => {
            const label = t("pool.tags.cell", {
              tag: item.tag,
              questions: t(item.questions === 1 ? "pools.questions.one" : "pools.questions", {
                n: item.questions,
              }),
              courses: t(item.courses === 1 ? "pool.tags.courses.one" : "pool.tags.courses", {
                n: item.courses,
              }),
            });
            // Too small for a name: the count is all that fits.
            const tiny = w < 44 || h < 40;
            return (
              <button
                key={item.tag}
                type="button"
                aria-label={label}
                title={label}
                onClick={() => onOpenTag(item.tag)}
                // Inset ring: the box clips, and an edge cell's ring must stay whole.
                className="absolute overflow-hidden bg-surface text-left transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2"
                style={{
                  left: `${(x / box.w) * 100}%`,
                  top: `${(y / box.h) * 100}%`,
                  width: `calc(${(w / box.w) * 100}% - 1px)`,
                  height: `calc(${(h / box.h) * 100}% - 1px)`,
                }}
              >
                <span className="flex h-full min-w-0 flex-col gap-0.5 p-2">
                  {tiny ? null : (
                    <span className="truncate text-[13px] font-semibold text-fg">#{item.tag}</span>
                  )}
                  <span className="truncate text-xs tabular-nums text-fg-muted">{item.questions}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-fg-faint">{t("pool.tags.heat.caption")}</p>
    </div>
  );
}
