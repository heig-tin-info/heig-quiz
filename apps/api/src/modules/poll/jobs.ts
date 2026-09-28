/**
 * The poll task of the ticker (ADR-006): the end of a poll left open by
 * mistake (#190, ADR-014 addendum 2026-09-28). Idempotent like every tick
 * task — the condition is re-read each pass, and an ended poll no longer
 * matches it. Twelve hours of silence need no one-second cadence.
 */
import type { TickTask } from "../../ticker.js";
import { endIdlePolls } from "./service.js";

export const POLL_TASKS: TickTask[] = [
  {
    name: "poll.end_idle",
    everyMs: 60_000,
    run: async (app) => {
      await endIdlePolls(app, app.clock.now());
    },
  },
];
