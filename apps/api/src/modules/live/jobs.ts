/**
 * The live tasks of the ticker (ADR-006, PLAN-MVP §5.3).
 *
 * Everything here is an IDEMPOTENT conditional UPDATE: re-running a tick is
 * free, and catching up after an outage is free, because the condition is
 * re-read every time and nothing is scheduled ahead. Deadlines live in the
 * database only (N-RES-04) — the ticker never holds a timer for one.
 *
 * The period is the ticker's own (`TICK_MS`, one second by default), which is
 * what "closed within a second of `deadline + 3 s`" needs.
 */
import type { TickTask } from "../../ticker.js";
import {
  autoCloseDue,
  autoOpenScheduled,
  autoStartFullLobbies,
  expireDueAttempts,
  sweepPresence,
} from "./service.js";

/** A connection silent for this long stops counting as present (§5.3 step 5). */
export const PRESENCE_IDLE_MS = 45_000;

export const LIVE_TASKS: TickTask[] = [
  {
    // Step 1. The conditional UPDATE is the claim: two processes running the
    // same tick close each attempt exactly once between them.
    name: "live.expire_attempts",
    run: async (app) => {
      await expireDueAttempts(app.db, app.clock.now(), app);
    },
  },
  {
    // Steps 2 and 3: `scheduled → lobby | running` at `opens_at`, and the
    // `lobby: auto` start once everybody enrolled is present.
    name: "live.open_scheduled",
    run: async (app) => {
      const now = app.clock.now();
      await autoOpenScheduled(app.db, now);
      await autoStartFullLobbies(app.db, now);
    },
  },
  {
    // Step 4: the common end of a `deadline`-timed evaluation.
    name: "live.close_due",
    run: async (app) => {
      await autoCloseDue(app.db, app.clock.now(), app);
    },
  },
  {
    // Step 5: presence is in memory, so this one touches no table at all.
    name: "live.presence_sweep",
    everyMs: 5_000,
    run: async (app) => {
      sweepPresence(app.clock.now(), PRESENCE_IDLE_MS);
    },
  },
];
