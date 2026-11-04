/**
 * The read-only rendering of a schematic — and the pieces the editor draws
 * with, which live here so there is ONE drawing of a resistor in the package.
 *
 * The view FILLS its box: one `viewBox` over the whole frame plus exactly one
 * grid cell of margin, and `xMidYMid meet`, so the same markup reads on a
 * phone and on a projector. It shows what is STORED — the `points` the editor
 * routed — and never routes anything itself.
 */
import { useId, type JSX } from "react";

import { GRID, MAJOR } from "../library.js";

import { resolveStrings } from "@quiz/core/client";
import { CANVAS_STRINGS, type CanvasStrings } from "./canvasStrings.js";
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
  symbolText,
  wireHit,
  wireLine,
} from "./canvasStyles.js";
import {
  connectedPins,
  fitView,
  GLYPH_RADIUS,
  hitRectOf,
  pinPosition,
  portPosition,
  transform,
  viewBoxAttr,
  type Placement,
} from "./geometry.js";
import { junctionPoints, pathOf } from "./router.js";
import { markPath } from "./symbols.js";
import type {
  CanvasComponent,
  CanvasSchematic,
  CanvasWire,
  SchematicLibrary,
} from "./schematicLibrary.js";

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

/**
 * The grid patterns; drawn INSIDE the box only, which is what {@link Paper}
 * does. The thick line falls every {@link MAJOR} cells from the box origin,
 * which is the lattice the border and the port anchors are laid out on.
 */
export function GridDefs({ id }: { id: string }): JSX.Element {
  const major = GRID * MAJOR;
  return (
    <defs>
      <pattern id={`${id}-min`} width={GRID} height={GRID} patternUnits="userSpaceOnUse">
        <path className={gridMinor} d={`M${GRID} 0H0V${GRID}`} />
      </pattern>
      <pattern id={`${id}-maj`} width={major} height={major} patternUnits="userSpaceOnUse">
        <rect width={major} height={major} fill={`url(#${id}-min)`} />
        <path className={gridMajor} d={`M${major} 0H0V${major}`} />
      </pattern>
    </defs>
  );
}

/** The box the student wires inside: its grid and its outline, nothing else. */
export function Paper({ id, box }: { id: string; box: SchematicLibrary["box"] }): JSX.Element {
  return (
    <g>
      <rect x={0} y={0} width={box.width} height={box.height} fill={`url(#${id}-maj)`} />
      <rect className={boxOutline} x={0} y={0} width={box.width} height={box.height} />
    </g>
  );
}

/**
 * The library's ports on the border (`circuit`'s four), with their labels
 * INSIDE the box: a label hanging outside would be the first thing a narrow
 * viewport clipped.
 */
export function Ports({
  strings,
  library,
  flagged,
  hovered,
}: {
  strings: CanvasStrings;
  library: SchematicLibrary;
  flagged?: readonly string[] | undefined;
  hovered?: string | null | undefined;
}): JSX.Element {
  return (
    <g>
      {library.ports.map(({ name: port }) => {
        const q = portPosition(port, library);
        const right = q.x > library.box.width / 2;
        const isFlagged = flagged?.includes(port) ?? false;
        return (
          <g
            key={port}
            className={cx(isFlagged ? inkFlagged : inkNormal)}
            data-port={port}
          >
            <circle className={portGlyph} cx={q.x} cy={q.y} r={GLYPH_RADIUS.port} />
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

interface ComponentGlyphProps {
  library: SchematicLibrary;
  component: CanvasComponent;
  selected?: boolean | undefined;
  /** A half-transparent preview under the cursor: no label, no mouse target. */
  ghost?: boolean | undefined;
  /** `"c1:0"` for every pin a wire already reaches; those pins are not drawn. */
  connected?: ReadonlySet<string> | undefined;
  flaggedPins?: readonly FlaggedPin[] | undefined;
  hoveredPin?: number | null | undefined;
}

export function ComponentGlyph({
  library,
  component,
  selected = false,
  ghost = false,
  connected,
  flaggedPins,
  hoveredPin,
}: ComponentGlyphProps): JSX.Element {
  const spec = library.part(component.kind);
  const symbol = library.symbol(component.kind, component.name);
  const m = component.m;
  const hit = hitRectOf(component, library);

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
            d={markPath(x, y, mark.sign)}
          />
        );
      })}
      {(symbol.texts ?? []).map((text, i) => {
        const [tx, ty] = transform(m, text.x, text.y);
        return <SymbolLabel key={`t${i}`} x={component.x + tx} y={component.y + ty} text={text.text} />;
      })}
      {spec.pins.map((_, i) => {
        const q = pinPosition(component, i, library);
        if (q === null) return null;
        const isFlagged = flaggedPins?.some((f) => f.c === component.id && f.p === i) ?? false;
        const isHovered = hoveredPin === i;
        if (!isFlagged && !isHovered && (connected?.has(`${component.id}:${i}`) ?? false)) return null;
        return (
          <g key={`p${i}`} className={isFlagged ? inkFlagged : undefined}>
            {isHovered ? (
              <circle className="fill-accent-soft stroke-accent stroke-[1.6]" cx={q.x} cy={q.y} r={6.5} />
            ) : null}
            <circle className={pinDot} cx={q.x} cy={q.y} r={isFlagged ? GLYPH_RADIUS.flaggedPin : GLYPH_RADIUS.pin} />
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

/** A symbol's upright text, centred on its point (`SymbolSpec.texts`). */
function SymbolLabel({ x, y, text }: { x: number; y: number; text: string }): JSX.Element {
  return (
    <text className={symbolText} x={x} y={y} textAnchor="middle" dominantBaseline="central">
      {text}
    </text>
  );
}

export function WireGlyph({
  wire,
  points,
  selected = false,
  ink,
}: {
  wire: CanvasWire;
  points: ReadonlyArray<readonly [number, number]>;
  selected?: boolean | undefined;
  /** The host's ink for this wire (a logic level in play mode); the normal ink when absent. */
  ink?: string | undefined;
}): JSX.Element | null {
  if (points.length < 2) return null;
  const d = pathOf(points);
  return (
    <g className={selected ? inkSelected : (ink ?? inkNormal)} data-wire={wire.id}>
      <path className={wireHit} d={d} />
      <path className={cx(wireLine, selected && "stroke-[2.3]")} d={d} />
    </g>
  );
}

export function Junctions({
  library,
  schematic,
  routes,
}: {
  library: SchematicLibrary;
  schematic: CanvasSchematic;
  routes: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;
}): JSX.Element {
  return (
    <g className={inkNormal}>
      {junctionPoints(schematic, routes, library).map(([x, y]) => (
        <circle key={`${x},${y}`} className={junctionDot} cx={x} cy={y} r={GLYPH_RADIUS.junction} />
      ))}
    </g>
  );
}

/** A small preview of one symbol alone, for a palette tile. */
export function SymbolPreview({
  library,
  kind,
  width = 44,
  height = 24,
}: {
  library: SchematicLibrary;
  kind: string;
  width?: number;
  height?: number;
}): JSX.Element {
  const symbol = library.symbol(kind);
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
          d={markPath(mark.x, mark.y, mark.sign)}
        />
      ))}
      {(symbol.texts ?? []).map((text, i) => (
        <SymbolLabel key={`t${i}`} x={text.x} y={text.y} text={text.text} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

interface SchematicViewProps {
  schematic: CanvasSchematic;
  /** The parts, the box and the ports. */
  library: SchematicLibrary;
  strings?: Partial<CanvasStrings> | undefined;
  className?: string | undefined;
  /** The tallest the drawing gets, in px; it shrinks to fit a narrow column. */
  height?: number | undefined;
  flaggedPins?: readonly FlaggedPin[] | undefined;
  flaggedPorts?: readonly string[] | undefined;
  /** The ink of each wire, by id (a logic level in play mode); the normal ink when it answers nothing. */
  wireInk?: ((wireId: string) => string | undefined) | undefined;
  "aria-label"?: string | undefined;
}

export function SchematicView({
  schematic,
  library,
  strings,
  className,
  height = 320,
  flaggedPins,
  flaggedPorts,
  wireInk,
  "aria-label": ariaLabel,
}: SchematicViewProps): JSX.Element {
  const s = resolveStrings(CANVAS_STRINGS, strings);
  const id = safeId(useId());
  const connected = connectedPins(schematic);
  const routes = new Map<string, ReadonlyArray<readonly [number, number]>>(
    schematic.wires.map((w) => [w.id, w.points]),
  );
  const empty = schematic.components.length === 0 && schematic.wires.length === 0;
  const fit = fitView(library.box);

  return (
    <div className={cx("relative w-full", className)}>
      <svg
        role="img"
        aria-label={ariaLabel ?? s.viewLabel}
        viewBox={viewBoxAttr(fit)}
        preserveAspectRatio="xMidYMid meet"
        /*
         * The same fit as the editor: the drawing IS the frame plus its
         * one-cell margin, so it fills its box on both axes. `maxWidth` is
         * what `maxHeight` alone would not do — capping the height of a
         * full-width SVG letterboxes it instead of narrowing it.
         */
        style={{
          width: "100%",
          maxWidth: Math.round(height * (fit.w / fit.h)),
          height: "auto",
          maxHeight: height,
        }}
        className="mx-auto block"
      >
        <GridDefs id={id} />
        <Paper id={id} box={library.box} />
        <g>
          {schematic.wires.map((w) => (
            <WireGlyph key={w.id} wire={w} points={w.points} ink={wireInk?.(w.id)} />
          ))}
        </g>
        <Junctions library={library} schematic={schematic} routes={routes} />
        <g>
          {schematic.components.map((c) => (
            <ComponentGlyph
              key={c.id}
              library={library}
              component={c}
              connected={connected}
              {...(flaggedPins === undefined ? {} : { flaggedPins })}
            />
          ))}
        </g>
        <Ports strings={s} library={library} {...(flaggedPorts === undefined ? {} : { flagged: flaggedPorts })} />
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
