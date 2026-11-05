/**
 * The account module's scheduled task (ADR-117 §3, §10): the student
 * lifecycle, once a day (`lifecycle.ts`). Its conditions are re-read at
 * every pass, so a missed day is caught up by the next one; it does nothing
 * while `ACCOUNT_LIFECYCLE` is off.
 */
import type { ScheduledTask } from "../../ticker.js";
import { lifecycleSummary, runAccountLifecycle } from "./lifecycle.js";

export const ACCOUNT_TASKS: ScheduledTask[] = [
  {
    key: "accounts.lifecycle",
    defaultIntervalMinutes: 24 * 60,
    run: async (app, config) =>
      lifecycleSummary(await runAccountLifecycle(app.db, { config, log: app.log, now: app.clock.now() })),
  },
];
