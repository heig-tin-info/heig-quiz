/**
 * The `blocks` answer key of the debrief (ADR-033, ADR-109, spec 4.17): the
 * reference program beside the host's bars of the warehouses and the
 * warehouses the class could see.
 *
 * - **Hidden**, the program is the starter the class's workspace held, named
 *   as such, or a hatched block when there was none; the reveal puts the
 *   reference in its place, in a frame of the same height.
 * - **On the wall**, the program is text in the canvas's words (`pseudoCode`),
 *   at projection size: a Blockly workspace would take the focus, and with
 *   it the arrows and the space bar the projection's stepper answers to. On
 *   the page (the Results "Questions" tab), it is the read-only workspace.
 * - **Only the visible warehouses**, the student view's (`visibleCases`):
 *   never a hidden map of `solution.cases`, even revealed — a class never saw
 *   them, and the host's bars name them by their label alone (ADR-033).
 *
 * Staff only (`QuestionTypeClient.Key`): never mounted on a student surface.
 */
import type { KeyProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { CORRECTION_SCALE, cx, KeyFigure, KeyFrame } from "@quiz/ui";

import { BlocklyHost } from "./BlocklyHost.js";
import { pseudoCode } from "./pseudo.js";
import type { BlocksSolution, BlocksStudent } from "./schema.js";
import {
  blocksCanvasStrings,
  blocksKeyStrings,
  type BlocksCanvasStringKey,
  type BlocksKeyStringKey,
} from "./strings.js";
import { WarehouseMap } from "./WarehouseMap.js";

/** The wall's program text: read across a room. */
const WALL_CODE = "text-[clamp(16px,1.5vw,22px)]";

/** The visible warehouses' thumbnails, per density. */
const MAPS = {
  wall: "grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-4",
  page: "grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3",
} as const;

type BlocksKeyProps = KeyProps<BlocksStudent, BlocksSolution> & {
  strings?: StringOverrides<BlocksKeyStringKey>;
  canvasStrings?: StringOverrides<BlocksCanvasStringKey>;
};

export function BlocksKey({
  student,
  solution,
  revealed,
  density,
  stats,
  prompt,
  rows,
  cases,
  strings,
  canvasStrings,
}: BlocksKeyProps) {
  const s = resolveStrings(blocksKeyStrings, strings);
  const c = resolveStrings(blocksCanvasStrings, canvasStrings);
  const scale = CORRECTION_SCALE[density];
  const reference = solution?.referenceSolution ?? null;
  const key = reference !== null && reference.length > 0 ? reference : null;
  const shown = revealed ? key : student.starter.length > 0 ? student.starter : null;
  const label = revealed ? s.reference : shown === null ? s.hidden : s.start;
  const wall = density === "wall";

  const program =
    key === null ? null : (
      <KeyFigure density={density} caption={label}>
        {/* The page's workspace draws its own border. */}
        <KeyFrame density={density} shown={shown} revealed={revealed} framed={wall}>
          {(program, height) =>
            wall ? (
              <pre
                // A focusable scroll region (W10), never a workspace: it holds
                // no key the stepper answers to.
                tabIndex={0}
                role="region"
                aria-label={label}
                className={cx("h-full w-full overflow-auto whitespace-pre font-mono leading-relaxed", WALL_CODE)}
              >
                {pseudoCode(program, c)}
              </pre>
            ) : (
              <div className="w-full">
                <BlocklyHost program={program} toolbox={student.toolbox} words={c} label={label} height={height} />
              </div>
            )
          }
        </KeyFrame>
      </KeyFigure>
    );

  const maps = student.visibleCases;
  const side =
    cases === null && maps.length === 0 ? null : (
      <div className="flex min-w-0 flex-col gap-4">
        {cases}
        {maps.length === 0 ? null : (
          <ul className={cx("grid", MAPS[density])} aria-label={c.cases}>
            {maps.map((warehouse, i) => (
              <li key={i}>
                <figure className="flex flex-col gap-1.5">
                  <WarehouseMap rows={warehouse.map} label={`${c.map} ${warehouse.name}`} dockLabel={c.dock} />
                  <figcaption className={cx("text-fg-muted", scale.caption)}>{warehouse.name}</figcaption>
                </figure>
              </li>
            ))}
          </ul>
        )}
      </div>
    );

  return (
    <>
      {prompt}
      {program === null && side === null ? null : (
        <div className={scale.program}>
          {program}
          {side}
        </div>
      )}
      {/* A program of blocks groups no answer today; the rows stand ready all the same. */}
      {stats.distribution.length > 0 ? rows : null}
    </>
  );
}
