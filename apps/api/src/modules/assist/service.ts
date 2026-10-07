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

import type { AssistContext, AssistConversation, AssistConversationSummary, AssistExchange, AssistReply } from "@quiz/contracts";
import {
  ASSIST_CAP_SHARE,
  ASSIST_HISTORY_EXCHANGES,
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
import { assistConversations, assistExchanges } from "../../db/schema.js";
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

const toExchange = (row: typeof assistExchanges.$inferSelect): AssistExchange => ({
  id: row.id,
  question: row.question,
  answer: row.answer,
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
  const exchanges = await db
    .select()
    .from(assistExchanges)
    .where(eq(assistExchanges.conversationId, row.id))
    .orderBy(asc(assistExchanges.createdAt), asc(assistExchanges.id));
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    exchanges: exchanges.map(toExchange),
  };
}

/** A user's conversations, newest first, each previewed by its first question. */
export async function listConversations(db: Db, userId: string): Promise<AssistConversationSummary[]> {
  const first = sql<string>`(select ${assistExchanges.question} from ${assistExchanges}
    where ${assistExchanges.conversationId} = ${assistConversations.id}
    order by ${assistExchanges.createdAt}, ${assistExchanges.id} limit 1)`;
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

/** The question cannot be answered: the conversation is not the asker's, or no longer exists (purged meanwhile). */
export class ConversationNotFound extends Error {}

export interface AskDeps {
  db: Db;
  gateway: LlmGateway;
  corpus: AssistCorpus;
  engine: Exclude<AssistEngine, null>;
}

/**
 * One question (ADR-080 §5): the conversation's last exchanges and the new
 * question go to the model with the stable prompt, the screen and the tool;
 * the question and its answer are stored as ONE exchange once the answer came, so
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
        .select({ question: assistExchanges.question, answer: assistExchanges.answer })
        .from(assistExchanges)
        .where(eq(assistExchanges.conversationId, existing.id))
        .orderBy(desc(assistExchanges.createdAt), desc(assistExchanges.id))
        .limit(ASSIST_HISTORY_EXCHANGES)
    : [];
  const history: ConverseTurn[] = earlier.reverse().flatMap((e): ConverseTurn[] => [
    { role: "user", text: e.question },
    { role: "assistant", text: e.answer },
  ]);
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
      // The model may have taken long enough for the purge, or another tab, to delete it.
      const touched = await tx
        .update(assistConversations)
        .set({ updatedAt: now })
        .where(eq(assistConversations.id, conversationId))
        .returning({ id: assistConversations.id });
      if (touched.length === 0) throw new ConversationNotFound();
    } else {
      await tx.insert(assistConversations).values({ id: conversationId, userId: asker.id, createdAt: now, updatedAt: now });
    }
    const [exchange] = await tx
      .insert(assistExchanges)
      .values({
        id: randomUUID(),
        conversationId,
        createdAt: now,
        question: question.message,
        answer: text,
        context: question.context,
        model,
        corpusVersion: corpus.version,
      })
      .returning();
    return { conversationId, exchange: toExchange(exchange!) };
  });
}

/**
 * The retention of ADR-080 §6: every exchange older than 30 days, then every
 * conversation left without one. A condition re-read at every pass, so a
 * missed night is caught up by the next one.
 */
export async function purgeAssist(db: Db, now: Date): Promise<{ exchanges: number; conversations: number }> {
  const before = new Date(now.getTime() - ASSIST_RETENTION_DAYS * 86_400_000);
  const exchanges = await db
    .delete(assistExchanges)
    .where(lt(assistExchanges.createdAt, before))
    .returning({ id: assistExchanges.id });
  const left = db
    .select({ one: sql`1` })
    .from(assistExchanges)
    .where(eq(assistExchanges.conversationId, assistConversations.id));
  const conversations = await db
    .delete(assistConversations)
    .where(notExists(left))
    .returning({ id: assistConversations.id });
  return { exchanges: exchanges.length, conversations: conversations.length };
}
