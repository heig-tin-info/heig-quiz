/**
 * The poll's scheduled tasks (ADR-006, D10): the end of a poll left open by
 * mistake (#190, ADR-014 addendum 2026-09-28), and the retention of the
 * anonymous participants, deleted 30 days after the poll closed once its
 * results are frozen (#873, N-DATA-03). Idempotent like every periodic task —
 * the condition is re-read each pass, and an ended poll no longer matches the
 * first, a purged one the second. Twelve hours of silence need no one-second
 * cadence; a retention counted in days needs one pass a day.
 */
import type { ScheduledTask } from "../../ticker.js";
import { endIdlePolls, purgePollGuests } from "./service.js";

export const POLL_TASKS: ScheduledTask[] = [
  {
    key: "poll.end_idle",
    defaultIntervalMinutes: 1,
    run: async (app) => `${(await endIdlePolls(app, app.clock.now())).length} idle polls ended`,
  },
  {
    key: "poll.purge_guests",
    defaultIntervalMinutes: 24 * 60,
    run: async (app) => `${await purgePollGuests(app.db, app.clock.now())} poll guests deleted`,
  },
];
