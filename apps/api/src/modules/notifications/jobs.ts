/**
 * The delivery job of the notification channels (ADR-030): one job per
 * notification and channel, enqueued by `notify` through the outbox.
 *
 * A job renders the message in the recipient's language at the moment it
 * runs, and sends it. A failure THROWS, and the queue retries it with
 * backoff (pg-boss; the in-process development queue only logs). What is
 * not a failure returns quietly: an account gone or anonymized, an empty
 * address, a Teams link removed since — there is nobody left to retry for.
 * So does a Teams answer that a retry cannot change (403, 404): logged.
 */
import type { FastifyInstance } from "fastify";

import { eq } from "drizzle-orm";

import { teamsEnabled, type AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { JobQueue } from "../../jobs.js";
import { createMailer, type Mailer } from "./mailer.js";
import {
  closeOutbox,
  NOTIFICATION_DELIVERY_QUEUE,
  openOutbox,
  type DeliveryJob,
} from "./outbox.js";
import { teamsLinkOf } from "./service.js";
import { createTeamsClient, TeamsError, type TeamsClient } from "./teams.js";
import { tenantAllowed, type AllowedTenants } from "./teamsLink.js";
import { mailLocale, renderNotification } from "./templates.js";

export interface DeliveryDeps {
  db: Db;
  /** Where a browser reaches the SPA: the base of every link in a message. */
  webUrl: string;
  mailer: Mailer;
  /** Null when Teams is not configured on this platform. */
  teams: TeamsClient | null;
  /** `TEAMS_ALLOWED_TENANTS`: a link of a tenant no longer listed is not delivered to. */
  tenants: AllowedTenants;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/** Performs one delivery. Exported for the tests, which pass fakes for both transports. */
export async function deliver(deps: DeliveryDeps, job: DeliveryJob): Promise<void> {
  const [user] = await deps.db
    .select({ email: users.email, locale: users.locale, anonymizedAt: users.anonymizedAt })
    .from(users)
    .where(eq(users.id, job.userId))
    .limit(1);
  if (!user || user.anonymizedAt) return;
  const message = renderNotification(job.payload, mailLocale(user.locale), deps.webUrl);

  if (job.channel === "email") {
    if (!user.email) return;
    await deps.mailer.send({
      to: user.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return;
  }

  if (!deps.teams) return;
  const link = await teamsLinkOf(deps.db, { userId: job.userId });
  if (!link) return;
  if (!tenantAllowed(deps.tenants, link.tenantId)) {
    // The organization was removed from the list since the link was made:
    // nothing is sent, and a retry would meet the same list.
    deps.log.warn({ userId: job.userId, tenantId: link.tenantId }, "teams notification skipped: tenant not allowed");
    return;
  }
  try {
    await deps.teams.send(
      { serviceUrl: link.serviceUrl, conversationId: link.conversationId },
      { type: "message", textFormat: "xml", text: message.teams },
    );
  } catch (err) {
    // The bot was blocked, the chat is gone, or the stored serviceUrl is no
    // longer allowed: a retry would meet the same answer. Logged, dropped;
    // the link stays (the uninstall event, or the user, removes it).
    if (err instanceof TeamsError && err.permanent) {
      deps.log.warn(
        { userId: job.userId, kind: job.payload.kind, status: err.status },
        "teams notification refused for good, not retried",
      );
      return;
    }
    throw err;
  }
  deps.log.info({ userId: job.userId, kind: job.payload.kind }, "teams notification sent");
}

/** Registers the queue and its worker, and opens the outbox. Called once, from `buildApp`. */
export async function registerNotificationJobs(
  app: FastifyInstance,
  queue: JobQueue,
  config: AppConfig,
): Promise<void> {
  await queue.createQueue(NOTIFICATION_DELIVERY_QUEUE, {
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 30,
  });
  const teams = teamsEnabled(config);
  const deps: DeliveryDeps = {
    db: app.db,
    webUrl: config.WEB_URL,
    mailer: createMailer(config, app.log),
    teams: teams ? createTeamsClient(config) : null,
    tenants: config.TEAMS_ALLOWED_TENANTS,
    log: app.log,
  };
  await queue.work<DeliveryJob>(NOTIFICATION_DELIVERY_QUEUE, async (job) => {
    try {
      await deliver(deps, job);
    } catch (err) {
      app.log.warn(
        { err, userId: job.userId, channel: job.channel, kind: job.payload.kind },
        "notification delivery failed",
      );
      throw err;
    }
  });
  openOutbox({ queue, teams, log: app.log });
  app.addHook("onClose", async () => closeOutbox());
}
