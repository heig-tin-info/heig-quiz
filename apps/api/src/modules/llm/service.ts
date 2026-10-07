/**
 * The `llm` module's service (ADR-058): the settings row, the call log and
 * the daily cap. The one entry other modules import; the gateway
 * (`./gateway.ts`) is how they call a model.
 */
import { randomUUID } from "node:crypto";

import { and, eq, gte, isNull, sql, sum } from "drizzle-orm";

import type { LlmErrorCode, LlmSettings, LlmSettingsPatch, LlmUsage } from "@quiz/contracts";
import {
  DEFAULT_LLM_MODEL,
  LLM_MODEL_IDS,
  llmCostUsd,
  SCHOOL_TIME_ZONE,
  shareAllows,
  type LlmModelId,
  type LlmPurpose,
} from "@quiz/domain";

import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { llmCalls, llmSettings, users } from "../../db/schema.js";
import { decryptKey, encryptKey } from "./crypto.js";
import { LlmError, type LlmUsageCount } from "./provider.js";

export { LlmError, type ConverseTurn, type ReadOnlyTool } from "./provider.js";
export { LlmGateway, type CompleteRequest, type Completion, type ConverseCall } from "./gateway.js";
export { STUB_MODEL } from "./stub.js";

/**
 * How a failed model call answers a screen (the wand, ADR-059; Review now,
 * ADR-060; the assistant, ADR-080): the gateway's code, worded by the client.
 */
const LLM_FAILURES: Partial<Record<LlmErrorCode, [number, string]>> = {
  not_configured: [409, "llm_not_configured"],
  key_unreadable: [409, "llm_not_configured"],
  budget_exhausted: [429, "llm_budget_exhausted"],
  rate_limited: [429, "rate_limited"],
};
export const llmFailure = (error: LlmError): { status: number; body: { error: string; reason: string } } => {
  const [status, code] = LLM_FAILURES[error.code] ?? [502, "llm_failed"];
  return { status, body: { error: code, reason: error.code } };
};

type SettingsRow = typeof llmSettings.$inferSelect;
type Secret = Pick<AppConfig, "LLM_KEY_SECRET">;

/** The one settings row, which the migration inserts (ADR-058 §2). */
export async function settingsRow(db: Db): Promise<SettingsRow> {
  const [row] = await db.select().from(llmSettings).where(eq(llmSettings.id, "default")).limit(1);
  if (!row) throw new Error("llm_settings: the 'default' row is missing (migration 0052)");
  return row;
}

/** Midnight, Europe/Zurich, of the day (or the month) `now` falls in. */
const startOf = (unit: "day" | "month", now: Date) =>
  sql`date_trunc(${unit}, ${now.toISOString()}::timestamptz, ${SCHOOL_TIME_ZONE})`;

/** Midnight, Europe/Zurich, of the day `now` falls in, as an SQL expression of the database. */
export const startOfDay = (now: Date) => startOf("day", now);

/**
 * Today's estimated spend, calls in flight included at their worst case.
 * `purpose` narrows it to one purpose, and `unattributed` to its calls made
 * by no person: the night's review counts its own share so (ADR-060 §5),
 * the assistant its own, every teacher's together (ADR-080 §4).
 */
export async function spentToday(
  db: Db | Tx,
  now: Date,
  only?: { purpose: LlmPurpose; unattributed?: boolean },
): Promise<number> {
  const [row] = await db
    .select({ total: sum(llmCalls.costUsd) })
    .from(llmCalls)
    .where(
      and(
        gte(llmCalls.createdAt, startOf("day", now)),
        ...(only ? [eq(llmCalls.purpose, only.purpose)] : []),
        ...(only?.unattributed ? [isNull(llmCalls.userId)] : []),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * Today against the cap: what was spent (calls in flight at their worst
 * case), the cap, and whether the cap already refused a call today — what the
 * settings screen and the `llm.budget` check read (ADR-058 §7).
 */
export async function todayBudget(db: Db, now: Date): Promise<{ spentUsd: number; capUsd: number; refused: boolean }> {
  const [row] = await db
    .select({
      spent: sum(llmCalls.costUsd),
      refused: sql<boolean>`bool_or(${llmCalls.error} = 'budget_exhausted')`,
    })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, startOf("day", now)));
  const { dailyCapUsd } = await settingsRow(db);
  return { spentUsd: Number(row?.spent ?? 0), capUsd: dailyCapUsd, refused: row?.refused ?? false };
}

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

// --- The call log and the cap (ADR-058 §4, §5) ---------------------------

/**
 * Reserves a call against the day's cap: under a transaction-scoped lock,
 * today's total plus this call's worst case must stay within the cap, and
 * the call is inserted `pending` at that worst case. Two parallel calls
 * therefore cannot both slip under the cap. Otherwise `budget_exhausted` is
 * thrown and nothing reaches the provider; the day's first refusal is logged.
 *
 * `share`, the chat's share of the cap (ADR-080 §4, `shareAllows`), is
 * checked first: its refusal is
 * the same `budget_exhausted` but writes nothing — the cap itself was not
 * reached, so the `llm.budget` check stays green.
 */
export async function reserveCall(
  db: Db,
  call: {
    now: Date;
    userId: string | null;
    purpose: LlmPurpose;
    provider: string;
    model: string;
    worstCaseUsd: number;
    capUsd: number;
    share?: number | undefined;
  },
): Promise<string> {
  const row = {
    id: randomUUID(),
    createdAt: call.now,
    userId: call.userId,
    purpose: call.purpose,
    provider: call.provider,
    model: call.model,
  };
  const reserved = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('llm-budget', 0))`);
    const spentTotalUsd = await spentToday(tx, call.now);
    if (
      call.share !== undefined &&
      !shareAllows(
        {
          spentTotalUsd,
          spentPurposeUsd: await spentToday(tx, call.now, { purpose: call.purpose }),
          worstCaseUsd: call.worstCaseUsd,
          capUsd: call.capUsd,
        },
        call.share,
      )
    ) {
      return false;
    }
    if (spentTotalUsd + call.worstCaseUsd <= call.capUsd) {
      await tx.insert(llmCalls).values({ ...row, status: "pending", costUsd: call.worstCaseUsd });
      return true;
    }
    // The day's FIRST refusal is recorded, at no cost, so that the check turns
    // red; a loop past the cap writes nothing more.
    const [already] = await tx
      .select({ id: llmCalls.id })
      .from(llmCalls)
      .where(and(gte(llmCalls.createdAt, startOf("day", call.now)), eq(llmCalls.error, "budget_exhausted")))
      .limit(1);
    if (!already) await tx.insert(llmCalls).values({ ...row, status: "error", error: "budget_exhausted", costUsd: 0 });
    return false;
  });
  if (!reserved) throw new LlmError("budget_exhausted");
  return row.id;
}

/**
 * The call's outcome. With the provider's token counts, the real cost
 * replaces the reservation; without them, a reply that came and could not be
 * read (`invalid_output`) keeps its worst case — it was billed, by an unknown
 * amount — and any other failure, which the provider does not bill, costs 0.
 */
export async function settleCall(
  db: Db,
  id: string,
  outcome: { model: string; durationMs: number; usage?: LlmUsageCount; error?: LlmErrorCode },
): Promise<void> {
  const cost = outcome.usage
    ? { costUsd: llmCostUsd(outcome.model, outcome.usage.inputTokens, outcome.usage.outputTokens) }
    : outcome.error === "invalid_output"
      ? {}
      : { costUsd: 0 };
  await db
    .update(llmCalls)
    .set({
      status: outcome.error ? "error" : "ok",
      error: outcome.error ?? null,
      model: outcome.model,
      durationMs: outcome.durationMs,
      ...(outcome.usage ? { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens } : {}),
      ...cost,
    })
    .where(eq(llmCalls.id, id));
}

/** The current month's calls, per person and in total (ADR-058 §9). */
export async function monthUsage(db: Db, now: Date): Promise<LlmUsage> {
  const since = startOf("month", now);
  const counts = {
    calls: sql<number>`count(*)::int`,
    errors: sql<number>`count(*) filter (where ${llmCalls.status} = 'error')::int`,
    inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)::int`,
    outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::int`,
    costUsd: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)`,
  };
  const [rows, [start]] = await Promise.all([
    db
      .select({
        userId: llmCalls.userId,
        givenName: users.givenName,
        familyName: users.familyName,
        email: users.email,
        ...counts,
      })
      .from(llmCalls)
      .leftJoin(users, eq(users.id, llmCalls.userId))
      .where(gte(llmCalls.createdAt, since))
      .groupBy(llmCalls.userId, users.givenName, users.familyName, users.email)
      .orderBy(sql`sum(${llmCalls.costUsd}) desc`),
    db.execute(sql`select ${since} as since`).then((r) => (r as unknown as { rows: { since: Date | string }[] }).rows),
  ]);
  const usage = rows.map((r) => ({ ...r, costUsd: Number(r.costUsd) }));
  const total = usage.reduce(
    (t, r) => ({
      calls: t.calls + r.calls,
      errors: t.errors + r.errors,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      costUsd: t.costUsd + r.costUsd,
    }),
    { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  return { since: new Date(start!.since).toISOString(), rows: usage, total };
}

