/**
 * The WHOLE program in one editor, its locked lines greyed and read-only
 * (docs/spec/04 §4.7, ADR-024). The student's player and the teacher's
 * reference-solution field both use it, so a teacher writes their reference
 * in exactly the surface a student will meet.
 *
 * What it is NOT: a guarantee. Only the editable regions leave the browser,
 * and the server rebuilds the file from the STORED template and those regions
 * (invariant 14). Everything below is about what the student sees.
 *
 * Decisions:
 *
 * 1. **One model, the real file.** The Monaco model holds the program as the
 *    server assembles it — every segment, in order, marker lines included —
 *    so the line numbers in the gutter ARE the source line numbers, and a
 *    `main.c:12:5: error:` from the compiler is drawn on line 12 with no
 *    translation (`./diagnostics.ts`). The marker lines (`// @@lock`) are
 *    noise to a student, so they are HIDDEN with `setHiddenAreas`, which
 *    folds a line away without renumbering the others. That method lives on
 *    the code editor widget of every Monaco this package loads (0.5x, CDN
 *    included) but not in its public typings, so it is feature-checked: a
 *    Monaco without it shows the markers as greyed, read-only comments and
 *    keeps the right line numbers — the degradation is cosmetic. Stripping
 *    the markers instead would have meant a display-line → source-line map
 *    on every diagnostic and every marker update; hiding costs nothing.
 *
 * 2. **The layout is tracked, and CHECKED after every edit.** Each segment is
 *    one tracked decoration: an editable one grows when typing at its edges
 *    (so an empty region still takes text), a locked one never does. After
 *    each change the model must still read as the segments in order, each
 *    separated from the next by exactly one line break, every locked one
 *    with its original text ({@link checkLayout}). Anything else — a
 *    Backspace at the very start of a region, a selection deleted across a
 *    locked line, a paste or a line moved onto one — is undone: the model is
 *    restored to the last good text by a single minimal edit, pushed on the
 *    undo stack (a raw `applyEdits` would desynchronise it), and the
 *    decorations are laid again. The check is on the RESULT, not on the
 *    shape of the event, so no edit path (keyboard, IME, drop, multi-cursor,
 *    a command) can slip past it.
 *
 * 3. **Most refusals never happen.** The editor turns itself read-only while
 *    a cursor or a selection touches a locked line — Monaco then says so in
 *    its own words — and swallows Backspace at the start of a region and
 *    Delete at its end. The check of point 2 is the backstop.
 *
 * 4. **Undo and redo** walk back through states that were all valid, but
 *    Monaco replays them as compressed edits that can collapse a tracked
 *    decoration. Such an event gets a second chance: the locked texts are
 *    looked for in the new text, nearest to where they were
 *    ({@link realignLayout}), and the decorations are laid again on them.
 *
 * 5. **The fallback is the stack**: one read-only block per locked segment,
 *    one textarea per region — in jsdom, while Monaco loads, if its CDN is
 *    blocked, or when `monaco={false}`. Every component test drives it.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { OnMount } from "@monaco-editor/react";

import { fmt } from "@quiz/core/client";
import { lockedBlock } from "@quiz/ui";

import type { Diagnostic } from "./diagnostics.js";
import { CodeArea, LazyMonaco, MONACO_LANGUAGE, MonacoBoundary, monacoAvailable } from "./MonacoHost.js";
import type { CodeLanguage, CodeSegment } from "./schema.js";
import { isMarkerLine, stripMarkerLines, trimTrailingNewline } from "./segments.js";

// ---------------------------------------------------------------------------
// The pure layout: segments + regions <-> one text.

/** One segment's place in the model text: `[start, end)` offsets. */
export interface Span {
  kind: "locked" | "editable";
  index: number | null;
  start: number;
  end: number;
}

export interface ProgramLayout {
  text: string;
  spans: Span[];
}

const endsWithBreak = (segment: CodeSegment): boolean => segment.text.endsWith("\n");

/**
 * A segment's text as the model holds it: without the line break that ends
 * it, which the next segment's join puts back. A region the student wrote
 * without that break reads the same — `assembleSource` adds it too.
 */
const bodyOf = (segment: CodeSegment, content: string): string =>
  endsWithBreak(segment) ? content.replace(/\n$/, "") : content;

/** The text of the model and where each segment sits in it. */
export function layoutProgram(
  segments: readonly CodeSegment[],
  regions: readonly string[],
): ProgramLayout {
  let text = "";
  const spans: Span[] = [];
  segments.forEach((segment, i) => {
    if (i > 0) text += "\n";
    const content =
      segment.kind === "locked" ? segment.text : (regions[segment.index ?? 0] ?? segment.text);
    const body = bodyOf(segment, content);
    spans.push({ kind: segment.kind, index: segment.index, start: text.length, end: text.length + body.length });
    text += body;
  });
  return { text, spans };
}

/** The regions a text holds, in editable order, each with its template's closing break. */
export function regionsFromLayout(
  text: string,
  spans: readonly Span[],
  segments: readonly CodeSegment[],
): string[] {
  const regions: string[] = [];
  spans.forEach((span, i) => {
    if (span.kind !== "editable") return;
    const body = text.slice(span.start, span.end);
    regions[span.index ?? 0] = endsWithBreak(segments[i]!) ? `${body}\n` : body;
  });
  return regions;
}

/**
 * Whether `spans` still lay `text` out as the segments: contiguous, one line
 * break between two of them, covering the whole text, and every locked span
 * holding exactly its template text.
 */
export function checkLayout(
  text: string,
  spans: readonly Span[],
  segments: readonly CodeSegment[],
): boolean {
  if (spans.length !== segments.length) return false;
  if (spans.length === 0) return text === "";
  if (spans[0]!.start !== 0 || spans[spans.length - 1]!.end !== text.length) return false;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    if (span.end < span.start) return false;
    if (i > 0) {
      const previous = spans[i - 1]!;
      if (span.start !== previous.end + 1 || text[previous.end] !== "\n") return false;
    }
    const segment = segments[i]!;
    if (segment.kind === "locked" && text.slice(span.start, span.end) !== bodyOf(segment, segment.text)) {
      return false;
    }
  }
  return true;
}

/**
 * The layout of `text` found from the locked texts alone, each looked for as
 * whole lines, in order, nearest to where `hint` last saw it; `null` when a
 * locked text is gone. Used after an undo or a redo only (decision 4): a
 * student may well have typed a copy of a locked line, and the tracked
 * decorations are the better witness whenever they survive.
 */
export function realignLayout(
  text: string,
  segments: readonly CodeSegment[],
  hint: readonly Span[],
): Span[] | null {
  const spans: Span[] = [];
  // Whether a locked body may sit at `at`: whole lines, followed by the
  // separating break unless it is the last segment.
  const fits = (at: number, length: number, last: boolean) =>
    (at === 0 || text[at - 1] === "\n") &&
    (last ? at + length === text.length : text[at + length] === "\n");

  let pos = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment.kind === "locked") {
      // Only at the very start, or after another locked segment: no editable
      // text in between, so it sits exactly here.
      const body = bodyOf(segment, segment.text);
      if (!text.startsWith(body, pos) || !fits(pos, body.length, i === segments.length - 1)) return null;
      spans.push({ kind: "locked", index: null, start: pos, end: pos + body.length });
      pos += body.length + 1;
      continue;
    }
    const next = segments[i + 1];
    if (next === undefined || next.kind !== "locked") {
      if (next !== undefined) return null;
      spans.push({ kind: "editable", index: segment.index, start: pos, end: text.length });
      pos = text.length + 1;
      continue;
    }
    // An editable region takes any text: the locked segment after it may
    // begin at any line start past it; the one nearest the hint wins.
    const body = bodyOf(next, next.text);
    const last = i + 1 === segments.length - 1;
    const wanted = hint[i + 1]?.start ?? pos;
    let best: number | null = null;
    for (let at = text.indexOf(body, pos + 1); at !== -1; at = text.indexOf(body, at + 1)) {
      if (!fits(at, body.length, last)) continue;
      if (best === null || Math.abs(at - wanted) < Math.abs(best - wanted)) best = at;
    }
    if (best === null) return null;
    spans.push({ kind: "editable", index: segment.index, start: pos, end: best - 1 });
    spans.push({ kind: "locked", index: null, start: best, end: best + body.length });
    pos = best + body.length + 1;
    i++;
  }
  return checkLayout(text, spans, segments) ? spans : null;
}

/** The single edit that turns `from` into `to`: the middle both do not share. */
export function minimalEdit(
  from: string,
  to: string,
): { start: number; end: number; text: string } | null {
  if (from === to) return null;
  let prefix = 0;
  const shortest = Math.min(from.length, to.length);
  while (prefix < shortest && from[prefix] === to[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { start: prefix, end: from.length - suffix, text: to.slice(prefix, to.length - suffix) };
}

/** 1-based line numbers of the marker lines inside the locked spans. */
export function markerLineNumbers(text: string, spans: readonly Span[]): number[] {
  const lines = text.split("\n");
  const found: number[] = [];
  let offset = 0;
  let spanIndex = 0;
  lines.forEach((line, i) => {
    while (spanIndex < spans.length && spans[spanIndex]!.end < offset) spanIndex++;
    const span = spans[spanIndex];
    if (span !== undefined && span.kind === "locked" && span.start <= offset && isMarkerLine(line)) {
      found.push(i + 1);
    }
    offset += line.length + 1;
  });
  return found;
}

/** Whether `[start, end]` lies inside one editable span (its edges included). */
export function insideEditable(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some((span) => span.kind === "editable" && span.start <= start && end <= span.end);
}

// ---------------------------------------------------------------------------
// The Monaco session: the model, its decorations, and the check.

type MonacoEditor = Parameters<OnMount>[0];
type MonacoApi = Parameters<OnMount>[1];
type MonacoModel = NonNullable<ReturnType<MonacoEditor["getModel"]>>;

/**
 * Tailwind classes, scanned by the web app (`@source`); tokens, so both
 * themes follow — the same surface as the stacked fallback's locked blocks.
 * Monaco keeps only `[\w-]` in a decoration's class names (`bg-fg/5` becomes
 * `bg-fg 5`), so no opacity modifier and no arbitrary value here.
 */
const LOCKED_LINE = "bg-surface-2";
const LOCKED_TEXT = "opacity-60";

interface SessionHost {
  emit: (regions: string[]) => void;
}

class LockedSession {
  private ids: string[] = [];
  private segments: readonly CodeSegment[] = [];
  private segmentsKey = "";
  private good: { text: string; spans: Span[] } = { text: "", spans: [] };
  private silent = false;
  private pendingRevert = false;
  private editable = false;
  private readonly model: MonacoModel;

  constructor(
    private readonly editor: MonacoEditor,
    private readonly monaco: MonacoApi,
    private readonly host: SessionHost,
  ) {
    this.model = editor.getModel()!;
    this.model.onDidChangeContent((event) => this.changed(event.isUndoing || event.isRedoing));
    editor.onDidChangeCursorSelection(() => this.followSelection());
    editor.onKeyDown((event) => {
      if (!this.editable) return;
      const backspace = event.keyCode === monaco.KeyCode.Backspace;
      const del = event.keyCode === monaco.KeyCode.Delete;
      if (!backspace && !del) return;
      const spans = this.spans();
      const blocked = (editor.getSelections() ?? []).some((selection) => {
        if (!selection.isEmpty()) return false;
        const at = this.model.getOffsetAt(selection.getPosition());
        return spans.some(
          (span) => span.kind === "editable" && (backspace ? span.start === at : span.end === at),
        );
      });
      if (blocked) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
  }

  /** Loads the program, unless the model already holds exactly it. */
  load(segments: readonly CodeSegment[], regions: readonly string[]) {
    const key = JSON.stringify(segments);
    const layout = layoutProgram(segments, regions);
    if (key === this.segmentsKey && layout.text === this.model.getValue()) return;
    this.segments = segments;
    this.segmentsKey = key;
    this.silent = true;
    try {
      if (this.model.getValue() !== layout.text) this.model.setValue(layout.text);
    } finally {
      this.silent = false;
    }
    this.lay(layout.spans);
    this.good = { text: layout.text, spans: layout.spans };
    this.hideMarkers();
    this.followSelection();
  }

  setEditable(editable: boolean) {
    this.editable = editable;
    this.followSelection();
  }

  setDiagnostics(diagnostics: readonly Diagnostic[]) {
    const count = this.model.getLineCount();
    this.monaco.editor.setModelMarkers(
      this.model,
      "compile",
      diagnostics
        .filter((d) => d.line >= 1 && d.line <= count)
        .map((d) => {
          // An empty range at a column is widened to the word by Monaco; a
          // line without a column is underlined whole.
          const column = d.column ?? this.model.getLineFirstNonWhitespaceColumn(d.line) ?? 1;
          return {
            severity:
              d.severity === "warning" ? this.monaco.MarkerSeverity.Warning : this.monaco.MarkerSeverity.Error,
            message: d.message,
            startLineNumber: d.line,
            startColumn: Math.max(1, column),
            endLineNumber: d.line,
            endColumn: d.column === null ? this.model.getLineMaxColumn(d.line) : Math.max(1, column),
          };
        }),
    );
  }

  private spans(): Span[] {
    return this.ids.map((id, i) => {
      const range = this.model.getDecorationRange(id);
      const segment = this.segments[i]!;
      if (range === null) return { kind: segment.kind, index: segment.index, start: 0, end: -1 };
      return {
        kind: segment.kind,
        index: segment.index,
        start: this.model.getOffsetAt(range.getStartPosition()),
        end: this.model.getOffsetAt(range.getEndPosition()),
      };
    });
  }

  /** Lays one tracked decoration per segment on `spans`. */
  private lay(spans: readonly Span[]) {
    const { TrackedRangeStickiness } = this.monaco.editor;
    this.ids = this.model.deltaDecorations(
      this.ids,
      spans.map((span) => {
        const start = this.model.getPositionAt(span.start);
        const end = this.model.getPositionAt(span.end);
        const range = new this.monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
        return span.kind === "locked"
          ? {
              range,
              options: {
                stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                isWholeLine: true,
                className: LOCKED_LINE,
                marginClassName: LOCKED_LINE,
                inlineClassName: LOCKED_TEXT,
              },
            }
          : { range, options: { stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges } };
      }),
    );
  }

  private changed(replay: boolean) {
    if (this.silent || this.pendingRevert) return;
    const text = this.model.getValue();
    let spans = this.spans();
    if (!checkLayout(text, spans, this.segments)) {
      const realigned = replay ? realignLayout(text, this.segments, spans) : null;
      if (realigned === null) {
        // Out of the event: the model must not be edited while it is still
        // telling its listeners about the previous edit.
        this.pendingRevert = true;
        queueMicrotask(() => this.revert());
        return;
      }
      spans = realigned;
      queueMicrotask(() => this.lay(realigned));
    }
    this.good = { text, spans };
    this.hideMarkers();
    this.host.emit(regionsFromLayout(text, spans, this.segments));
  }

  private revert() {
    this.pendingRevert = false;
    if (this.model.isDisposed()) return;
    const edit = minimalEdit(this.model.getValue(), this.good.text);
    if (edit !== null) {
      const start = this.model.getPositionAt(edit.start);
      const end = this.model.getPositionAt(edit.end);
      this.silent = true;
      try {
        this.model.pushEditOperations(
          this.editor.getSelections(),
          [
            {
              range: new this.monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
              text: edit.text,
            },
          ],
          () => null,
        );
      } finally {
        this.silent = false;
      }
    }
    this.lay(this.good.spans);
    this.hideMarkers();
    this.followSelection();
  }

  /** Decision 1: the marker lines fold away, the numbering stays. */
  private hideMarkers() {
    // Hidden areas are kept per SOURCE and merged, so the folding
    // controller's own never clobber these, nor these theirs.
    const widget = this.editor as MonacoEditor & {
      setHiddenAreas?: (ranges: unknown[], source?: unknown) => void;
    };
    if (typeof widget.setHiddenAreas !== "function") return;
    const ranges = markerLineNumbers(this.good.text, this.good.spans).map(
      (line) => new this.monaco.Range(line, 1, line, 1),
    );
    widget.setHiddenAreas(ranges, this);
  }

  /** Decision 3: read-only while a cursor touches a locked line. */
  private followSelection() {
    let writable = this.editable;
    if (writable) {
      const spans = this.spans();
      writable = (this.editor.getSelections() ?? []).every((selection) =>
        insideEditable(
          spans,
          this.model.getOffsetAt(selection.getStartPosition()),
          this.model.getOffsetAt(selection.getEndPosition()),
        ),
      );
    }
    this.editor.updateOptions({ readOnly: !writable });
  }
}

// ---------------------------------------------------------------------------
// The component.

export interface LockedEditorProps {
  segments: readonly CodeSegment[];
  /** One string per editable region, in template order. */
  regions: readonly string[];
  /** Absent means read-only. */
  onChange?: ((regions: string[]) => void) | undefined;
  language: CodeLanguage;
  /** Accessible name of the whole program. */
  label: string;
  /** Accessible name of region `n` (1-based) in the stacked fallback: a `{n}` template. */
  regionLabel: string;
  /** Accessible name of a locked block, and what Monaco says when one is typed into. */
  lockedLabel: string;
  /** Compiler diagnostics, drawn on their source lines (Monaco only). */
  diagnostics?: readonly Diagnostic[] | undefined;
  /** Forces the Monaco path on or off; defaults to {@link monacoAvailable}. */
  monaco?: boolean | undefined;
}

const LINE_PX = 19;
const MIN_PX = 4 * LINE_PX;
const MAX_PX = 30 * LINE_PX;

/** The stacked fallback of decision 5. */
function Stack({
  segments,
  regions,
  onChange,
  language,
  label,
  regionLabel,
  lockedLabel,
}: LockedEditorProps): ReactNode {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      {segments.map((segment, i) => {
        if (segment.kind === "locked") {
          const text = trimTrailingNewline(stripMarkerLines(segment.text));
          if (text === "") return null;
          return (
            <pre key={i} className={lockedBlock} aria-label={lockedLabel} title={lockedLabel}>
              <code>{text}</code>
            </pre>
          );
        }
        const index = segment.index ?? 0;
        return (
          <CodeArea
            key={i}
            label={fmt(regionLabel, { n: index + 1 })}
            language={language}
            value={regions[index] ?? ""}
            onChange={
              onChange === undefined
                ? undefined
                : (next) => onChange(regions.map((text, j) => (j === index ? next : text)))
            }
            readOnly={onChange === undefined}
            minLines={4}
            monaco={false}
          />
        );
      })}
    </div>
  );
}

export function LockedEditor(props: LockedEditorProps): ReactNode {
  const { segments, regions, onChange, language, label, lockedLabel, diagnostics, monaco } = props;
  const session = useRef<LockedSession | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [height, setHeight] = useState<number | null>(null);

  const readOnly = onChange === undefined;
  // Memoised: the wrapper re-applies its options whenever the object changes,
  // which would undo the session's read-only switch (decision 3) on every
  // render. `readOnly` itself is the session's alone.
  const options = useMemo(
    () => ({
      domReadOnly: readOnly,
      readOnlyMessage: { value: lockedLabel },
      ariaLabel: label,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      fontSize: 13,
      tabSize: 4,
      lineNumbersMinChars: 3,
      renderLineHighlight: "none" as const,
      overviewRulerLanes: 0,
      padding: { top: 8, bottom: 8 },
      // A drop lands where the mouse is, not where the cursor was: the
      // read-only switch of decision 3 cannot see it coming.
      dragAndDrop: false,
      dropIntoEditor: { enabled: false },
    }),
    [readOnly, lockedLabel, label],
  );

  useEffect(() => {
    session.current?.load(segments, regions);
  }, [segments, regions]);
  useEffect(() => {
    session.current?.setEditable(!readOnly);
  }, [readOnly, options]);
  useEffect(() => {
    session.current?.setDiagnostics(diagnostics ?? []);
  }, [diagnostics]);

  const stack = <Stack {...props} />;
  if (!(monaco ?? monacoAvailable())) return stack;

  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const initial = layoutProgram(segments, regions);

  const mount: OnMount = (editor, api) => {
    const current = new LockedSession(editor, api, {
      emit: (next) => latest.current.onChange?.(next),
    });
    session.current = current;
    current.load(latest.current.segments, latest.current.regions);
    current.setEditable(latest.current.onChange !== undefined);
    current.setDiagnostics(latest.current.diagnostics ?? []);
    const fit = () => setHeight(Math.min(MAX_PX, Math.max(MIN_PX, editor.getContentHeight())));
    editor.onDidContentSizeChange(fit);
    fit();
    editor.onDidDispose(() => {
      if (session.current === current) session.current = null;
    });
  };

  return (
    <div
      className="overflow-hidden rounded-field border border-line-strong"
      data-testid="locked-editor"
    >
      <MonacoBoundary fallback={stack}>
        <Suspense fallback={stack}>
          <LazyMonaco
            height={`${height ?? Math.min(MAX_PX, Math.max(MIN_PX, initial.text.split("\n").length * LINE_PX + 16))}px`}
            language={MONACO_LANGUAGE[language]}
            theme={dark ? "vs-dark" : "light"}
            defaultValue={initial.text}
            loading={stack}
            onMount={mount}
            options={options}
          />
        </Suspense>
      </MonacoBoundary>
    </div>
  );
}

export default LockedEditor;
