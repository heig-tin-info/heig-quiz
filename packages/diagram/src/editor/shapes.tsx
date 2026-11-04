/**
 * The SVG of an element and of a link, shared by the editor and the view.
 * The geometry is `paint.ts`'s, which the printed figure shares (ADR-126 §1):
 * here each primitive's role gets its classes, and the pointer its hit area.
 */
import type { JSX } from "react";

import { sizeOf, type Measure } from "../geometry.js";
import { LINK_STYLE, type PlaceTool } from "../kinds.js";
import { type Route } from "../layout.js";
import { inkPath, linkPath, paintCrowFoot, paintLink, paintNode, type PaintRole, type PaintedLink, type Prim } from "../paint.js";
import type { Cardinality, DiagramNode, LinkType } from "../scene.js";
import {
  cardFill,
  cx,
  dashed,
  dotInk,
  headFill,
  headInk,
  labelText,
  line,
  lineHit,
  lineLabel,
  lineLabelMono,
  lineSelected,
  memberText,
  nameText,
  outline,
  selectedHalo,
  shapeInk,
  stereoText,
  strokeInk,
  thin,
} from "./styles.js";

export { inkPath };

/** The classes of each role: the screen's look of the notation. */
export const ROLE_CLASS: Readonly<Record<PaintRole, string>> = {
  shape: shapeInk,
  outline,
  thin,
  ink: strokeInk,
  dot: dotInk,
  card: cardFill,
  header: headFill,
  frame: cx(outline, "stroke-[1.4]"),
  line,
  headOpen: cx(headInk, "fill-none"),
  headSolid: cx(headInk, "fill-current"),
  headHollow: cx(headInk, "fill-surface"),
  name: nameText,
  frameName: cx(nameText, "text-[13px]"),
  stereo: stereoText,
  member: memberText,
  label: labelText,
  lineLabel,
  lineLabelMono,
};

/** One primitive as SVG; a selected link's line is drawn heavier. */
function Primitive({ p, selected }: { p: Prim; selected: boolean }): JSX.Element {
  const cls = ROLE_CLASS[p.role];
  switch (p.el) {
    case "path":
      return <path className={cx(cls, p.dashed === true && dashed, selected && p.role === "line" && lineSelected)} d={p.d} />;
    case "rect":
      return <rect className={cls} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.rx} />;
    case "ellipse":
      return <ellipse className={cls} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} />;
    case "circle":
      return <circle className={cls} cx={p.cx} cy={p.cy} r={p.r} />;
    case "text":
      return (
        <text className={cx(cls, p.underline === true && "underline", p.italic === true && "italic")} x={p.x} y={p.y} textAnchor={p.anchor}>
          {p.text}
        </text>
      );
  }
}

/** Primitives as SVG elements, in order. */
const draw = (prims: readonly Prim[], selected = false): JSX.Element[] =>
  prims.map((p, i) => <Primitive key={i} p={p} selected={selected} />);

export interface NodeShapeProps {
  node: DiagramNode;
  measure: Measure;
  selected?: boolean;
  ghost?: boolean;
}

export function NodeShape({ node: n, measure, selected = false, ghost = false }: NodeShapeProps): JSX.Element {
  const { w, h } = sizeOf(n, measure);
  return (
    <g className={cx(ghost && "pointer-events-none opacity-50")} transform={`translate(${n.x} ${n.y})`}>
      {selected && <rect className={selectedHalo} x={-4} y={-4} width={w + 8} height={h + 8} rx={3} />}
      {draw(paintNode(n, measure))}
    </g>
  );
}

export interface LinkShapeProps {
  link: PaintedLink;
  route: Route;
  selected?: boolean;
  /** Being drawn: no hit area, the accent. */
  draft?: boolean;
  /** A toolbox icon: no label, no hit area. */
  icon?: boolean;
  /** `data-link` and a wide hit area, for the editor's pointer; absent in a view. */
  id?: string;
}

export function LinkShape({ link, route, selected = false, draft = false, icon = false, id }: LinkShapeProps): JSX.Element {
  const hit = id !== undefined && id !== "" && !draft && !icon;
  return (
    <g className={cx(draft && "text-accent")} {...(hit ? { "data-link": id } : {})}>
      {hit && <path className={lineHit} d={linkPath(route)} />}
      {draw(paintLink(link, route, !icon), selected)}
    </g>
  );
}

// ---------------------------------------------------------------------------
// The toolbox's icons: the notation itself, and nothing else
// ---------------------------------------------------------------------------

const ICONS: Readonly<Record<PlaceTool, JSX.Element>> = {
  class: (
    <>
      <rect className={cardFill} x={10} y={3} width={24} height={24} />
      <rect className={headFill} x={10} y={3} width={24} height={8} />
      <path className={thin} d="M10 11H34M10 19H34" />
      <rect className={outline} x={10} y={3} width={24} height={24} />
    </>
  ),
  entity: (
    <>
      <rect className={cardFill} x={10} y={3} width={24} height={24} />
      <rect className={headFill} x={10} y={3} width={24} height={8} />
      <path className={thin} d="M10 11H34" />
      <rect className={outline} x={10} y={3} width={24} height={24} />
    </>
  ),
  actor: (
    <g className={strokeInk}>
      <circle cx={22} cy={6.5} r={3.5} />
      <path d="M22 10v9M16 13.5h12M22 19l-5 7M22 19l5 7" />
    </g>
  ),
  usecase: <ellipse className={shapeInk} cx={22} cy={15} rx={15} ry={8.5} />,
  system: (
    <g className={strokeInk}>
      <rect x={7} y={4} width={30} height={22} />
      <path d="M10.5 9h9" />
    </g>
  ),
  initial: <circle className={dotInk} cx={22} cy={15} r={6} />,
  state: <rect className={shapeInk} x={8} y={7} width={28} height={16} rx={5} />,
  final: (
    <>
      <circle className={outline} cx={22} cy={15} r={8} />
      <circle className={dotInk} cx={22} cy={15} r={4.5} />
    </>
  ),
  terminal: <rect className={shapeInk} x={7} y={9} width={30} height={12} rx={6} />,
  action: <rect className={shapeInk} x={8} y={7} width={28} height={16} rx={1.5} />,
  decision: <path className={shapeInk} d="M22 4L37 15L22 26L7 15Z" />,
  astate: <circle className={shapeInk} cx={22} cy={15} r={10} />,
  accept: (
    <>
      <circle className={shapeInk} cx={22} cy={15} r={10} />
      <circle className={outline} cx={22} cy={15} r={6.5} />
    </>
  ),
  vertex: <circle className={shapeInk} cx={22} cy={15} r={9} />,
  stroke: <path className={strokeInk} d="M8 21c4-9 7-11 10-6s6 5 9-1 5-7 9-3" />,
  line: <path className={strokeInk} d="M9 23L35 7" />,
  rect: <rect className={shapeInk} x={8} y={8} width={28} height={14} />,
  square: <rect className={shapeInk} x={15} y={8} width={14} height={14} />,
  circle: <circle className={shapeInk} cx={22} cy={15} r={8} />,
  ellipse: <ellipse className={shapeInk} cx={22} cy={15} rx={14} ry={7.5} />,
  triangle: <path className={shapeInk} d="M22 6L32 24H12Z" />,
};

export function ToolIcon({ tool }: { tool: PlaceTool }): JSX.Element {
  return (
    <svg viewBox="0 0 44 30" className="h-[22px] w-8" aria-hidden="true">
      {ICONS[tool]}
    </svg>
  );
}

const iconRoute = (y: number, crow: boolean): Route => ({
  pts: [
    [4, y],
    [40, y],
  ],
  a: { x: 4, y, d: crow ? 0 : -1 },
  b: { x: 40, y, d: crow ? 2 : -1 },
});

export function LinkIcon({ type }: { type: LinkType }): JSX.Element {
  const style = LINK_STYLE[type];
  const y = style.label ? 19 : 15;
  return (
    <svg viewBox="0 0 44 30" className="h-[22px] w-10" aria-hidden="true">
      <LinkShape link={{ type, ma: "1", mb: "0..*" }} route={iconRoute(y, style.crow === true)} icon />
      {style.label && (
        <text x={22} y={10} textAnchor="middle" className="fill-current text-[6.5px] font-medium">
          {style.label}
        </text>
      )}
    </svg>
  );
}

export function CardinalityIcon({ card }: { card: Cardinality }): JSX.Element {
  return (
    <svg viewBox="0 0 44 30" className="h-[20px] w-8" aria-hidden="true">
      <path className={line} d="M4 15H40M40 7V23" />
      {draw(paintCrowFoot(card, { x: 40, y: 15, d: 2 }))}
    </svg>
  );
}
