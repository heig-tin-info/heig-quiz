/**
 * A warehouse, drawn: the map of the player's simulation, the review's trail
 * and the thumbnails of the case table (DESIGN.md, "The blocks workspace").
 *
 * Monochrome on the recessed `surface-2`, hairline cells: racks are rounded
 * rects with two shelf lines, the dock a dashed `info` cell labelled DOCK,
 * the robot an ink rounded square whose chevron points where it faces, the
 * trail small dots. `danger` only for a robot that hit something. The map
 * is the domain's (`parseMap`); this file only draws it.
 */
import type { ReactNode } from "react";

import { parseMap, type GridMap, type Heading } from "@quiz/domain/blocks";
import { cx } from "@quiz/ui";

/** One cell of the player's map, in viewBox units (DESIGN.md: 44 px). */
export const CELL = 44;

export interface Pose {
  x: number;
  y: number;
  heading: Heading;
}

/** The map of a case, or `null` for rows the domain refuses (a draft being drawn). */
export function mapOf(rows: readonly string[]): GridMap | null {
  try {
    return parseMap(rows);
  } catch {
    return null;
  }
}

function Rack({ x, y, cell, shelves }: { x: number; y: number; cell: number; shelves: boolean }) {
  const pad = shelves ? 5 : 1;
  const side = cell - 2 * pad;
  return (
    <g transform={`translate(${x * cell + pad} ${y * cell + pad})`}>
      <rect width={side} height={side} rx={shelves ? 3 : 1} className="fill-fg-faint/60" />
      {shelves
        ? [0.33, 0.66].map((at) => (
            <line key={at} x1={3} x2={side - 3} y1={side * at} y2={side * at} strokeWidth={2} className="stroke-surface-2" />
          ))
        : null}
    </g>
  );
}

/** The robot at the centre of its cell, turned to its heading; it glides from cell to cell. */
export function Robot({ pose, cell, crashed = false }: { pose: Pose; cell: number; crashed?: boolean }) {
  const body = cell * 0.62;
  return (
    <g
      data-testid="robot"
      className="transition-transform duration-200 ease-out motion-reduce:transition-none"
      style={{ transform: `translate(${pose.x * cell + cell / 2}px, ${pose.y * cell + cell / 2}px) rotate(${pose.heading * 90}deg)` }}
    >
      <rect x={-body / 2} y={-body / 2} width={body} height={body} rx={7} className={crashed ? "fill-danger" : "fill-fg"} />
      <path
        d={`M ${-body * 0.22} ${body * 0.12} L 0 ${-body * 0.2} L ${body * 0.22} ${body * 0.12}`}
        fill="none"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-surface"
      />
    </g>
  );
}

export function WarehouseMap({
  rows,
  pose = null,
  trail = [],
  crashed = false,
  ended = false,
  label,
  dockLabel,
  className,
}: {
  rows: readonly string[];
  /** The robot; `null` draws it at its start. */
  pose?: Pose | null;
  /**
   * A finished run read from a grading (the review): no robot, whose heading
   * the stored trail does not hold; every cell walked is dotted and the last
   * one ringed — in `danger` after a collision.
   */
  ended?: boolean;
  /** The cells walked, start first; the robot's own cell is not dotted. */
  trail?: readonly { x: number; y: number }[];
  crashed?: boolean;
  label: string;
  dockLabel: string;
  className?: string;
}): ReactNode {
  const map = mapOf(rows);
  if (map === null) return null;
  const cell = CELL;
  const robot = pose ?? map.start;
  const cells = Array.from({ length: map.width * map.height }, (_, i) => ({ x: i % map.width, y: Math.floor(i / map.width) }));
  return (
    <svg
      viewBox={`0 0 ${map.width * cell} ${map.height * cell}`}
      role="img"
      aria-label={label}
      className={cx("block h-auto w-full rounded-field border border-line bg-surface-2", className)}
    >
      {cells.map(({ x, y }) => (
        <rect key={`${x},${y}`} x={x * cell} y={y * cell} width={cell} height={cell} fill="none" className="stroke-line" />
      ))}
      {[...map.racks].map((key) => {
        const [x, y] = key.split(",").map(Number);
        return <Rack key={key} x={x!} y={y!} cell={cell} shelves />;
      })}
      <rect
        x={map.dock.x * cell + 3}
        y={map.dock.y * cell + 3}
        width={cell - 6}
        height={cell - 6}
        rx={4}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        className="fill-info-soft stroke-info"
      />
      <text
        x={map.dock.x * cell + cell / 2}
        y={map.dock.y * cell + cell / 2 + 3.5}
        textAnchor="middle"
        fontSize={11}
        fontWeight={600}
        className="fill-info font-mono"
      >
        {dockLabel}
      </text>
      {(ended ? trail : trail.slice(0, -1)).map((step, i) => (
        <circle key={i} cx={step.x * cell + cell / 2} cy={step.y * cell + cell / 2} r={3.5} opacity={0.45} className="fill-fg-faint" />
      ))}
      {ended ? (
        trail.length === 0 ? null : (
          <circle
            data-testid="trail-end"
            cx={trail[trail.length - 1]!.x * cell + cell / 2}
            cy={trail[trail.length - 1]!.y * cell + cell / 2}
            r={cell * 0.3}
            fill="none"
            strokeWidth={2.4}
            className={crashed ? "stroke-danger" : "stroke-fg"}
          />
        )
      ) : (
        <Robot pose={robot} cell={cell} crashed={crashed} />
      )}
    </svg>
  );
}

/** The thumbnail of a case's row: the plan alone, 5 px a cell, no robot but its start. */
export function MapThumbnail({ rows }: { rows: readonly string[] }): ReactNode {
  const map = mapOf(rows);
  if (map === null) return null;
  const cell = 5;
  return (
    <svg
      width={map.width * cell}
      height={map.height * cell}
      viewBox={`0 0 ${map.width * cell} ${map.height * cell}`}
      aria-hidden="true"
      className="block shrink-0 rounded-xs border border-line bg-surface-2"
    >
      {[...map.racks].map((key) => {
        const [x, y] = key.split(",").map(Number);
        return <Rack key={key} x={x!} y={y!} cell={cell} shelves={false} />;
      })}
      <rect x={map.dock.x * cell} y={map.dock.y * cell} width={cell} height={cell} className="fill-info" />
      <rect x={map.start.x * cell + 1} y={map.start.y * cell + 1} width={cell - 2} height={cell - 2} className="fill-fg" />
    </svg>
  );
}
