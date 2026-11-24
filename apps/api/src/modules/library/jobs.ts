/**
 * The library's scheduled task (ADR-144): a file no document names any more
 * leaves the store once a day, 48 hours after the last request that touched
 * it. A request never unlinks a file itself.
 */
import type { ScheduledTask } from "../../ticker.js";
import { sweepDocumentFiles } from "./service.js";

export const LIBRARY_TASKS: ScheduledTask[] = [
  {
    key: "library.blob_sweep",
    defaultIntervalMinutes: 24 * 60,
    run: async (app, config) =>
      `${await sweepDocumentFiles(app.db, config.ASSETS_DIR, app.clock.now())} document files swept`,
  },
];
