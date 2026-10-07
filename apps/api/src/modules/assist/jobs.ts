/**
 * The assistant's scheduled task (ADR-080 §6): the 30-day retention of its
 * conversations, once a day. A condition re-read at every pass, so a missed
 * night is caught up by the next one.
 */
import type { ScheduledTask } from "../../ticker.js";
import { purgeAssist } from "./service.js";

export const ASSIST_TASKS: ScheduledTask[] = [
  {
    key: "assist.purge",
    defaultIntervalMinutes: 24 * 60,
    run: async (app) => {
      const { exchanges, conversations } = await purgeAssist(app.db, app.clock.now());
      return `${exchanges} exchanges and ${conversations} conversations deleted`;
    },
  },
];
