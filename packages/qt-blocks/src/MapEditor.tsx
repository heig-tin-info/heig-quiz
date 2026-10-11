/**
 * The teacher's grid over a warehouse's ASCII rows (ADR-103 §6): a click
 * cycles floor and rack; the Start tool places the robot and turns it on a
 * second click; the Dock tool moves the dock. The rows stay the stored
 * truth: every edit writes rows, and a map the domain refuses is said by the
 * schema's issue under the grid, never repaired behind the teacher's back.
 */
import { useState, type ReactNode } from "react";

import { fmt } from "@quiz/core/client";
import { MAP_SIZE } from "@quiz/domain/blocks";
import { cx, NumberField, Segmented } from "@quiz/ui";

import type { BlocksEditorStrings } from "./strings.js";

type Tool = "rack" | "start" | "dock";

const HEADINGS = "^>v<";
const HEADING_WORD = ["headingNorth", "headingEast", "headingSouth", "headingWest"] as const;

/** The rows resized to `width` × `height`: new cells are floor, cut ones are gone. */
export function resizeRows(rows: readonly string[], width: number, height: number): string[] {
  return Array.from({ length: height }, (_, y) => (rows[y] ?? "").slice(0, width).padEnd(width, "."));
}

/** The rows with one cell set. */
const setCell = (rows: readonly string[], x: number, y: number, char: string) =>
  rows.map((row, ry) => (ry === y ? row.slice(0, x) + char + row.slice(x + 1) : row));

/** The rows with every cell of `chars` turned to floor. */
const clear = (rows: readonly string[], chars: RegExp) => rows.map((row) => row.replace(chars, "."));

/** What a click with `tool` does to the cell at (x, y). */
export function applyTool(rows: readonly string[], tool: Tool, x: number, y: number): string[] {
  const here = rows[y]?.[x] ?? ".";
  const heading = HEADINGS.indexOf(here);
  switch (tool) {
    case "rack":
      return here === "." ? setCell(rows, x, y, "#") : here === "#" ? setCell(rows, x, y, ".") : [...rows];
    case "start": {
      if (heading !== -1) return setCell(rows, x, y, HEADINGS[(heading + 1) % 4]!);
      if (here === "D") return [...rows];
      const previous = rows.join("").match(/[\^>v<]/)?.[0] ?? ">";
      return setCell(clear(rows, /[\^>v<]/g), x, y, previous);
    }
    case "dock":
      return heading !== -1 ? [...rows] : setCell(clear(rows, /D/g), x, y, "D");
  }
}

function CellGlyph({ char }: { char: string }) {
  const heading = HEADINGS.indexOf(char);
  if (char === "#") return <span className="block size-4.5 rounded-xs bg-fg-faint/60" />;
  if (char === "D") return <span className="block size-5 rounded-xs border border-dashed border-info bg-info-soft" />;
  if (heading === -1) return null;
  return (
    <svg viewBox="-10 -10 20 20" className="size-5" aria-hidden="true" style={{ transform: `rotate(${heading * 90}deg)` }}>
      <rect x={-8} y={-8} width={16} height={16} rx={4} className="fill-fg" />
      <path d="M -3.5 2 L 0 -3 L 3.5 2" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="stroke-surface" />
    </svg>
  );
}

export function MapEditor({
  id,
  rows,
  onChange,
  disabled,
  s,
}: {
  id: string;
  rows: readonly string[];
  onChange: (rows: string[]) => void;
  disabled?: boolean | undefined;
  s: BlocksEditorStrings;
}): ReactNode {
  const [tool, setTool] = useState<Tool>("rack");
  const height = rows.length;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const what = (char: string) => {
    const heading = HEADINGS.indexOf(char);
    if (heading !== -1) return fmt(s.cellStart, { heading: s[HEADING_WORD[heading]!] });
    return char === "#" ? s.cellRack : char === "D" ? s.cellDock : s.cellFloor;
  };
  const size = (value: number) => Math.min(MAP_SIZE.max, Math.max(MAP_SIZE.min, Math.round(value) || MAP_SIZE.min));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <NumberField
          id={`${id}-width`}
          label={s.width}
          value={width}
          min={MAP_SIZE.min}
          max={MAP_SIZE.max}
          width="w-20"
          disabled={disabled}
          onChange={(w) => onChange(resizeRows(rows, size(w), height))}
        />
        <NumberField
          id={`${id}-height`}
          label={s.height}
          value={height}
          min={MAP_SIZE.min}
          max={MAP_SIZE.max}
          width="w-20"
          disabled={disabled}
          onChange={(h) => onChange(resizeRows(rows, width, size(h)))}
        />
        <div className="flex flex-col gap-1.5">
          <span id={`${id}-tool`} className="text-[13px] font-medium text-fg">
            {s.tool}
          </span>
          <Segmented
            name={`${id}-tool`}
            size="sm"
            labelledBy={`${id}-tool`}
            value={tool}
            onChange={setTool}
            disabled={disabled}
            options={[
              { value: "rack", label: s.toolRack },
              { value: "start", label: s.toolStart },
              { value: "dock", label: s.toolDock },
            ]}
          />
        </div>
      </div>
      <div
        className="grid w-fit overflow-hidden rounded-field border border-line bg-surface-2"
        style={{ gridTemplateColumns: `repeat(${Math.max(width, 1)}, 2rem)` }}
      >
        {rows.flatMap((row, y) =>
          Array.from({ length: width }, (_, x) => {
            const char = row[x] ?? ".";
            return (
              <button
                key={`${x},${y}`}
                type="button"
                disabled={disabled}
                aria-label={fmt(s.cell, { x: x + 1, y: y + 1, what: what(char) })}
                onClick={() => onChange(applyTool(rows, tool, x, y))}
                className={cx(
                  "flex size-8 items-center justify-center border-line transition-colors hover:bg-surface-3 disabled:cursor-default",
                  x < width - 1 && "border-r",
                  y < height - 1 && "border-b",
                )}
              >
                <CellGlyph char={char} />
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
