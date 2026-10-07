/**
 * The teacher assistant's conversations (ADR-080 §6), owned by the `assist`
 * module (`modules/assist/`): no other module writes these tables.
 *
 * A conversation belongs to the teacher who asked. Each of its exchanges is
 * one question with its answer, written together once the answer came: the
 * screen it was asked on (the route PATTERN, the help topic and the UI
 * language, never an entity), the model and the corpus version that
 * answered. Kept 30 days each, deleted by the nightly `assist.purge`
 * (`ASSIST_RETENTION_DAYS`). The cost of each call is in `llm_calls`,
 * purpose `assist`, as for every other call.
 */
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
    /** The last exchange's time: the list's order. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("assist_conversations_user_idx").on(t.userId, t.updatedAt)],
);

export const assistExchanges = pgTable(
  "assist_exchanges",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistConversations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    /** The screen the question was asked on. */
    context: jsonb("context").$type<AssistContext>().notNull(),
    /** The model that answered, `development-stub` for the stub. */
    model: text("model").notNull(),
    /** The corpus that answered (`AssistCorpus.version`). */
    corpusVersion: text("corpus_version").notNull(),
  },
  (t) => [
    index("assist_exchanges_conversation_idx").on(t.conversationId, t.createdAt),
    index("assist_exchanges_created_idx").on(t.createdAt),
  ],
);
