/**
 * The drill's ticker task (ADR-006): the five-year retention of N-DATA-03.
 * A condition re-read at every pass, so a missed night is caught up by the
 * next one.
 */
import type { TickTask } from "../../ticker.js";
import { purgeExpiredDrill } from "./service.js";

export const DRILL_TASKS: TickTask[] = [
  {
    name: "drill.purge",
    everyMs: 6 * 60 * 60_000,
    run: async (app) => {
      await purgeExpiredDrill(app.db, app.clock.now());
    },
  },
];
