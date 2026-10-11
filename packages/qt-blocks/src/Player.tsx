/**
 * The `blocks` player (docs/spec/04 §4.17, ADR-103): the statement, the
 * block workspace full width — a permanent palette in three groups, a
 * `Blocks | Code` switch, the block count — then the Simulation card, whose
 * one primary action tests the program on every visible warehouse.
 *
 * Controlled through `onChange` with OUR syntax tree. A program equal to the
 * starter goes back as the empty program (`isBlocksAnswered`, schema.ts):
 * an untouched question stays unanswered, and the player shows the starter
 * again for it. A program over `PROGRAM_LIMITS` is held back and said so
 * (`onUnsent`): the server would refuse it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { PlayerProps, StringOverrides } from "@quiz/core/client";
import { fmt, plural, resolveStrings } from "@quiz/core/client";
import { PROGRAM_LIMITS, programEquals, programStats, type NodePath, type Stmt } from "@quiz/domain/blocks";
import { caption, hint, isLocked, markdown, Segmented } from "@quiz/ui";

import { BlocklyHost } from "./BlocklyHost.js";
import { programFits, shownProgram, storedProgram, type BlocksAnswer, type BlocksStudent } from "./schema.js";
import { Simulation } from "./Simulation.js";
import {
  blocksCanvasStrings,
  blocksPlayerStrings,
  type BlocksCanvasStringKey,
  type BlocksPlayerStringKey,
} from "./strings.js";

export type BlocksPlayerProps = PlayerProps<BlocksStudent, BlocksAnswer> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<BlocksPlayerStringKey>;
  canvasStrings?: StringOverrides<BlocksCanvasStringKey>;
  /** False where the host has its own primary action (the Try tab): the test button steps down. */
  testsPrimary?: boolean | undefined;
  /** Forces the Blockly path on or off (the tests drive the text fallback). */
  blockly?: boolean | undefined;
};

export function BlocksPlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  strings,
  canvasStrings,
  renderMarkdown,
  onUnsent,
  testsPrimary,
  blockly,
}: BlocksPlayerProps) {
  const s = resolveStrings(blocksPlayerStrings, strings);
  const c = resolveStrings(blocksCanvasStrings, canvasStrings);
  const locked = isLocked(readOnly, disabled);
  const [program, setProgram] = useState<Stmt[]>(() => shownProgram(answer, student.starter));
  const [view, setView] = useState<"blocks" | "code">("blocks");
  const [highlight, setHighlight] = useState<NodePath | null>(null);
  /** The answer this player last sent: its own echo is not a change from outside. */
  const sent = useRef<Stmt[] | null>(null);

  // An answer from outside (the host's "Clear", another tab) replaces the blocks.
  useEffect(() => {
    const incoming = answer?.program ?? [];
    if (sent.current !== null && programEquals(incoming, sent.current)) return;
    setProgram(shownProgram(answer, student.starter));
    // The starter by what it holds: a host may hand a fresh student object.
  }, [answer, JSON.stringify(student.starter)]);

  const unsent = useRef(onUnsent);
  unsent.current = onUnsent;
  useEffect(() => () => unsent.current?.(false), []);

  const edit = (next: Stmt[]) => {
    setProgram(next);
    const fits = programFits(next);
    onUnsent?.(!fits);
    if (!fits) return;
    const stored = storedProgram(next, student.starter);
    sent.current = stored;
    onChange({ program: stored });
  };
  const onHighlight = useCallback((path: NodePath | null) => setHighlight(path), []);

  const count = programStats(program).nodes;
  const fits = programFits(program);
  // The starter itself is no answer yet (ADR-103 §10): say so where the count is.
  const unchanged = fits && student.starter.length > 0 && storedProgram(program, student.starter).length === 0;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="text-lg leading-relaxed text-fg">{markdown(renderMarkdown, student.prompt)}</div>
        {locked ? null : <p className={caption}>{s.instruction}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Segmented
            name="blocks-view"
            size="sm"
            label={s.view}
            value={view}
            onChange={setView}
            options={[
              { value: "blocks", label: s.viewBlocks },
              { value: "code", label: s.viewCode },
            ]}
          />
          <span className={hint}>
            {!locked && unchanged ? `${s.unchangedStarter} · ` : ""}
            {plural(s, "blockCount", count)}
          </span>
        </div>
        <BlocklyHost
          program={program}
          onChange={locked ? undefined : edit}
          toolbox={student.toolbox}
          words={c}
          label={c.workspace}
          view={view}
          highlight={highlight}
          height={540}
          blockly={blockly}
        />
        {view === "code" ? <p className={caption}>{s.codeHint}</p> : null}
        {fits ? null : (
          <p role="alert" className="rounded-field bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {fmt(s.tooLarge, { nodes: PROGRAM_LIMITS.nodes, depth: PROGRAM_LIMITS.depth })}
          </p>
        )}
      </div>

      <Simulation
        student={student}
        program={program}
        s={s}
        c={c}
        primary={testsPrimary !== false}
        onHighlight={onHighlight}
      />
    </div>
  );
}
