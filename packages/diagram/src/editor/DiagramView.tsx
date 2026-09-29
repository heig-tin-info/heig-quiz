/**
 * A diagram, read only, framed on its content: the review, the grading panel
 * and the previews. No grid, no tool, no pointer handling.
 */
import { resolveStrings } from "@quiz/core/client";
import { useMemo, useRef, type JSX } from "react";

import { drawOrder } from "../geometry.js";
import type { DiagramKind } from "../kinds.js";
import { bounds, layout } from "../layout.js";
import type { Scene } from "../scene.js";
import { useMeasure } from "./useMeasure.js";
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
  const measure = useMeasure(ref);
  const lay = useMemo(() => layout(value, kind, measure), [value, kind, measure]);
  const box = bounds(lay);

  /* the frame holds the elements and the lines: an elbow or a loop may go beyond them */
  const x0 = box ? box.x0 - MARGIN : 0;
  const y0 = box ? box.y0 - MARGIN : 0;
  const w = box ? box.x1 + MARGIN - x0 : 400;
  const h = box ? box.y1 + MARGIN - y0 : 120;

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
        {drawOrder(value.nodes).map((n) => (
          <NodeShape key={n.id} node={n} measure={measure} />
        ))}
        {value.links.map((l) => {
          const route = lay.routes.get(l.id);
          return route ? <LinkShape key={l.id} link={l} route={route} /> : null;
        })}
      </svg>
      {!box && <span className="pointer-events-none absolute inset-0 grid place-items-center text-[12.5px] text-fg-faint">{s.empty}</span>}
    </div>
  );
}
