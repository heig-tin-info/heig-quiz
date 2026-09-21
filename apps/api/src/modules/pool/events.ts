/**
 * Refresh hints of the `pool` module (PLAN-MVP §4.8, `HintEvent`).
 *
 * A hint carries no data: it names a kind and the topics it is addressed to,
 * and every subscriber that can see the pool re-issues its own authorized
 * requests (ADR-005). `pool:<id>` is subscribed to at connection time by
 * whoever `poolAccess` lets in — see `modules/events.ts`.
 */
import { publish, type AppNotice, type Topic } from "../../events.js";

/** One pool changed: its question list, its categories or its tags. */
export function poolChanged(poolId: string, notice?: AppNotice): void {
  publish("pool", [`pool:${poolId}`], notice);
}

/**
 * The PEOPLE of a pool changed (F-POOL-05): a seat given, changed or given
 * up, a visibility, a deletion. It is addressed to each party's OWN topic,
 * because `pool:<id>` is computed when an SSE connection opens — the
 * colleague who has just been named is exactly the one not listening to it
 * yet, and the one who has just left must stop seeing it.
 */
export function poolPeopleChanged(topics: Topic[]): void {
  publish("pool", topics);
}

/** A question changed: same topic as its pool, which is what the UI watches. */
export function questionChanged(poolId: string, notice?: AppNotice): void {
  poolChanged(poolId, notice);
}
