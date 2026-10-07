/**
 * A squarified treemap layout (Bruls, Huizing & van Wijk, 2000), pure: each
 * item gets a rectangle whose area is its share of the total, and the
 * rectangles tile `width × height` without overlapping, as close to squares
 * as the greedy row-by-row placement allows — a square cell is the one a
 * label fits in.
 *
 * Items with a value of zero or less get no cell: a share of nothing has no
 * area. The cells come out in decreasing value (ties keep their input order).
 */
export interface TreemapCell<T> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The worst aspect ratio of a row of `areas` laid along a side of `side`. */
function worst(areas: readonly number[], side: number): number {
  const sum = areas.reduce((s, a) => s + a, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/** Lays one row along the shorter side of `rect`, and returns what is left. */
function layRow<T>(row: readonly { item: T; area: number }[], rect: Rect, out: TreemapCell<T>[]): Rect {
  const sum = row.reduce((s, r) => s + r.area, 0);
  if (rect.w >= rect.h) {
    // A column at the left edge, its cells stacked top to bottom.
    const thick = rect.h > 0 ? sum / rect.h : 0;
    let y = rect.y;
    for (const r of row) {
      const h = thick > 0 ? r.area / thick : 0;
      out.push({ item: r.item, x: rect.x, y, w: thick, h });
      y += h;
    }
    return { x: rect.x + thick, y: rect.y, w: rect.w - thick, h: rect.h };
  }
  // A row along the top edge, its cells left to right.
  const thick = rect.w > 0 ? sum / rect.w : 0;
  let x = rect.x;
  for (const r of row) {
    const w = thick > 0 ? r.area / thick : 0;
    out.push({ item: r.item, x, y: rect.y, w, h: thick });
    x += w;
  }
  return { x: rect.x, y: rect.y + thick, w: rect.w, h: rect.h - thick };
}

export function squarify<T>(
  items: readonly T[],
  value: (item: T) => number,
  width: number,
  height: number,
): TreemapCell<T>[] {
  const positive = items
    .map((item, index) => ({ item, index, v: value(item) }))
    .filter((e) => e.v > 0)
    .sort((a, b) => b.v - a.v || a.index - b.index);
  const total = positive.reduce((s, e) => s + e.v, 0);
  if (total === 0 || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const queue = positive.map((e) => ({ item: e.item, area: e.v * scale }));

  const out: TreemapCell<T>[] = [];
  let rect: Rect = { x: 0, y: 0, w: width, h: height };
  let row: { item: T; area: number }[] = [];
  for (const next of queue) {
    const side = Math.min(rect.w, rect.h);
    const areas = row.map((r) => r.area);
    if (row.length === 0 || worst([...areas, next.area], side) <= worst(areas, side)) {
      row.push(next);
    } else {
      rect = layRow(row, rect, out);
      row = [next];
    }
  }
  if (row.length > 0) layRow(row, rect, out);
  return out;
}
