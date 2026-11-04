/**
 * The paper module's scheduled task (ADR-125 §15, N-DATA-03): a scan goes
 * with its attempt. The row goes by cascade whatever deleted the attempt;
 * the file follows here, once a day, from a condition re-read at every pass.
 */
import type { ScheduledTask } from "../../ticker.js";
import { sweepOrphanScans } from "./service.js";

export const PAPER_TASKS: ScheduledTask[] = [
  {
    key: "paper.scan_sweep",
    defaultIntervalMinutes: 24 * 60,
    run: async (app, config) => `${await sweepOrphanScans(app.db, config.ASSETS_DIR)} paper scans swept`,
  },
];
