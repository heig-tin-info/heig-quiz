/**
 * The EXPAND layer (ADR-046 §6 and addendum): what a host lends a question
 * type's canvas through `PlayerProps.Expand` or `EditorProps.Expand`. The
 * canvas over the page with a margin of 16 px, under a thin bar: what the
 * layer holds on the left, a status on the right (the clock and the save
 * state of an attempt, the draft's save state in the editor), and the layer's
 * ONE primary action, which closes it.
 *
 * It is a layer of the page, not the browser's full screen: the Fullscreen
 * API would hide the header and ask Safe Exam Browser (ADR-027) to change its
 * window, which it may refuse.
 *
 * One layer, two hosts: `student/ExpandLayer.tsx` (the attempt) and
 * `question/EditorExpandLayer.tsx` (the teacher's editor and previews) only
 * fill the bar. The keyboard is here:
 *   - ESCAPE first reaches the canvas, which cancels the link or the wire
 *     being drawn, the tool or the selection and then CONSUMES the key
 *     (`preventDefault`); a key it left alone closes the layer. Hence
 *     `useLayer(…, { escape: false })` and a listener in the bubble phase,
 *     after the canvas's own;
 *   - with `navigation` (the attempt only), ALT+←/→ closes the layer and is
 *     left to the player's own listener (`usePlayerControls`), which moves to
 *     the neighbouring question as ever.
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./controls";
import { useLayer, useScrollLock, Z } from "./layers";

export interface ExpandPanelProps {
  open: boolean;
  onClose: () => void;
  /** The dialog's accessible name. */
  label: string;
  /** The one primary action's words ("Back to the questions", "Close"). */
  closeLabel: string;
  /** The left of the bar: what is being edited. */
  title?: ReactNode;
  /** The right of the bar, before the action: a clock, a save state. */
  status?: ReactNode;
  /** Alt+←/→ closes the layer and moves on (the attempt's question navigation). */
  navigation?: boolean;
  children: ReactNode;
}

export function ExpandPanel({ open, ...props }: ExpandPanelProps) {
  if (!open) return null;
  return createPortal(<Panel {...props} />, document.body);
}

function Panel({ onClose, label, closeLabel, title, status, navigation = false, children }: Omit<ExpandPanelProps, "open">) {
  const panel = useRef<HTMLDivElement>(null);
  useLayer(panel, onClose, { escape: false });
  useScrollLock();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !e.isDefaultPrevented()) {
      e.preventDefault();
      onClose();
    } else if (navigation && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      // Not prevented: the player's window listener still moves.
      onClose();
    }
  };

  return (
    // Portalled but still in the React tree of the canvas's host (a sheet, a
    // pane): a click in here is not a click on what lies under it.
    <div className={`fixed inset-0 ${Z.modal} bg-fg/30 p-4 backdrop-blur-[2px]`} onClick={(e) => e.stopPropagation()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex h-full flex-col overflow-hidden rounded-sheet border border-line bg-surface shadow-overlay focus:outline-none"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{title}</span>
          {status}
          <Button variant="primary" size="sm" onClick={onClose}>
            {closeLabel}
          </Button>
        </div>
        <div className="min-h-0 flex-1 p-2">{children}</div>
      </div>
    </div>
  );
}
