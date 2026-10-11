/**
 * The feedback view of a `blocks` answer (docs/spec/04 §4.17): the student's
 * program, read-only, and the table of warehouses with each verdict; the
 * selected warehouse drawn with the robot's trail where this reader may see
 * its map. The teacher, and a student under a shown key, also get the hidden
 * maps and the reference (both from `toSolution`).
 *
 * It renders what it was given: the filtering happened server-side in
 * `studentDetails` (no trail, no move count for a hidden warehouse), and
 * nothing here reconstructs a key.
 */
import { useState } from "react";

import type { ReviewProps, StringOverrides } from "@quiz/core/client";
import { fmt, resolveStrings, showsSection } from "@quiz/core/client";
import { badge, caption, cx, label as labelToken, pointsOrDash, ReviewPrompt, sectionTitle } from "@quiz/ui";

import { BlocklyHost } from "./BlocklyHost.js";
import { CaseTable, type CaseRow } from "./CaseTable.js";
import {
  isTraced,
  type BlocksAnswer,
  type BlocksReviewDetails,
  type BlocksSolution,
  type BlocksStudent,
} from "./schema.js";
import {
  blocksCanvasStrings,
  blocksReviewStrings,
  type BlocksCanvasStringKey,
  type BlocksReviewStringKey,
} from "./strings.js";
import { WarehouseMap } from "./WarehouseMap.js";

export type BlocksReviewProps = ReviewProps<BlocksStudent, BlocksAnswer, BlocksSolution, BlocksReviewDetails> & {
  strings?: StringOverrides<BlocksReviewStringKey>;
  canvasStrings?: StringOverrides<BlocksCanvasStringKey>;
  blockly?: boolean | undefined;
};

interface ReviewRow extends CaseRow {
  trail: { x: number; y: number }[] | null;
}

/**
 * The rows of the table: the graded cases when there is a grading, the
 * visible warehouses otherwise. A visible case's map is the student view's
 * (in order: the k-th visible case is the k-th of `visibleCases`); a hidden
 * one's only comes with the key.
 */
function rowsOf(student: BlocksStudent, details: BlocksReviewDetails | null, solution: BlocksSolution | null): ReviewRow[] {
  if (details === null) {
    return student.visibleCases.map((k, i) => ({ n: String(i + 1), name: k.name, map: k.map, result: null, trail: null }));
  }
  let visible = 0;
  return details.cases.map((c, i) => {
    const map = c.visible ? (student.visibleCases[visible++]?.map ?? null) : (solution?.cases[i]?.map ?? null);
    return {
      n: String(i + 1),
      name: c.name,
      map,
      hidden: !c.visible,
      result: { ok: c.ok, reason: c.reason, moves: isTraced(c) ? c.moves : null },
      trail: isTraced(c) ? c.trail : null,
    };
  });
}

export function BlocksReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  sections,
  renderMarkdown,
  strings,
  canvasStrings,
  blockly,
}: BlocksReviewProps) {
  const s = resolveStrings(blocksReviewStrings, strings);
  const c = resolveStrings(blocksCanvasStrings, canvasStrings);
  const rows = rowsOf(student, details, solution);
  const drawable = rows.findIndex((row) => row.map !== null && row.trail !== null);
  const [selected, setSelected] = useState<number | null>(drawable === -1 ? null : drawable);
  const shown = selected === null ? null : rows[selected];
  const redacted = details?.cases.some((row) => !isTraced(row)) ?? false;
  const reference = showsSection(sections, "solution") ? (solution?.referenceSolution ?? null) : null;

  return (
    <div className="flex flex-col gap-5">
      <ReviewPrompt prompt={student.prompt} sections={sections} renderMarkdown={renderMarkdown} />
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={cx(sectionTitle, "tabular-nums")}>{fmt(s.score, { points: pointsOrDash(points), max: maxPoints })}</h3>
        {student.allOrNothing ? <span className={badge("warning")}>{s.allOrNothing}</span> : null}
      </div>

      <section className="flex flex-col gap-2">
        <h4 className={labelToken}>{s.program}</h4>
        {answer === null || answer.program.length === 0 ? (
          <p className={caption}>{s.noAnswer}</p>
        ) : (
          <BlocklyHost program={answer.program} toolbox={student.toolbox} words={c} label={s.program} height={280} blockly={blockly} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h4 className={labelToken}>{s.cases}</h4>
        <div className="@container">
          <div
            className={cx(
              "flex flex-col gap-4",
              shown?.map && shown.trail ? "@min-[40rem]:grid @min-[40rem]:grid-cols-[minmax(0,4fr)_minmax(0,5fr)] @min-[40rem]:items-start" : "",
            )}
          >
            {shown?.map && shown.trail ? (
              <WarehouseMap
                rows={shown.map}
                trail={shown.trail}
                ended
                crashed={shown.result?.reason === "collision"}
                label={`${c.map} ${shown.name}`}
                dockLabel={c.dock}
              />
            ) : null}
            <CaseTable
              rows={rows}
              c={c}
              selected={selected}
              onSelect={drawable === -1 ? undefined : (i) => setSelected(rows[i]!.map && rows[i]!.trail ? i : selected)}
            />
          </div>
        </div>
        {redacted ? <p className={caption}>{s.hiddenNote}</p> : null}
      </section>

      {reference === null ? null : (
        <section className="flex flex-col gap-2">
          <h4 className={labelToken}>{s.reference}</h4>
          <BlocklyHost program={reference} toolbox={student.toolbox} words={c} label={s.reference} height={280} blockly={blockly} />
        </section>
      )}
    </div>
  );
}
