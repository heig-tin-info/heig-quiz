/**
 * The expected and obtained outputs of a program's test, side by side or as
 * one green/red diff (issue #553) — the code player's visible cases and the
 * code review's cases render them the same way.
 *
 * The rules are `@quiz/domain/outputDiff`'s (which whitespace is worth a
 * glyph, the line-then-character diff, what the comparison options ignore);
 * this file only draws them. Glyphs are pseudo-elements over the real
 * characters, so copying a cell copies the program's real output, and a diff
 * line says "−" or "+" in its gutter, so the colour is never the only signal.
 *
 * It shows only what the caller hands it: a hidden case has no expected output
 * to give, and gets no diff.
 */
import { useMemo, useState, type ReactNode } from "react";

import type { CompareOptions } from "@quiz/domain/compareOutput";
import {
  diffOutput,
  differsOnlyByWhitespace,
  missingFinalNewline,
  whitespaceKind,
  whitespaceSpans,
  type DiffLine,
  type DiffSegment,
  type WhitespaceKind,
} from "@quiz/domain/outputDiff";

import { CheckboxField, Segmented } from "./fields.js";
import { badge, cx } from "./styles.js";

export type OutputMode = "side" | "diff";

/** The words of the output views, translated by the caller. */
export interface OutputStrings {
  expected: string;
  got: string;
  /** The segmented control's two options and the name of its group. */
  outputSideBySide: string;
  outputDiff: string;
  outputView: string;
  showWhitespace: string;
  /** The heading of the single diff column, which replaces Expected and Got. */
  outputDiffHeader: string;
  /** Read for the marker of an output that does not end with a newline. */
  noFinalNewline: string;
  /**
   * The badge and the note of an output the runner cut. Only a caller that
   * knows of a cut (the player's live run) needs them.
   */
  truncated?: string | undefined;
  truncatedDiff?: string | undefined;
}

/* The glyph drawn over each whitespace character, in the muted ink. */
const GLYPH: Record<WhitespaceKind, string> = {
  space: "·",
  tab: "→",
  cr: "␍",
  nbsp: "⍽",
  zw: "▯",
};

/* Over the character (it keeps its width), or beside it (a zero-width one has none). */
const OVER =
  "relative whitespace-pre before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:text-fg-faint before:content-[attr(data-glyph)]";
const BESIDE = "before:text-fg-faint before:content-[attr(data-glyph)]";

const STORAGE_KEY = "quiz.outputMode";

/**
 * The reader's choice of view, remembered in this browser only — a per-viewer
 * convenience, so an unavailable storage just means side by side every time.
 */
export function useOutputMode(): [OutputMode, (mode: OutputMode) => void] {
  const [mode, setMode] = useState<OutputMode>(() => {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) === "diff" ? "diff" : "side";
    } catch {
      return "side";
    }
  });
  const choose = (next: OutputMode) => {
    setMode(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      /* Private window, blocked storage: the choice lasts the page. */
    }
  };
  return [mode, choose];
}

/** One run of characters sharing a whitespace kind and a changed flag. */
interface Run {
  text: string;
  ws: WhitespaceKind | null;
  changed: boolean;
}

/**
 * The text cut where its whitespace kind or its changed flag changes. The
 * whitespace is judged on the whole text (a space is "trailing" only at the
 * end of its line), the change on the diff's segments.
 */
function runsOf(text: string, glyphs: boolean, segments?: readonly DiffSegment[]): Run[] {
  const kinds: (WhitespaceKind | null)[] = [];
  for (const span of whitespaceSpans(text)) {
    for (const _ of Array.from(span.text)) kinds.push(span.ws);
  }
  const changed: boolean[] = [];
  for (const segment of segments ?? [{ text, changed: false }]) {
    for (const _ of Array.from(segment.text)) changed.push(segment.changed);
  }
  const runs: Run[] = [];
  Array.from(text).forEach((ch, i) => {
    const c = changed[i] ?? false;
    // A changed space is the difference itself: it gets its glyph, single or not.
    const ws = glyphs ? (kinds[i] ?? (c ? whitespaceKind(ch) : null)) : null;
    const last = runs[runs.length - 1];
    // A whitespace glyph sits over ONE character, so each gets its own run.
    if (last !== undefined && last.ws === null && ws === null && last.changed === c) last.text += ch;
    else runs.push({ text: ch, ws, changed: c });
  });
  return runs;
}

function Runs({ runs, changedClass }: { runs: Run[]; changedClass?: string }): ReactNode {
  return runs.map((run, i) => {
    const tone = run.changed ? changedClass : undefined;
    if (run.ws === null) {
      return tone === undefined ? run.text : <span key={i} className={tone}>{run.text}</span>;
    }
    return (
      <span
        key={i}
        data-ws={run.ws}
        data-glyph={GLYPH[run.ws]}
        className={cx(run.ws === "zw" ? BESIDE : OVER, tone)}
      >
        {run.text}
      </span>
    );
  });
}

/** The marker of an output that ends without its newline: a glyph, named for a screen reader. */
function NoNewline({ label }: { label: string }): ReactNode {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-glyph="⊘"
      className={cx(BESIDE, "ml-0.5")}
    />
  );
}

/** An output with its invisible characters made visible when `glyphs` is on. */
export function WhitespaceText({
  text,
  glyphs,
  compare,
  noFinalNewline,
}: {
  text: string;
  glyphs: boolean;
  compare?: CompareOptions | undefined;
  /** The marker's name; absent, no marker (a truncated output has no end of its own). */
  noFinalNewline?: string | undefined;
}): ReactNode {
  if (!glyphs) return text;
  return (
    <>
      <Runs runs={runsOf(text, true)} />
      {noFinalNewline !== undefined && missingFinalNewline(text, compare) ? (
        <NoNewline label={noFinalNewline} />
      ) : null}
    </>
  );
}

const LINE: Record<DiffLine["op"], { sign: string; row: string; changed: string }> = {
  equal: { sign: " ", row: "", changed: "" },
  removed: { sign: "−", row: "bg-danger-soft", changed: "rounded-xs bg-danger/25 text-fg" },
  added: { sign: "+", row: "bg-success-soft", changed: "rounded-xs bg-success/25 text-fg" },
};

/**
 * The unified diff of one case: the expected lines that are missing in red,
 * the obtained lines that should not be there in green, the differing
 * characters darker inside them, and the whitespace glyphs everywhere — a
 * line that differs by one space otherwise looks like its neighbour.
 */
export function OutputDiff({
  expected,
  actual,
  compare,
  truncated,
  glyphs,
  strings,
}: {
  expected: string;
  actual: string;
  compare?: CompareOptions | undefined;
  truncated?: boolean | undefined;
  glyphs: boolean;
  strings: Pick<OutputStrings, "expected" | "got" | "noFinalNewline" | "truncatedDiff">;
}): ReactNode {
  const lines = useMemo(
    () => diffOutput(expected, actual, { ...compare, truncated }),
    [expected, actual, compare, truncated],
  );
  return (
    <div className="flex flex-col">
      {lines.map((line, i) => {
        const look = LINE[line.op];
        const text = line.segments.map((s) => s.text).join("");
        return (
          <div key={i} data-op={line.op} className={cx("flex", look.row)}>
            <span aria-hidden="true" className="w-4 shrink-0 select-none text-center text-fg-faint">
              {look.sign}
            </span>
            {line.op === "equal" ? null : (
              <span className="sr-only select-none">
                {line.op === "removed" ? strings.expected : strings.got}:{" "}
              </span>
            )}
            <span className="min-w-0 whitespace-pre-wrap break-all">
              <Runs runs={runsOf(text, glyphs, line.segments)} changedClass={look.changed} />
              {line.noNewline ? <NoNewline label={strings.noFinalNewline} /> : null}
            </span>
          </div>
        );
      })}
      {truncated ? <p className="mt-1 font-sans text-xs text-fg-muted">{strings.truncatedDiff}</p> : null}
    </div>
  );
}

/** The header cells of the output columns: Expected and Got, or the one diff column. */
export function OutputHeads({
  mode,
  strings,
  className,
}: {
  mode: OutputMode;
  strings: Pick<OutputStrings, "expected" | "got" | "outputDiffHeader">;
  className: string;
}): ReactNode {
  if (mode === "diff") {
    return (
      <th scope="col" className={className}>
        {strings.outputDiffHeader}
      </th>
    );
  }
  return (
    <>
      <th scope="col" className={className}>
        {strings.expected}
      </th>
      <th scope="col" className={className}>
        {strings.got}
      </th>
    </>
  );
}

/**
 * The output cells of one case's row, in the chosen mode.
 *
 * `expected: null` is a case with nothing to compare (its output is not
 * checked, or the reader may not see the key): `expectedFallback` stands in
 * its cell, and the diff column shows the obtained output alone. `actual:
 * null` is a case that did not run. A passed case has no diff to draw either.
 * The glyphs come on by themselves on a failed case whose outputs differ only
 * by whitespace, and on every case when the reader asks.
 */
export function OutputCells({
  mode,
  expected,
  expectedFallback,
  actual,
  ok,
  compare,
  truncated,
  showWhitespace,
  strings,
  className,
}: {
  mode: OutputMode;
  expected: string | null;
  expectedFallback: ReactNode;
  actual: string | null;
  ok: boolean | null;
  compare?: CompareOptions | undefined;
  truncated?: boolean | undefined;
  showWhitespace: boolean;
  strings: OutputStrings;
  className: string;
}): ReactNode {
  const glyphs =
    showWhitespace ||
    (ok === false && expected !== null && actual !== null && differsOnlyByWhitespace(expected, actual, compare));
  const eol = truncated ? undefined : strings.noFinalNewline;
  const cut = truncated ? <span className={badge("warning", "ml-1")}>{strings.truncated}</span> : null;
  const got =
    actual === null || actual === "" ? (
      "—"
    ) : (
      <WhitespaceText text={actual} glyphs={glyphs} compare={compare} noFinalNewline={eol} />
    );

  if (mode === "diff") {
    const diffable = expected !== null && actual !== null && ok !== true;
    return (
      <td className={className}>
        {diffable ? (
          <OutputDiff
            expected={expected}
            actual={actual}
            compare={compare}
            truncated={truncated}
            glyphs={glyphs}
            strings={strings}
          />
        ) : (
          <>
            {got}
            {cut}
          </>
        )}
      </td>
    );
  }
  return (
    <>
      <td className={className}>
        {expected === null ? (
          expectedFallback
        ) : expected === "" ? (
          "—"
        ) : (
          <WhitespaceText text={expected} glyphs={glyphs} compare={compare} noFinalNewline={strings.noFinalNewline} />
        )}
      </td>
      <td className={className}>
        {got}
        {cut}
      </td>
    </>
  );
}

/**
 * The two secondary controls above a table of outputs: the view (side by side
 * or diff) and "Show whitespace". Small and quiet — the screen's primary
 * action is elsewhere (invariant 2).
 */
export function OutputControls({
  name,
  mode,
  onMode,
  showWhitespace,
  onShowWhitespace,
  strings,
}: {
  /** Groups the native radios of this table's control. */
  name: string;
  mode: OutputMode;
  onMode: (mode: OutputMode) => void;
  showWhitespace: boolean;
  onShowWhitespace: (on: boolean) => void;
  strings: Pick<OutputStrings, "outputSideBySide" | "outputDiff" | "outputView" | "showWhitespace">;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented
        name={name}
        size="sm"
        label={strings.outputView}
        value={mode}
        onChange={onMode}
        options={[
          { value: "side", label: strings.outputSideBySide },
          { value: "diff", label: strings.outputDiff },
        ]}
      />
      <CheckboxField
        label={strings.showWhitespace}
        checked={showWhitespace}
        onChange={onShowWhitespace}
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted"
      />
    </div>
  );
}
