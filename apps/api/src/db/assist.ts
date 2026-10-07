/**
 * The teacher assistant's conversations (ADR-080 §6), owned by the `assist`
 * module (`modules/assist/`): no other module writes these tables.
 *
 * A conversation belongs to the teacher who asked; its messages are what
 * was typed and what the model answered, kept 30 days each and deleted by
 * the nightly `assist.purge` (`ASSIST_RETENTION_DAYS`). A message records
 * the screen it was asked on (the route PATTERN, the help topic and the UI
 * language, never an entity) and, for an answer, the model and the corpus
 * version that produced it. The cost of each call is in `llm_calls`, purpose
 * `assist`, as for every other call.
 */
import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import type { AssistContext } from "@quiz/contracts";

import { users } from "./auth.js";

export const assistConversations = pgTable(
  "assist_conversations",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** The last message's time: the list's order. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("assist_conversations_user_idx").on(t.userId, t.updatedAt)],
);

export const assistMessages = pgTable(
  "assist_messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistConversations.id, { onDelete: "cascade" }),
    /** The order in the conversation, from 0. */
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** A question's screen; null on an answer. */
    context: jsonb("context").$type<AssistContext>(),
    /** An answer's model, `development-stub` for the stub's; null on a question. */
    model: text("model"),
    /** An answer's corpus (`AssistCorpus.version`); null on a question. */
    corpusVersion: text("corpus_version"),
  },
  (t) => [unique("assist_messages_seq_unique").on(t.conversationId, t.seq), index("assist_messages_created_idx").on(t.createdAt)],
);
