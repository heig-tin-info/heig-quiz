import { useEffect, useState } from "react";

import { entryKey } from "./EntryList";
import type { GradingOrder } from "./labels";
import { neighbour, useGradingTraversal } from "./useGradingTraversal";
import { useGradingView } from "./view";

/**
 * The choices of one grading session and what they read: the remembered
 * view (order, filters, parts — #110), the names switch, the step and the
 * open answer, fed to `useGradingTraversal`. The panel lays the screen out;
 * this hook is where the traversal's state lives and how it moves.
 *
 * The order, the filters and the parts shown are remembered per browser;
 * the names are not, and start hidden on every visit (F-GRADE-03). The step
 * and the open answer are where the teacher is, and a new visit starts over.
 */
export function useGradingSession(evaluationId: string) {
  const [view, setView] = useGradingView();
  const [showNames, setShowNames] = useState(false);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  const traversal = useGradingTraversal(evaluationId, {
    order: view.order,
    index,
    selected,
    stateFilter: view.stateFilter,
    source: view.source,
    confidence: view.confidence,
    showNames,
  });
  const { entries, steps } = traversal;

  // The selection follows the list: it lands on the first answer of a step
  // and never points at a row that is no longer there.
  useEffect(() => {
    if (entries.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((current) =>
      current && entries.some((e) => entryKey(e) === current) ? current : entryKey(entries[0]!),
    );
  }, [entries]);

  const count = steps.length;
  return {
    ...traversal,
    view,
    /** Merges a patch into the remembered view. */
    setView,
    /** Another order restarts at its first step. */
    setOrder: (order: GradingOrder) => {
      setView({ order });
      setIndex(0);
    },
    showNames,
    setShowNames,
    index,
    /** The steps wrap: the chevrons go round. */
    prevStep: () => setIndex((i) => (i - 1 + count) % count),
    nextStep: () => setIndex((i) => (i + 1) % count),
    jumpTo: setIndex,
    selected,
    select: setSelected,
    /** One answer back or forward: the detail's buttons, the same as `←` / `→`. */
    move: (delta: number) => {
      const next = neighbour(entries, selected, delta);
      if (next) setSelected(next);
    },
  };
}

export type GradingSession = ReturnType<typeof useGradingSession>;
