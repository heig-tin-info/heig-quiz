import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { PoolConceptMap } from "@quiz/contracts";

import { api } from "../api";
import { refName } from "../concepts/names";
import { useT } from "../i18n";
import { poolConceptMapKey } from "../queryKeys";
import { useSearchParam } from "../router";
import { Button, cx } from "../ui";
import { levelCells, shownPath, validPath, type Branches, type MapCell, type MapIndex } from "./conceptMap";
import { squarify } from "./treemap";

/**
 * `GET /pools/:id/concept-map` (ADR-116 §7), asked for only while the map is
 * the tab's view; under the pool's key, so a change of the pool refreshes it.
 */
export function usePoolConceptMap(poolId: string, enabled: boolean) {
  return useQuery<PoolConceptMap>({
    queryKey: poolConceptMapKey(poolId),
    queryFn: async () => PoolConceptMap.parse(await api(`/app/api/pools/${poolId}/concept-map`)),
    enabled,
  });
}

/** The box before it is measured (and in a test, where nothing has a size). */
const BOX = { w: 1000, h: 416 };

/**
 * The concept map of the pool's Concepts tab (ADR-116): one level of the
 * vocabulary's hierarchy per view, a squarified treemap whose cells' areas
 * are their covered counts. A cell with narrower concepts zooms into them; a
 * leaf, and the "itself" cell of the concept's own questions, open the
 * Questions tab filtered on the concept (§4). The path is in the address
 * (`?at=`, the ids from the top), kept whole while a search draws a shorter
 * part of it. No colour: the area is the message (§5).
 *
 * The box is the page's width and a fixed height per breakpoint; it is
 * measured, so the cells are laid out on its real aspect and placed in
 * percent of it.
 */
export function ConceptMap({
  index,
  kept,
  onOpenConcept,
}: {
  index: MapIndex;
  kept: Branches | null;
  onOpenConcept: (id: string) => void;
}) {
  const t = useT();
  const [at, setAt] = useSearchParam("at", "");
  const path = useMemo(() => validPath(index, at.split(",").filter(Boolean)), [index, at]);
  const shown = shownPath(path, kept);
  const current = shown.at(-1) ?? null;
  const cells = useMemo(() => levelCells(index, current, kept), [index, current, kept]);
  const questions = (n: number) => t(n === 1 ? "pools.questions.one" : "pools.questions", { n });
  const nameOf = (id: string) => refName(index.byId.get(id)!.concept);

  // A callback ref: the box is not drawn while the search leaves no cell,
  // so it must be observed whenever it (re)appears, not on the first mount.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState(BOX);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (width > 0 && height > 0) setBox({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  const laid = useMemo(() => squarify(cells, (c) => c.value, box.w, box.h), [cells, box]);

  // Where the focus goes once a level is drawn: the cell of the concept just
  // left (a step back up), else the first cell (a zoom in); `undefined` when
  // the level changed by itself (a search, the address).
  const focusNext = useRef<string | null | undefined>(undefined);
  const [announced, setAnnounced] = useState("");
  useLayoutEffect(() => {
    const wanted = focusNext.current;
    if (wanted === undefined || !el) return;
    focusNext.current = undefined;
    const buttons = [...el.querySelectorAll<HTMLElement>("button")];
    (buttons.find((b) => wanted !== null && b.dataset.concept === wanted) ?? buttons[0])?.focus();
  }, [current, el]);

  const zoomIn = (id: string) => {
    focusNext.current = null;
    setAnnounced(t("pool.concepts.map.level", { name: nameOf(id), questions: questions(index.byId.get(id)!.covered) }));
    setAt([...shown, id].join(","));
  };
  /** Back up to the level of depth `depth` (0 the root), the focus on the concept left. */
  const zoomOut = (depth: number) => {
    focusNext.current = shown[depth] ?? null;
    setAt(shown.slice(0, depth).join(","));
  };

  const crumbs = [t("pool.concepts.map.root"), ...shown.map(nameOf)];
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : undefined;
  const currentNode = current === null ? null : index.byId.get(current)!;
  const levelName = crumbs.at(-1)!;

  /** A cell's accessible name and `title`: everything it says, and what its click does. */
  function cellLabel(cell: MapCell): string {
    const { concept } = cell.node;
    if (cell.kind === "itself") {
      return t("pool.concepts.map.itselfCell", { questions: questions(cell.value), name: refName(concept) });
    }
    const name =
      concept.status === "proposed" ? `${refName(concept)}, ${t("concepts.picker.proposed")}` : refName(concept);
    if (cell.narrower === 0) return t("pool.concepts.cell", { name, questions: questions(cell.value) });
    return t(cell.narrower === 1 ? "pool.concepts.map.zoomCell.one" : "pool.concepts.map.zoomCell", {
      name,
      questions: questions(cell.value),
      n: cell.narrower,
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* The path navigated, not the page's Breadcrumb: a button per level,
            and on a phone the way back and the current level only. */}
        <nav aria-label={t("pool.concepts.map.trail")} className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
          {parent !== undefined ? (
            <button
              type="button"
              aria-label={t("pool.concepts.map.back", { name: parent })}
              onClick={() => zoomOut(crumbs.length - 2)}
              className="flex min-w-0 shrink-[3] items-center gap-1 transition-colors hover:text-fg hover:underline sm:hidden"
            >
              <ChevronLeft aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
              <span className="truncate">{parent}</span>
            </button>
          ) : null}
          <ol className="flex min-w-0 items-center gap-1.5">
            {crumbs.map((label, i) => {
              const last = i === crumbs.length - 1;
              return (
                <Fragment key={i}>
                  {i > 0 ? (
                    <li aria-hidden className="flex shrink-0 max-sm:hidden">
                      <ChevronRight className="size-3.5 text-fg-faint" />
                    </li>
                  ) : null}
                  <li className={last ? "min-w-0 shrink" : "min-w-0 shrink-[3] max-sm:hidden"}>
                    {last ? (
                      <span aria-current="location" className="block truncate font-semibold text-fg">
                        {label}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => zoomOut(i)}
                        className="block max-w-full truncate transition-colors hover:text-fg hover:underline"
                      >
                        {label}
                      </button>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ol>
        </nav>
        {currentNode ? (
          <Button variant="secondary" size="sm" onClick={() => onOpenConcept(currentNode.concept.id)}>
            {currentNode.covered === 1
              ? t("pool.concepts.map.show.one")
              : t("pool.concepts.map.show", { n: currentNode.covered })}
          </Button>
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only">
        {announced}
      </p>
      {/* The hairlines between cells are the box's own fill showing through a
          1 px gap; the layer is 1 px wider and taller than the box, so the
          last row and column end on its border instead of doubling it. */}
      <div
        ref={setEl}
        role="group"
        aria-label={levelName}
        className="relative h-72 w-full overflow-hidden rounded-card border border-line bg-line sm:h-104"
      >
        <div className="absolute inset-0 -right-px -bottom-px">
          {laid.map(({ item, x, y, w, h }) => (
            <MapCellButton
              key={`${item.kind}:${item.node.concept.id}`}
              cell={item}
              // Too small for a name: the count is all that fits.
              tiny={w < 44 || h < 40}
              label={cellLabel(item)}
              onClick={() =>
                item.kind === "concept" && item.narrower > 0 ? zoomIn(item.node.concept.id) : onOpenConcept(item.node.concept.id)
              }
              style={{
                left: `${(x / box.w) * 100}%`,
                top: `${(y / box.h) * 100}%`,
                width: `calc(${(w / box.w) * 100}% - 1px)`,
                height: `calc(${(h / box.h) * 100}% - 1px)`,
              }}
            />
          ))}
        </div>
      </div>
      <p className="text-xs text-fg-faint">{t("pool.concepts.map.caption")}</p>
    </div>
  );
}

/**
 * A cell: a neutral surface (`surface-2` on hover) with the concept's name, a
 * chevron when it zooms, its count and, for a proposed concept, the word. The
 * box clips, so the focus ring is drawn inside the cell.
 */
function MapCellButton({
  cell,
  tiny,
  label,
  onClick,
  style,
}: {
  cell: MapCell;
  tiny: boolean;
  label: string;
  onClick: () => void;
  style: CSSProperties;
}) {
  const t = useT();
  const concept = cell.kind === "concept" ? cell.node.concept : null;
  return (
    <button
      type="button"
      data-concept={concept?.id}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="absolute overflow-hidden bg-surface text-left transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2"
      style={style}
    >
      <span className="flex h-full min-w-0 flex-col gap-0.5 p-2">
        {tiny ? null : concept ? (
          <span className="flex min-w-0 items-center gap-0.5">
            <span className="truncate text-[13px] font-semibold text-fg">{refName(concept)}</span>
            {cell.kind === "concept" && cell.narrower > 0 ? (
              <ChevronRight aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
            ) : null}
          </span>
        ) : (
          <span className="truncate text-[13px] font-semibold text-fg-muted">{t("pool.concepts.map.itself")}</span>
        )}
        <span className="truncate text-xs tabular-nums text-fg-muted">{cell.value}</span>
        {!tiny && concept?.status === "proposed" ? (
          <span className="truncate text-[11px] text-fg-faint">{t("concepts.picker.proposed")}</span>
        ) : null}
      </span>
    </button>
  );
}
