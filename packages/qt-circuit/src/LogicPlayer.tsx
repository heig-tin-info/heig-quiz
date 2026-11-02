/**
 * The student's view of a `logic` question (docs/spec/04 §4.18).
 *
 * The ONE thing it is for is the circuit: the canvas, with the declared
 * inputs and outputs already on it. PLAY is a second mode of the same canvas,
 * in the browser and with no route (ADR-123 §7): the inputs become toggles,
 * the outputs light up and every wire takes the colour of its level, all
 * from the student's own circuit through the domain's simulator — the one
 * the server grades with. It never shows an expected value nor a comparison:
 * the grade is the server's.
 *
 * EXPAND as in `circuit` (`ExpandableCanvas` of `@quiz/ui`).
 */
import { useId, useMemo, useState } from "react";

import { fmt, plural, resolveStrings } from "@quiz/core/client";
import type { PlayerProps } from "@quiz/core/client";
import { compileNetlist, type Bit, type Value } from "@quiz/domain/logic";
import { badge, cx, ExpandableCanvas, hint, isLocked, markdown, Segmented } from "@quiz/ui";

import { logicLibrary, SchematicEditor, SchematicView, type CanvasStrings } from "./canvas/index.js";
import { gateCount, LOGIC_GATES_MAX, offeredLogicKinds } from "./logicLibrary.js";
import { buildLogicNetlist } from "./logicNetlist.js";
import { initialLogicAnswer, type LogicAnswer, type LogicSchematic, type LogicStudent } from "./logicSchema.js";
import { LOGIC_PLAYER_STRINGS, type LogicPlayerStrings } from "./logicStrings.js";
import { strip } from "./styles.js";

interface LogicPlayerProps extends PlayerProps<LogicStudent, LogicAnswer> {
  disabled?: boolean | undefined;
  strings?: Partial<LogicPlayerStrings> | undefined;
  canvasStrings?: Partial<CanvasStrings> | undefined;
}

type Mode = "draw" | "play";

/**
 * A level's ink on a wire, a toggle and an output: 1 in the info blue, 0
 * muted, an unknown in danger, a floating net in warning. Not the accent: on
 * this theme it is red, and a 1 must never read as an X.
 */
export const LEVEL_INK: Readonly<Record<string, string>> = {
  "0": "text-fg-faint",
  "1": "text-info",
  X: "text-danger",
  Z: "text-warning",
};

export interface PlayState {
  outputs: Record<string, Value>;
  wireLevel: (wireId: string) => Value | undefined;
}

/** The student's circuit under `levels`, simulated from a fresh state; `null` when it cannot be compiled. */
export function playCircuit(schematic: LogicSchematic, levels: Readonly<Record<string, Bit>>): PlayState | null {
  try {
    const { netlist, netOfWire } = buildLogicNetlist(schematic);
    const sim = compileNetlist(netlist).createSimulator();
    const inputs = Object.entries(netlist.ports).filter(([, port]) => port.direction === "input");
    sim.set(Object.fromEntries(inputs.map(([name]) => [name, levels[name] ?? 0])));
    sim.settle();
    const nets = sim.nets();
    return {
      outputs: sim.read(),
      wireLevel: (id) => {
        const net = netOfWire.get(id);
        return net === undefined ? undefined : nets[net];
      },
    };
  } catch {
    return null;
  }
}

export function LogicPlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  strings,
  canvasStrings,
  renderMarkdown,
  Expand,
  onCanvasShortcuts,
}: LogicPlayerProps) {
  const s = resolveStrings(LOGIC_PLAYER_STRINGS, strings);
  const locked = isLocked(readOnly, disabled);
  const library = logicLibrary(student.symbols);
  const modeName = useId();
  const [mode, setMode] = useState<Mode>("draw");
  const [levels, setLevels] = useState<Record<string, Bit>>({});

  const schematic = useMemo(() => answer?.schematic ?? initialLogicAnswer(student).schematic, [answer, student]);
  const played = useMemo(() => (mode === "play" ? playCircuit(schematic, levels) : null), [mode, schematic, levels]);
  const gates = gateCount(schematic);
  const max = student.palette.maxGates ?? LOGIC_GATES_MAX;
  const canvas = canvasStrings === undefined ? {} : { strings: canvasStrings };
  const level = (value: Value | undefined): string => (value === undefined ? "Z" : String(value));

  return (
    <div className="flex flex-col gap-5">
      <div className="whitespace-pre-wrap text-sm text-fg">{markdown(renderMarkdown, student.prompt)}</div>

      <ExpandableCanvas
        Expand={Expand}
        title={s.schematic}
        strings={s}
        locked={locked}
        preview={<SchematicView schematic={schematic} library={library} height={280} {...canvas} />}
      >
        {(expanded) => (
          <div className={cx("flex flex-col gap-2", expanded && "h-full")}>
            {mode === "play" ? (
              <SchematicView
                schematic={schematic}
                library={library}
                height={expanded ? 720 : 420}
                wireInk={(id) => (played === null ? undefined : LEVEL_INK[level(played.wireLevel(id))])}
                {...canvas}
              />
            ) : (
              <SchematicEditor
                aria-label={s.schematic}
                library={library}
                value={schematic}
                onChange={(next) => onChange({ schematic: next })}
                palette={{ kinds: offeredLogicKinds(student.palette.kinds), maxComponents: max }}
                readOnly={locked}
                {...(expanded ? { height: "fill" as const } : {})}
                {...canvas}
                onShortcuts={onCanvasShortcuts}
              />
            )}
            <div className={strip}>
              <Segmented<Mode>
                name={modeName}
                label={s.mode}
                size="sm"
                value={mode}
                options={[
                  { value: "draw", label: s.draw },
                  { value: "play", label: s.play },
                ]}
                onChange={setMode}
              />
              <span className={badge(gates > max ? "danger" : "neutral")}>{plural(s, "gates", gates, { n: gates, max })}</span>
            </div>
            {mode === "play" ? (
              <div className="flex flex-col gap-2" role="group" aria-label={s.play}>
                <p className={hint}>{s.playHint}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] text-fg-muted">{s.inputs}</span>
                  {student.inputs.map((name) => {
                    const on = (levels[name] ?? 0) === 1;
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={on}
                        className={cx(
                          "rounded-full border px-3 py-0.5 font-mono text-[13px]",
                          on ? "border-info bg-info-soft text-info" : "border-line-strong bg-surface text-fg-muted hover:bg-surface-2",
                        )}
                        onClick={() => setLevels({ ...levels, [name]: on ? 0 : 1 })}
                      >
                        {fmt(s.toggle, { name, value: on ? 1 : 0 })}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-2" role="status">
                  <span className="text-[13px] text-fg-muted">{s.outputs}</span>
                  {student.outputs.map((name) => {
                    const value = level(played?.outputs[name]);
                    return (
                      <span key={name} className={cx("font-mono text-[13px] font-semibold", LEVEL_INK[value])}>
                        {fmt(s.toggle, { name, value })}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </ExpandableCanvas>
    </div>
  );
}

export default LogicPlayer;
