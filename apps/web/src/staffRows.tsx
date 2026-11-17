import { useMemo } from "react";

import { useT } from "./i18n";
import { Switch } from "./ui";
import { usePersistentChoice } from "./ui/state";

/**
 * "Show test attempts" (ADR-018, amended 2026-11-17, decision 5): a
 * teacher's own walk, from a staff seat, is a row of the staff's tables. The
 * switch shows or hides those ROWS and nothing else: every figure (a mean, a
 * count, a histogram, a success rate) is the server's, the class alone,
 * whatever it says, and no export reads it.
 *
 * Remembered per screen in this browser, never on the server: a habit, like
 * a list's layout. Hidden by default where the class is being read (the
 * results table, the gradebook), shown where the work is (grading, the live
 * dashboard), as the owner chose.
 */
export type StaffRowsScreen = "results" | "gradebook" | "grading" | "live";

const SHOWN_BY_DEFAULT: Record<StaffRowsScreen, boolean> = {
  results: false,
  gradebook: false,
  grading: true,
  live: true,
};

const CHOICES = ["shown", "hidden"] as const;

export interface StaffRows<R> {
  /** The rows to draw: all of them, or the class alone. */
  visible: R[];
  /** Some row is a staff one: the switch has something to do. */
  present: boolean;
  shown: boolean;
  setShown: (shown: boolean) => void;
}

/** The rows a screen draws, by its remembered choice. */
export function useStaffRows<R extends { staff: boolean }>(screen: StaffRowsScreen, rows: readonly R[]): StaffRows<R> {
  const [choice, setChoice] = usePersistentChoice(
    `quiz-staff-rows-${screen}`,
    CHOICES,
    SHOWN_BY_DEFAULT[screen] ? "shown" : "hidden",
  );
  const shown = choice === "shown";
  const visible = useMemo(() => (shown ? [...rows] : rows.filter((row) => !row.staff)), [rows, shown]);
  return {
    visible,
    present: rows.some((row) => row.staff),
    shown,
    setShown: (on) => setChoice(on ? "shown" : "hidden"),
  };
}

/** The switch itself, a secondary control beside a table's other switches; nothing while no row is a staff one. */
export function StaffRowsSwitch({ rows }: { rows: Pick<StaffRows<unknown>, "present" | "shown" | "setShown"> }) {
  const t = useT();
  if (!rows.present) return null;
  return (
    <label className="flex items-center gap-2 text-[13px] font-medium text-fg-muted">
      <Switch checked={rows.shown} onChange={rows.setShown} label={t("staffRows.show")} />
      <span aria-hidden>{t("staffRows.show")}</span>
    </label>
  );
}
