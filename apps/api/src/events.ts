/**
 * In-process event bus (ADR-005): feeds the SSE stream of
 * `modules/realtime/routes.ts`.
 *
 * It carries two kinds of message on one emitter:
 *
 *   - a HINT (`publish`), the inherited mechanism: a type and the topics it
 *     is addressed to, no data. The client re-issues its own authorized
 *     requests. Everything that is not the live path uses it, unchanged;
 *   - a DATA message (`publishData`), added by WP5 for the live domain, where
 *     a round trip is too slow or too noisy: the typed `ServerEvent` union of
 *     PLAN-MVP §4.8 travels as-is, with the audience it is allowed to reach.
 *
 * Nothing publishes on this module directly except `modules/realtime/bus.ts`,
 * which is the seam the plan names (§10) and the place the coalescers live.
 * If `WORKER_MODE` ever splits the roles, this bus becomes Postgres
 * LISTEN/NOTIFY and nothing above it changes.
 */
import { EventEmitter } from "node:events";

import type { NoticeKind, ServerEvent, Topic } from "@quiz/contracts";

/** Real-time notification attached to an event (toast in the UI). */
export interface AppNotice {
  kind: NoticeKind;
  message: string;
}

/** Refresh-hint families the client knows how to react to. */
export type EventType =
  | "courses"
  | "classrooms"
  | "roster"
  | "pool"
  | "evaluations"
  | "results"
  | "grading"
  | "admin"
  | "mutation";

/**
 * Topic grammar: which audience a message is addressed to. The definition
 * lives in `@quiz/contracts` so the client can name the same topics.
 */
export type { Topic };

export interface AppEvent {
  type: EventType;
  topics: Topic[];
  notice?: AppNotice;
}

/** `staff` drops the message for a student connection (PLAN-MVP §4.8). */
export type Audience = "all" | "staff";

export interface DataEvent {
  event: ServerEvent;
  topics: Topic[];
  audience: Audience;
}

export type BusMessage =
  | ({ kind: "hint" } & AppEvent)
  | ({ kind: "data" } & DataEvent);

const bus = new EventEmitter();
bus.setMaxListeners(0); // one SSE connection per tab

/** A refresh hint: no data, just "something in these families changed". */
export function publish(type: EventType, topics: Topic[], notice?: AppNotice) {
  if (topics.length === 0) return;
  const event: AppEvent = notice ? { type, topics, notice } : { type, topics };
  bus.emit("event", { kind: "hint", ...event } satisfies BusMessage);
}

/** A typed live event. Go through `modules/realtime/bus.ts`, never here. */
export function publishData(event: ServerEvent, topics: Topic[], audience: Audience = "all") {
  if (topics.length === 0) return;
  bus.emit("event", { kind: "data", event, topics, audience } satisfies BusMessage);
}

export function subscribe(listener: (e: BusMessage) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
