/**
 * SSE grammar (PLAN-MVP §4.8, docs/spec/05 §5.4).
 *
 * One stream, two kinds of frame:
 *   - a `hint` carries NO data (ADR-005): it names the families that changed
 *     and the client re-issues its own authorized requests. Everything that
 *     is not the live path keeps using it;
 *   - every other member of {@link ServerEvent} is a DATA frame of the live
 *     domain, where a round trip would be too slow or too noisy (a countdown,
 *     a dashboard cell, a lobby counter).
 *
 * A connection carries a set of topics AND a role flag: `dashboard.*` is
 * dropped for a student connection even when it legitimately watches the same
 * `evaluation:<id>` topic for `lobby.count` and `evaluation.state`.
 */
import { z } from "zod";

import { EvaluationState } from "./evaluation.js";
import { CellStatus, ClosedBy } from "./live.js";
import type { NoticeKind } from "./notifications.js";

/** The audiences an event can be addressed to. */
export const Topic = z.union([
  z.literal("admin"),
  z.templateLiteral(["course:", z.string()]),
  z.templateLiteral(["pool:", z.string()]),
  z.templateLiteral(["classroom:", z.string()]),
  z.templateLiteral(["teacher:", z.string()]),
  z.templateLiteral(["user:", z.string()]),
  z.templateLiteral(["evaluation:", z.string()]),
  z.templateLiteral(["attempt:", z.string()]),
]);
export type Topic = z.infer<typeof Topic>;

/** The subjects a client may ask to watch: `?watch=evaluation:<id>`. */
export const WatchSubject = z.union([
  z.templateLiteral(["evaluation:", z.uuid()]),
  z.templateLiteral(["attempt:", z.uuid()]),
]);
export type WatchSubject = z.infer<typeof WatchSubject>;

export const EventsQuery = z.object({
  /** Omitted = the user's own topics only (the legacy hint stream). */
  watch: WatchSubject.optional(),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

// --- Events ---------------------------------------------------------------

/** Sent once, to the opening connection: `DashboardView`, `AttemptView` or `LobbyView`. */
export const SnapshotEvent = z.object({
  type: z.literal("snapshot"),
  serverNow: z.iso.datetime(),
  subject: z.string(),
  state: z.unknown(),
});
export type SnapshotEvent = z.infer<typeof SnapshotEvent>;

/** Every 10 s, or every second on an `attempt:` stream of a running evaluation. */
export const ClockEvent = z.object({
  type: z.literal("clock"),
  serverNow: z.iso.datetime(),
});
export type ClockEvent = z.infer<typeof ClockEvent>;

export const EvaluationStateEvent = z.object({
  type: z.literal("evaluation.state"),
  evaluationId: z.uuid(),
  state: EvaluationState,
  pausedAt: z.iso.datetime().nullable(),
  closesAt: z.iso.datetime().nullable(),
  serverNow: z.iso.datetime(),
});
export type EvaluationStateEvent = z.infer<typeof EvaluationStateEvent>;

export const AttemptDeadlineEvent = z.object({
  type: z.literal("attempt.deadline"),
  attemptId: z.uuid(),
  deadlineAt: z.iso.datetime().nullable(),
  bonusS: z.number().int(),
  reason: z.enum(["teacher_extend", "pause_resume", "start", "reopen"]),
  serverNow: z.iso.datetime(),
});
export type AttemptDeadlineEvent = z.infer<typeof AttemptDeadlineEvent>;

export const AttemptClosedEvent = z.object({
  type: z.literal("attempt.closed"),
  attemptId: z.uuid(),
  evaluationId: z.uuid(),
  closedBy: ClosedBy,
  serverNow: z.iso.datetime(),
});
export type AttemptClosedEvent = z.infer<typeof AttemptClosedEvent>;

/** Staff connections only; coalesced 250 ms per `(attemptId, itemId)`. */
export const DashboardCellEvent = z.object({
  type: z.literal("dashboard.cell"),
  evaluationId: z.uuid(),
  attemptId: z.uuid(),
  itemId: z.uuid(),
  status: CellStatus,
  revision: z.number().int(),
  points: z.number().nullable(),
  summary: z.string().nullable(),
});
export type DashboardCellEvent = z.infer<typeof DashboardCellEvent>;

/** Staff connections only. */
export const DashboardPresenceEvent = z.object({
  type: z.literal("dashboard.presence"),
  evaluationId: z.uuid(),
  userId: z.uuid(),
  online: z.boolean(),
  lastSeenAt: z.iso.datetime(),
});
export type DashboardPresenceEvent = z.infer<typeof DashboardPresenceEvent>;

/** A student in the lobby legitimately receives this one. */
export const LobbyCountEvent = z.object({
  type: z.literal("lobby.count"),
  evaluationId: z.uuid(),
  present: z.number().int(),
  enrolled: z.number().int(),
});
export type LobbyCountEvent = z.infer<typeof LobbyCountEvent>;

export const RunnerResultEvent = z.object({
  type: z.literal("runner.result"),
  requestId: z.uuid(),
  itemId: z.uuid(),
  result: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      compile: z.object({ ok: z.boolean(), stderr: z.string() }),
      cases: z.array(
        z.object({
          name: z.string(),
          ok: z.boolean(),
          stdout: z.string(),
          expected: z.string(),
          ms: z.number(),
          timedOut: z.boolean(),
        }),
      ),
    }),
    z.object({ status: z.literal("unavailable") }),
    z.object({ status: z.literal("busy") }),
    z.object({ status: z.literal("error"), message: z.string() }),
  ]),
});
export type RunnerResultEvent = z.infer<typeof RunnerResultEvent>;

/** WP6 publishes it; the grammar lives here so both halves agree. */
export const GradingProgressEvent = z.object({
  type: z.literal("grading.progress"),
  evaluationId: z.uuid(),
  done: z.number().int(),
  total: z.number().int(),
  phase: z.enum(["auto", "runner", "done"]),
});
export type GradingProgressEvent = z.infer<typeof GradingProgressEvent>;

/**
 * The inherited refresh hint (ADR-005), for everything that is not the live
 * path. `notice` keeps the catalogue of `./notifications.ts`, which is what
 * the web app already renders as a toast.
 */
export const HintEvent = z.object({
  type: z.literal("hint"),
  kinds: z.array(
    z.enum([
      "courses",
      "classrooms",
      "roster",
      "pool",
      "evaluations",
      "results",
      "grading",
      "admin",
      "mutation",
    ]),
  ),
  notice: z
    .object({ kind: z.custom<NoticeKind>((v) => typeof v === "string"), message: z.string() })
    .nullish(),
});
export type HintEvent = z.infer<typeof HintEvent>;

export const ServerEvent = z.discriminatedUnion("type", [
  SnapshotEvent,
  ClockEvent,
  EvaluationStateEvent,
  AttemptDeadlineEvent,
  AttemptClosedEvent,
  DashboardCellEvent,
  DashboardPresenceEvent,
  LobbyCountEvent,
  RunnerResultEvent,
  GradingProgressEvent,
  HintEvent,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** The event names a `dashboard.*` filter must drop for a student stream. */
export const STAFF_ONLY_EVENTS = ["dashboard.cell", "dashboard.presence"] as const;

export function isStaffOnly(event: ServerEvent): boolean {
  return (STAFF_ONLY_EVENTS as readonly string[]).includes(event.type);
}
