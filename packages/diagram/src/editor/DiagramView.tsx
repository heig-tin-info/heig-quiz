/**
 * A diagram, read only, framed on its content: the review, the grading panel
 * and the previews. No grid, no tool, no pointer handling.
 */
import { resolveStrings } from "@quiz/core/client";
import { useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";

import type { Measure } from "../geometry.js";
import type { DiagramKind } from "../kinds.js";
import { layout } from "../layout.js";
import type { Scene } from "../scene.js";
import { canvasMeasure } from "./measure.js";
import { LinkShape, NodeShape } from "./shapes.js";
import { diagramStrings, type DiagramStrings } from "./strings.js";
import { cx, inkNormal } from "./styles.js";

export interface DiagramViewProps {
  kind: DiagramKind;
  value: Scene;
  /** The tallest the view gets, in px; it is shorter when the diagram is wide. */
  maxHeight?: number | undefined;
  className?: string | undefined;
  strings?: Partial<DiagramStrings> | undefined;
  "aria-label"?: string | undefined;
}

/** Room around the content, in canvas units: an initial arrow or a loop goes beyond an element. */
const MARGIN = 40;

export function DiagramView({ kind, value, maxHeight = 420, className, strings, ...rest }: DiagramViewProps): JSX.Element {
  const s = useMemo(() => resolveStrings<DiagramStrings>(diagramStrings, strings), [strings]);
  const ref = useRef<SVGSVGElement>(null);
  const [measure, setMeasure] = useState<Measure>(() => canvasMeasure(null));
  useLayoutEffect(() => setMeasure(() => canvasMeasure(ref.current)), []);
  const { rects, routes } = useMemo(() => layout(value, kind, measure), [value, kind, measure]);

  /* the frame holds the elements, and the lines too: an elbow or a loop may go beyond them */
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of rects.values()) xs.push(r.x0, r.x1), ys.push(r.y0, r.y1);
  for (const route of routes.values()) {
    for (const [x, y] of route.pts) xs.push(x), ys.push(y);
    if (route.label) xs.push(route.label.x), ys.push(route.label.y);
  }
  const empty = rects.size === 0;
  const x0 = empty ? 0 : Math.min(...xs) - MARGIN;
  const y0 = empty ? 0 : Math.min(...ys) - MARGIN;
  const w = empty ? 400 : Math.max(...xs) + MARGIN - x0;
  const h = empty ? 120 : Math.max(...ys) + MARGIN - y0;

  return (
    <div className={cx("relative w-full", className)}>
      <svg
        ref={ref}
        viewBox={`${x0} ${y0} ${w} ${h}`}
        className={cx("mx-auto block w-full", inkNormal)}
        style={{ maxHeight, aspectRatio: `${w} / ${h}` }}
        role="img"
        aria-label={rest["aria-label"] ?? s.canvas}
      >
        {[...value.nodes.filter((n) => n.t === "system"), ...value.nodes.filter((n) => n.t !== "system")].map((n) => (
          <NodeShape key={n.id} node={n} measure={measure} />
        ))}
        {value.links.map((l) => {
          const route = routes.get(l.id);
          return route ? <LinkShape key={l.id} link={l} route={route} /> : null;
        })}
      </svg>
      {empty && <span className="pointer-events-none absolute inset-0 grid place-items-center text-[12.5px] text-fg-faint">{s.empty}</span>}
    </div>
  );
}
