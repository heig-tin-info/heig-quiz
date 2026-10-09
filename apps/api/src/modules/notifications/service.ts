/**
 * Notifications: the bell (F-POOL-05) and the channels that leave the
 * platform, e-mail and Microsoft Teams (ADR-030).
 *
 * `notifyMany` is the ONE entry, and `notify` its one-recipient case. Every
 * other module calls them and never inserts into `notifications` itself, nor
 * enqueues a delivery of its own. For each
 * channel the recipient's preference decides (`notification_preferences`,
 * sparse, the kind's defaults of `DEFAULT_CHANNEL_ENABLED`):
 *
 *  - the bell: a row, and the refresh hint on the recipient's own topic — the
 *    row without the hint is a notification nobody sees until their reload;
 *  - e-mail and Teams: a JOB each (`outbox.ts`), never a send inline, so a
 *    slow or failing provider can neither delay nor break the caller.
 *
 * The stream carries NO data (ADR-005): a `notifications` hint on
 * `user:<id>`, and the client re-reads `GET /app/api/notifications` with its
 * own session. A notification is therefore never a channel for content.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  DEFAULT_CHANNEL_ENABLED,
  kindChannels,
  NOTIFICATION_AUDIENCE,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  notificationKindsFor,
  NotificationPayload,
  type Notification,
  type NotificationChannel,
  type NotificationKind,
  type NotificationList,
  type NotificationMatrix,
  type NotificationPreferencePut,
  type NotificationSettings,
  type TestMailResult,
} from "@quiz/contracts";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { errorClass } from "../../serviceHealth.js";
import {
  enrollments,
  foldKindLiteral,
  NOTIFICATION_FOLD_TARGETS,
  notificationPreferences,
  notifications,
  users,
  type FoldedKind,
} from "../../db/schema.js";
import { holdsCourseSeat } from "../org/service.js";
import { hint, userTopic } from "../realtime/bus.js";
import { createMailer } from "./mailer.js";
import { enqueueDeliveries, teamsOpen, type ExternalChannel } from "./outbox.js";
import { mailLocale, renderTestMail } from "./templates.js";
import { teamsLinkedUsers, teamsLinkOf } from "./teamsLink.js";

const DEFAULT_LIMIT = 30;

/** The kinds only an admin receives (`NOTIFICATION_AUDIENCE`). */
const ADMIN_KINDS = NOTIFICATION_KINDS.filter((kind) => NOTIFICATION_AUDIENCE[kind] === "admin");

type NotificationRow = typeof notifications.$inferSelect;

/** The channels each of `userIds` wants for each of `kinds`, defaults filled in: one query. */
async function channelsFor(
  db: Db,
  userIds: readonly string[],
  kinds: readonly NotificationKind[],
): Promise<(userId: string, kind: NotificationKind) => Record<NotificationChannel, boolean>> {
  const rows = await db
    .select({
      userId: notificationPreferences.userId,
      kind: notificationPreferences.kind,
      channel: notificationPreferences.channel,
      enabled: notificationPreferences.enabled,
    })
    .from(notificationPreferences)
    .where(
      and(
        inArray(notificationPreferences.userId, [...userIds]),
        inArray(notificationPreferences.kind, [...kinds]),
      ),
    );
  const moved = new Map<string, Partial<Record<NotificationChannel, boolean>>>();
  for (const row of rows) {
    const key = `${row.userId}:${row.kind}`;
    moved.set(key, { ...moved.get(key), [row.channel]: row.enabled });
  }
  return (userId, kind) => ({ ...DEFAULT_CHANNEL_ENABLED[kind], ...moved.get(`${userId}:${kind}`) });
}

/**
 * Delivers one notification to one account, on every channel it chose:
 * {@link notifyMany} with a single delivery.
 *
 * Returns the bell row, or null when the user turned the bell off for this
 * kind: then no row is written at all — a row they asked not to see would
 * still count in the badge.
 */
export async function notify(
  db: Db,
  userId: string,
  payload: NotificationPayload,
): Promise<Notification | null> {
  const [created] = await notifyMany(db, [{ userId, payload }]);
  return created ?? null;
}

/**
 * One notification for one account. `channels`, when given, is the most it
 * may use: the recipient's preferences still decide within it, and a channel
 * left out is not used whatever they chose — an in-class exercise opening
 * stays in the app (ADR-030 §h.3). Absent, every channel the recipient chose.
 */
export interface Delivery {
  userId: string;
  payload: NotificationPayload;
  channels?: readonly NotificationChannel[];
}

/**
 * Delivers notifications to many accounts at once — a release tells a whole
 * class — with the reads grouped: the preferences in one query, the Teams
 * links in one, the bell rows in one multi-row insert (a folded kind, §e:
 * one atomic upsert per row). Each recipient still
 * gets its own hint and its own jobs, exactly as {@link notify} would.
 *
 * The payload is parsed on the way IN as well as on the way out: a caller
 * that builds one by hand cannot write a shape the list would then refuse.
 *
 * Returns the bell row of each delivery, in order; null where the user
 * turned the bell off for that kind.
 *
 * Call it AFTER the write it announces has committed, never inside a
 * transaction: the jobs it enqueues live in their own connection and would
 * survive a rollback.
 */
export async function notifyMany(
  db: Db,
  deliveries: readonly Delivery[],
): Promise<(Notification | null)[]> {
  if (deliveries.length === 0) return [];
  const parsed = deliveries.map((d) => ({
    userId: d.userId,
    payload: NotificationPayload.parse(d.payload),
    channels: d.channels ?? NOTIFICATION_CHANNELS,
  }));
  const userIds = [...new Set(parsed.map((d) => d.userId))];
  const wantedBy = await channelsFor(db, userIds, [...new Set(parsed.map((d) => d.payload.kind))]);
  const planned = parsed.map((d) => {
    const chosen = wantedBy(d.userId, d.payload.kind);
    // The kind's own channels bound the delivery's too (`KIND_CHANNELS`).
    const allowed = kindChannels(d.payload.kind);
    const wanted = Object.fromEntries(
      NOTIFICATION_CHANNELS.map((c) => [c, chosen[c] && d.channels.includes(c) && allowed.includes(c)]),
    ) as Record<NotificationChannel, boolean>;
    return { userId: d.userId, payload: d.payload, wanted };
  });

  // A Teams job needs a link; without one it would only be dropped later.
  const linked = await teamsLinkedUsers(
    db,
    teamsOpen() ? [...new Set(planned.filter((d) => d.wanted.teams).map((d) => d.userId))] : [],
  );

  const bells = planned.map((d) =>
    d.wanted.bell
      ? {
          id: randomUUID(),
          userId: d.userId,
          poolId: "poolId" in d.payload ? d.payload.poolId : null,
          evaluationId: evaluationIdOf(d.payload),
          classroomId: "classroomId" in d.payload ? d.payload.classroomId : null,
          projectId: "projectId" in d.payload ? d.payload.projectId : null,
          payload: d.payload,
        }
      : null,
  );
  const values = bells.filter((b) => b !== null);
  const plain = values.filter((b) => !isFolded(b.payload.kind));
  const rows = plain.length === 0 ? [] : await db.insert(notifications).values(plain).returning();
  // Keyed by the id each delivery was GIVEN: a fold answers with the id of
  // the unread row it bumped, which is the one the caller must get back.
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const value of values) {
    if (isFolded(value.payload.kind)) byId.set(value.id, await fold(db, value));
  }
  for (const row of values) hint("notifications", [userTopic(row.userId)]);

  for (const d of planned) {
    const external: ExternalChannel[] = [];
    if (d.wanted.email) external.push("email");
    if (d.wanted.teams && linked.has(d.userId)) external.push("teams");
    if (external.length > 0) await enqueueDeliveries(d.userId, d.payload, external);
  }
  return bells.map((b) => (b ? notificationJson(byId.get(b.id)!) : null));
}

/** Where a best-effort send reports a failure: `app.log` from a job or the ticker, stderr from a service. */
export interface NotifyLog {
  error(obj: object, msg: string): void;
}
// The service layer has no logger (as `realtime/bus.ts`): stderr, which the process log collects.
const stderrLog: NotifyLog = { error: (obj, msg) => console.error(msg, obj) };

/**
 * One payload to each of `userIds`, once each, BEST-EFFORT: the one way a
 * module tells an audience of something that has already committed (a
 * reminder, a release, an organization lost). A failure is logged and never
 * thrown — the action it announces has happened, and must not look as if it
 * had not (ADR-030). Nothing is sent to nobody.
 */
export async function notifyUsers(
  db: Db,
  userIds: readonly string[],
  payload: NotificationPayload,
  log: NotifyLog = stderrLog,
): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  try {
    await notifyMany(
      db,
      unique.map((userId) => ({ userId, payload })),
    );
  } catch (err) {
    log.error({ err, kind: payload.kind }, "notifications: telling an audience failed");
  }
}

/** A kind folded per target (ADR-030 §e), per `NOTIFICATION_FOLD_TARGETS` (`db/notifications.ts`). */
const isFolded = (kind: NotificationKind): kind is FoldedKind => kind in NOTIFICATION_FOLD_TARGETS;

/**
 * One folded delivery, as ONE atomic statement: an insert that, when the
 * recipient already holds an unread row of this kind for this target,
 * conflicts on the kind's partial unique index and bumps that row instead —
 * its count, its payload (the latest name), its `created_at` (so the client
 * toasts it again, §a). It never reads then writes, so two concurrent events
 * cannot both insert, and a row being marked read at the same moment no
 * longer matches the index predicate: the event then starts a new row.
 */
async function fold(
  db: Db,
  value: typeof notifications.$inferInsert & { payload: NotificationPayload },
): Promise<NotificationRow> {
  const kind = value.payload.kind as FoldedKind;
  const target = NOTIFICATION_FOLD_TARGETS[kind];
  const count = sql`(${notifications.payload}->>'count')::int + (excluded.payload->>'count')::int`;
  const [row] = await db
    .insert(notifications)
    .values(value)
    .onConflictDoUpdate({
      target: [notifications.userId, notifications[target]],
      // The kind as a literal, never a bind parameter: Postgres infers the
      // arbiter index by proving this predicate implies the index's, which a
      // `$1` cannot do. The same expression the index is built from.
      targetWhere: sql`${notifications.payload}->>'kind' = ${foldKindLiteral(kind)} and ${notifications.readAt} is null`,
      set: {
        payload: sql`excluded.payload || jsonb_build_object('count', ${count})`,
        createdAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

/**
 * A stored payload that no longer parses (an older shape, a kind that was
 * withdrawn) is DROPPED from the list rather than failing it: the bell of a
 * whole account must not break because one row aged badly.
 */
function notificationJson(row: NotificationRow): Notification {
  return {
    id: row.id,
    payload: NotificationPayload.parse(row.payload),
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

/**
 * The evaluation a payload is about, lifted into `evaluation_id` so deleting
 * the evaluation deletes the bell (a foreign key): its `evaluationId`, or the
 * `activityId` of a kind-neutral payload about an evaluation.
 */
function evaluationIdOf(payload: NotificationPayload): string | null {
  if ("evaluationId" in payload) return payload.evaluationId;
  if ("activityKind" in payload && payload.activityKind === "evaluation") return payload.activityId;
  return null;
}

/**
 * `GET /notifications`: newest first, capped, `unread` over the whole inbox.
 * A bell never points at a deleted pool or evaluation: both foreign keys
 * cascade.
 */
export async function listNotifications(
  db: Db,
  userId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<NotificationList> {
  // The admin kinds (`system_alert`) only while the account is still admin:
  // a demoted account neither sees nor counts the platform's health.
  const [account] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  const visible =
    account?.role === "admin"
      ? eq(notifications.userId, userId)
      : and(
          eq(notifications.userId, userId),
          sql`${notifications.payload}->>'kind' not in (${sql.join(
            ADMIN_KINDS.map((kind) => sql`${kind}`),
            sql`, `,
          )})`,
        );
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(visible)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(visible, isNull(notifications.readAt))),
  ]);
  const items: Notification[] = [];
  for (const row of rows) {
    try {
      items.push(notificationJson(row));
    } catch {
      continue;
    }
  }
  return { items, unread: counted?.n ?? 0 };
}

/**
 * Marks one notification read. Ownership is part of the UPDATE (invariant 6):
 * a row belonging to somebody else is not found, never checked afterwards.
 * Already read is a success — the button is idempotent.
 */
export async function markRead(db: Db, userId: string, id: string): Promise<boolean> {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  if (updated.length > 0) return true;
  const [existing] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .limit(1);
  return existing !== undefined;
}

/** Empties the bell in one statement; returns how many rows it cleared. */
export async function markAllRead(db: Db, userId: string): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return updated.length;
}

/**
 * A release withdrawn (`results.unreleaseResults`): the bells that announced
 * it, or a correction after it (`results_updated`), go, since the page they
 * open no longer shows anything. An e-mail or a Teams message already sent
 * cannot be taken back, and is not pretended to.
 */
export async function withdrawResultsNotifications(db: Db, evaluationId: string): Promise<number> {
  const deleted = await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.evaluationId, evaluationId),
        sql`${notifications.payload}->>'kind' in ('results_released', 'results_updated')`,
      ),
    )
    .returning({ userId: notifications.userId });
  const topics = [...new Set(deleted.map((d) => userTopic(d.userId)))];
  if (topics.length > 0) hint("notifications", topics);
  return deleted.length;
}

// --- Preferences (ADR-030) -----------------------------------------------

/** The whole grid of one user: every kind × every channel, defaults filled in. */
export async function preferenceMatrix(db: Db, userId: string): Promise<NotificationMatrix> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  const matrix = Object.fromEntries(
    NOTIFICATION_KINDS.map((kind) => [kind, { ...DEFAULT_CHANNEL_ENABLED[kind] }]),
  ) as NotificationMatrix;
  for (const row of rows) {
    // A row of a kind or channel that was withdrawn is ignored.
    if (!NOTIFICATION_KINDS.includes(row.kind) || !NOTIFICATION_CHANNELS.includes(row.channel)) continue;
    matrix[row.kind][row.channel] = row.enabled;
  }
  return matrix;
}

/** One toggle of the grid; idempotent. */
export async function setPreference(
  db: Db,
  userId: string,
  pref: NotificationPreferencePut,
): Promise<void> {
  await db
    .insert(notificationPreferences)
    .values({ userId, kind: pref.kind, channel: pref.channel, enabled: pref.enabled })
    .onConflictDoUpdate({
      target: [
        notificationPreferences.userId,
        notificationPreferences.kind,
        notificationPreferences.channel,
      ],
      set: { enabled: pref.enabled, updatedAt: new Date() },
    });
}

/**
 * `GET /notifications/settings`: the grid and its rows, the address, the
 * Teams link. `githubAvailable`: the platform has Quiz's GitHub App, without
 * which the project kinds are never sent and not listed (F-NOTIF-13).
 */
export async function notificationSettings(
  db: Db,
  userId: string,
  teamsAvailable: boolean,
  githubAvailable: boolean,
): Promise<NotificationSettings> {
  const [matrix, link, [user], [seat], courseSeat] = await Promise.all([
    preferenceMatrix(db, userId),
    teamsLinkOf(db, { userId }),
    db
      .select({ email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    // A claimed student seat: what the seat kinds are sent to, whatever the role.
    db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(and(eq(enrollments.userId, userId), eq(enrollments.staff, false)))
      .limit(1),
    holdsCourseSeat(db, userId),
  ]);
  // A link made while Teams was configured means nothing once it is not.
  const shown = teamsAvailable ? link : null;
  return {
    matrix,
    kinds: notificationKindsFor({
      role: user?.role ?? "student",
      studentSeat: seat !== undefined,
      courseSeat,
      github: githubAvailable,
    }),
    email: user?.email ?? "",
    teams: {
      available: teamsAvailable,
      linkedAt: shown?.linkedAt.toISOString() ?? null,
      teamsName: shown?.teamsName ?? null,
      // '' is "Teams gave none": null, as the contract says for unknown.
      teamsUsername: shown?.teamsUsername || null,
    },
  };
}

// --- The Teams link (ADR-030) ----------------------------------------------
// Made, read and forgotten in `teamsLink.ts`; the entry other modules import
// is this one.

export { teamsLinkOf, unlinkTeams } from "./teamsLink.js";

// --- The administrator's test e-mail (ADR-055 §6) -------------------------

/**
 * Sends the short test message to one administrator, now, through the
 * platform's mailer and nothing else: no notification row, no preference,
 * no queue — the point is to see the transport answer. The mailer records
 * the outcome for the services' status like any delivery; the caller gets
 * it back as `sent`, `dry_run` or the failure's class, never its words.
 */
export async function sendTestMail(
  config: AppConfig,
  log: { info(obj: object, msg: string): void },
  to: { email: string; locale: string | null },
): Promise<TestMailResult> {
  const message = renderTestMail(mailLocale(to.locale), config.WEB_URL);
  try {
    return { outcome: await createMailer(config, log).send({ to: to.email, ...message }) };
  } catch (err) {
    return { outcome: "error", error: errorClass(err) };
  }
}
