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
import { and, asc, eq, inArray, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";

import type { GithubWebhookBody } from "@quiz/contracts";
import { attemptVerdict, mayAskAgain, type CommitAuthor, type RedeliveryAsks } from "@quiz/domain";

import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { botCommits, codespaceRelays, githubAccounts, projectRepos, pushReceipts, webhookDeliveries, webhookDeliveryScan, webhookRedeliveryAsks } from "../../db/schema.js";
import { githubApp, githubStatus, hookDeliveriesPage, isZeroSha, rateLimitReset, redeliverHookDelivery, type HookDelivery, type HookDeliveryPage } from "../../github/app.js";
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
  commits: z
    .array(z.object({ distinct: z.boolean().optional(), author: z.object({ username: z.string().optional() }).optional() }))
    .optional(),
});

/** The workflows' own token (GR-16): the grader's commits, never a student's. */
const GITHUB_ACTIONS_BOT = "github-actions[bot]";

/**
 * Who pushed, by the push's sender (D23, M3-04): Quiz's own App (`app`),
 * a workflow's `GITHUB_TOKEN` (`workflow`), or anyone else (`person`).
 * The bots are these two only: heig-classroom's App stops acting on a
 * repository once it is imported (M8). Both bots' pushes are bot commits,
 * never graded; only the App's are spared the protected-file check.
 */
export function pushedBy(config: AppConfig, login: string | undefined): "app" | "workflow" | "person" {
  if (login === GITHUB_ACTIONS_BOT) return "workflow";
  if (config.GITHUB_APP_SLUG !== "" && login === `${config.GITHUB_APP_SLUG}[bot]`) return "app";
  return "person";
}

/**
 * Who pushed a PUSH (ADR-078 §6): {@link pushedBy} of its sender, except
 * that a push of Quiz's App is the student's — a person's — when the online
 * workspace portal declared its head before relaying it (a row of
 * `codespace_relays` for that repository and `after`), and that head is
 * none of the App's own commits (`bot_commits`): a restore, a sync or a
 * deadline commit is never the student's, declared or not. Any other push
 * of the App stays the App's. One primary-key lookup (N-SEC-17), reading
 * the `codespace` and `project` modules' tables by join. A push of the App
 * whose head the deadline job recorded as a collection (`collected`, ADR-130
 * §6) is `collection`: the student's work, made by the platform.
 */
export async function pushAuthor(
  db: Db | Tx,
  config: AppConfig,
  push: { senderLogin: string | undefined; githubRepoId: number; after: string },
): Promise<"app" | "workflow" | "person" | "collection"> {
  const by = pushedBy(config, push.senderLogin);
  if (by !== "app") return by;
  // The deadline job's collection (ADR-130 §6): its receipt, written before the ref moved, says so.
  const [collection] = await db
    .select({ id: pushReceipts.id })
    .from(pushReceipts)
    .where(and(eq(pushReceipts.githubRepoId, push.githubRepoId), eq(pushReceipts.headSha, push.after), eq(pushReceipts.collected, true)))
    .limit(1);
  if (collection) return "collection";
  const ownCommit = db
    .select({ sha: botCommits.sha })
    .from(botCommits)
    .innerJoin(projectRepos, eq(projectRepos.id, botCommits.repoId))
    .where(and(eq(projectRepos.githubRepoId, push.githubRepoId), eq(botCommits.sha, push.after)));
  const [declared] = await db
    .select({ sha: codespaceRelays.sha })
    .from(codespaceRelays)
    .where(and(eq(codespaceRelays.githubRepoId, push.githubRepoId), eq(codespaceRelays.sha, push.after), notExists(ownCommit)))
    .limit(1);
  return declared ? "person" : "app";
}

/**
 * The commits a push brought that no bot authored (M3-14i), null without
 * the list: a commit already pushed (`distinct` false: a sync branch
 * merged, a branch copied) is no new work, nor one of the App's or a
 * workflow's.
 */
function pushedCommits(config: AppConfig, commits: z.infer<typeof PushEvent>["commits"]) {
  return commits?.filter((c) => c.distinct !== false && pushedBy(config, c.author?.username) === "person") ?? null;
}

/**
 * Who authored `commits` (ADR-136): each commit's `author.username` as
 * GitHub reports it — never the pusher, never a `Co-authored-by` trailer —
 * resolved through the linked accounts (`github_accounts`, case-insensitive
 * as GitHub's logins are) to the account's immutable id, with its number of
 * commits. A login no linked account holds, or one two hold (a rename not yet
 * followed), resolves to nobody, and nothing of it is kept. One read.
 */
async function commitAuthors(tx: Tx, commits: ReturnType<typeof pushedCommits>): Promise<CommitAuthor[] | null> {
  if (commits === null) return null;
  const login = (c: (typeof commits)[number]) => c.author?.username?.toLowerCase() ?? null;
  const logins = [...new Set(commits.map(login).filter((l) => l !== null))];
  if (logins.length === 0) return [];
  const lowered = sql<string>`lower(${githubAccounts.login})`;
  const accounts = await tx.select({ login: lowered, id: githubAccounts.githubUserId }).from(githubAccounts).where(inArray(lowered, logins));
  const holders = new Map<string, number[]>();
  for (const a of accounts) holders.set(a.login, [...(holders.get(a.login) ?? []), a.id]);
  const counts = new Map<number, number>();
  for (const c of commits) {
    const held = holders.get(login(c) ?? "");
    if (held?.length === 1) counts.set(held[0]!, (counts.get(held[0]!) ?? 0) + 1);
  }
  return [...counts].map(([id, n]) => ({ id, n }));
}

/**
 * The collection's receipt (ADR-130 §6), written by the deadline job BEFORE
 * the branch moves, in the caller's transaction: `collected`, not a bot's,
 * received at `deadline` — the repository's effective deadline Quiz
 * computed, never a time from the portal. The only writer of `collected`.
 */
export async function recordCollectedReceipt(
  tx: Db | Tx,
  receipt: { githubRepoId: number; branch: string; sha: string; deadline: Date },
): Promise<void> {
  await tx.insert(pushReceipts).values({
    id: randomUUID(),
    githubRepoId: receipt.githubRepoId,
    branch: receipt.branch,
    headSha: receipt.sha,
    receivedAt: receipt.deadline,
    isBot: false,
    forced: false,
    commits: null,
    collected: true,
  })
    // Written again by a run that lost its row's settlement (ADR-130 §5): the first receipt stands.
    .onConflictDoNothing();
}

/** A collection's receipt withdrawn: its commit never reached the branch (GitHub refused the move, ADR-130 §4.3). */
export async function dropCollectedReceipt(tx: Db | Tx, githubRepoId: number, sha: string): Promise<void> {
  await tx
    .delete(pushReceipts)
    .where(and(eq(pushReceipts.githubRepoId, githubRepoId), eq(pushReceipts.headSha, sha), eq(pushReceipts.collected, true)));
}

async function writeReceipt(tx: Tx, config: AppConfig, delivery: WebhookDelivery): Promise<void> {
  if (trackers.size === 0) return;
  const push = PushEvent.safeParse(delivery.payload);
  if (!push.success || isZeroSha(push.data.after)) return;
  const repoId = push.data.repository.id;
  let tracked = false;
  for (const tracks of trackers) if ((tracked = await tracks(tx, repoId))) break;
  if (!tracked) return;
  const commits = pushedCommits(config, push.data.commits);
  await tx
    .insert(pushReceipts)
    .values({
      id: randomUUID(),
      githubRepoId: repoId,
      branch: push.data.ref.replace(/^refs\/heads\//, ""),
      headSha: push.data.after,
      receivedAt: delivery.receivedAt,
      // A collection's head already holds its receipt (ADR-130 §6): this insert is a no-op for it, and never sets `collected`.
      isBot: !["person", "collection"].includes(await pushAuthor(tx, config, { senderLogin: push.data.sender?.login, githubRepoId: repoId, after: push.data.after })),
      forced: push.data.forced ?? false,
      commits: commits?.length ?? null,
      authors: await commitAuthors(tx, commits),
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

/** A failure as it may be stored or logged: its text, every token masked (invariant 15). */
function redactedError(err: unknown): string {
  return redactTokens(String(err)).slice(0, ERROR_MAX);
}

/**
 * The `github.webhook` job: the stored delivery through every handler of
 * its event, then `processed_at`. An unknown or already processed delivery
 * is a no-op, so a second job for the same one costs a read.
 *
 * A failure is kept on the delivery, tokens masked (invariant 15), and a
 * NEW error carrying only that masked text is thrown for the queue's retry
 * — never the original, nor as its `cause`: pg-boss stores what a job
 * throws (`pgboss.job.output`), and a handler's error may quote a token.
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
    const message = redactedError(err);
    await app.db
      .update(webhookDeliveries)
      .set({ error: message })
      .where(eq(webhookDeliveries.deliveryId, deliveryId));
    // GitHub's rate limit (N-PERF-07): the job waits until its reset, sent
    // again for then, without spending one of the queue's retries (the
    // handlers are idempotent, so the part already done is a no-op then).
    const reset = rateLimitReset(err, Date.now());
    if (reset !== null && app.boss) {
      await app.boss.send(GITHUB_WEBHOOK_QUEUE, { deliveryId }, { startAfter: new Date(reset) });
      return;
    }
    throw new Error(message);
  }
  await app.db
    .update(webhookDeliveries)
    .set({ processedAt: app.clock.now(), error: null })
    .where(eq(webhookDeliveries.deliveryId, deliveryId));
}

/**
 * Hands a stored delivery to the worker: the `github.webhook` queue, or,
 * without one (`JOBS_DISABLED=1`, a queue failed at boot), a run in this
 * process — beside the caller by default, so the intake still answers at
 * once; awaited with `wait`, so the reconciliation replays one delivery at
 * a time. An inline failure is logged masked, and left to the
 * reconciliation.
 */
export async function dispatchDelivery(
  app: FastifyInstance,
  config: AppConfig,
  deliveryId: string,
  { wait = false }: { wait?: boolean } = {},
): Promise<void> {
  if (app.boss) {
    await app.boss.send(GITHUB_WEBHOOK_QUEUE, { deliveryId });
    return;
  }
  const run = processDelivery(app, config, deliveryId).catch((err: unknown) =>
    app.log.error({ deliveryId, error: redactedError(err) }, "handling a GitHub delivery failed"),
  );
  if (wait) await run;
}

// ---------------------------------------------------------------- reconciliation

/**
 * A delivery unprocessed for this long lost its job, or exhausted its
 * retries: five, with a backoff from 30 s doubling each time (`jobs.ts`),
 * about 15 minutes in all. Classroom replayed after 10 minutes, while
 * retries could still be pending; 30 leaves them room, jitter included.
 */
export const REPLAY_AFTER_MS = 30 * 60_000;
/** At most this many replayed per run: the next run takes the rest. */
const MAX_REPLAYS = 200;
/** GitHub's failed attempts younger than this are asked again, at most {@link MAX_REDELIVERIES} per pass. */
export const REDELIVERY_WINDOW_MS = 24 * 3_600_000;
export const MAX_REDELIVERIES = 50;
/**
 * Pages of GitHub's delivery log (100 attempts each) one pass reads at most:
 * a pass every 15 minutes reads one to a few in nominal operation; a gap
 * deeper than this (the task stopped for hours) is read over several passes.
 */
export const MAX_LOG_PAGES = 20;
/**
 * How far below the point already covered a pass reads again: GitHub's clock
 * against the server's, and an attempt listed a few seconds after it was made.
 */
export const LOG_OVERLAP_MS = 5 * 60_000;
/** The one row of `webhook_delivery_scan`. */
const SCAN_ROW = "app";

type Scan = Omit<typeof webhookDeliveryScan.$inferSelect, "id">;

/** Where the previous passes left GitHub's log; no row is nothing read yet. */
async function readScan(db: Db): Promise<Scan> {
  const [row] = await db.select().from(webhookDeliveryScan).where(eq(webhookDeliveryScan.id, SCAN_ROW));
  return row ?? { coveredUntil: null, resumeCursor: null, resumeCeiling: null };
}

async function saveScan(db: Db, scan: Scan): Promise<void> {
  await db
    .insert(webhookDeliveryScan)
    .values({ id: SCAN_ROW, ...scan })
    .onConflictDoUpdate({ target: webhookDeliveryScan.id, set: scan });
}

/** A failure GitHub answered for its rate limit: the pass stops on it, its place kept. */
const rateLimited = (err: unknown): boolean => rateLimitReset(err, Date.now()) !== null;

/** What one pass over GitHub's log did. */
interface LogPass {
  pages: number;
  redelivered: number;
  stoppedOnRateLimit: boolean;
}

/** A 4xx GitHub answered for a request: the cursor it named is no longer its own. */
const refusedRequest = (err: unknown): boolean => {
  const status = githubStatus(err);
  return status !== undefined && status >= 400 && status < 500;
};

/**
 * A delivery's newest attempt found refused (a 4xx: `attemptVerdict`): it is
 * never asked for, and logged once, when its row first records the refusal.
 */
async function recordRefusal(app: FastifyInstance, attempt: HookDelivery, now: Date): Promise<void> {
  const [recorded] = await app.db
    .insert(webhookRedeliveryAsks)
    .values({ guid: attempt.guid, firstAskedAt: now, asks: 0, lastStatus: attempt.statusCode, refusedAt: now })
    .onConflictDoUpdate({
      target: webhookRedeliveryAsks.guid,
      set: { lastStatus: attempt.statusCode, refusedAt: now },
      setWhere: isNull(webhookRedeliveryAsks.refusedAt),
    })
    .returning({ guid: webhookRedeliveryAsks.guid });
  if (recorded) {
    app.log.warn({ guid: attempt.guid, status: attempt.statusCode }, "reconcile.deliveries: the intake refused a delivery; it is not asked for again");
  }
}

/** One ask of a delivery counted (`mayAskAgain` reads the count): the first sets the start of its day. */
async function recordAsk(db: Db, attempt: HookDelivery, now: Date): Promise<void> {
  await db
    .insert(webhookRedeliveryAsks)
    .values({ guid: attempt.guid, firstAskedAt: now, asks: 1, lastStatus: attempt.statusCode })
    .onConflictDoUpdate({
      target: webhookRedeliveryAsks.guid,
      set: { asks: sql`${webhookRedeliveryAsks.asks} + 1`, lastStatus: attempt.statusCode },
    });
}

/** The newest attempt of each delivery in the stretch read, and how the read ended. */
interface Stretch {
  newest: Map<string, HookDelivery>;
  pages: number;
  /** The floor was reached (or the log's end): the stretch is whole. */
  reached: boolean;
  /** The page to read next when it was not. */
  next: string | null;
  /** How the read failed, if it did. */
  failure: "rate_limit" | "stale_cursor" | null;
}

/** GitHub's log from `cursor` down to `floor`, at most {@link MAX_LOG_PAGES} pages. */
async function readStretch(config: AppConfig, cursor: string | null, floor: number): Promise<Stretch> {
  const stretch: Stretch = { newest: new Map(), pages: 0, reached: false, next: cursor, failure: null };
  while (stretch.pages < MAX_LOG_PAGES) {
    let page: HookDeliveryPage;
    try {
      page = await hookDeliveriesPage(config, stretch.next);
    } catch (err) {
      if (rateLimited(err)) return { ...stretch, failure: "rate_limit" };
      if (stretch.next !== null && refusedRequest(err)) return { ...stretch, failure: "stale_cursor" };
      throw err;
    }
    stretch.pages += 1;
    const inWindow = page.deliveries.filter((d) => d.deliveredAt.getTime() >= floor);
    for (const d of inWindow) if (!stretch.newest.has(d.guid)) stretch.newest.set(d.guid, d);
    if (inWindow.length < page.deliveries.length || page.next === null) return { ...stretch, reached: true };
    stretch.next = page.next;
  }
  return stretch;
}

/**
 * The deliveries GitHub failed to hand over (GH-62), read INCREMENTALLY from
 * its log of the App's attempts (ADR-011's addendum of 2026-11-22): newest
 * first, one page of 100 at a time, down to the point the previous passes
 * covered less {@link LOG_OVERLAP_MS}, and never below the 24-hour
 * redelivery window — so a pass costs the pages of the deliveries made since
 * the last one, not 24 hours of them.
 *
 * Each delivery's NEWEST attempt in that stretch decides (`attemptVerdict`):
 * delivered, or stored by Quiz meanwhile, nothing to do; refused (a 4xx),
 * never asked for, logged once; else (no answer, a 429, a 5xx) asked again
 * while `mayAskAgain` holds — three asks within a day of the first, so a
 * delivery the intake keeps failing cannot spend every pass's cap. The asks
 * go OLDEST FIRST, the deliveries closest to leaving the window, at most
 * {@link MAX_REDELIVERIES} a pass.
 *
 * Where the pass stops is kept (`webhook_delivery_scan`). Having read down
 * to the floor and asked all it found, everything up to its start is covered
 * — or up to the oldest ask that failed, so the next pass asks it again. Its
 * {@link MAX_LOG_PAGES} pages read first, the next pass goes on from the page
 * it reached (GitHub's own cursor), down to the same floor, before it reads
 * the newer top. Its asks cut short (the cap, a rate limit), the next pass
 * reads the same stretch again. A resume cursor GitHub no longer knows, or
 * one left past the window, is dropped: the top is read instead.
 */
async function redeliverFailures(app: FastifyInstance, config: AppConfig, now: number): Promise<LogPass> {
  const stored = await readScan(app.db);
  const stale = stored.resumeCeiling !== null && stored.resumeCeiling.getTime() < now - REDELIVERY_WINDOW_MS;
  const scan = stale ? { ...stored, resumeCursor: null, resumeCeiling: null } : stored;
  const floor = Math.max(now - REDELIVERY_WINDOW_MS, (scan.coveredUntil?.getTime() ?? 0) - LOG_OVERLAP_MS);
  const ceiling = scan.resumeCeiling ?? new Date(now);
  /** The next pass reads from `cursor` again (null: the top, nothing to keep), down to the same floor. */
  const resumeAt = (cursor: string | null) =>
    saveScan(app.db, { coveredUntil: scan.coveredUntil, resumeCursor: cursor, resumeCeiling: cursor === null ? null : ceiling });

  const stretch = await readStretch(config, scan.resumeCursor, floor);
  const result: LogPass = { pages: stretch.pages, redelivered: 0, stoppedOnRateLimit: stretch.failure === "rate_limit" };
  if (stretch.failure === "stale_cursor") {
    app.log.warn("reconcile.deliveries: GitHub no longer knows the resume cursor; the top is read next");
    await resumeAt(null);
    return result;
  }

  const failed = [...stretch.newest.values()].filter((d) => attemptVerdict(d.statusCode) !== "delivered");
  const guids = failed.map((d) => d.guid);
  const [held, asked] =
    guids.length === 0
      ? [new Set<string>(), new Map<string, RedeliveryAsks>()]
      : await Promise.all([
          app.db
            .select({ deliveryId: webhookDeliveries.deliveryId })
            .from(webhookDeliveries)
            .where(inArray(webhookDeliveries.deliveryId, guids))
            .then((rows) => new Set(rows.map((r) => r.deliveryId))),
          app.db
            .select()
            .from(webhookRedeliveryAsks)
            .where(inArray(webhookRedeliveryAsks.guid, guids))
            .then((rows) => new Map(rows.map((r) => [r.guid, r]))),
        ]);
  const due: HookDelivery[] = [];
  for (const d of failed) {
    if (held.has(d.guid)) continue;
    if (attemptVerdict(d.statusCode) === "refused") await recordRefusal(app, d, new Date(now));
    else if (mayAskAgain(asked.get(d.guid), new Date(now))) due.push(d);
  }
  due.sort((a, b) => a.deliveredAt.getTime() - b.deliveredAt.getTime());

  let tries = 0;
  let cutShort = false;
  /** The oldest delivery whose ask GitHub failed: the covered point stays below it. */
  let failedAsk: number | null = null;
  for (const d of due) {
    if (tries === MAX_REDELIVERIES) {
      cutShort = true;
      break;
    }
    tries += 1;
    try {
      await redeliverHookDelivery(config, d.id);
      result.redelivered += 1;
    } catch (err) {
      if (rateLimited(err)) {
        result.stoppedOnRateLimit = true;
        cutShort = true;
        break;
      }
      app.log.warn({ guid: d.guid, error: redactedError(err) }, "reconcile.deliveries: a redelivery failed");
      failedAsk = Math.min(failedAsk ?? Infinity, d.deliveredAt.getTime());
    }
    await recordAsk(app.db, d, new Date(now));
  }

  if (cutShort || (!stretch.reached && failedAsk !== null)) await resumeAt(scan.resumeCursor);
  else if (!stretch.reached) await resumeAt(stretch.next);
  else {
    const covered = failedAsk === null ? ceiling : new Date(Math.min(ceiling.getTime(), failedAsk));
    await saveScan(app.db, { coveredUntil: covered, resumeCursor: null, resumeCeiling: null });
  }
  return result;
}

/**
 * `reconcile.deliveries` (GH-62, ADR-011 as amended 2026-11-22), a
 * scheduled task, every 15 minutes: the deliveries stored but left
 * unprocessed (a lost job, a crash, retries exhausted) go through the worker
 * again; the deliveries GitHub failed to hand over in the last 24 hours (the
 * intake down, a 5xx) are asked again, unless one of their attempts was
 * stored since ({@link redeliverFailures}). Its cost follows the traffic,
 * not the number of repositories. Without Quiz's App it does nothing: there
 * is no intake, and no handler registered to replay through.
 */
export async function reconcileDeliveries(
  app: FastifyInstance,
  config: AppConfig,
): Promise<string> {
  if (!githubApp(config)) return "GitHub App not configured";
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
  // A delivery waiting out a rate limit (`processDelivery`) may be replayed
  // here before its reset: accepted — it meets the limit again and is sent
  // again for the reset, at the cost of a few calls.
  for (const { deliveryId } of stuck) {
    await dispatchDelivery(app, config, deliveryId, { wait: true });
  }
  const log = await redeliverFailures(app, config, now);
  return (
    `${stuck.length} local deliveries replayed, ${log.redelivered} GitHub redeliveries requested, ${log.pages} log pages read` +
    (log.stoppedOnRateLimit ? ", stopped on GitHub's rate limit" : "")
  );
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

/** A delivery's asks are kept this long after the first: its last redelivery has left the 24-hour window by then. */
export const ASKS_RETENTION_MS = 3 * 24 * 3_600_000;

/** `deliveries.purge`, second step: the asks of deliveries past any window (`webhook_redelivery_asks`). */
export async function purgeRedeliveryAsks(db: Db, now: Date): Promise<number> {
  const purged = await db
    .delete(webhookRedeliveryAsks)
    .where(lt(webhookRedeliveryAsks.firstAskedAt, new Date(now.getTime() - ASKS_RETENTION_MS)))
    .returning({ guid: webhookRedeliveryAsks.guid });
  return purged.length;
}
