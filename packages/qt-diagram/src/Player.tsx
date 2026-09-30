/**
 * The `diagram` player (docs/spec/04 §4.14, ADR-046 §6): the statement, the
 * canvas inline under it, and an Expand button that opens the same canvas in
 * the host's layer (`PlayerProps.Expand`) — the page covered with a margin of
 * 16 px, the host's thin bar above: the server's clock, the save state, and
 * "Back to the questions". Never the browser's full screen.
 *
 * Both views edit ONE answer, the one the host holds: the canvas is
 * controlled, and every committed edit goes out through `onChange` as a whole
 * scene, which the autosave sends as usual. Nothing is written before the
 * first edit — the starter shows, but an untouched question has no answer.
 *
 * On a screen under 1024 px the inline canvas is a preview and the layer is
 * where one draws; without a host layer (the try panel, the grading panel)
 * there is no Expand button, and the inline canvas edits at every width.
 *
 * ESCAPE in the layer: the canvas cancels what it has in progress first (the
 * link being drawn, the tool, the selection) and consumes the key only then;
 * a key it leaves alone closes the layer, which is the host's to decide.
 */
import { useState, useSyncExternalStore } from "react";

import type { MarkdownRenderer, PlayerProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { DiagramEditor, DiagramView, type DiagramStrings } from "@quiz/diagram/client";
import type { Scene } from "@quiz/diagram/server";
import { buttonClass, caption, isLocked, label, markdown, StrokeIcon } from "@quiz/ui";

import { startingScene, type DiagramAnswer, type DiagramStudent } from "./schema.js";
import { diagramPlayerStrings, type DiagramPlayerStringKey } from "./strings.js";

type DiagramPlayerProps = PlayerProps<DiagramStudent, DiagramAnswer> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<DiagramPlayerStringKey>;
  /** The engine's dictionary: the tools' accessible names, the inspector. */
  canvasStrings?: Partial<DiagramStrings>;
  renderMarkdown?: MarkdownRenderer;
};

/** The inline canvas: tall enough to draw a dozen elements, short enough to keep the prompt in sight. */
const INLINE_HEIGHT = 440;

/** Below this width the inline canvas is a preview (docs/04 §4.14). */
const WIDE_QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the window is wide enough to draw inline; a host without `matchMedia` (a test) is wide. */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia !== "function" || window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

/** Four corners pushed outwards: the pictogram of "expand". */
const ExpandIcon = () => (
  <StrokeIcon>
    <path d="M3.5 9V3.5H9M15 3.5h5.5V9M20.5 15v5.5H15M9 20.5H3.5V15" />
  </StrokeIcon>
);

export function DiagramPlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  strings,
  canvasStrings,
  renderMarkdown,
  Expand,
}: DiagramPlayerProps) {
  const s = resolveStrings(diagramPlayerStrings, strings);
  const locked = isLocked(readOnly, disabled);
  const wide = useWide();
  const [expanded, setExpanded] = useState(false);
  const scene = answer?.scene ?? startingScene(student.starter);
  const change = (next: Scene) => onChange({ scene: next });
  /** Narrow, with a layer to draw in: the inline canvas is only a preview. */
  const preview = Expand !== undefined && !wide;

  const editor = (height?: number) => (
    <DiagramEditor
      kind={student.kind}
      value={scene}
      onChange={change}
      readOnly={locked}
      strings={canvasStrings}
      aria-label={s.label}
      {...(height === undefined ? {} : { height })}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="text-lg leading-relaxed text-fg">{markdown(renderMarkdown, student.prompt)}</div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className={label}>{s.label}</span>
          {Expand === undefined ? null : (
            <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setExpanded(true)}>
              <ExpandIcon />
              {s.expand}
            </button>
          )}
        </div>
        {expanded ? (
          // The layer holds the one editor; two live editors would keep two
          // undo histories of the same answer.
          <p className={caption}>{s.expanded}</p>
        ) : preview ? (
          <button
            type="button"
            className="rounded-field border border-line bg-surface p-2 text-left"
            onClick={() => setExpanded(true)}
            aria-label={s.expandHint}
          >
            {/* The button names itself; the picture inside it is decoration. */}
            <div aria-hidden="true">
              <DiagramView kind={student.kind} value={scene} maxHeight={280} strings={canvasStrings} />
            </div>
            {locked ? null : <span className={caption}>{s.expandHint}</span>}
          </button>
        ) : (
          editor(INLINE_HEIGHT)
        )}
      </div>
      {Expand === undefined ? null : (
        <Expand open={expanded} onClose={() => setExpanded(false)}>
          {editor()}
        </Expand>
      )}
    </div>
  );
}
