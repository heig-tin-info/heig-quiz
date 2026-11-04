/**
 * A warehouse as a printed figure (ADR-126 §1, §8): the map of
 * `WarehouseMap.tsx` written as a closed `Drawing` of `@quiz/docexport`, in
 * the printer's black and greys. Pure: no React, no DOM; the map is the
 * domain's (`parseMap`), this file only draws it.
 *
 * Hairline cells, racks as grey rounded squares with two shelf lines, the
 * dock a dashed cell labelled in the reader's language, the robot an ink
 * rounded square whose chevron points where it faces. A key may add the
 * reference's trail: a dot on every cell walked, the last one ringed.
 */
import type { Drawing, DrawingItem, Matrix } from "@quiz/docexport";
import { parseMap, type GridMap, type Heading } from "@quiz/domain/blocks";

/** One cell, in drawing units: the player's 44 px. */
export const MAP_CELL = 44;

/** A printed cell, in millimetres: a 12-cell map stays within 120 mm. */
export const MAP_CELL_MM = 10;

/**
 * The map's geometry, one source for the screen (`WarehouseMap.tsx`) and the
 * paper: a rack's padding and corner (the full map's, then the thumbnail's
 * flat one), its two shelf lines, the robot's body and chevron.
 */
export const RACK = {
  shelves: { pad: 5, rx: 3 },
  flat: { pad: 1, rx: 1 },
  /** How far a shelf line stops short of the rack's sides. */
  shelfInset: 3,
} as const;
/** Where the two shelf lines cross a rack, as fractions of its side. */
export const SHELVES = [0.33, 0.66] as const;
/** The robot's body, as a fraction of a cell, and its corner. */
export const ROBOT_BODY = 0.62;
export const ROBOT_RX = 7;

/** The robot's chevron, pointing up, on a body of side `body` centred on the origin. */
export const robotChevron = (body: number): string =>
  `M ${-body * 0.22} ${body * 0.12} L 0 ${-body * 0.2} L ${body * 0.22} ${body * 0.12}`;

export interface MapFigureOptions {
  /** The dock's word, in the reader's language (`DOCK`, `QUAI`). */
  dockLabel: string;
  /** The cells walked, start first: a dot on each between the start and the last, which is ringed. */
  trail?: readonly { x: number; y: number }[];
}

const rack = (x: number, y: number): DrawingItem => {
  const { pad, rx } = RACK.shelves;
  const side = MAP_CELL - 2 * pad;
  const left = x * MAP_CELL + pad;
  const top = y * MAP_CELL + pad;
  return {
    kind: "g",
    items: [
      { kind: "rect", x: left, y: top, w: side, h: side, rx, fill: "grey", stroke: "none" },
      ...SHELVES.map(
        (at): DrawingItem => ({
          kind: "line",
          x1: left + RACK.shelfInset,
          x2: left + side - RACK.shelfInset,
          y1: top + side * at,
          y2: top + side * at,
          stroke: "paper",
          width: 2,
        }),
      ),
    ],
  };
};

/** The robot at the centre of its cell, turned a quarter per heading step (0 faces up). */
function robot(start: { x: number; y: number; heading: Heading }): DrawingItem {
  const body = MAP_CELL * ROBOT_BODY;
  const angle = (start.heading * Math.PI) / 2;
  const cos = Math.round(Math.cos(angle));
  const sin = Math.round(Math.sin(angle));
  const transform: Matrix = [cos, sin, -sin, cos, start.x * MAP_CELL + MAP_CELL / 2, start.y * MAP_CELL + MAP_CELL / 2];
  return {
    kind: "g",
    transform,
    items: [
      { kind: "rect", x: -body / 2, y: -body / 2, w: body, h: body, rx: ROBOT_RX, fill: "ink", stroke: "none" },
      {
        kind: "path",
        d: robotChevron(body),
        stroke: "paper",
        width: 2.4,
      },
    ],
  };
}

const centre = (v: number) => v * MAP_CELL + MAP_CELL / 2;

function trailItems(trail: readonly { x: number; y: number }[]): DrawingItem[] {
  if (trail.length < 2) return [];
  const last = trail[trail.length - 1]!;
  return [
    // The start holds the robot and the last cell its ring: neither is dotted.
    ...trail.slice(1, -1).map((step): DrawingItem => ({
      kind: "ellipse",
      cx: centre(step.x),
      cy: centre(step.y),
      rx: 3.5,
      ry: 3.5,
      fill: "grey",
      stroke: "none",
    })),
    // Wide enough to ring the dock's word rather than cross it.
    { kind: "ellipse", cx: centre(last.x), cy: centre(last.y), rx: MAP_CELL * 0.45, ry: MAP_CELL * 0.45, width: 2.4 },
  ];
}

/** The figure of a parsed map. */
export function gridFigure(map: GridMap, options: MapFigureOptions): Drawing {
  const width = map.width * MAP_CELL;
  const height = map.height * MAP_CELL;
  const cells = Array.from({ length: map.width * map.height }, (_, i): DrawingItem => ({
    kind: "rect",
    x: (i % map.width) * MAP_CELL,
    y: Math.floor(i / map.width) * MAP_CELL,
    w: MAP_CELL,
    h: MAP_CELL,
    stroke: "faint",
    width: 1,
  }));
  const racks = [...map.racks].map((key) => {
    const [x, y] = key.split(",").map(Number);
    return rack(x!, y!);
  });
  const dock: DrawingItem[] = [
    {
      kind: "rect",
      x: map.dock.x * MAP_CELL + 3,
      y: map.dock.y * MAP_CELL + 3,
      w: MAP_CELL - 6,
      h: MAP_CELL - 6,
      rx: 4,
      width: 1.5,
      dash: [4, 3],
    },
    {
      kind: "text",
      x: centre(map.dock.x),
      y: centre(map.dock.y),
      text: options.dockLabel,
      anchor: "middle",
      baseline: "middle",
      size: 11,
      weight: "bold",
    },
  ];
  return {
    // A unit of margin: the frame's stroke straddles the edge and would be clipped.
    viewBox: [-1, -1, width + 2, height + 2],
    items: [
      ...cells,
      ...racks,
      ...dock,
      ...trailItems(options.trail ?? []),
      robot(map.start),
      { kind: "rect", x: 0, y: 0, w: width, h: height, width: 1.5 },
    ],
  };
}

/** The figure of a case's rows, or `null` for rows the domain refuses. */
export function mapFigure(rows: readonly string[], options: MapFigureOptions): Drawing | null {
  try {
    return gridFigure(parseMap(rows), options);
  } catch {
    return null;
  }
}
