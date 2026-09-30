/**
 * The kiosk module's ticker task (ADR-006): the stations sitting an exam
 * that stopped attesting are silent, hence suspended (ADR-051 §6). Once a
 * minute is plenty against a twelve-minute threshold. Inert while the kiosk
 * path is off: no station can sit anything then.
 */
import type { TickTask } from "../../ticker.js";
import { sweepSilentStations } from "./watch.js";

export const KIOSK_TASKS: TickTask[] = [
  {
    name: "kiosk.silent",
    everyMs: 60_000,
    run: async (app, config) => {
      if (config.KIOSK_ATTESTATION === "off") return;
      await sweepSilentStations(app.db, app.clock.now());
    },
  },
];
