import { useCallback, useEffect } from "react";

import type { GradingEntry } from "@quiz/contracts";

import { useT } from "../i18n";
import { useShortcuts } from "../shortcuts";
import { isTyping } from "../ui";
import { entryKey } from "./EntryList";
import { neighbour } from "./useGradingTraversal";

/**
 * The grading panel's keyboard (docs/08 §8.5): `←` / `→` walk the answers of
 * the step — the same move as the detail's Previous / Next buttons, through
 * the same `neighbour` — `V` validates the open proposal and moves on, `O` opens the
 * adjustment sheet of the open answer. Bare keys, because nothing on this
 * screen is typed into — except a sheet, a dialog or a field, which own the
 * keyboard while they are up.
 */
export function useGradingKeys({
  entries,
  selected,
  onSelect,
  onValidate,
  onOverride,
}: {
  entries: readonly GradingEntry[];
  selected: string | null;
  onSelect: (key: string) => void;
  /** Called with the grading id of the open answer, when it is a proposal. */
  onValidate: (gradingId: string) => void;
  onOverride: (key: string) => void;
}) {
  const t = useT();

  const move = useCallback(
    (delta: number) => {
      const next = neighbour(entries, selected, delta);
      if (next) onSelect(next);
    },
    [entries, selected, onSelect],
  );

  useEffect(() => {
    const selectedEntry = entries.find((e) => entryKey(e) === selected) ?? null;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // A sheet, a dialog or a field owns the keyboard while it is up: `v`
      // must type a v in the comment box, not validate behind the form.
      if (isTyping(document.activeElement)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const key = e.key.toLowerCase();
      if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(-1);
      } else if (key === "v") {
        e.preventDefault();
        const grading = selectedEntry?.grading;
        if (grading && grading.state === "proposed") onValidate(grading.id);
        move(1);
      } else if (key === "o") {
        e.preventDefault();
        if (selected) onOverride(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, entries, selected, onValidate, onOverride]);

  // The same four in the sidebar strip, while the panel is mounted.
  useShortcuts([
    { keys: "←", label: t("shortcuts.prevEntry") },
    { keys: "→", label: t("shortcuts.nextEntry") },
    { keys: "V", label: t("grading.validate") },
    { keys: "O", label: t("grading.override") },
  ]);
}
