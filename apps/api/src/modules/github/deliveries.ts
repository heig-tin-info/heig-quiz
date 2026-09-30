/**
 * The webhook deliveries of Quiz's App (spec 05 §5.11, N-SEC-17, merge task
 * M2-04; ported from heig-classroom's `modules/webhooks.ts` and
 * `tasks.ts`, sync point `ab98cc0`):
 *
 * ```
 * POST /webhooks/github (routes.ts)
 *   HMAC over the raw body                → 401, nothing parsed nor stored
 *   headers, JSON body                    → 400
 *   one transaction:
 *     webhook_deliveries, ON CONFLICT DO NOTHING on delivery_id
 *                                         → 200, a duplicate: nothing more
 *     a push on a tracked repository      → push_receipts (ADR-012), the first kept
 *   github.webhook { deliveryId }         → 200
 *
 * github.webhook → processDelivery: every handler of the event, in order
 *   all succeed → processed_at; one throws → the error kept, the job retried
 * ```
 *
 * The HANDLER REGISTRY is how other modules plug in without this one
 * importing them (03 §3.3, direction project → github): `onEvent` for the
 * asynchronous work of an event (the journal's push, M4-02), `onReceipt`
 * for the repositories whose pushes need a synchronous receipt (projects'
 * student repositories, M3). This module's own handlers (`handlers.ts`)
 * register the same way. Registration is idempotent: the registry is a set
 * per event, filled once per handler however many apps a process builds.
 *
 * The reconciliation (`reconcileDeliveries`, ADR-011) replays through the
 * same `processDelivery`: there is no second code path.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { z } from "zod";

import type { GithubWebhookBody } from "@quiz/contracts";

import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { pushReceipts, webhookDeliveries } from "../../db/schema.js";
import { recentHookDeliveries, redeliverHookDelivery } from "../../github/app.js";
import { GITHUB_WEBHOOK_QUEUE } from "../../jobs.js";
import { redactTokens } from "../../redact.js";

// ---------------------------------------------------------------- the registry

/** A stored delivery, as a handler receives it. */
export interface WebhookDelivery {
  deliveryId: string;
  /** `X-GitHub-Event`. */
  event: string;
  action: string | null;
  payload: GithubWebhookBody;
  /** The server's receipt time (invariant 5). */
  receivedAt: Date;
}

/**
 * The asynchronous handling of one event. Idempotent (ADR-011): a delivery
 * is replayed after a failure, and by the reconciliation. A handler that
 * throws fails the delivery, which is retried whole.
 */
export type WebhookHandler = (
  app: FastifyInstance,
  config: AppConfig,
  delivery: WebhookDelivery,
) => Promise<void>;

/**
 * Whether pushes on a GitHub repository need a receipt (ADR-012): asked
 * inside the intake's transaction, before the 200, so it must be one cheap
 * read.
 */
export type ReceiptTracker = (tx: Tx, githubRepoId: number) => Promise<boolean>;

const handlers = new Map<string, Set<WebhookHandler>>();
const trackers = new Set<ReceiptTracker>();

/** Registers `handler` for every delivery of `event` (`push`, `installation`, ...). */
export function onEvent(event: string, handler: WebhookHandler): void {
  const set = handlers.get(event) ?? new Set<WebhookHandler>();
  set.add(handler);
  handlers.set(event, set);
}

/**
 * Registers a module's repositories as needing push receipts: a push on a
 * repository any tracker claims gets its `push_receipts` row before the
 * intake answers (the legal reference of a deadline, ADR-012).
 */
export function onReceipt(tracks: ReceiptTracker): void {
  trackers.add(tracks);
}

// ---------------------------------------------------------------- the intake

/**
 * The fields of a push the receipt reads. A branch deletion (`after` all
 * zeros) is no receipt: there is no head to freeze.
 */
const PushEvent = z.object({
  ref: z.string(),
  after: z.string().regex(/^[0-9a-f]{40,64}$/),
  forced: z.boolean().optional(),
  repository: z.object({ id: z.number().int() }),
  sender: z.object({ login: z.string() }).optional(),
});
const DELETED = /^0+$/;

/** The workflows' own token (GR-16): the grader's commits, never a student's. */
const GITHUB_ACTIONS_BOT = "github-actions[bot]";

/** Pushed by Quiz's App (D23) or by a workflow: a bot commit, never graded. */
function pushedByBot(config: AppConfig, login: string | undefined): boolean {
  return (
    login !== undefined &&
    (login === GITHUB_ACTIONS_BOT ||
      (config.GITHUB_APP_SLUG !== "" && login === `${config.GITHUB_APP_SLUG}[bot]`))
  );
}

async function writeReceipt(tx: Tx, config: AppConfig, delivery: WebhookDelivery): Promise<void> {
  if (trackers.size === 0) return;
  const push = PushEvent.safeParse(delivery.payload);
  if (!push.success || DELETED.test(push.data.after)) return;
  const repoId = push.data.repository.id;
  let tracked = false;
  for (const tracks of trackers) if ((tracked = await tracks(tx, repoId))) break;
  if (!tracked) return;
  await tx
    .insert(pushReceipts)
    .values({
      id: randomUUID(),
      githubRepoId: repoId,
      branch: push.data.ref.replace(/^refs\/heads\//, ""),
      headSha: push.data.after,
      receivedAt: delivery.receivedAt,
      isBot: pushedByBot(config, push.data.sender?.login),
      forced: push.data.forced ?? false,
    })
    // The FIRST receipt of a head stands: a redelivery never moves it later.
    .onConflictDoNothing();
}

/**
 * Stores a verified delivery and, for a push on a tracked repository, its
 * receipt — in ONE transaction, so that a failed receipt leaves no
 * delivery behind to swallow GitHub's redelivery as a duplicate. False: the
 * delivery was already stored, and nothing was written.
 */
export async function storeDelivery(
  db: Db,
  config: AppConfig,
  delivery: WebhookDelivery,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(webhookDeliveries)
      .values(delivery)
      .onConflictDoNothing({ target: webhookDeliveries.deliveryId })
      .returning({ deliveryId: webhookDeliveries.deliveryId });
    if (!stored) return false;
    if (delivery.event === "push") await writeReceipt(tx, config, delivery);
    return true;
  });
}

// ---------------------------------------------------------------- the worker

/** How much of a failure is kept on the delivery. */
const ERROR_MAX = 1000;

/**
 * The `github.webhook` job: the stored delivery through every handler of
 * its event, then `processed_at`. An unknown or already processed delivery
 * is a no-op, so a second job for the same one costs a read. A failure is
 * kept on the delivery, tokens masked (invariant 15), and rethrown for the
 * queue's retry.
 */
export async function processDelivery(
  app: FastifyInstance,
  config: AppConfig,
  deliveryId: string,
): Promise<void> {
  const [row] = await app.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.deliveryId, deliveryId));
  // A purged payload belongs to a processed delivery: nothing is left to do.
  if (!row || row.processedAt !== null || row.payload === null) return;
  const delivery: WebhookDelivery = { ...row, payload: row.payload };
  try {
    for (const handler of handlers.get(row.event) ?? []) await handler(app, config, delivery);
  } catch (err) {
    await app.db
      .update(webhookDeliveries)
      .set({ error: redactTokens(String(err)).slice(0, ERROR_MAX) })
      .where(eq(webhookDeliveries.deliveryId, deliveryId));
    throw err;
  }
  await app.db
    .update(webhookDeliveries)
    .set({ processedAt: app.clock.now(), error: null })
    .where(eq(webhookDeliveries.deliveryId, deliveryId));
}

/**
 * Hands a stored delivery to the worker: the `github.webhook` queue, or,
 * without one (`JOBS_DISABLED=1`, a queue failed at boot), a run beside
 * the caller, never awaited by it — the intake still answers at once, and
 * a failure is left to the reconciliation.
 */
export async function dispatchDelivery(
  app: FastifyInstance,
  config: AppConfig,
  deliveryId: string,
): Promise<void> {
  if (app.boss) {
    await app.boss.send(GITHUB_WEBHOOK_QUEUE, { deliveryId });
    return;
  }
  void processDelivery(app, config, deliveryId).catch((err: unknown) =>
    app.log.error({ err, deliveryId }, "handling a GitHub delivery failed"),
  );
}

// ---------------------------------------------------------------- reconciliation

/** A delivery unprocessed for this long lost its job, or failed its retries. */
export const REPLAY_AFTER_MS = 10 * 60_000;
/** At most this many replayed per run: the next run takes the rest. */
const MAX_REPLAYS = 200;
/** GitHub's failed attempts younger than this are asked again, at most {@link MAX_REDELIVERIES}. */
const REDELIVERY_WINDOW_MS = 24 * 3_600_000;
const MAX_REDELIVERIES = 50;

/**
 * `reconcile.deliveries` (GH-62, ADR-011), a scheduled task: the deliveries
 * stored but left unprocessed (a lost job, a crash, retries exhausted) go
 * through the worker again; the deliveries GitHub failed to hand over in
 * the last 24 hours (the intake down, a 5xx) are asked again, unless one of
 * their attempts was stored since.
 */
export async function reconcileDeliveries(
  app: FastifyInstance,
  config: AppConfig,
): Promise<string> {
  const now = app.clock.now().getTime();
  const stuck = await app.db
    .select({ deliveryId: webhookDeliveries.deliveryId })
    .from(webhookDeliveries)
    .where(
      and(
        isNull(webhookDeliveries.processedAt),
        isNotNull(webhookDeliveries.payload),
        lt(webhookDeliveries.receivedAt, new Date(now - REPLAY_AFTER_MS)),
      ),
    )
    .orderBy(asc(webhookDeliveries.receivedAt))
    .limit(MAX_REPLAYS);
  for (const { deliveryId } of stuck) await dispatchDelivery(app, config, deliveryId);

  const failed = new Map<string, number>();
  for (const d of await recentHookDeliveries(config)) {
    const ok = d.statusCode >= 200 && d.statusCode < 300;
    if (ok || d.redelivery || d.deliveredAt.getTime() < now - REDELIVERY_WINDOW_MS) continue;
    if (!failed.has(d.guid)) failed.set(d.guid, d.id);
  }
  const held = new Set(
    failed.size === 0
      ? []
      : (
          await app.db
            .select({ deliveryId: webhookDeliveries.deliveryId })
            .from(webhookDeliveries)
            .where(inArray(webhookDeliveries.deliveryId, [...failed.keys()]))
        ).map((r) => r.deliveryId),
  );
  let redelivered = 0;
  for (const [guid, id] of failed) {
    if (held.has(guid)) continue;
    if (redelivered >= MAX_REDELIVERIES) break;
    try {
      await redeliverHookDelivery(config, id);
      redelivered += 1;
    } catch (err) {
      app.log.warn({ err, guid }, "reconcile.deliveries: a redelivery failed");
    }
  }
  return `${stuck.length} local deliveries replayed, ${redelivered} GitHub redeliveries requested`;
}

/** A processed delivery's payload is kept this long, then cleared (spec 05 §5.11). */
export const PAYLOAD_RETENTION_MS = 30 * 24 * 3_600_000;

/**
 * `deliveries.purge`, a scheduled task: the payload of every delivery
 * processed and received more than 30 days ago is cleared. The row stays,
 * so the deduplication outlives GitHub's redelivery window; an unprocessed
 * delivery keeps its payload for the replay.
 */
export async function purgeDeliveryPayloads(db: Db, now: Date): Promise<number> {
  const purged = await db
    .update(webhookDeliveries)
    .set({ payload: null })
    .where(
      and(
        isNotNull(webhookDeliveries.processedAt),
        isNotNull(webhookDeliveries.payload),
        lt(webhookDeliveries.receivedAt, new Date(now.getTime() - PAYLOAD_RETENTION_MS)),
      ),
    )
    .returning({ deliveryId: webhookDeliveries.deliveryId });
  return purged.length;
}
