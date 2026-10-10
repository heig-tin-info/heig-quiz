import { SearchX, Tags } from "lucide-react";
import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";

import type { PoolConcept } from "@quiz/contracts";

import { ConceptLabel } from "../concepts/refs";
import { refName } from "../concepts/names";
import { useT } from "../i18n";
import {
  Badge,
  Button,
  Card,
  type Column,
  cx,
  EmptyState,
  SearchInput,
  T,
  TableHead,
  usePersistentChoice,
  useSortableTable,
  ViewSwitch,
} from "../ui";
import { squarify } from "./treemap";

/**
 * The pool's "Concepts" tab (ADR-081 third addendum §6): the concepts the
 * pool's live questions use, each with how many of them — the pool detail's
 * own `concepts` (`PoolConcept`), so the tab has no request of its own.
 *
 * The ONE thing it is for: find a concept and go to its questions. A row's
 * name (or a cell of the heat) opens the Questions tab filtered on that
 * concept (`onOpenConcept`). It is read-only: a concept's label and
 * description are the instance's vocabulary, which the admin curates; what a
 * question exercises is changed in its editor or by the bulk bar.
 *
 * Two readings of the same list, a habit remembered per browser like the
 * question list's (`usePersistentChoice`): the table, and the "heat" — a
 * squarified treemap where a cell's area is the concept's share of the
 * summed question counts. No colour: neutral surface and hairline, the area
 * is the message.
 */
type ConceptsView = "list" | "heat";
const VIEW_KEY = "quiz-pool-concepts-view";
const VIEWS: readonly ConceptsView[] = ["list", "heat"];

/** Most-used first, then by name: the order before a header is clicked. */
const byUse = (a: PoolConcept, b: PoolConcept) =>
  b.count - a.count || refName(a.concept).localeCompare(refName(b.concept));

export function ConceptsTab({
  concepts,
  onOpenConcept,
}: {
  concepts: readonly PoolConcept[];
  onOpenConcept: (id: string) => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [view, setView] = usePersistentChoice(VIEW_KEY, VIEWS, "list");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = [...concepts].sort(byUse);
    return needle === "" ? all : all.filter((row) => refName(row.concept).toLowerCase().includes(needle));
  }, [concepts, q]);

  let body: ReactNode;
  if (concepts.length === 0) {
    body = (
      <Card>
        <EmptyState icon={Tags} title={t("pool.concepts.empty.title")}>
          {t("pool.concepts.empty.body")}
        </EmptyState>
      </Card>
    );
  } else if (shown.length === 0) {
    body = (
      <Card>
        <EmptyState
          icon={SearchX}
          title={t("pool.concepts.noMatch.title")}
          action={
            <Button variant="secondary" onClick={() => setQ("")}>
              {t("pool.concepts.clearFilter")}
            </Button>
          }
        >
          {t("pool.concepts.noMatch.body", { q: q.trim() })}
        </EmptyState>
      </Card>
    );
  } else if (view === "heat") {
    body = <ConceptHeat rows={shown} onOpen={onOpenConcept} />;
  } else {
    body = <ConceptTable rows={shown} onOpen={onOpenConcept} />;
  }

  const total = concepts.length;
  // Nothing to filter or to draw two ways: an empty pool shows its state alone.
  if (total === 0) return body;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          className="w-full sm:w-72"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("pool.concepts.filter")}
          aria-label={t("pool.concepts.filter")}
        />
        <div className="ml-auto flex items-center gap-3">
          <span aria-live="polite" className="text-xs tabular-nums text-fg-faint">
            {q.trim() === ""
              ? t(total === 1 ? "pool.concepts.count.one" : "pool.concepts.count", { n: total })
              : t("pool.concepts.countOf", { n: shown.length, total })}
          </span>
          <ViewSwitch
            name="pool-concepts-view"
            size="sm"
            label={t("pool.concepts.view")}
            views={["list", "heat"]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>
      {body}
    </div>
  );
}

type ConceptKey = "name" | "count";

/** The table: the concept (its qualifier, whether it is still proposed), its questions. */
function ConceptTable({ rows, onOpen }: { rows: PoolConcept[]; onOpen: (id: string) => void }) {
  const t = useT();
  // `null`: the rows stand most-used first (`byUse`) until a header is clicked.
  const { sorted, sort, toggle } = useSortableTable<PoolConcept, ConceptKey>(
    rows,
    (row, key) => (key === "name" ? refName(row.concept) : row.count),
    null,
  );
  const columns: Column<ConceptKey>[] = [
    { key: "name", label: t("pool.concepts.col.concept") },
    { key: "count", label: t("pool.concepts.col.questions"), right: true, className: "w-28" },
  ];
  return (
    <Card className={cx(T.container, "overflow-x-auto")}>
      <table className={T.table}>
        <TableHead columns={columns} sort={sort} onToggle={toggle} />
        <tbody>
          {sorted.map(({ concept, count }) => (
            <tr key={concept.id} className={cx(T.row, T.rowHover)}>
              <td className={T.td}>
                <span className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    title={t("pool.concepts.open", { name: refName(concept) })}
                    className="max-w-full truncate text-left font-semibold text-fg underline-offset-2 hover:underline"
                    onClick={() => onOpen(concept.id)}
                  >
                    <ConceptLabel concept={concept} />
                  </button>
                  {concept.status === "proposed" ? (
                    <Badge tone="zinc">{t("concepts.picker.proposed")}</Badge>
                  ) : null}
                </span>
              </td>
              <td className={cx(T.td, "text-right tabular-nums")}>{count}</td>
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
 * The heat: one cell per concept, its area the concept's share of the summed
 * counts. The box is the page's width and a fixed height per breakpoint; it
 * is measured, so the cells are laid out on its real aspect and placed in
 * percent of it. Cells are buttons; one too small for its name keeps it in
 * its accessible name and its `title`, and shows the count alone.
 */
function ConceptHeat({ rows, onOpen }: { rows: PoolConcept[]; onOpen: (id: string) => void }) {
  const t = useT();
  // A callback ref: the box is not drawn while the filter leaves no cell,
  // so it must be observed whenever it (re)appears, not on the first mount.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState(HEAT_BOX);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (width > 0 && height > 0) setBox({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  const cells = useMemo(() => squarify(rows, (r) => r.count, box.w, box.h), [rows, box]);
  return (
    <div className="space-y-2">
      {/* The hairlines between cells are the box's own fill showing through a
          1 px gap; the layer is 1 px wider and taller than the box, so the
          last row and column end on its border instead of doubling it. */}
      <div
        ref={setEl}
        className="relative h-72 w-full overflow-hidden rounded-card border border-line bg-line sm:h-104"
      >
        <div className="absolute inset-0 -right-px -bottom-px">
          {cells.map(({ item, x, y, w, h }) => {
            const name = refName(item.concept);
            const label = t("pool.concepts.cell", {
              name,
              questions: t(item.count === 1 ? "pools.questions.one" : "pools.questions", { n: item.count }),
            });
            // Too small for a name: the count is all that fits.
            const tiny = w < 44 || h < 40;
            return (
              <button
                key={item.concept.id}
                type="button"
                aria-label={label}
                title={label}
                onClick={() => onOpen(item.concept.id)}
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
                  {tiny ? null : <span className="truncate text-[13px] font-semibold text-fg">{name}</span>}
                  <span className="truncate text-xs tabular-nums text-fg-muted">{item.count}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-fg-faint">{t("pool.concepts.heat.caption")}</p>
    </div>
  );
}
