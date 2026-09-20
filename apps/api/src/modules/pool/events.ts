/**
 * Refresh hints of the `pool` module (PLAN-MVP §4.8, `HintEvent`).
 *
 * A hint carries no data: it names a kind and the topics it is addressed to,
 * and every subscriber that can see the pool re-issues its own authorized
 * requests (ADR-005). `pool:<id>` is subscribed to at connection time by
 * whoever `poolAccess` lets in — see `modules/events.ts`.
 */
import { publish, type AppNotice } from "../../events.js";

/** One pool changed: its question list, its categories or its tags. */
export function poolChanged(poolId: string, notice?: AppNotice): void {
  publish("pool", [`pool:${poolId}`], notice);
}

/** A question changed: same topic as its pool, which is what the UI watches. */
export function questionChanged(poolId: string, notice?: AppNotice): void {
  poolChanged(poolId, notice);
}
