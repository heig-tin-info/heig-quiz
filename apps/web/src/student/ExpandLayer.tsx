/**
 * The EXPAND layer the attempt lends a question type (`PlayerProps.Expand`,
 * ADR-046 §6 and its addendum): the `diagram` canvas drawn over the page with
 * a margin of 16 px, under a thin bar that keeps what the exam screen must
 * never hide — the remaining time on the SERVER's clock (invariant 5), the
 * save state — and the layer's one primary action, "Back to the questions".
 *
 * It is a layer of the page, not the browser's full screen: the Fullscreen
 * API would hide the header and ask Safe Exam Browser (ADR-027) to change its
 * window, which it may refuse.
 *
 * The keyboard:
 *   - ESCAPE first reaches the canvas, which cancels the link being drawn,
 *     the tool or the selection and then CONSUMES the key; a key it left
 *     alone closes the layer. Hence `useLayer(…, { escape: false })` and a
 *     listener in the bubble phase, after the canvas's own;
 *   - ALT+←/→ closes the layer, and the player's own listener
 *     (`usePlayerControls`) moves to the neighbouring question as ever.
 *
 * What the bar shows comes from {@link ExpandChrome}, which the player
 * provides around the question: the question itself is memoised, and a
 * context lets the clock and the badge change without re-rendering it.
 */
import { createContext, useContext, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { ExpandProps } from "@quiz/core/client";

import { useT } from "../i18n";
import { Button, ClockCountdown, SyncBadge, useLayer, useScrollLock, Z, type SyncState } from "../ui";

/** What the bar of the layer shows: the attempt's clock and its save state. */
export interface ExpandChromeValue {
  /** Epoch ms on the server's clock; `null` in a `manual` evaluation. */
  deadlineAt: number | null;
  clock: () => number;
  paused: boolean;
  /** Absent where nothing is saved as one types (the preview). */
  sync?: SyncState | undefined;
}

export const ExpandChrome = createContext<ExpandChromeValue | null>(null);

export function ExpandLayer({ open, onClose, children }: ExpandProps) {
  if (!open) return null;
  return createPortal(<Panel onClose={onClose}>{children}</Panel>, document.body);
}

function Panel({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const t = useT();
  const chrome = useContext(ExpandChrome);
  const panel = useRef<HTMLDivElement>(null);
  useLayer(panel, onClose, { escape: false });
  useScrollLock();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !e.isDefaultPrevented()) {
      e.preventDefault();
      onClose();
    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      // Not prevented: the player's window listener still moves.
      onClose();
    }
  };

  return (
    <div className={`fixed inset-0 ${Z.modal} bg-fg/30 p-4 backdrop-blur-[2px]`}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("player.expand.title")}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex h-full flex-col overflow-hidden rounded-sheet border border-line bg-surface shadow-overlay focus:outline-none"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5">
          <span className="min-w-0 flex-1" />
          {chrome?.deadlineAt === null || chrome === null ? null : (
            <ClockCountdown deadlineAt={chrome.deadlineAt} clock={chrome.clock} paused={chrome.paused} />
          )}
          {chrome?.sync === undefined ? null : <SyncBadge state={chrome.sync} />}
          <Button variant="primary" size="sm" onClick={onClose}>
            {t("player.expand.back")}
          </Button>
        </div>
        <div className="min-h-0 flex-1 p-2">{children}</div>
      </div>
    </div>
  );
}
