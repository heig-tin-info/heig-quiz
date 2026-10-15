import { SearchX, Tags } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import type { PoolConcept } from "@quiz/contracts";

import { ConceptLabel } from "../concepts/refs";
import { refName } from "../concepts/names";
import { useT } from "../i18n";
import { QueryError } from "../queryError";
import {
  Badge,
  Button,
  Card,
  type Column,
  cx,
  EmptyState,
  SearchInput,
  Skeleton,
  T,
  TableHead,
  usePersistentChoice,
  useSortableTable,
  ViewSwitch,
} from "../ui";
import { ConceptMap, usePoolConceptMap } from "./ConceptMap";
import { branches, keptRows, mapIndex, nameHolds } from "./conceptMap";

/**
 * The pool's "Concepts" tab (ADR-081 third addendum §6): the concepts the
 * pool's live questions use, each with its covered count — its questions and
 * those of its narrower concepts, what its click opens (ADR-116 §8) — the
 * pool detail's own `concepts` (`PoolConcept`), so the tab has no request of
 * its own.
 *
 * The ONE thing it is for: find a concept and go to its questions. A row's
 * name (or a leaf of the map) opens the Questions tab filtered on that
 * concept (`onOpenConcept`). It is read-only: a concept's label and
 * description are the instance's vocabulary, which the admin curates; what a
 * question exercises is changed in its editor or by the bulk bar.
 *
 * Two readings of the same list, a habit remembered per browser like the
 * question list's (`usePersistentChoice`): the table of the concepts the
 * questions carry, and the concept map (`ConceptMap`, ADR-116), one level of
 * the hierarchy per view, which also draws the broader concepts above them.
 * The map has a request of its own, made only when it is the view. A search
 * keeps the matching rows, or the matching branches of the map (§6).
 */
type ConceptsView = "list" | "map";
const VIEW_KEY = "quiz-pool-concepts-view";
const VIEWS: readonly ConceptsView[] = ["list", "map"];

/** Most-used first, then by name: the order before a header is clicked. */
const byUse = (a: PoolConcept, b: PoolConcept) =>
  b.count - a.count || refName(a.concept).localeCompare(refName(b.concept));

export function ConceptsTab({
  poolId,
  concepts,
  onOpenConcept,
}: {
  poolId: string;
  concepts: readonly PoolConcept[];
  onOpenConcept: (id: string) => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [view, setView] = usePersistentChoice(VIEW_KEY, VIEWS, "list");
  const map = usePoolConceptMap(poolId, view === "map" && concepts.length > 0);
  const index = useMemo(() => (map.data ? mapIndex(map.data) : null), [map.data]);
  const kept = useMemo(() => (index ? branches(index, q) : null), [index, q]);

  const shown = useMemo(() => [...concepts].sort(byUse).filter((row) => nameHolds(row.concept, q)), [concepts, q]);
  // The map counts the table's rows its branches keep; the list's rule until it is there.
  const matched = view === "map" && index ? keptRows(concepts, kept).length : shown.length;

  let body: ReactNode;
  if (concepts.length === 0) {
    body = (
      <Card>
        <EmptyState icon={Tags} title={t("pool.concepts.empty.title")}>
          {t("pool.concepts.empty.body")}
        </EmptyState>
      </Card>
    );
  } else if (view === "map" && map.isError) {
    body = <QueryError title={t("pool.concepts.map.error")} query={map} />;
  } else if (view === "map" && !index) {
    body = <Skeleton className="h-72 w-full rounded-card sm:h-104" />;
  } else if (matched === 0) {
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
  } else if (view === "map") {
    body = <ConceptMap index={index!} kept={kept} onOpenConcept={onOpenConcept} />;
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
              : t("pool.concepts.countOf", { n: matched, total })}
          </span>
          <ViewSwitch
            name="pool-concepts-view"
            size="sm"
            label={t("pool.concepts.view")}
            views={VIEWS}
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
    <div className="space-y-2">
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
      <p className="text-xs text-fg-faint">{t("pool.concepts.table.caption")}</p>
    </div>
  );
}
