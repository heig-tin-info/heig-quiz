/**
 * The read-only rendering of a schematic — and the pieces the editor draws
 * with, which live here so there is ONE drawing of a resistor in the package.
 *
 * The view fits its width: one `viewBox` over the whole box, a little bleed so
 * the outline and the ports are not clipped, and `xMidYMid meet`, so the same
 * markup reads on a phone and on a projector. It shows what is STORED — the
 * `points` the editor routed — and never routes anything itself.
 */
import { useId, type JSX } from "react";

import { BOX, GRID, LIBRARY, PORT_IDS, type PortId } from "../library.js";
import type { Schematic, SchematicComponent, Wire } from "../schema.js";

import { CANVAS_STRINGS, withStrings, type CanvasStrings } from "./canvasStrings.js";
import {
  boxOutline,
  componentLabel,
  componentValue,
  cx,
  emptyNote,
  gridMajor,
  gridMinor,
  hitArea,
  inkFlagged,
  inkNormal,
  inkSelected,
  junctionDot,
  pinDot,
  portGlyph,
  portLabel,
  selectedHalo,
  shapeClass,
  wireHit,
  wireLine,
} from "./canvasStyles.js";
import {
  FIT_VIEW,
  hitRectOf,
  pinPosition,
  portPosition,
  transform,
  viewBoxAttr,
  type Placement,
} from "./geometry.js";
import { junctionPoints, pathOf } from "./router.js";
import { SYMBOLS } from "./symbols.js";

/** A pin the host wants flagged — a floating net, a short, whatever it found. */
export interface FlaggedPin {
  readonly c: string;
  readonly p: number;
}

/** React ids carry a colon, which has no business inside a `url(#…)`. */
const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_");

// ---------------------------------------------------------------------------
// The paper: grid, box, ports
// ---------------------------------------------------------------------------

/** The grid patterns; drawn INSIDE the box only, which is what {@link Paper} does. */
export function GridDefs({ id }: { id: string }): JSX.Element {
  return (
    <defs>
      <pattern id={`${id}-min`} width={GRID} height={GRID} patternUnits="userSpaceOnUse">
        <path className={gridMinor} d={`M${GRID} 0H0V${GRID}`} />
      </pattern>
      <pattern id={`${id}-maj`} width={GRID * 5} height={GRID * 5} patternUnits="userSpaceOnUse">
        <rect width={GRID * 5} height={GRID * 5} fill={`url(#${id}-min)`} />
        <path className={gridMajor} d={`M${GRID * 5} 0H0V${GRID * 5}`} />
      </pattern>
    </defs>
  );
}

/** The box the student wires inside: its grid and its outline, nothing else. */
export function Paper({ id }: { id: string }): JSX.Element {
  return (
    <g>
      <rect x={0} y={0} width={BOX.width} height={BOX.height} fill={`url(#${id}-maj)`} />
      <rect className={boxOutline} x={0} y={0} width={BOX.width} height={BOX.height} />
    </g>
  );
}

/**
 * The four ports on the border, with their labels INSIDE the box: a label
 * hanging outside would be the first thing a narrow viewport clipped.
 */
export function Ports({
  strings,
  flagged,
  hovered,
}: {
  strings: CanvasStrings;
  flagged?: readonly PortId[] | undefined;
  hovered?: PortId | null | undefined;
}): JSX.Element {
  return (
    <g>
      {PORT_IDS.map((port) => {
        const q = portPosition(port);
        const right = q.x > BOX.width / 2;
        const isFlagged = flagged?.includes(port) ?? false;
        return (
          <g
            key={port}
            className={cx(isFlagged ? inkFlagged : inkNormal)}
            data-port={port}
          >
            <circle className={portGlyph} cx={q.x} cy={q.y} r={4.5} />
            {hovered === port ? (
              <circle className="fill-accent-soft stroke-accent stroke-[1.6]" cx={q.x} cy={q.y} r={7} />
            ) : null}
            <text
              className={cx(portLabel, isFlagged ? inkFlagged : "text-fg-muted")}
              x={right ? q.x - 9 : q.x + 9}
              y={q.y - 8}
              textAnchor={right ? "end" : "start"}
            >
              {strings.port(port)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export interface ComponentGlyphProps {
  component: SchematicComponent;
  selected?: boolean | undefined;
  /** A half-transparent preview under the cursor: no label, no mouse target. */
  ghost?: boolean | undefined;
  /** `"c1:0"` for every pin a wire already reaches; those pins are not drawn. */
  connected?: ReadonlySet<string> | undefined;
  flaggedPins?: readonly FlaggedPin[] | undefined;
  hoveredPin?: number | null | undefined;
}

export function ComponentGlyph({
  component,
  selected = false,
  ghost = false,
  connected,
  flaggedPins,
  hoveredPin,
}: ComponentGlyphProps): JSX.Element {
  const spec = LIBRARY[component.kind];
  const symbol = SYMBOLS[component.kind];
  const m = component.m;
  const hit = hitRectOf(component);

  const label = spec.label_at;
  let text: JSX.Element | null = null;
  if (label !== null && !ghost) {
    const [lx, ly] = transform(m, label[0], label[1]);
    let anchor: "middle" | "start" | "end" = "middle";
    let dy = "0";
    if (Math.abs(lx) > Math.abs(ly)) {
      anchor = lx > 0 ? "start" : "end";
      dy = "0.35em";
    } else if (ly > 0) {
      dy = "0.8em";
    }
    text = (
      <text
        className={componentLabel}
        x={component.x + lx}
        y={component.y + ly}
        dy={dy}
        textAnchor={anchor}
      >
        <tspan>{component.name}</tspan>
        {component.value !== "" ? (
          <tspan className={componentValue} dx={6}>
            {component.value}
          </tspan>
        ) : null}
      </text>
    );
  }

  return (
    <g
      className={cx(selected ? inkSelected : inkNormal, ghost && "opacity-50")}
      {...(ghost ? {} : { "data-component": component.id })}
    >
      {selected ? (
        <rect
          className={selectedHalo}
          x={hit.x0}
          y={hit.y0}
          width={hit.x1 - hit.x0}
          height={hit.y1 - hit.y0}
          rx={3}
        />
      ) : null}
      {ghost ? null : (
        <rect
          className={hitArea}
          x={hit.x0}
          y={hit.y0}
          width={hit.x1 - hit.x0}
          height={hit.y1 - hit.y0}
          rx={3}
        />
      )}
      <g transform={`matrix(${m.join(" ")} ${component.x} ${component.y})`}>
        {symbol.shapes.map((shape, i) => (
          <path key={i} className={shapeClass(shape.paint)} d={shape.d} />
        ))}
      </g>
      {/* The `+` and `−` of an op-amp move with the symbol but stay upright:
          a minus sign turned on its side is a plus sign. */}
      {symbol.marks.map((mark, i) => {
        const [mx, my] = transform(m, mark.x, mark.y);
        const x = component.x + mx;
        const y = component.y + my;
        return (
          <path
            key={`m${i}`}
            className="fill-none stroke-current stroke-[1.4] [stroke-linecap:round]"
            d={`M${x - 3.5} ${y}h7${mark.sign === "+" ? `M${x} ${y - 3.5}v7` : ""}`}
          />
        );
      })}
      {spec.pins.map((_, i) => {
        const q = pinPosition(component, i);
        if (q === null) return null;
        const isFlagged = flaggedPins?.some((f) => f.c === component.id && f.p === i) ?? false;
        const isHovered = hoveredPin === i;
        if (!isFlagged && !isHovered && (connected?.has(`${component.id}:${i}`) ?? false)) return null;
        return (
          <g key={`p${i}`} className={isFlagged ? inkFlagged : undefined}>
            {isHovered ? (
              <circle className="fill-accent-soft stroke-accent stroke-[1.6]" cx={q.x} cy={q.y} r={6.5} />
            ) : null}
            <circle className={pinDot} cx={q.x} cy={q.y} r={isFlagged ? 4 : 2.6} />
          </g>
        );
      })}
      {text}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Wires
// ---------------------------------------------------------------------------

export function WireGlyph({
  wire,
  points,
  selected = false,
}: {
  wire: Wire;
  points: ReadonlyArray<readonly [number, number]>;
  selected?: boolean | undefined;
}): JSX.Element | null {
  if (points.length < 2) return null;
  const d = pathOf(points);
  return (
    <g className={selected ? inkSelected : inkNormal} data-wire={wire.id}>
      <path className={wireHit} d={d} />
      <path className={cx(wireLine, selected && "stroke-[2.3]")} d={d} />
    </g>
  );
}

export function Junctions({
  schematic,
  routes,
}: {
  schematic: Schematic;
  routes: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;
}): JSX.Element {
  return (
    <g className={inkNormal}>
      {junctionPoints(schematic, routes).map(([x, y]) => (
        <circle key={`${x},${y}`} className={junctionDot} cx={x} cy={y} r={3.6} />
      ))}
    </g>
  );
}

/** `"c1:0"` for every pin a wire ends on: those pins are drawn by the wire, not twice. */
export function connectedPins(schematic: Schematic): Set<string> {
  const set = new Set<string>();
  for (const w of schematic.wires) {
    for (const e of [w.a, w.b]) {
      if (e.kind === "pin") set.add(`${e.c}:${e.p}`);
    }
  }
  return set;
}

/** A small preview of one symbol alone, for a palette tile. */
export function SymbolPreview({
  kind,
  width = 44,
  height = 24,
}: {
  kind: SchematicComponent["kind"];
  width?: number;
  height?: number;
}): JSX.Element {
  const symbol = SYMBOLS[kind];
  return (
    <svg
      viewBox={symbol.viewBox}
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
      className="block"
    >
      {symbol.shapes.map((shape, i) => (
        <path key={i} className={shapeClass(shape.paint)} d={shape.d} />
      ))}
      {symbol.marks.map((mark, i) => (
        <path
          key={`m${i}`}
          className="fill-none stroke-current stroke-[1.4] [stroke-linecap:round]"
          d={`M${mark.x - 3.5} ${mark.y}h7${mark.sign === "+" ? `M${mark.x} ${mark.y - 3.5}v7` : ""}`}
        />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface SchematicViewProps {
  schematic: Schematic;
  strings?: Partial<CanvasStrings> | undefined;
  className?: string | undefined;
  /** The tallest the drawing gets, in px; it shrinks to fit a narrow column. */
  height?: number | undefined;
  flaggedPins?: readonly FlaggedPin[] | undefined;
  flaggedPorts?: readonly PortId[] | undefined;
  "aria-label"?: string | undefined;
}

export function SchematicView({
  schematic,
  strings,
  className,
  height = 320,
  flaggedPins,
  flaggedPorts,
  "aria-label": ariaLabel,
}: SchematicViewProps): JSX.Element {
  const s = withStrings(CANVAS_STRINGS, strings);
  const id = safeId(useId());
  const connected = connectedPins(schematic);
  const routes = new Map<string, ReadonlyArray<readonly [number, number]>>(
    schematic.wires.map((w) => [w.id, w.points]),
  );
  const empty = schematic.components.length === 0 && schematic.wires.length === 0;

  return (
    <div className={cx("relative w-full", className)}>
      <svg
        role="img"
        aria-label={ariaLabel ?? s.viewLabel}
        viewBox={viewBoxAttr(FIT_VIEW)}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "auto", maxHeight: height }}
        className="block"
      >
        <GridDefs id={id} />
        <Paper id={id} />
        <g>
          {schematic.wires.map((w) => (
            <WireGlyph key={w.id} wire={w} points={w.points} />
          ))}
        </g>
        <Junctions schematic={schematic} routes={routes} />
        <g>
          {schematic.components.map((c) => (
            <ComponentGlyph
              key={c.id}
              component={c}
              connected={connected}
              {...(flaggedPins === undefined ? {} : { flaggedPins })}
            />
          ))}
        </g>
        <Ports strings={s} {...(flaggedPorts === undefined ? {} : { flagged: flaggedPorts })} />
      </svg>
      {empty ? (
        <span className={cx(emptyNote, "pointer-events-none absolute inset-0 grid place-items-center")}>
          {s.emptySchematic}
        </span>
      ) : null}
    </div>
  );
}

/** Re-exported for the editor, which needs the same shapes under its own ink. */
export type { Placement };
