/**
 * The SVG of an element and of a link, shared by the editor and the view.
 * Pure: a shape is a function of its data and of the layout's route.
 */
import { DIRS } from "@quiz/domain/gridRouter";
import type { JSX } from "react";

import { FINAL_RADIUS, HEAD, INITIAL_RADIUS, PAD, PSEUDO, ROW, bodyCompartments, member, sizeOf, wrapName, wrapWidth, type Measure } from "../geometry.js";
import { CIRCLES, FLOW_NODES, INK, LINK_STYLE, SHAPES, type PlaceTool } from "../kinds.js";
import { type End, type Route } from "../layout.js";
import type { Cardinality, DiagramLink, DiagramNode, LinkType } from "../scene.js";
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

type XY = readonly [number, number];

/** A brush stroke, smoothed through the midpoints of its points. */
export function inkPath(pts: readonly XY[]): string {
  if (pts.length < 3) return `M${pts.map((q) => `${q[0]} ${q[1]}`).join("L")}`;
  const first = pts[0] as XY;
  let d = `M${first[0]} ${first[1]}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p = pts[i] as XY;
    const q = pts[i + 1] as XY;
    d += `Q${p[0]} ${p[1]} ${(p[0] + q[0]) / 2} ${(p[1] + q[1]) / 2}`;
  }
  const last = pts[pts.length - 1] as XY;
  return `${d}L${last[0]} ${last[1]}`;
}

const polyline = (pts: readonly XY[]): string => `M${pts.map((q) => `${q[0]} ${q[1]}`).join("L")}`;

/** Centred lines of text, 16 apart, around `cy`. */
function Lines({ lines, cx: x, cy }: { lines: readonly string[]; cx: number; cy: number }): JSX.Element {
  const y0 = cy - (lines.length - 1) * 8 + 4.5;
  return (
    <>
      {lines.map((l, i) => (
        <text key={i} className={labelText} x={x} y={y0 + i * 16} textAnchor="middle">
          {l}
        </text>
      ))}
    </>
  );
}

export interface NodeShapeProps {
  node: DiagramNode;
  measure: Measure;
  selected?: boolean;
  ghost?: boolean;
}

export function NodeShape({ node: n, measure, selected = false, ghost = false }: NodeShapeProps): JSX.Element {
  const { w, h } = sizeOf(n, measure);
  const mid = w / 2;
  const name = n.name ?? "";
  let body: JSX.Element;
  if (INK.has(n.t)) {
    const pts = n.pts ?? [];
    body = <path className={strokeInk} d={n.t === "stroke" ? inkPath(pts) : polyline(pts)} />;
  } else if (SHAPES.has(n.t)) {
    body = (
      <>
        {n.t === "circle" || n.t === "ellipse" ? (
          <ellipse className={shapeInk} cx={mid} cy={h / 2} rx={mid} ry={h / 2} />
        ) : n.t === "triangle" ? (
          <path className={shapeInk} d={`M${mid} 0L${w} ${h}L0 ${h}Z`} />
        ) : (
          <rect className={shapeInk} width={w} height={h} />
        )}
        {name && <Lines lines={[name]} cx={mid} cy={n.t === "triangle" ? h * 0.66 : h / 2} />}
      </>
    );
  } else if (n.t === "initial") {
    body = <circle className={dotInk} cx={PSEUDO / 2} cy={PSEUDO / 2} r={INITIAL_RADIUS} />;
  } else if (n.t === "final") {
    body = (
      <>
        <circle className={outline} cx={PSEUDO / 2} cy={PSEUDO / 2} r={FINAL_RADIUS} />
        <circle className={dotInk} cx={PSEUDO / 2} cy={PSEUDO / 2} r={FINAL_RADIUS - 4.5} />
      </>
    );
  } else if (CIRCLES.has(n.t)) {
    body = (
      <>
        <circle className={shapeInk} cx={mid} cy={h / 2} r={mid} />
        {n.accept && <circle className={outline} cx={mid} cy={h / 2} r={mid - 4} />}
        {n.initial && (
          <>
            <path className={line} d={`M-30 ${h / 2}H-2`} />
            <Head kind="arrowF" aim={[[-30, h / 2], [0, h / 2]]} />
          </>
        )}
        <Lines lines={[name]} cx={mid} cy={h / 2} />
      </>
    );
  } else if (n.t === "actor") {
    body = (
      <>
        <path className={strokeInk} d="M20 17V38M8 24H32M20 38L10 54M20 38L30 54" />
        <circle className={strokeInk} cx={20} cy={10} r={7} />
        <text className={labelText} x={mid} y={72} textAnchor="middle">
          {name}
        </text>
      </>
    );
  } else if (n.t === "usecase") {
    body = (
      <>
        <ellipse className={shapeInk} cx={mid} cy={h / 2} rx={mid} ry={h / 2} />
        <Lines lines={wrapName(name, wrapWidth(n), measure)} cx={mid} cy={h / 2} />
      </>
    );
  } else if (n.t === "system") {
    body = (
      <>
        <rect className={cx(outline, "stroke-[1.4]")} width={w} height={h} />
        <text className={cx(nameText, "text-[13px]")} x={12} y={20}>
          {name}
        </text>
      </>
    );
  } else if (FLOW_NODES.has(n.t)) {
    body = (
      <>
        {n.t === "decision" ? (
          <path className={shapeInk} d={`M${mid} 0L${w} ${h / 2}L${mid} ${h}L0 ${h / 2}Z`} />
        ) : (
          <rect className={shapeInk} width={w} height={h} rx={n.t === "terminal" ? h / 2 : 3} />
        )}
        <Lines lines={wrapName(name, wrapWidth(n), measure)} cx={mid} cy={h / 2} />
      </>
    );
  } else if (n.t === "state") {
    const lines = n.body ?? [];
    body = (
      <>
        <rect className={shapeInk} width={w} height={h} rx={10} />
        <text className={labelText} x={mid} y={25} textAnchor="middle">
          {name}
        </text>
        {lines.length > 0 && <path className={thin} d={`M0 ${HEAD}H${w}`} />}
        {lines.map((l, i) => (
          <text key={i} className={memberText} x={10} y={HEAD + PAD / 2 + i * ROW + 14}>
            {l}
          </text>
        ))}
      </>
    );
  } else {
    body = <Box node={n} w={w} h={h} />;
  }
  return (
    <g className={cx(ghost && "pointer-events-none opacity-50")} transform={`translate(${n.x} ${n.y})`}>
      {selected && <rect className={selectedHalo} x={-4} y={-4} width={w + 8} height={h + 8} rx={3} />}
      {body}
    </g>
  );
}

/** A class or an entity: a header, then compartments. */
function Box({ node: n, w, h }: { node: DiagramNode; w: number; h: number }): JSX.Element {
  const entity = n.t === "entity";
  let y = HEAD;
  const seps: string[] = [];
  const texts: JSX.Element[] = [];
  for (const lines of bodyCompartments(n)) {
    seps.push(`M0 ${y}H${w}`);
    lines.forEach((raw, i) => {
      const m = member(raw, entity);
      texts.push(
        <text
          key={`${y}-${i}`}
          className={cx(memberText, m.underline && "underline", m.italic && "italic")}
          x={10}
          y={y + PAD / 2 + i * ROW + 14}
        >
          {m.text}
        </text>,
      );
    });
    y += lines.length * ROW + PAD;
  }
  const name = n.name ?? "";
  return (
    <>
      <rect className={cardFill} width={w} height={h} />
      <rect className={headFill} width={w} height={HEAD} />
      {seps.length > 0 && <path className={thin} d={seps.join("")} />}
      <rect className={outline} width={w} height={h} />
      {n.stereo ? (
        <text className={stereoText} x={w / 2} y={16} textAnchor="middle">
          «{n.stereo}»
        </text>
      ) : null}
      <text className={cx(nameText, n.abstract && "italic")} x={w / 2} y={n.stereo ? 33 : 25} textAnchor="middle">
        {name}
      </text>
      {texts}
    </>
  );
}

/** The head at a line's end, aimed along the two points. */
function Head({ kind, aim }: { kind: NonNullable<(typeof LINK_STYLE)[LinkType]["head"]>; aim: readonly [XY, XY] }): JSX.Element | null {
  const [p, b] = aim;
  const len = Math.hypot(b[0] - p[0], b[1] - p[1]);
  if (len === 0) return null;
  const ux = (b[0] - p[0]) / len;
  const uy = (b[1] - p[1]) / len;
  const at = (a: number, s: number): string => `${b[0] - ux * a - uy * s} ${b[1] - uy * a + ux * s}`;
  if (kind === "open") return <path className={cx(headInk, "fill-none")} d={`M${at(12, 6)}L${at(0, 0)}L${at(12, -6)}`} />;
  if (kind === "arrowF") return <path className={cx(headInk, "fill-current")} d={`M${at(0, 0)}L${at(11, 5)}L${at(11, -5)}Z`} />;
  if (kind === "tri") return <path className={cx(headInk, "fill-surface")} d={`M${at(0, 0)}L${at(15, 8)}L${at(15, -8)}Z`} />;
  return <path className={cx(headInk, kind === "diaF" ? "fill-current" : "fill-surface")} d={`M${at(0, 0)}L${at(10, 6)}L${at(20, 0)}L${at(10, -6)}Z`} />;
}

/** Crow's foot at an entity end; `end.d` points away from the entity. */
function CrowFoot({ card, end }: { card: string | undefined; end: End }): JSX.Element | null {
  if (!card || end.d < 0) return null;
  const u = DIRS[end.d] ?? [1, 0];
  const at = (a: number, s: number): string => `${end.x + u[0] * a - u[1] * s} ${end.y + u[1] * a + u[0] * s}`;
  const bar = (t: number): string => `M${at(t, -6)}L${at(t, 6)}`;
  const many = `M${at(12, 0)}L${at(0, -7)}M${at(12, 0)}L${at(0, 7)}`;
  const ring = (t: number): JSX.Element => <circle className={cx(headInk, "fill-surface")} cx={end.x + u[0] * t} cy={end.y + u[1] * t} r={4} />;
  const c = card as Cardinality;
  const [d, r] = c === "1" ? [bar(7) + bar(13), null] : c === "0..1" ? [bar(7), ring(18)] : c === "1..*" ? [many + bar(16), null] : [many, ring(18)];
  return (
    <>
      <path className={cx(headInk, "fill-none")} d={d} />
      {r}
    </>
  );
}

/** Where a label sits off an end leaving right, down, left or up. */
const END_LABEL: Readonly<Record<0 | 1 | 2 | 3, readonly [number, number, "start" | "end"]>> = {
  0: [5, -11, "start"],
  1: [11, 15, "start"],
  2: [-5, -11, "end"],
  3: [11, -6, "start"],
};

/** A multiplicity, or a flowchart's label, set just off an end. */
function EndLabel({ text, end, mono }: { text: string | undefined; end: End; mono: boolean }): JSX.Element | null {
  if (!text || end.d < 0) return null;
  const [dx, dy, anchor] = END_LABEL[end.d as 0 | 1 | 2 | 3];
  return (
    <text className={mono ? lineLabelMono : lineLabel} x={end.x + dx} y={end.y + dy} textAnchor={anchor}>
      {text}
    </text>
  );
}

/** A name on the longest segment of an orthogonal line. */
function MidLabel({ text, pts, mono }: { text: string; pts: readonly XY[]; mono: boolean }): JSX.Element {
  let best = 0;
  let at = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i] as XY;
    const b = pts[i + 1] as XY;
    const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    if (len > best) {
      best = len;
      at = i;
    }
  }
  const a = pts[at] as XY;
  const b = (pts[at + 1] ?? a) as XY;
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const cls = mono ? lineLabelMono : lineLabel;
  return a[1] === b[1] ? (
    <text className={cls} x={mx} y={my - 7} textAnchor="middle">
      {text}
    </text>
  ) : (
    <text className={cls} x={mx + 8} y={my + 4}>
      {text}
    </text>
  );
}

export interface LinkShapeProps {
  link: Pick<DiagramLink, "type"> & Partial<Pick<DiagramLink, "name" | "ma" | "mb">>;
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
  const style = LINK_STYLE[link.type];
  const d = route.path ?? polyline(route.pts);
  const last = route.pts[route.pts.length - 1] as XY;
  const before = route.pts[route.pts.length - 2] ?? last;
  const aim = route.aim ?? ([before, last] as const);
  const mono = style.mono === true;
  const text = style.label ?? link.name;
  return (
    <g className={cx(draft && "text-accent")} {...(id && !draft && !icon ? { "data-link": id } : {})}>
      {id && !draft && !icon && <path className={lineHit} d={d} />}
      <path className={cx(line, style.dash && dashed, selected && lineSelected)} d={d} />
      {style.head && <Head kind={style.head} aim={aim} />}
      {style.crow && (
        <>
          <CrowFoot card={link.ma} end={route.a} />
          <CrowFoot card={link.mb} end={route.b} />
        </>
      )}
      {!icon && !style.crow && (
        <>
          <EndLabel text={link.ma} end={route.a} mono />
          <EndLabel text={link.mb} end={route.b} mono />
        </>
      )}
      {!icon && text ? (
        route.label ? (
          <text className={mono ? lineLabelMono : lineLabel} x={route.label.x} y={route.label.y + 4} textAnchor="middle">
            {text}
          </text>
        ) : style.labelAtStart ? (
          <EndLabel text={text} end={route.a} mono={mono} />
        ) : (
          <MidLabel text={text} pts={route.pts} mono={mono} />
        )
      ) : null}
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
      <CrowFoot card={card} end={{ x: 40, y: 15, d: 2 }} />
    </svg>
  );
}
