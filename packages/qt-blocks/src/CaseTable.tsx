/**
 * The table of warehouses, the player's and the review's: case, warehouse
 * (thumbnail and name), result, verdict (DESIGN.md, tables: one identity
 * column, numbers right-aligned, the status a badge, `—` for nothing yet).
 * A row is selected by its name, a button, so the keyboard reaches it.
 */
import type { ReactNode } from "react";

import { plural } from "@quiz/core/client";
import type { RunReason } from "@quiz/domain/blocks";
import { cx, Dash, table, Verdict, verdictTone } from "@quiz/ui";

import type { BlocksCanvasStrings } from "./strings.js";
import { MapThumbnail } from "./WarehouseMap.js";

const REASON = {
  dock: "reasonDock",
  collision: "reasonCollision",
  battery: "reasonBattery",
  loop: "reasonLoop",
  short: "reasonShort",
} as const satisfies Record<RunReason, keyof BlocksCanvasStrings>;

/** How a run ended, in a word of the canvas. */
export const reasonWord = (c: BlocksCanvasStrings, reason: RunReason): string => c[REASON[reason]];

/** The table's cells: 8 px of side padding, not 12 — four columns share half a card. */
const th = "px-2 py-2 font-medium";
const td = "px-2 py-2.5 align-middle";

export interface CaseRow {
  /** "1", or "#4" for a hidden warehouse under closed names. */
  n: string;
  name: string;
  /** The plan, when this reader may see it. */
  map: readonly string[] | null;
  /** How the run ended; `null` before any run. */
  result: { ok: boolean; reason: RunReason; moves: number | null } | null;
  hidden?: boolean;
}

export function CaseTable({
  rows,
  c,
  selected,
  onSelect,
}: {
  rows: readonly CaseRow[];
  c: BlocksCanvasStrings;
  /** The row whose map is drawn beside the table. */
  selected?: number | null;
  /** Absent: the rows are not selectable. */
  onSelect?: ((index: number) => void) | undefined;
}): ReactNode {
  return (
    <div className="overflow-x-auto">
      <table className={table.table}>
        <thead className={table.head}>
          <tr>
            <th className={th}>{c.colCase}</th>
            <th className={th}>{c.colWarehouse}</th>
            <th className={cx(th, "text-right")}>{c.colResult}</th>
            <th className={th}>{c.colVerdict}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isSelected = selected === i;
            const name = (
              <span className="flex min-w-0 items-center gap-2.5">
                {row.map === null ? null : <MapThumbnail rows={row.map} />}
                <span className="min-w-0 break-words">{row.name}</span>
                {row.hidden ? <span className="text-xs text-fg-faint">{c.hidden}</span> : null}
              </span>
            );
            return (
              <tr
                key={i}
                className={cx(table.row, onSelect && "hover:bg-surface-2", isSelected && "bg-surface-2")}
              >
                <td className={cx(td, "font-semibold tabular-nums")}>{row.n}</td>
                <td className={td}>
                  {onSelect === undefined ? (
                    name
                  ) : (
                    <button
                      type="button"
                      className="w-full cursor-pointer rounded-xs text-left"
                      aria-pressed={isSelected}
                      onClick={() => onSelect(i)}
                    >
                      {name}
                    </button>
                  )}
                </td>
                <td className={cx(td, "whitespace-nowrap text-right tabular-nums")}>
                  {row.result === null || row.result.moves === null ? <Dash /> : plural(c, "moves", row.result.moves)}
                </td>
                <td className={td}>
                  <Verdict tone={verdictTone(row.result?.ok)}>
                    {row.result === null ? c.notRun : reasonWord(c, row.result.reason)}
                  </Verdict>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
