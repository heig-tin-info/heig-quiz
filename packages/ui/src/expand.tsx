/**
 * A canvas that can be EXPANDED into the host's layer (`PlayerProps.Expand`,
 * `EditorProps.Expand`; ADR-046, addendum): the one behaviour the `diagram`
 * and `circuit` surfaces share, player and editor alike, written once.
 *
 * - A heading row: the canvas's name, whatever the caller adds beside it, and
 *   an Expand button — only when the host lends a layer. Without one (the
 *   grading panel, a package's own tests) there is no button, and the inline
 *   canvas edits at every width.
 * - While the layer is open the inline spot shows ONE line: the layer holds
 *   the one live editor, since two would keep two undo histories of the same
 *   value.
 * - With a `preview` (the players), a window under 1024 px shows it instead
 *   of the inline canvas: a picture that opens the layer, which is where one
 *   draws on a narrow screen.
 *
 * The layer is the host's: this component only renders it with `open`, a
 * title and the canvas as `children`, and the host calls `onClose`. ESCAPE
 * belongs to the canvas first — it cancels what it has in progress and
 * consumes the key only then (`preventDefault`); a key it leaves alone is the
 * host's, which closes the layer.
 *
 * Every word arrives translated (`strings`), like every primitive here.
 */
import { useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

import type { ExpandProps } from "@quiz/core/client";

import { StrokeIcon } from "./icon.js";
import { buttonClass, caption, label as labelClass } from "./styles.js";

/** Below this width a canvas with a preview draws in the layer only (docs/spec/04 §4.11, §4.14). */
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
function ExpandIcon({ className }: { className?: string | undefined }): ReactNode {
  return (
    <StrokeIcon className={className}>
      <path d="M3.5 9V3.5H9M15 3.5h5.5V9M20.5 15v5.5H15M9 20.5H3.5V15" />
    </StrokeIcon>
  );
}

export interface ExpandableCanvasStrings {
  /** The button: "Expand". */
  expand: string;
  /** The one line left in place while the layer is open. */
  expanded: string;
  /** The narrow preview's name and caption: "Expand the diagram to draw." Needed with `preview`. */
  expandHint?: string | undefined;
}

export interface ExpandableCanvasProps {
  /** The host's layer; absent, no Expand button and no preview. */
  Expand?: ComponentType<ExpandProps> | undefined;
  /** What is being drawn: the heading's words and the layer's title. */
  title: string;
  /** The heading, when the caller's is more than `title` as a label (a section title). */
  heading?: ReactNode;
  /** One line under the heading row. */
  hint?: ReactNode;
  /** Beside the heading, before the Expand button (a "Remove" of the caller's). */
  actions?: ReactNode;
  strings: ExpandableCanvasStrings;
  /**
   * The canvas. Called with `true` for the layer, where it fills the room it
   * is given (`h-full`), and with `false` inline, at its own height.
   */
  children: (expanded: boolean) => ReactNode;
  /**
   * A still picture of the canvas, shown instead of it under 1024 px when the
   * host lends a layer. Absent (the editors), the canvas stays live inline at
   * every width.
   */
  preview?: ReactNode;
  /** Read-only: the preview drops its "expand to draw" caption. */
  locked?: boolean | undefined;
}

export function ExpandableCanvas({
  Expand,
  title,
  heading,
  hint,
  actions,
  strings: s,
  children,
  preview,
  locked = false,
}: ExpandableCanvasProps): ReactNode {
  const wide = useWide();
  const [expanded, setExpanded] = useState(false);
  const previewing = Expand !== undefined && preview !== undefined && !wide;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading ?? <span className={labelClass}>{title}</span>}
        {actions === undefined && Expand === undefined ? null : (
          <span className="flex flex-wrap items-center gap-2">
            {actions}
            {Expand === undefined ? null : (
              <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setExpanded(true)}>
                <ExpandIcon />
                {s.expand}
              </button>
            )}
          </span>
        )}
      </div>
      {hint}
      {expanded ? (
        <p className={caption}>{s.expanded}</p>
      ) : previewing ? (
        <button
          type="button"
          className="rounded-field border border-line bg-surface p-2 text-left"
          onClick={() => setExpanded(true)}
          aria-label={s.expandHint}
        >
          {/* The button names itself; the picture inside it is decoration. */}
          <div aria-hidden="true">{preview}</div>
          {locked ? null : <span className={caption}>{s.expandHint}</span>}
        </button>
      ) : (
        children(false)
      )}
      {Expand === undefined ? null : (
        <Expand open={expanded} onClose={() => setExpanded(false)} title={title}>
          {expanded ? children(true) : null}
        </Expand>
      )}
    </div>
  );
}
