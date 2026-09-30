/**
 * The drill's scheduled task (ADR-006, D10): the five-year retention of
 * N-DATA-03. A condition re-read at every pass, so a missed night is caught
 * up by the next one.
 */
import type { ScheduledTask } from "../../ticker.js";
import { purgeExpiredDrill } from "./service.js";

export const DRILL_TASKS: ScheduledTask[] = [
  {
    key: "drill.purge",
    defaultIntervalMinutes: 6 * 60,
    run: async (app) => {
      const { reviews, cards } = await purgeExpiredDrill(app.db, app.clock.now());
      return `${cards} cards and ${reviews} reviews deleted`;
    },
  },
];
