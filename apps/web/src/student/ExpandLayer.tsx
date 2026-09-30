/**
 * The attempt's EXPAND layer (`PlayerProps.Expand`, ADR-046 §6 and its
 * addendum): the `diagram` or `circuit` canvas in the app's expand layer
 * (`ui/expand.tsx`), under a bar that keeps what the exam screen must never
 * hide — the remaining time on the SERVER's clock (invariant 5), the save
 * state — and the layer's one primary action, "Back to the questions".
 * Alt+←/→ closes it and moves to the neighbouring question.
 *
 * What the bar shows comes from {@link ExpandChrome}, which the player
 * provides around the question: the question itself is memoised, and a
 * context lets the clock and the badge change without re-rendering it.
 */
import { createContext, useContext } from "react";

import type { ExpandProps } from "@quiz/core/client";

import { useT } from "../i18n";
import { ClockCountdown, ExpandPanel, SyncBadge, type SyncState } from "../ui";

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
  const t = useT();
  const chrome = useContext(ExpandChrome);
  return (
    <ExpandPanel
      open={open}
      onClose={onClose}
      label={t("player.expand.title")}
      closeLabel={t("player.expand.back")}
      navigation
      status={
        <>
          {chrome === null || chrome.deadlineAt === null ? null : (
            <ClockCountdown deadlineAt={chrome.deadlineAt} clock={chrome.clock} paused={chrome.paused} />
          )}
          {chrome?.sync === undefined ? null : <SyncBadge state={chrome.sync} />}
        </>
      }
    >
      {children}
    </ExpandPanel>
  );
}
