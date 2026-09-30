/**
 * What the pointer is doing, drawn over the diagram: the elements a link
 * may join, the link being drawn and its elbows, the element about to be
 * placed, the stroke being drawn, the rubber band. Nothing here takes the
 * pointer.
 */
import type { JSX } from "react";

import type { Bounds, Measure, Rect } from "../geometry.js";
import type { Route } from "../layout.js";
import type { DiagramNode, LinkType, Point } from "../scene.js";
import { LinkShape, NodeShape, inkPath } from "./shapes.js";
import { cx, draftLine, handle, hoverFrame, inkNormal, marquee } from "./styles.js";

export interface OverlayProps {
  highlight: ReadonlySet<string>;
  rects: ReadonlyMap<string, Rect>;
  draft: { type: LinkType; route: Route | undefined; via: readonly Point[] } | null;
  ghost: DiagramNode | null;
  measure: Measure;
  ink: { t: "stroke" | "line"; pts: ReadonlyArray<readonly [number, number]> } | null;
  band: Bounds | null;
}

export function Overlay({ highlight, rects, draft, ghost, measure, ink, band }: OverlayProps): JSX.Element {
  return (
    <g className="pointer-events-none">
      {[...highlight].map((id) => {
        const r = rects.get(id);
        return r ? <rect key={id} className={hoverFrame} x={r.x0 - 3} y={r.y0 - 3} width={r.w + 6} height={r.h + 6} rx={3} /> : null;
      })}
      {draft?.route && <LinkShape link={{ type: draft.type }} route={draft.route} draft />}
      {draft?.via.map((v, i) => <circle key={i} className="fill-accent" cx={v.x} cy={v.y} r={3} />)}
      {ghost && (
        <g className={inkNormal}>
          <NodeShape node={ghost} measure={measure} ghost />
        </g>
      )}
      {ink && <path className={draftLine} d={ink.t === "stroke" ? inkPath(ink.pts.slice(1)) : `M${ink.pts.map((q) => q.join(" ")).join("L")}`} />}
      {band && <rect className={marquee} x={band.x0} y={band.y0} width={band.x1 - band.x0} height={band.y1 - band.y0} />}
    </g>
  );
}

/** The handles of the selection, which do take the pointer: elbows to drag, a corner to size by. */
export function Handles({ elbows, corner }: { elbows: ReadonlyArray<{ link: string; via: readonly Point[] }>; corner: { id: string; r: Rect } | null }): JSX.Element {
  return (
    <g>
      {elbows.flatMap(({ link, via }) =>
        via.map((v, i) => <rect key={`${link}-${i}`} className={handle} data-via={i} data-via-link={link} x={v.x - 4.5} y={v.y - 4.5} width={9} height={9} rx={1.5} />),
      )}
      {corner && <rect className={cx(handle, "cursor-nwse-resize")} data-resize={corner.id} x={corner.r.x1 - 5} y={corner.r.y1 - 5} width={10} height={10} rx={1.5} />}
    </g>
  );
}
