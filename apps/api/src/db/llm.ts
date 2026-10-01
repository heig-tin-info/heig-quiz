/**
 * The LLM gateway (ADR-058), owned by the `llm` module (`modules/llm/`): no
 * other module writes these tables.
 *
 * `llm_settings` holds ONE row (`id = 'default'`): the provider, its key
 * ENCRYPTED under `LLM_KEY_SECRET` (AES-256-GCM, `modules/llm/crypto.ts`) —
 * never the key itself — the model per purpose and the daily cap.
 *
 * `llm_calls` records every call, never its content (F-LLM-04): who it was
 * made for, why, which model, the tokens and the estimated cost. A call is
 * inserted `pending` at its WORST-case cost before it is made, under a lock,
 * which is how the daily cap holds against parallel calls (ADR-058 §5), and
 * gets its real numbers after.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { LLM_ERROR_CODES } from "@quiz/contracts";
import { LLM_PURPOSES, type LlmPurpose } from "@quiz/domain";

import { users } from "./auth.js";
import { bytea } from "./columns.js";

export const llmSettings = pgTable(
  "llm_settings",
  {
    id: text("id").primaryKey().default("default"),
    provider: text("provider", { enum: ["anthropic"] }).notNull().default("anthropic"),
    /** nonce (12 bytes) ‖ tag (16 bytes) ‖ ciphertext; null without a key. */
    keyCiphertext: bytea("key_ciphertext"),
    /** The key's last four characters, what the screen shows. */
    keyLast4: text("key_last4"),
    /** `{ purpose → model id }`, `default` for every purpose without its own. */
    models: jsonb("models").$type<Partial<Record<LlmPurpose | "default", string>>>().notNull().default({}),
    dailyCapUsd: numeric("daily_cap_usd", { precision: 10, scale: 2, mode: "number" }).notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("llm_settings_singleton", sql`${t.id} = 'default'`)],
);

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** The person the call was made for; null for a call no person made (a nightly batch). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    purpose: text("purpose", { enum: LLM_PURPOSES }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: text("status", { enum: ["pending", "ok", "error"] }).notNull(),
    error: text("error", { enum: LLM_ERROR_CODES }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Estimated, in USD: the worst case while `pending`, the real tokens' price after. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull(),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("llm_calls_created_at_idx").on(t.createdAt)],
);
