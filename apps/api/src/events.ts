/**
 * In-process event bus (ADR-005): feeds the SSE stream of
 * `modules/realtime/routes.ts`.
 *
 * It carries three kinds of message on one emitter:
 *
 *   - a HINT (`publish`), the inherited mechanism: a type and the topics it
 *     is addressed to, no data. The client re-issues its own authorized
 *     requests. Everything that is not the live path uses it, unchanged;
 *   - a DATA message (`publishData`), added by WP5 for the live domain, where
 *     a round trip is too slow or too noisy: the typed `ServerEvent` union of
 *     PLAN-MVP §4.8 travels as-is, with the audience it is allowed to reach;
 *   - a CLOSE (`publishClose`): the streams holding one of the topics are
 *     ended. A stream computes its topics once, at connection; when access
 *     is lost, closing it is how they are recomputed — the client reconnects
 *     on its own (#248).
 *   - an END (`publishEndSessions`): the streams opened by these SESSIONS
 *     (the SHA-256 of their token) are ended, and none of the user's others
 *     — a deleted session would otherwise keep its stream (ADR-051 §4, §7).
 *
 * Nothing publishes on this module directly except `modules/realtime/bus.ts`,
 * which is the seam the plan names (§10) and the place the coalescers live.
 * If `WORKER_MODE` ever splits the roles, this bus becomes Postgres
 * LISTEN/NOTIFY and nothing above it changes.
 */
import { EventEmitter } from "node:events";

import type { ServerEvent, Topic } from "@quiz/contracts";

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
  | "notifications"
  | "journal"
  | "projects"
  | "groups"
  | "gradebook"
  | "mutation";

/**
 * Topic grammar: which audience a message is addressed to. The definition
 * lives in `@quiz/contracts` so the client can name the same topics.
 */
export type { Topic };

interface AppEvent {
  type: EventType;
  topics: Topic[];
  /** A user whose streams skip this hint: the one whose action raised it. */
  except?: string;
}

/** `staff` drops the message for a student connection (PLAN-MVP §4.8). */
export type Audience = "all" | "staff";

interface DataEvent {
  event: ServerEvent;
  topics: Topic[];
  audience: Audience;
}

export type BusMessage =
  | ({ kind: "hint" } & AppEvent)
  | ({ kind: "data" } & DataEvent)
  | { kind: "close"; topics: Topic[] }
  | { kind: "end"; sessions: string[] };

const bus = new EventEmitter();
bus.setMaxListeners(0); // one SSE connection per tab

/** A refresh hint: no data, just "something in these families changed". */
export function publish(type: EventType, topics: Topic[], except?: string) {
  if (topics.length === 0) return;
  const event: AppEvent = { type, topics, ...(except && { except }) };
  bus.emit("event", { kind: "hint", ...event } satisfies BusMessage);
}

/** A typed live event. Go through `modules/realtime/bus.ts`, never here. */
export function publishData(event: ServerEvent, topics: Topic[], audience: Audience = "all") {
  if (topics.length === 0) return;
  bus.emit("event", { kind: "data", event, topics, audience } satisfies BusMessage);
}

/** Ends the streams of these topics. Go through `modules/realtime/bus.ts`. */
export function publishClose(topics: Topic[]) {
  if (topics.length === 0) return;
  bus.emit("event", { kind: "close", topics } satisfies BusMessage);
}

/** Ends the streams opened by these sessions (`sid_hash`). Go through `modules/realtime/bus.ts`. */
export function publishEndSessions(sidHashes: string[]) {
  if (sidHashes.length === 0) return;
  bus.emit("event", { kind: "end", sessions: sidHashes } satisfies BusMessage);
}

export function subscribe(listener: (e: BusMessage) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
