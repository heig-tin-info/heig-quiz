/**
 * The door between `notify` and the job queue (ADR-030).
 *
 * `notify` is called with a database handle and nothing else — from a route,
 * from a service, from a job — so it cannot reach `app.boss` itself. The
 * outbox is opened once at boot by `registerNotificationJobs`, with the
 * queue; until then (a test, `JOBS_DISABLED=1`, a queue that failed to start)
 * it is closed and an external delivery is simply not made: the bell row
 * stands on its own, and nothing is ever sent inline instead.
 *
 * Enqueuing never throws into the caller. A notification that cannot leave
 * is logged; the business action that caused it has already happened.
 */
import type { NotificationPayload } from "@quiz/contracts";

import type { JobQueue } from "../../jobs.js";

export const NOTIFICATION_DELIVERY_QUEUE = "notifications.deliver";

/** The channels that leave the platform; the bell is a row, not a job. */
export type ExternalChannel = "email" | "teams";

/**
 * One delivery: whom, where, and the payload itself — ids and titles, the
 * same as the bell's, so a job never has to find a row the user may have
 * turned off or deleted.
 */
export interface DeliveryJob {
  userId: string;
  channel: ExternalChannel;
  payload: NotificationPayload;
}

interface Log {
  error(obj: object, msg: string): void;
}

interface Outbox {
  queue: JobQueue;
  /** The Teams channel is configured on this platform. */
  teams: boolean;
  log: Log;
}

let outbox: Outbox | null = null;

export function openOutbox(next: Outbox): void {
  outbox = next;
}

export function closeOutbox(): void {
  outbox = null;
}

/** Whether a Teams delivery would be enqueued at all (the link check is skipped otherwise). */
export function teamsOpen(): boolean {
  return outbox?.teams === true;
}

/** Enqueues one job per channel; returns the channels actually enqueued. */
export async function enqueueDeliveries(
  userId: string,
  payload: NotificationPayload,
  channels: readonly ExternalChannel[],
): Promise<ExternalChannel[]> {
  const box = outbox;
  if (!box) return [];
  const sent: ExternalChannel[] = [];
  for (const channel of channels) {
    if (channel === "teams" && !box.teams) continue;
    try {
      await box.queue.send<DeliveryJob>(NOTIFICATION_DELIVERY_QUEUE, { userId, channel, payload });
      sent.push(channel);
    } catch (err) {
      box.log.error({ err, userId, channel, kind: payload.kind }, "notification enqueue failed");
    }
  }
  return sent;
}
