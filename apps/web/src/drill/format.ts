/**
 * The drill's words about a session and a date, shared by the drill page and
 * the student home (which must not pull the page's chunk in for them).
 */
import type { DrillSession, DrillSessionCard } from "@quiz/contracts";

import type { Dict, TFunction } from "../i18n";

/** The confidence scale in the student's words, 0 No idea to 4 Certain (ADR-085). */
export const CONFIDENCE = [
  "drill.confidence.0",
  "drill.confidence.1",
  "drill.confidence.2",
  "drill.confidence.3",
  "drill.confidence.4",
] as const satisfies readonly (keyof Dict)[];

/** "5 questions · up to 10 min": what today holds, never how many days in a row. */
export function sessionLine(session: DrillSession, t: TFunction): string {
  const min = Math.round(session.budgetMs / 60_000);
  const n = session.cards.length;
  return n === 1 ? t("drill.today.one", { min }) : t("drill.today.count", { n, min });
}

/** The courses today's cards come from, once each, in the session's order. */
export function sessionCourses(cards: readonly DrillSessionCard[]): string {
  return [...new Set(cards.map((c) => c.courseCode))].join(" · ");
}

/**
 * When a card is next due, in calendar days from today: "tomorrow", "in 5
 * days" (`Intl.RelativeTimeFormat`, the interface language). A drill counts
 * in days (ADR-041 §12), and "in 17 hours" for tomorrow morning would read as
 * a countdown. Pure: the caller gives the clock.
 */
export function dueIn(iso: string, now: number, locale: "en" | "fr"): string {
  const day = (ms: number) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  };
  const days = Math.max(0, Math.round(day(Date.parse(iso)) - day(now)));
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
}
