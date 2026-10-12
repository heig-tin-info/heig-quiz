/**
 * The activity's scheduled task (ADR-107, N-DATA-03): the hourly rows past
 * their eight days, once a day. A condition re-read at every pass, so a
 * missed day is caught up by the next one.
 */
import type { ScheduledTask } from "../../ticker.js";
import { purgePresence } from "./service.js";

export const PRESENCE_TASKS: ScheduledTask[] = [
  {
    key: "presence.purge",
    defaultIntervalMinutes: 24 * 60,
    run: async (app) => `${await purgePresence(app.db, app.clock.now())} activity hours deleted`,
  },
];
