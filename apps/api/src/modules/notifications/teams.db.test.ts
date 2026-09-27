/**
 * The Teams link (ADR-030) on a real database: what the bot does with each
 * activity, and the single-use token behind its card.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { TeamsActivity } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { auditLog, teamsLinks, teamsLinkTokens, users } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { handleActivity, type BotDeps } from "./bot.js";
import type { OutgoingActivity, TeamsConversation } from "./teams.js";
import {
  consumeLinkToken,
  issueLinkToken,
  LINK_TOKEN_TTL_MS,
  previewLinkToken,
  teamsLinkOf,
} from "./teamsLink.js";

let db: Db;

async function seedUser(email: string, givenName = "Léa", familyName = "Rochat"): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `s-${id}`, email, role: "student", givenName, familyName });
  return id;
}

beforeAll(async () => {
  db = (await testDb()) as unknown as Db;
});

const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
const BOT = "28:bot-app-id";

/** A personal-chat activity from one Teams user; `over` replaces any field. */
function activity(conversationId: string, over: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    channelId: "msteams",
    serviceUrl: SERVICE_URL,
    locale: "en-US",
    from: { id: "29:user", name: "Léa Rochat (HEIG-VD)", aadObjectId: "aad-lea" },
    recipient: { id: BOT, name: "HEIG Quiz" },
    conversation: { id: conversationId, conversationType: "personal", tenantId: "tenant-heig" },
    channelData: { tenant: { id: "tenant-heig" } },
    text: "hello",
    ...over,
  };
}

function bot(start = new Date("2026-09-27T10:00:00Z"), tenants: readonly string[] = ["tenant-heig"]) {
  const sent: { to: TeamsConversation; activity: OutgoingActivity }[] = [];
  let now = start;
  const deps: BotDeps = {
    db,
    teams: {
      async send(to, message) {
        sent.push({ to, activity: message });
      },
    },
    webUrl: "https://quiz.test",
    tenants,
    now: () => now,
    log: { info: () => {}, warn: () => {} },
  };
  return {
    deps,
    sent,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    now: () => now,
  };
}

/** The token behind the one link card of `sent[index]`. */
function tokenOf(message: OutgoingActivity): string {
  const card = message.attachments?.[0]?.content as { actions: { url: string }[] };
  const url = new URL(card.actions[0]!.url);
  expect(url.origin + url.pathname).toBe("https://quiz.test/teams/link");
  return url.searchParams.get("token")!;
}

describe("the bot", () => {
  it("answers an install with ONE link card, however many events announce it", async () => {
    const b = bot();
    const conversation = `a:${randomUUID()}`;
    await handleActivity(b.deps, activity(conversation, { type: "installationUpdate", action: "add" }));
    await handleActivity(
      b.deps,
      activity(conversation, { type: "conversationUpdate", membersAdded: [{ id: BOT }] }),
    );
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]!.to).toEqual({ serviceUrl: SERVICE_URL, conversationId: conversation });
    const card = b.sent[0]!.activity.attachments![0]!;
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(JSON.stringify(card.content)).toContain("Link to my Quiz account");
    const token = tokenOf(b.sent[0]!.activity);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Only the hash is stored.
    const rows = await db.select().from(teamsLinkTokens).where(eq(teamsLinkTokens.conversationId, conversation));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]).toMatchObject({ tenantId: "tenant-heig", aadObjectId: "aad-lea", teamsName: "Léa Rochat (HEIG-VD)" });
  });

  it("caps a burst of messages from an unlinked chat at one card a minute", async () => {
    const b = bot();
    const conversation = `a:${randomUUID()}`;
    for (let i = 0; i < 5; i++) await handleActivity(b.deps, activity(conversation));
    expect(b.sent).toHaveLength(1);
    b.advance(61_000);
    await handleActivity(b.deps, activity(conversation));
    expect(b.sent).toHaveLength(2);
    expect(tokenOf(b.sent[1]!.activity)).not.toBe(tokenOf(b.sent[0]!.activity));
  });

  it("mints nothing for a Teams account of another organization, and says why", async () => {
    const b = bot();
    const conversation = `a:${randomUUID()}`;
    const stranger = { id: conversation, conversationType: "personal", tenantId: "tenant-elsewhere" };
    await handleActivity(
      b.deps,
      activity(conversation, { conversation: stranger, channelData: { tenant: { id: "TENANT-ELSEWHERE" } }, locale: "fr-FR" }),
    );
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]!.activity).toMatchObject({ type: "message", textFormat: "plain" });
    expect(b.sent[0]!.activity.text).toContain("HEIG-VD");
    expect(b.sent[0]!.activity.attachments).toBeUndefined();
    expect(await db.select().from(teamsLinkTokens).where(eq(teamsLinkTokens.conversationId, conversation))).toHaveLength(0);

    // An empty list admits every tenant (a test bot).
    const open = bot(undefined, []);
    await handleActivity(open.deps, activity(conversation, { conversation: stranger }));
    expect(open.sent[0]!.activity.attachments).toHaveLength(1);
  });

  it("speaks the language of the Teams client", async () => {
    const b = bot();
    await handleActivity(b.deps, activity(`a:${randomUUID()}`, { locale: "fr-CH" }));
    expect(JSON.stringify(b.sent[0]!.activity)).toContain("Lier à mon compte Quiz");
  });

  it("tells a linked chat to whom it is linked, and follows a new serviceUrl", async () => {
    const b = bot();
    const conversation = `a:${randomUUID()}`;
    const lea = await seedUser(`lea-${randomUUID()}@heig.test`);
    await handleActivity(b.deps, activity(conversation));
    await consumeLinkToken(db, lea, tokenOf(b.sent[0]!.activity), b.now());

    const moved = "https://smba.trafficmanager.net/amer/";
    await handleActivity(b.deps, activity(conversation, { serviceUrl: moved }));
    expect(b.sent).toHaveLength(2);
    expect(b.sent[1]!.activity).toMatchObject({ type: "message", textFormat: "plain" });
    expect(b.sent[1]!.activity.text).toContain("Léa Rochat");
    expect((await teamsLinkOf(db, { conversationId: conversation }))!.serviceUrl).toBe(moved);
  });

  it("ignores what is not a personal chat of Teams, or has no Entra identity", async () => {
    const b = bot();
    const conversation = `a:${randomUUID()}`;
    await handleActivity(b.deps, activity(conversation, { channelId: "webchat" }));
    await handleActivity(
      b.deps,
      activity(conversation, { conversation: { id: conversation, conversationType: "groupChat" } }),
    );
    await handleActivity(b.deps, activity(conversation, { from: { id: "29:x" } }));
    await handleActivity(b.deps, activity(conversation, { type: "typing" }));
    expect(b.sent).toHaveLength(0);
  });

  it("forgets the chat when the app is removed, audited as the linked account's act", async () => {
    const b = bot();
    const conversation = `a:${randomUUID()}`;
    const lea = await seedUser(`lea-${randomUUID()}@heig.test`);
    await handleActivity(b.deps, activity(conversation));
    await consumeLinkToken(db, lea, tokenOf(b.sent[0]!.activity), b.now());

    await handleActivity(b.deps, activity(conversation, { type: "installationUpdate", action: "remove" }));
    expect(await teamsLinkOf(db, { conversationId: conversation })).toBeNull();
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "teams.unlink"), eq(auditLog.subjectId, lea)));
    expect(entry).toMatchObject({ actorUserId: lea, actorType: "user", payload: { via: "teams" } });
    // Nothing is said in a chat the person just left.
    expect(b.sent).toHaveLength(1);
  });
});

describe("the link token", () => {
  async function issued(start: Date) {
    const conversation = `a:${randomUUID()}`;
    const token = await issueLinkToken(
      db,
      {
        conversationId: conversation,
        serviceUrl: SERVICE_URL,
        tenantId: "tenant-heig",
        aadObjectId: `aad-${conversation}`,
        teamsName: "Léa Rochat",
      },
      start,
    );
    return { conversation, token: token! };
  }

  it("previews without consuming, then links once and never again", async () => {
    const now = new Date("2026-09-27T12:00:00Z");
    const { conversation, token } = await issued(now);
    const lea = await seedUser(`lea-${randomUUID()}@heig.test`);

    expect(await previewLinkToken(db, token, now)).toMatchObject({ teamsName: "Léa Rochat", tenantId: "tenant-heig" });
    expect(await previewLinkToken(db, token, now)).not.toBeNull();

    const outcome = await consumeLinkToken(db, lea, token, now);
    expect(outcome).toMatchObject({ displaced: null, link: { userId: lea, conversationId: conversation } });
    // Replayed: nothing, and the preview says so too.
    expect(await consumeLinkToken(db, lea, token, now)).toBeNull();
    expect(await previewLinkToken(db, token, now)).toBeNull();
  });

  it("is unusable after fifteen minutes, and pruned by the next one made", async () => {
    const now = new Date("2026-09-27T13:00:00Z");
    const { token } = await issued(now);
    const later = new Date(now.getTime() + LINK_TOKEN_TTL_MS + 1);
    expect(await previewLinkToken(db, token, later)).toBeNull();
    expect(await consumeLinkToken(db, await seedUser(`x-${randomUUID()}@heig.test`), token, later)).toBeNull();

    await issued(later);
    const left = await db.select().from(teamsLinkTokens);
    expect(left.every((row) => row.expiresAt > later)).toBe(true);
  });

  it("is refused, and left unspent, once its tenant is no longer allowed", async () => {
    const now = new Date("2026-09-27T12:30:00Z");
    const { token } = await issued(now);
    const lea = await seedUser(`lea-${randomUUID()}@heig.test`);
    expect(await previewLinkToken(db, token, now, ["another-tenant"])).toBeNull();
    expect(await consumeLinkToken(db, lea, token, now, ["another-tenant"])).toBeNull();
    expect(await consumeLinkToken(db, lea, token, now, ["another-tenant", "tenant-heig"])).not.toBeNull();
  });

  it("knows nothing of a token it never made", async () => {
    const now = new Date();
    const random = "A".repeat(43);
    expect(await previewLinkToken(db, random, now)).toBeNull();
    expect(await consumeLinkToken(db, await seedUser(`y-${randomUUID()}@heig.test`), random, now)).toBeNull();
  });

  it("moves a chat to the account that links it last, and replaces an account's old chat", async () => {
    const now = new Date("2026-09-27T14:00:00Z");
    const first = await seedUser(`first-${randomUUID()}@heig.test`);
    const second = await seedUser(`second-${randomUUID()}@heig.test`);

    const one = await issued(now);
    await consumeLinkToken(db, first, one.token, now);
    // The same chat again (a new card), linked from another Quiz account.
    const again = await issueLinkToken(
      db,
      {
        conversationId: one.conversation,
        serviceUrl: SERVICE_URL,
        tenantId: "tenant-heig",
        aadObjectId: "aad",
        teamsName: "Léa",
      },
      new Date(now.getTime() + 61_000),
    );
    const moved = await consumeLinkToken(db, second, again!, new Date(now.getTime() + 62_000));
    expect(moved!.displaced).toBe(first);
    const holders = await db.select().from(teamsLinks).where(eq(teamsLinks.conversationId, one.conversation));
    expect(holders.map((l) => l.userId)).toEqual([second]);

    // A second chat for the same account replaces the first one.
    const two = await issued(now);
    const replaced = await consumeLinkToken(db, second, two.token, now);
    expect(replaced!.displaced).toBeNull();
    const mine = await db.select().from(teamsLinks).where(eq(teamsLinks.userId, second));
    expect(mine.map((l) => l.conversationId)).toEqual([two.conversation]);
  });
});
