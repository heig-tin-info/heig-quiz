/**
 * The poll's scheduled task (ADR-006, D10): the end of a poll left open by
 * mistake (#190, ADR-014 addendum 2026-09-28). Idempotent like every
 * periodic task — the condition is re-read each pass, and an ended poll no
 * longer matches it. Twelve hours of silence need no one-second cadence.
 */
import type { ScheduledTask } from "../../ticker.js";
import { endIdlePolls } from "./service.js";

export const POLL_TASKS: ScheduledTask[] = [
  {
    key: "poll.end_idle",
    defaultIntervalMinutes: 1,
    run: async (app) => `${(await endIdlePolls(app, app.clock.now())).length} idle polls ended`,
  },
];
