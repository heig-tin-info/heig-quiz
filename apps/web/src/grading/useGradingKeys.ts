import { useEffect, useRef } from "react";

import { useT } from "../i18n";
import { useShortcuts } from "../shortcuts";
import { isTyping } from "../ui";

export interface GradingKeyActions {
  /** The answer panel is open: ↑ / ↓ then move it, and ← / → stay put. */
  panelOpen: boolean;
  /** ← / →: the previous or the next question. */
  onQuestion: (delta: number) => void;
  /** ↑ / ↓: the previous or the next row, the expected row first. */
  onRow: (delta: number) => void;
  /** Enter: the selected row, in the panel. */
  onOpen: () => void;
  /** V: validate the selected row's proposal. */
  onValidate: () => void;
  /** A: adjust the selected row, the panel open on its points. */
  onAdjust: () => void;
}

/**
 * The grading screen's keyboard (docs/08 §8.5, ADR-040): ← / → change the
 * question, ↑ / ↓ the row, Enter opens it, V validates it, A adjusts it;
 * Escape is the panel's own (a sheet closes on it). Bare keys, because
 * nothing on this screen is typed into — except a field, which owns the
 * keyboard while it has the focus, and any OTHER layer (a confirmation, the
 * re-grade sheet) that is up over the table or the panel.
 *
 * The keys are not drawn on the page: they are registered in the app's
 * shortcut strip for as long as the screen is mounted.
 */
export function useGradingKeys(actions: GradingKeyActions) {
  const t = useT();
  // The latest callbacks, read at the key press: the listener is attached once.
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = latest.current;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(document.activeElement)) return;
      // Our own panel is one dialog; anything more is a layer over it.
      const dialogs = document.querySelectorAll('[role="dialog"]').length;
      if (dialogs > (a.panelOpen ? 1 : 0)) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      switch (key) {
        case "ArrowLeft":
        case "ArrowRight":
          if (a.panelOpen) return;
          e.preventDefault();
          a.onQuestion(key === "ArrowLeft" ? -1 : 1);
          return;
        case "ArrowUp":
        case "ArrowDown":
          e.preventDefault();
          a.onRow(key === "ArrowUp" ? -1 : 1);
          return;
        case "Enter": {
          // A focused control (a button, a row) answers Enter itself.
          const focused = document.activeElement;
          if (a.panelOpen || (focused instanceof HTMLElement && focused !== document.body)) return;
          e.preventDefault();
          a.onOpen();
          return;
        }
        case "v":
          e.preventDefault();
          a.onValidate();
          return;
        case "a":
          e.preventDefault();
          a.onAdjust();
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useShortcuts([
    { keys: "← →", label: t("grading.keys.question") },
    { keys: "↑ ↓", label: t("grading.keys.answer") },
    { keys: "Enter", label: t("grading.keys.open") },
    { keys: "V", label: t("grading.validate") },
    { keys: "A", label: t("grading.override") },
  ]);
}
