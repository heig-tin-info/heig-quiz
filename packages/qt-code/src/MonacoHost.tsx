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
 * 2. **Locked regions are enforced by SPLITTING, not by decorating.** The
 *    player stacks one read-only block per locked segment and one editor per
 *    editable region, so a locked line is not in any editable buffer at all.
 *    Read-only ranges inside a single Monaco model would be a rendering trick
 *    a devtools console can undo; here there is nothing to undo, and the
 *    fallback keeps the same guarantee with no extra code. The server rebuilds
 *    the file from the template either way (invariant 14) — this is about what
 *    the student sees, not about what is trusted.
 */
import { Component, lazy, Suspense } from "react";
import type { ReactNode } from "react";

import type { CodeLanguage } from "./schema.js";
import { codeArea, cx } from "@quiz/ui";

/** The Monaco language ids, which differ from ours for JavaScript. */
const MONACO_LANGUAGE: Record<CodeLanguage, string> = {
  c: "c",
  cpp: "cpp",
  python: "python",
  js: "javascript",
  rust: "rust",
};

const LazyMonaco = lazy(async () => {
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
class MonacoBoundary extends Component<
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
}

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
}: CodeAreaProps) {
  const lines = heightLines(value, minLines);

  const fallback = (
    <textarea
      id={id}
      aria-label={label}
      value={value}
      readOnly={readOnly || onChange === undefined}
      spellCheck={false}
      rows={lines}
      onChange={(e) => onChange?.(e.target.value)}
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
