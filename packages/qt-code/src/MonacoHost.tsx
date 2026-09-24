/**
 * The code surface: Monaco when the browser can run it, a plain `<textarea>`
 * otherwise.
 *
 * Two decisions live here.
 *
 * 1. **Monaco is lazy** (`React.lazy` on `@monaco-editor/react`, itself loading
 *    the editor from its CDN), so it never enters the initial bundle
 *    (N-PERF-05). Until it resolves — and forever, if it fails to resolve —
 *    the same `<textarea>` is rendered, with the same value and the same
 *    `onChange`. A student whose network blocks the CDN keeps a usable editor
 *    and loses only the syntax colours.
 *
 * 2. **Locked regions are DISPLAY, not a guarantee.** A template with locked
 *    regions is not edited here but in `./LockedEditor.tsx`: one Monaco model
 *    holding the whole program, its locked lines greyed and refused to the
 *    keyboard, so the student reads one file with its real line numbers and
 *    the compiler's errors land on the right line. That refusal is a
 *    rendering convenience a devtools console can undo, and it does not need
 *    to be more: only the editable regions ever leave the browser, and the
 *    server rebuilds the file from the STORED template and those regions
 *    (invariant 14). Where Monaco does not load, the locked editor falls back
 *    to a stack of read-only blocks and one textarea per region, built from
 *    this component.
 */
import { Component, lazy, Suspense, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { OnMount } from "@monaco-editor/react";

import type { CodeLanguage } from "./schema.js";
import { codeArea, cx } from "@quiz/ui";

/** The Monaco language ids, which differ from ours for JavaScript. */
export const MONACO_LANGUAGE: Record<CodeLanguage, string> = {
  c: "c",
  cpp: "cpp",
  python: "python",
  js: "javascript",
  rust: "rust",
};

export const LazyMonaco = lazy(async () => {
  // The named export, not the default one: `@monaco-editor/react` ships both
  // and only the named one is typed as a component under NodeNext resolution.
  const { Editor } = await import("@monaco-editor/react");
  return { default: Editor };
});

/**
 * Whether the Monaco path is worth trying. jsdom has no layout, no canvas and
 * no network, so the component suite always renders the textarea — which is
 * also the surface every test drives.
 */
export function monacoAvailable(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return !navigator.userAgent.includes("jsdom");
}

/** A failed dynamic import throws while rendering; the textarea takes over. */
export class MonacoBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface CodeAreaProps {
  value: string;
  language: CodeLanguage;
  /** Absent (or `undefined`) means read-only, so a caller can pass the flag straight through. */
  onChange?: ((next: string) => void) | undefined;
  readOnly?: boolean | undefined;
  /** Accessible name; there is no visible label inside a stack of editors. */
  label: string;
  /** Minimum height, in lines. */
  minLines?: number | undefined;
  /** Forces the Monaco path on or off; defaults to {@link monacoAvailable}. */
  monaco?: boolean | undefined;
  id?: string | undefined;
  className?: string | undefined;
  /**
   * Called once Monaco is mounted, with the editor and the `monaco` namespace
   * — for a caller that listens to the selection or adds its own widgets.
   * Never called on the textarea path.
   */
  onMount?: OnMount | undefined;
  /** Whole-line decorations, Monaco path only (the textarea cannot draw them). */
  decorations?: readonly CodeLineDecoration[] | undefined;
  /**
   * The textarea's selection, as offsets, whenever it may have changed — the
   * fallback's counterpart of listening to Monaco's selection in `onMount`.
   */
  onTextareaSelect?: ((start: number, end: number) => void) | undefined;
}

/** A run of whole lines drawn with a class, 1-based and inclusive. */
export interface CodeLineDecoration {
  fromLine: number;
  toLine: number;
  /** On the line's background layer. */
  className: string;
  /** On the line's text. */
  inlineClassName?: string | undefined;
}

type MonacoEditor = Parameters<OnMount>[0];
type MonacoApi = Parameters<OnMount>[1];

const LINE_PX = 20;
const MAX_LINES = 30;

function heightLines(value: string, minLines: number): number {
  return Math.min(MAX_LINES, Math.max(minLines, value.split("\n").length));
}

export function CodeArea({
  value,
  language,
  onChange,
  readOnly = false,
  label,
  minLines = 6,
  monaco,
  id,
  className = "",
  onMount,
  decorations,
  onTextareaSelect,
}: CodeAreaProps) {
  const lines = heightLines(value, minLines);
  const mounted = useRef<{
    editor: MonacoEditor;
    monaco: MonacoApi;
    collection: ReturnType<MonacoEditor["createDecorationsCollection"]>;
  } | null>(null);

  const draw = (host: NonNullable<typeof mounted.current>) =>
    host.collection.set(
      (decorations ?? []).map((d) => ({
        range: new host.monaco.Range(d.fromLine, 1, d.toLine, 1),
        options: {
          isWholeLine: true,
          className: d.className,
          ...(d.inlineClassName === undefined ? {} : { inlineClassName: d.inlineClassName }),
        },
      })),
    );

  useEffect(() => {
    if (mounted.current !== null) draw(mounted.current);
    // `draw` reads nothing but `decorations`.
  }, [decorations]);

  const handleMount: OnMount = (editor, monacoApi) => {
    mounted.current = { editor, monaco: monacoApi, collection: editor.createDecorationsCollection() };
    // The first decorations were passed before the editor existed.
    draw(mounted.current);
    onMount?.(editor, monacoApi);
  };
  const select = (target: HTMLTextAreaElement) =>
    onTextareaSelect?.(target.selectionStart, target.selectionEnd);

  const fallback = (
    <textarea
      id={id}
      aria-label={label}
      value={value}
      readOnly={readOnly || onChange === undefined}
      spellCheck={false}
      rows={lines}
      onChange={(e) => onChange?.(e.target.value)}
      onSelect={(e) => select(e.currentTarget)}
      onKeyUp={(e) => select(e.currentTarget)}
      onMouseUp={(e) => select(e.currentTarget)}
      className={cx(codeArea, readOnly && "bg-surface-2 text-fg-muted", className)}
    />
  );

  if (!(monaco ?? monacoAvailable())) return fallback;

  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");

  return (
    <div
      className={cx("overflow-hidden rounded-field border border-line-strong", className)}
      data-testid="monaco-host"
    >
      <MonacoBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <LazyMonaco
            height={`${lines * LINE_PX + 16}px`}
            language={MONACO_LANGUAGE[language]}
            theme={dark ? "vs-dark" : "light"}
            value={value}
            onChange={(next) => onChange?.(next ?? "")}
            onMount={handleMount}
            options={{
              readOnly: readOnly || onChange === undefined,
              domReadOnly: readOnly || onChange === undefined,
              ariaLabel: label,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              fontSize: 13,
              tabSize: 4,
              lineNumbersMinChars: 3,
              renderLineHighlight: "none",
              overviewRulerLanes: 0,
            }}
          />
        </Suspense>
      </MonacoBoundary>
    </div>
  );
}

export default CodeArea;
