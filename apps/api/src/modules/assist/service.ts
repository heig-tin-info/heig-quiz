/**
 * The teacher assistant (ADR-080, F-LLM-07): a question about the platform,
 * asked from any teacher screen, answered from the documentation by the
 * gateway's `converse()` with one read-only tool, `read_guide` — or, in
 * development without a model, by the stub (`LLM_PROVIDER=stub`).
 *
 * What reaches the model is the corpus, the route PATTERN, the help topic,
 * the UI language and what the teacher typed: never an entity, never a name
 * the platform holds (ADR-080 §2). The conversations are stored, 30 days a
 * message (§6), and read by their owner and by the administrators.
 */
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";

import type { AssistContext, AssistConversation, AssistConversationSummary, AssistMessage, AssistReply } from "@quiz/contracts";
import {
  ASSIST_CAP_SHARE,
  ASSIST_HISTORY_MESSAGES,
  ASSIST_MAX_STEPS,
  ASSIST_MAX_TOKENS,
  ASSIST_RETENTION_DAYS,
  assistScreen,
  assistSystem,
  readGuide,
  stubAnswer,
  type AssistCorpus,
  type AssistRole,
} from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { assistConversations, assistMessages } from "../../db/schema.js";
import type { ConverseTurn, LlmGateway, ReadOnlyTool } from "../llm/service.js";
import { STUB_MODEL } from "../llm/service.js";

/** How the assistant answers on this server: the gateway's model, the development stub, or not at all. */
export type AssistEngine = "model" | "stub" | null;

/**
 * The stub when `LLM_PROVIDER=stub` (development), as the grading service
 * chooses (`llm/index.ts`); else the gateway when it holds a key; else nothing.
 */
export async function assistEngine(gateway: LlmGateway, stub: boolean): Promise<AssistEngine> {
  if (stub) return "stub";
  return (await gateway.ready()) ? "model" : null;
}

const ReadGuideInput = z.object({ page: z.string().min(1).max(200), section: z.string().max(200).optional() });

/**
 * The one tool of P1 (ADR-080 §5): a page or a section of the corpus the
 * asker's role reads. It reads the corpus in memory and nothing else.
 */
export function readGuideTool(corpus: AssistCorpus, role: AssistRole, locale: AssistContext["locale"]): ReadOnlyTool {
  return {
    name: "read_guide",
    description:
      "Returns a page of the platform's documentation, or one of its sections: `page` is a page id of the index " +
      "(guide/pools, help/pool), `section` a section anchor of that page (search-and-filters). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string", description: "A page id of the index, such as guide/pools or help/pool." },
        section: { type: "string", description: "Optional: a section anchor of that page, such as sharing-a-pool." },
      },
      required: ["page"],
      additionalProperties: false,
    },
    run(input) {
      const parsed = ReadGuideInput.safeParse(input);
      if (!parsed.success) throw new Error("Give `page`, a page id of the index, and optionally `section`.");
      return readGuide(corpus, role, locale, parsed.data);
    },
  };
}

const roleOf = (role: string): AssistRole => (role === "admin" ? "admin" : "teacher");

const toMessage = (row: typeof assistMessages.$inferSelect): AssistMessage => ({
  id: row.id,
  role: row.role,
  content: row.content,
  createdAt: row.createdAt.toISOString(),
});

/**
 * A conversation by id, only when `ownerId` owns it — anyone else's is a miss
 * (invariant 6); `null` for whoever owns it, the administrators' read
 * (ADR-080 §6), audited by the route.
 */
export async function findConversation(db: Db, id: string, ownerId: string | null) {
  const [row] = await db
    .select()
    .from(assistConversations)
    .where(and(eq(assistConversations.id, id), ownerId === null ? undefined : eq(assistConversations.userId, ownerId)))
    .limit(1);
  return row ?? null;
}

export async function conversationDetail(
  db: Db,
  row: typeof assistConversations.$inferSelect,
): Promise<AssistConversation> {
  const messages = await db
    .select()
    .from(assistMessages)
    .where(eq(assistMessages.conversationId, row.id))
    .orderBy(asc(assistMessages.seq));
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messages: messages.map(toMessage),
  };
}

/** A user's conversations, newest first, each previewed by its first question. */
export async function listConversations(db: Db, userId: string): Promise<AssistConversationSummary[]> {
  const first = sql<string>`(select ${assistMessages.content} from ${assistMessages}
    where ${assistMessages.conversationId} = ${assistConversations.id}
    order by ${assistMessages.seq} limit 1)`;
  const rows = await db
    .select({
      id: assistConversations.id,
      createdAt: assistConversations.createdAt,
      updatedAt: assistConversations.updatedAt,
      preview: first,
    })
    .from(assistConversations)
    .where(eq(assistConversations.userId, userId))
    .orderBy(desc(assistConversations.updatedAt));
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    preview: (r.preview ?? "").slice(0, 120),
  }));
}

export async function deleteConversation(db: Db, id: string): Promise<void> {
  await db.delete(assistConversations).where(eq(assistConversations.id, id));
}

/** The question cannot be answered: the conversation is not the asker's. */
export class ConversationNotFound extends Error {}

export interface AskDeps {
  db: Db;
  gateway: LlmGateway;
  corpus: AssistCorpus;
  engine: Exclude<AssistEngine, null>;
}

/**
 * One question (ADR-080 §5): the conversation's last messages and the new
 * question go to the model with the stable prompt, the screen and the tool;
 * the question and its answer are stored TOGETHER once the answer came, so
 * a failed call leaves nothing behind and the teacher simply asks again.
 * Throws `ConversationNotFound` or the gateway's `LlmError`.
 */
export async function ask(
  deps: AskDeps,
  asker: { id: string; role: string },
  question: { conversationId?: string | undefined; message: string; context: AssistContext },
  now: Date,
): Promise<AssistReply> {
  const { db, corpus } = deps;
  const existing = question.conversationId ? await findConversation(db, question.conversationId, asker.id) : null;
  if (question.conversationId && !existing) throw new ConversationNotFound();
  const role = roleOf(asker.role);
  const earlier = existing
    ? await db
        .select({ role: assistMessages.role, content: assistMessages.content })
        .from(assistMessages)
        .where(eq(assistMessages.conversationId, existing.id))
        .orderBy(desc(assistMessages.seq))
        .limit(ASSIST_HISTORY_MESSAGES)
    : [];
  const history: ConverseTurn[] = earlier.reverse().map((m) => ({ role: m.role, text: m.content }));
  // Questions and answers are written in pairs (below): the replay opens on a question.
  history.push({ role: "user", text: question.message });

  const { text, model } =
    deps.engine === "model"
      ? await deps.gateway.converse({
          purpose: "assist",
          userId: asker.id,
          system: { stable: assistSystem(corpus, role), volatile: assistScreen(corpus, role, question.context) },
          history,
          tools: [readGuideTool(corpus, role, question.context.locale)],
          maxTokens: ASSIST_MAX_TOKENS,
          maxSteps: ASSIST_MAX_STEPS,
          effort: "low",
          share: ASSIST_CAP_SHARE,
        })
      : { text: stubAnswer(corpus, role, question.message, question.context), model: STUB_MODEL };

  return db.transaction(async (tx) => {
    const conversationId = existing?.id ?? randomUUID();
    if (existing) {
      // Its row lock orders two tabs asking in the same conversation, before `seq` is read.
      await tx.update(assistConversations).set({ updatedAt: now }).where(eq(assistConversations.id, conversationId));
    } else {
      await tx.insert(assistConversations).values({ id: conversationId, userId: asker.id, createdAt: now, updatedAt: now });
    }
    const [last] = await tx
      .select({ seq: sql<number>`coalesce(max(${assistMessages.seq}), -1)::int` })
      .from(assistMessages)
      .where(eq(assistMessages.conversationId, conversationId));
    const seq = (last?.seq ?? -1) + 1;
    const [asked, answered] = await tx
      .insert(assistMessages)
      .values([
        { id: randomUUID(), conversationId, seq, role: "user", content: question.message, createdAt: now, context: question.context },
        {
          id: randomUUID(),
          conversationId,
          seq: seq + 1,
          role: "assistant",
          content: text,
          createdAt: now,
          model,
          corpusVersion: corpus.version,
        },
      ])
      .returning();
    return { conversationId, question: toMessage(asked!), answer: toMessage(answered!) };
  });
}

/**
 * The retention of ADR-080 §6: every message older than 30 days, then every
 * conversation left without a message. A condition re-read at every pass,
 * so a missed night is caught up by the next one.
 */
export async function purgeAssist(db: Db, now: Date): Promise<{ messages: number; conversations: number }> {
  const before = new Date(now.getTime() - ASSIST_RETENTION_DAYS * 86_400_000);
  const messages = await db.delete(assistMessages).where(lt(assistMessages.createdAt, before)).returning({ id: assistMessages.id });
  const empty = db
    .select({ one: sql`1` })
    .from(assistMessages)
    .where(eq(assistMessages.conversationId, assistConversations.id));
  const conversations = await db
    .delete(assistConversations)
    .where(notExists(empty))
    .returning({ id: assistConversations.id });
  return { messages: messages.length, conversations: conversations.length };
}
