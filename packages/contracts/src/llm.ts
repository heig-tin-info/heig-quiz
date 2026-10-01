import { z } from "zod";

import { LLM_MODEL_IDS } from "@quiz/domain";

/**
 * The LLM gateway's administration (ADR-058): the settings, the connection
 * test and the usage, all under `/app/api/admin/llm`, administrators only.
 */

/** Why a call failed, a closed vocabulary (ADR-058 §1): the `error` of `llm_calls` and of the test. */
export const LLM_ERROR_CODES = [
  "not_configured",
  "key_unreadable",
  "budget_exhausted",
  "auth_failed",
  "rate_limited",
  "refused",
  "invalid_output",
  "timeout",
  "provider_error",
] as const;
export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number];

/** `GET /app/api/admin/llm`. The key itself never leaves the server: only its last four characters. */
export const LlmSettings = z.object({
  /** `LLM_KEY_SECRET` is set: without it nothing can be stored nor called. */
  enabled: z.boolean(),
  provider: z.literal("anthropic"),
  /** The stored key's last four characters, or null without a key. */
  keyLast4: z.string().nullable(),
  /** False when a key is stored but the master key cannot decrypt it: enter it again. */
  keyReadable: z.boolean(),
  /** The one model of the screen, written for every purpose. */
  model: z.enum(LLM_MODEL_IDS),
  dailyCapUsd: z.number(),
  /** `LLM_DAILY_CAP_MAX_USD`: the most the screen may set. */
  dailyCapMaxUsd: z.number(),
  /** Today's estimated spend (Europe/Zurich), calls in flight included at their worst case. */
  spentTodayUsd: z.number(),
  updatedAt: z.iso.datetime().nullable(),
});
export type LlmSettings = z.infer<typeof LlmSettings>;

/**
 * `PATCH /app/api/admin/llm`. `apiKey` replaces the key, `null` removes it;
 * the model is written for every purpose; the cap is checked against
 * `LLM_DAILY_CAP_MAX_USD` by the server.
 */
export const LlmSettingsPatch = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(20)
      .max(400)
      .regex(/^\S+$/)
      .nullable()
      .optional(),
    model: z.enum(LLM_MODEL_IDS).optional(),
    dailyCapUsd: z.number().min(1).max(100_000).optional(),
  })
  .strict();
export type LlmSettingsPatch = z.infer<typeof LlmSettingsPatch>;

/** `POST /app/api/admin/llm/test`: the capital of France, asked of the configured model. */
export const LlmTestResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), model: z.string(), latencyMs: z.number() }),
  z.object({ ok: z.literal(false), model: z.string().nullable(), error: z.enum(LLM_ERROR_CODES) }),
]);
export type LlmTestResult = z.infer<typeof LlmTestResult>;

const UsageCounts = z.object({
  calls: z.number().int(),
  errors: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
});

/**
 * `GET /app/api/admin/llm/usage`: the current month (Europe/Zurich), per
 * person and in total. A row with no user is the calls no person made.
 */
export const LlmUsage = z.object({
  since: z.iso.datetime(),
  rows: z.array(
    UsageCounts.extend({
      userId: z.string().nullable(),
      givenName: z.string().nullable(),
      familyName: z.string().nullable(),
      email: z.string().nullable(),
    }),
  ),
  total: UsageCounts,
});
export type LlmUsage = z.infer<typeof LlmUsage>;

// --- "Generate answers" (ADR-059) -------------------------------------------

/**
 * `GET /app/api/generate/availability`, a teacher's: whether the wand can work
 * now (a master key and a stored key), and the types that have one.
 */
export const LlmAvailability = z.object({
  available: z.boolean(),
  types: z.array(z.string()),
});
export type LlmAvailability = z.infer<typeof LlmAvailability>;

/**
 * `POST /app/api/questions/:id/generate`: the editor's draft as it stands,
 * saved or not, and the element to fill when the wand is one element's (an
 * MCQ choice). The question's type is the server's, never the client's.
 */
export const GenerateRequest = z
  .object({
    config: z.unknown(),
    explanation: z.string().max(20_000),
    item: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type GenerateRequest = z.infer<typeof GenerateRequest>;

/** The draft with the proposal merged in: what the editor sets, and what Undo reverts. */
export const GenerateResult = z.object({
  config: z.unknown(),
  explanation: z.string(),
});
export type GenerateResult = z.infer<typeof GenerateResult>;
