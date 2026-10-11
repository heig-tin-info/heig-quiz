/**
 * The `training.install` task (ADR-105 §2), in the scheduled catalog of the
 * administration page: an admin's "Run now" installs the content; the daily
 * pass re-runs the same idempotent install, so a content update shipped by
 * a deploy reaches the pool without a click. A run that changes nothing
 * writes nothing.
 */
import type { ScheduledTask } from "../../ticker.js";
import { install } from "./service.js";

export const TRAINING_TASKS: readonly ScheduledTask[] = [
  {
    key: "training.install",
    defaultIntervalMinutes: 24 * 60,
    run: async (app, config) => {
      const { questions } = await install(app.db, config, app.clock.now());
      return `${questions.created} created, ${questions.updated} updated, ${questions.unchanged} unchanged`;
    },
  },
];
