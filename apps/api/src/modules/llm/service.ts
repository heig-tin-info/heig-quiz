/**
 * The `llm` module's service (ADR-058): the settings row, the call log and
 * the daily cap (`./ledger.ts`, which the gateway reads too). The one entry
 * other modules import; the gateway (`./gateway.ts`) is how they call a
 * model. Two services on the Fastify instance:
 *
 *  - `app.llm`, the GRADING service (ADR-045, ADR-063): at most one
 *    `GradingLlm`, selected once, at boot. `LLM_PROVIDER=stub` is the
 *    deterministic provider of development (`./stub.ts`), which `config.ts`
 *    refuses in production; otherwise the real model through the gateway
 *    (`./grader.ts`) whenever the gateway is on. `ready()` says whether a
 *    call can be made at all: the gateway holds a key.
 *  - `app.llmGateway`, the GATEWAY of ADR-058 (`./gateway.ts`): a real model,
 *    called with the institutional key an administrator stored, logged and
 *    capped. Off without `LLM_KEY_SECRET`.
 */
import { eq } from "drizzle-orm";

import type { LlmErrorCode, LlmSettings, LlmSettingsPatch } from "@quiz/contracts";
import type { LlmGradeOutcome, LlmGradeRequest } from "@quiz/core/server";
import { DEFAULT_LLM_MODEL, LLM_MODEL_IDS, type LlmModelId } from "@quiz/domain";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { llmSettings } from "../../db/schema.js";
import { tracked } from "../../serviceHealth.js";
import type { FailureArms } from "../http.js";
import { decryptKey, encryptKey } from "./crypto.js";
import type { LlmGateway } from "./gateway.js";
import { gatewayGrader } from "./grader.js";
import { settingsRow, todayBudget, type SettingsRow } from "./ledger.js";
import { LlmError } from "./provider.js";
import { StubLlm } from "./stub.js";

export { LlmError, type ConverseTurn, type ReadOnlyTool } from "./provider.js";
export { LlmGateway, type CompleteRequest, type Completion } from "./gateway.js";
export { STUB_MODEL } from "./stub.js";
export { monthUsage, settingsRow, spentToday, startOfDay, todayBudget } from "./ledger.js";

export interface GradingLlm {
  /** Whether a call can be made now; the grading pass offers the service only then. */
  ready(): Promise<boolean>;
  /** `billedTo` is the person the call is logged against (`llm_calls`, F-LLM-04), never sent to the model. */
  grade(req: LlmGradeRequest, billedTo: string | null): Promise<LlmGradeOutcome>;
}

/**
 * The stub when `LLM_PROVIDER=stub`, else the gateway's grader when there is
 * a gateway that is on. The seed passes none: it never calls a real model.
 */
export function createLlm(config: Pick<AppConfig, "LLM_PROVIDER">, gateway: LlmGateway | null): GradingLlm | null {
  if (config.LLM_PROVIDER === "stub") {
    const stub = new StubLlm();
    // Every call recorded for the services' status (ADR-055 §6); the gateway records its own.
    return { ready: () => Promise.resolve(true), grade: (req) => tracked("llm", () => stub.grade(req)) };
  }
  return gateway?.enabled ? gatewayGrader(gateway) : null;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Null without a provider: nothing is ever sent to a model. */
    llm: GradingLlm | null;
    /** The gateway of ADR-058; `enabled` is false without a master key. */
    llmGateway: LlmGateway;
  }
}

/**
 * How a failed model call answers a screen (the wand, ADR-059; Review now,
 * ADR-060; the assistant, ADR-080): the gateway's code, worded by the client,
 * as a route's failure arm (`{ error, reason }`, no message).
 */
const LLM_FAILURES: Partial<Record<LlmErrorCode, [number, string]>> = {
  not_configured: [409, "llm_not_configured"],
  key_unreadable: [409, "llm_not_configured"],
  budget_exhausted: [429, "llm_budget_exhausted"],
  rate_limited: [429, "rate_limited"],
};
export const llmArms: FailureArms = (reply, error) => {
  if (!(error instanceof LlmError)) return null;
  const [status, code] = LLM_FAILURES[error.code] ?? [502, "llm_failed"];
  return reply.code(status).send({ error: code, reason: error.code });
};

type Secret = Pick<AppConfig, "LLM_KEY_SECRET">;

/** The one model of the screen: the default of every purpose, kept only while it is on the list. */
function screenModel(row: SettingsRow): LlmModelId {
  const model = row.models.default ?? DEFAULT_LLM_MODEL;
  return (LLM_MODEL_IDS as readonly string[]).includes(model) ? (model as LlmModelId) : DEFAULT_LLM_MODEL;
}

/** Whether the stored key decrypts under the current master key. */
function readable(config: Secret, row: SettingsRow): boolean {
  if (!row.keyCiphertext || config.LLM_KEY_SECRET === "") return false;
  try {
    decryptKey(config.LLM_KEY_SECRET, row.provider, row.keyCiphertext);
    return true;
  } catch {
    return false;
  }
}

export async function readSettings(
  db: Db,
  config: Pick<AppConfig, "LLM_KEY_SECRET" | "LLM_DAILY_CAP_MAX_USD">,
  now: Date,
): Promise<LlmSettings> {
  const [row, budget] = await Promise.all([settingsRow(db), todayBudget(db, now)]);
  return {
    enabled: config.LLM_KEY_SECRET !== "",
    provider: "anthropic",
    keyLast4: row.keyCiphertext ? row.keyLast4 : null,
    keyReadable: readable(config, row),
    model: screenModel(row),
    dailyCapUsd: row.dailyCapUsd,
    dailyCapMaxUsd: config.LLM_DAILY_CAP_MAX_USD,
    spentTodayUsd: budget.spentUsd,
    updatedAt: row.updatedBy ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Writes what the patch carries. The key is encrypted here and only its last
 * four characters are kept in clear; the model is written for EVERY purpose
 * (one model in the screen, ADR-058 §2). The caller has checked the cap
 * against the ceiling and that the gateway is enabled.
 */
export async function writeSettings(
  db: Db,
  config: Secret,
  patch: LlmSettingsPatch,
  actorId: string,
  now: Date,
): Promise<void> {
  const { provider } = await settingsRow(db);
  const key =
    patch.apiKey === undefined
      ? {}
      : patch.apiKey === null
        ? { keyCiphertext: null, keyLast4: null }
        : { keyCiphertext: encryptKey(config.LLM_KEY_SECRET, provider, patch.apiKey), keyLast4: patch.apiKey.slice(-4) };
  await db
    .update(llmSettings)
    .set({
      ...key,
      ...(patch.model ? { models: { default: patch.model } } : {}),
      ...(patch.dailyCapUsd !== undefined ? { dailyCapUsd: patch.dailyCapUsd } : {}),
      updatedBy: actorId,
      updatedAt: now,
    })
    .where(eq(llmSettings.id, "default"));
}
