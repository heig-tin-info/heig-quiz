/**
 * When each application's ticker last COMPLETED a pass (wall clock, ms), for
 * the system status (N-OPS-03): a pass that hangs, or a loop that stopped,
 * shows as a growing lag. No entry: this process runs no ticker
 * (`WORKER_MODE=web`). A leaf apart from the ticker's task list
 * (`ticker.ts`), so the status reads it without loading the tasks it
 * observes.
 */
import type { FastifyInstance } from "fastify";

import { perApp } from "./perApp.js";

const lastPass = perApp<number>();

/** Records the end of a pass of this app's ticker (`startTicker` only). */
export function markTickerPass(app: FastifyInstance, at: number): void {
  lastPass.set(app, at);
}

/** The end of the last completed pass of this app's ticker; `undefined` without one. */
export function lastTickOf(app: FastifyInstance): number | undefined {
  return lastPass.get(app);
}
