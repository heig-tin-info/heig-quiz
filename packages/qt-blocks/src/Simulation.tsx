/**
 * The player's Simulation card (spec 4.17, ADR-103 §8): its ONE primary
 * action, "Test on every warehouse", runs the VISIBLE warehouses in the
 * browser through the domain interpreter and fills the table; the selected
 * warehouse is animated from the interpreter's own trace, with a battery
 * meter and "Run here", "Step", "Reset". No route is involved: the grade is
 * the server's, by the same function.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { fmt, plural } from "@quiz/core/client";
import type { NodePath, RunResult, Stmt } from "@quiz/domain/blocks";
import { badge, Button, card, caption, countTone, cx, hint, prefersReducedMotion, sectionTitle, type AnswerTone, type BadgeTone } from "@quiz/ui";

import { CaseTable, reasonWord, type CaseRow } from "./CaseTable.js";
import { runCase } from "./grade.js";
import type { BlocksStudent } from "./schema.js";
import type { BlocksCanvasStrings, BlocksPlayerStrings } from "./strings.js";
import { mapOf, WarehouseMap, type Pose } from "./WarehouseMap.js";

/** How long the robot takes for one move or one turn. */
const TICK_MS = 180;

/** The passed-count badge in the tone of the grading table's chips: all, some, none. */
const BADGE_OF: Partial<Record<AnswerTone, BadgeTone>> = { good: "success", partial: "warning", bad: "danger" };

/** A run being replayed: its trace, and how many events of it are shown. */
interface Replay {
  run: RunResult;
  at: number;
}

/** The pose, the trail and the moves after the first `at` events of a run. */
export function replayState(run: RunResult, start: Pose, at: number) {
  const shown = run.events.slice(0, at);
  const pose = shown.at(-1)?.pose ?? start;
  const trail = [{ x: start.x, y: start.y }];
  for (const event of shown) {
    const last = trail[trail.length - 1]!;
    if (event.op === "forward" && (event.pose.x !== last.x || event.pose.y !== last.y)) trail.push({ x: event.pose.x, y: event.pose.y });
  }
  return { pose, trail, moves: trail.length - 1, path: shown.at(-1)?.path ?? null, done: at >= run.events.length };
}

/** The index of the event after the next move or turn: a sensor's test is shown with what follows it. */
export function nextStop(run: RunResult, at: number): number {
  let i = at;
  while (i < run.events.length && run.events[i]!.op === "test") i++;
  return Math.min(i + 1, run.events.length);
}

export function Simulation({
  student,
  program,
  s,
  c,
  primary,
  onHighlight,
}: {
  student: BlocksStudent;
  program: Stmt[];
  s: BlocksPlayerStrings;
  c: BlocksCanvasStrings;
  /** Whether "Test on every warehouse" is the screen's primary (not where the host has its own). */
  primary: boolean;
  onHighlight: (path: NodePath | null) => void;
}): ReactNode {
  const cases = student.visibleCases;
  const [results, setResults] = useState<RunResult[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [playing, setPlaying] = useState(false);
  const programKey = JSON.stringify(program);

  // A changed program is a program nobody tested yet.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setResults(null);
    setReplay(null);
    setPlaying(false);
  }, [programKey]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setReplay((current) => {
        if (current === null) return current;
        const at = nextStop(current.run, current.at);
        if (at >= current.run.events.length) setPlaying(false);
        return { ...current, at };
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing]);

  const kase = cases[selected];
  const map = kase === undefined ? null : mapOf(kase.map);
  const state = replay !== null && map !== null ? replayState(replay.run, map.start, replay.at) : null;
  useEffect(() => onHighlight(state?.path ?? null), [state?.path, onHighlight]);

  const start = () => (kase === undefined ? null : runCase(program, kase));
  const runHere = () => {
    const run = start();
    if (run === null) return;
    if (prefersReducedMotion()) {
      setReplay({ run, at: run.events.length });
      return;
    }
    setReplay({ run, at: 0 });
    setPlaying(true);
  };
  const step = () => {
    setPlaying(false);
    setReplay((current) => {
      const base = current === null || current.at >= current.run.events.length ? { run: start()!, at: 0 } : current;
      return { ...base, at: nextStop(base.run, base.at) };
    });
  };
  const reset = () => {
    setPlaying(false);
    setReplay(null);
    setResults(null);
  };
  const select = (index: number) => {
    setPlaying(false);
    setReplay(null);
    setSelected(index);
  };
  const testAll = () => {
    setResults(cases.map((k) => runCase(program, k, { events: false })));
    setReplay(null);
    setPlaying(false);
  };

  const passed = results?.filter((r) => r.ok).length ?? 0;
  const rows: CaseRow[] = cases.map((k, i) => {
    const r = results?.[i];
    return {
      n: String(i + 1),
      name: k.name,
      map: k.map,
      result: r === undefined ? null : { ok: r.ok, reason: r.reason, moves: r.moves },
    };
  });
  const finished = state !== null && state.done ? replay!.run : null;

  return (
    <section className={cx(card, "flex flex-col gap-4 p-4")} aria-labelledby="blocks-simulation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="blocks-simulation" className={sectionTitle}>
              {s.simulation}
            </h3>
            {results === null ? null : (
              <span className={badge(BADGE_OF[countTone(passed, cases.length)] ?? "neutral")}>
                {fmt(s.passed, { passed, total: cases.length })}
              </span>
            )}
            {student.allOrNothing ? <span className={badge("warning")}>{c.allOrNothing}</span> : null}
          </div>
          <p className={hint}>{cases.length === 0 ? s.noVisible : s.simulationHint}</p>
        </div>
        {cases.length === 0 ? null : (
          <Button variant={primary ? "primary" : "secondary"} onClick={testAll}>
            {s.testAll}
          </Button>
        )}
      </div>

      {kase === undefined || map === null ? null : (
        <div className="@container">
          <div className="flex flex-col gap-5 @min-[40rem]:grid @min-[40rem]:grid-cols-[minmax(0,4fr)_minmax(0,5fr)] @min-[40rem]:items-start">
            <div className="flex flex-col gap-2.5">
              <p className="truncate text-sm font-semibold text-fg">
                {fmt(s.caseTitle, { n: selected + 1, name: kase.name })}
              </p>
              <WarehouseMap
                rows={kase.map}
                pose={state?.pose ?? null}
                trail={state?.trail ?? []}
                crashed={finished !== null && finished.reason === "collision"}
                label={`${c.map} ${kase.name}`}
                dockLabel={c.dock}
              />
              <Battery label={c.battery} left={kase.battery - (state?.moves ?? 0)} total={kase.battery} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={runHere} disabled={playing}>
                  {s.runHere}
                </Button>
                <Button size="sm" onClick={step}>
                  {s.step}
                </Button>
                <Button size="sm" onClick={reset}>
                  {s.reset}
                </Button>
              </div>
              <p role="status" className={cx("min-h-5 text-[13px]", finished === null ? "text-fg-muted" : finished.ok ? "text-success" : "text-danger")}>
                {finished === null ? "" : `${reasonWord(c, finished.reason)} · ${plural(c, "moves", finished.moves)}`}
              </p>
            </div>
            <CaseTable rows={rows} c={c} selected={selected} onSelect={select} />
          </div>
        </div>
      )}
      {student.hiddenCount > 0 ? (
        <p className={caption}>
          {plural(s, "hiddenFoot", student.hiddenCount, { count: student.hiddenCount, points: student.hiddenPoints })}
        </p>
      ) : null}
    </section>
  );
}

/** What is left of the battery: a thin `info` bar and the figures. */
function Battery({ label, left, total }: { label: string; left: number; total: number }): ReactNode {
  const share = total > 0 ? Math.max(0, left) / total : 0;
  return (
    <div className="flex items-center gap-2.5 text-xs text-fg-muted">
      <span>{label}</span>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.max(0, left)}
        className="h-1.5 max-w-40 flex-1 overflow-hidden rounded-full bg-surface-3"
      >
        <span className="block h-full bg-info transition-[width] duration-200" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="font-mono tabular-nums">
        {Math.max(0, left)} / {total}
      </span>
    </div>
  );
}
