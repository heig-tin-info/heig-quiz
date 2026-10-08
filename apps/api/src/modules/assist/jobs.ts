/**
 * The assistant's scheduled task (ADR-080 §6, §8): the 30-day retention of
 * its conversations, and the per-question tokens a crash left behind, once
 * a day. A condition re-read at every pass, so a missed night is caught up
 * by the next one.
 */
import { purgeAssistTokens } from "../../auth/tokens.js";
import type { ScheduledTask } from "../../ticker.js";
import { purgeAssist } from "./service.js";

export const ASSIST_TASKS: ScheduledTask[] = [
  {
    key: "assist.purge",
    defaultIntervalMinutes: 24 * 60,
    run: async (app) => {
      const now = app.clock.now();
      const { exchanges, conversations } = await purgeAssist(app.db, now);
      const tokens = await purgeAssistTokens(app.db, now);
      return `${exchanges} exchanges, ${conversations} conversations and ${tokens} expired tokens deleted`;
    },
  },
];
