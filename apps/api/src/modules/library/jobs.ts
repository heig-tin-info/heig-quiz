/**
 * The library's scheduled task (ADR-144), once a day: the Markdown documents
 * an older renderer rendered are rendered again from their file (§3), then
 * a file no document names any more leaves the store, 48 hours after the
 * last request that touched it (§4). A request never re-renders nor unlinks
 * anything itself. The key predates the re-rendering and stays: it names
 * the task in the administration's settings.
 */
import type { ScheduledTask } from "../../ticker.js";
import { rerenderDocuments, sweepDocumentFiles } from "./service.js";

export const LIBRARY_TASKS: ScheduledTask[] = [
  {
    key: "library.blob_sweep",
    defaultIntervalMinutes: 24 * 60,
    run: async (app, config) => {
      // The sweep runs whatever the re-rendering did.
      let rendered: string;
      try {
        rendered = `${await rerenderDocuments(app.db, config.ASSETS_DIR, app.log)} documents rendered again`;
      } catch (error) {
        app.log.warn({ error: String((error as Error)?.message ?? error) }, "document re-rendering failed");
        rendered = "documents not rendered again";
      }
      const swept = await sweepDocumentFiles(app.db, config.ASSETS_DIR, app.clock.now());
      return `${rendered}, ${swept} document files swept`;
    },
  },
];
