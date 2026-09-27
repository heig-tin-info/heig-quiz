/**
 * What the HEIG Quiz bot does with an activity Teams posted to it (ADR-030).
 * The route has already authenticated the call and parsed the activity; this
 * decides, and answers in the chat.
 *
 * Only personal chats of the `msteams` channel are served — the Teams app
 * declares the `personal` scope alone — and anything else is ignored (the
 * route still answers 200: an error would only make Microsoft retry).
 *
 *  - the app installed (`installationUpdate` `add`, or a `conversationUpdate`
 *    whose `membersAdded` holds the bot), or any message: when the chat is
 *    not linked, the link card, behind a fresh single-use token — at most
 *    one a minute per chat, so the two install events and a burst of
 *    messages cost one card; when it is linked, one line saying to whom;
 *  - a Teams account of a tenant outside `TEAMS_ALLOWED_TENANTS` gets no
 *    token at all, only a line saying why: a link minted for a stranger's
 *    chat is the bait of a consent phishing (ADR-030);
 *  - the app removed (`installationUpdate` `remove`): the chat is unlinked,
 *    audited as `teams.unlink` by the linked account, via Teams.
 *
 * Replies are in the language of the Teams client (`activity.locale`).
 */
import { eq } from "drizzle-orm";

import type { TeamsActivity } from "@quiz/contracts";
import { displayName } from "@quiz/domain";

import { audit } from "../../audit.js";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { TeamsClient, TeamsConversation } from "./teams.js";
import {
  issueLinkToken,
  refreshServiceUrl,
  teamsLinkOf,
  tenantAllowed,
  unlinkTeams,
  type AllowedTenants,
  type TeamsChatIdentity,
} from "./teamsLink.js";
import { botLocale, botText, linkCard, type MailLocale } from "./templates.js";

export interface BotDeps {
  db: Db;
  teams: TeamsClient;
  /** Where a browser reaches the SPA (`WEB_URL`): the base of the link card. */
  webUrl: string;
  /** `TEAMS_ALLOWED_TENANTS`, split; empty admits every tenant. */
  tenants: AllowedTenants;
  now: () => Date;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/** The name an account is greeted by in Teams (`displayName`). */
export async function accountName(db: Db, userId: string): Promise<string> {
  const [user] = await db
    .select({ givenName: users.givenName, familyName: users.familyName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ? displayName(user) : "";
}

function identityOf(activity: TeamsActivity): TeamsChatIdentity | null {
  const tenantId = activity.channelData?.tenant?.id ?? activity.conversation.tenantId;
  const aadObjectId = activity.from?.aadObjectId;
  if (!tenantId || !aadObjectId) return null;
  return {
    conversationId: activity.conversation.id,
    serviceUrl: activity.serviceUrl,
    tenantId: tenantId.trim().toLowerCase(),
    aadObjectId,
    teamsName: activity.from?.name?.trim() || aadObjectId,
  };
}

/** The card for an unlinked chat, the line for a linked one. */
async function greet(deps: BotDeps, activity: TeamsActivity, to: TeamsConversation, locale: MailLocale) {
  const link = await teamsLinkOf(deps.db, { conversationId: to.conversationId });
  if (link) {
    await refreshServiceUrl(deps.db, to.conversationId, to.serviceUrl);
    const name = await accountName(deps.db, link.userId);
    await deps.teams.send(to, botText(locale, "bot.linked", { name, settings: `${deps.webUrl}/settings` }));
    return;
  }
  const who = identityOf(activity);
  if (!who) {
    deps.log.warn({ conversationId: to.conversationId }, "teams activity without tenant or user id");
    return;
  }
  if (!tenantAllowed(deps.tenants, who.tenantId)) {
    deps.log.info({ tenantId: who.tenantId }, "teams link refused: tenant not allowed");
    await deps.teams.send(to, botText(locale, "bot.tenantRefused"));
    return;
  }
  const token = await issueLinkToken(deps.db, who, deps.now());
  if (!token) return;
  await deps.teams.send(to, linkCard(locale, `${deps.webUrl}/teams/link?token=${token}`));
}

export async function handleActivity(deps: BotDeps, activity: TeamsActivity): Promise<void> {
  if (activity.channelId !== "msteams" || activity.conversation.conversationType !== "personal") return;
  const to: TeamsConversation = { serviceUrl: activity.serviceUrl, conversationId: activity.conversation.id };
  const locale = botLocale(activity.locale);

  switch (activity.type) {
    case "installationUpdate":
      if (activity.action === "add") return greet(deps, activity, to, locale);
      if (activity.action === "remove") {
        const userId = await unlinkTeams(deps.db, { conversationId: to.conversationId });
        if (userId) {
          await audit(deps.db, {
            actorUserId: userId,
            actorType: "user",
            action: "teams.unlink",
            subjectType: "user",
            subjectId: userId,
            payload: { via: "teams" },
          });
          deps.log.info({ userId }, "teams app removed: link forgotten");
        }
      }
      return;
    case "conversationUpdate": {
      const botId = activity.recipient?.id;
      if (botId && activity.membersAdded?.some((m) => m.id === botId)) return greet(deps, activity, to, locale);
      return;
    }
    case "message":
      return greet(deps, activity, to, locale);
    default:
      return;
  }
}
