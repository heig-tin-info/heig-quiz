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
import type { FastifyBaseLogger } from "fastify";

import { AI_KEY, JUSTIFICATION_KEY, type LlmErrorCode, type LlmSettings, type LlmSettingsPatch } from "@quiz/contracts";
import type { LlmConfidence, LlmCriterion, LlmGradeOutcome, LlmGradeRequest } from "@quiz/core/server";
import { DEFAULT_LLM_MODEL, LLM_MODEL_IDS, round2, scaleCriteria, type LlmModelId, type LlmPurpose } from "@quiz/domain";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { llmSettings } from "../../db/schema.js";
import { tracked } from "../../serviceHealth.js";
import type { FailureArms } from "../http.js";
import { decryptKey, encryptKey } from "./crypto.js";
import type { LlmGateway } from "./gateway.js";
import { gatewayGrader } from "./grader.js";
import { settingsRow, todayBudget, type SettingsRow } from "./ledger.js";
import { stubProjectReview, type ProjectReviewOutcome, type ProjectReviewRequest } from "./projectReviewer.js";
import { LlmError } from "./provider.js";
import { STUB_MODEL, StubLlm } from "./stub.js";

export { LlmError, type ConverseTurn, type ReadOnlyTool } from "./provider.js";
export { type ProjectReviewCriterion, type ProjectReviewOutcome, type ProjectReviewRequest } from "./projectReviewer.js";
export { LlmGateway, type CompleteRequest, type Completion } from "./gateway.js";
export { STUB_MODEL } from "./stub.js";
export { monthUsage, settingsRow, spentToday, startOfDay, todayBudget } from "./ledger.js";

/**
 * The reason a failed model call leaves on what it was to grade (ADR-063
 * §2): the day's budget, no usable key, anything else. One rule for the
 * grading pass and a project's (ADR-106 §4).
 */
export function llmFailure(err: unknown): "llm_budget" | "llm_not_configured" | "grader_error" {
  if (!(err instanceof LlmError)) return "grader_error";
  if (err.code === "budget_exhausted") return "llm_budget";
  if (err.code === "not_configured" || err.code === "key_unreadable") return "llm_not_configured";
  return "grader_error";
}

/**
 * What a grading call is logged as: the pass's `grade` (exempt from the
 * person's share, bounded by the students' answers), or the editor's `try`
 * (ADR-063, amendment of 2026-10-23), the same prompt within the teacher's
 * own share.
 */
export type GradePurpose = Extract<LlmPurpose, "grade" | "try">;

export interface GradingLlm {
  /** Whether a call can be made now; the grading pass offers the service only then. */
  ready(): Promise<boolean>;
  /** `billedTo` is the person the call is logged against (`llm_calls`, F-LLM-04), never sent to the model. */
  grade(req: LlmGradeRequest, billedTo: string | null, purpose: GradePurpose): Promise<LlmGradeOutcome>;
  /** A project's pass for one repository (ADR-106 §4): `req` masked by the caller, `billedTo` the project's creator. */
  reviewProject(req: ProjectReviewRequest, billedTo: string | null): Promise<ProjectReviewOutcome>;
}

/**
 * The stub when `LLM_PROVIDER=stub`, else the gateway's grader when there is
 * a gateway that is on. The seed passes none: it never calls a real model.
 */
export function createLlm(config: Pick<AppConfig, "LLM_PROVIDER">, gateway: LlmGateway | null): GradingLlm | null {
  if (config.LLM_PROVIDER === "stub") {
    const stub = new StubLlm();
    // Every call recorded for the services' status (ADR-055 §6); the gateway records its own.
    return {
      ready: () => Promise.resolve(true),
      grade: (req) => tracked("llm", () => stub.grade(req)),
      reviewProject: (req) => tracked("llm", () => Promise.resolve(stubProjectReview(req, STUB_MODEL))),
    };
  }
  return gateway?.enabled ? gatewayGrader(gateway) : null;
}

/**
 * The model's points and breakdown on the item's scale, the two in
 * agreement (ADR-118). Structured criteria come back in weight units and are
 * scaled by the domain's rule, keyed by the request's ids. A free rubric's
 * breakdown is the model's own: when its maxima do not add up to the item's
 * points, points and maxima are rescaled in proportion, and the total is
 * their sum; the clamp to `[0, maxPoints]` stays the last guard.
 */
export function onItemScale(request: LlmGradeRequest, outcome: LlmGradeOutcome): { points: number; criteria: LlmCriterion[] } {
  const max = request.maxPoints;
  const clampTotal = (x: number) => round2(Math.min(max, Math.max(0, x)));
  if (request.criteria !== undefined && request.criteria.length > 0) {
    const replied = new Map(outcome.criteria.map((c) => [c.id, c]));
    const scaled = scaleCriteria(
      request.criteria.map((c) => ({ id: c.id, weight: c.weight, earned: replied.get(c.id)?.points ?? 0 })),
      max,
    );
    return {
      points: scaled.total,
      criteria: request.criteria.map((c, i) => ({
        id: c.id,
        criterion: c.title,
        points: scaled.criteria[i]!.points,
        maxPoints: scaled.criteria[i]!.maxPoints,
        comment: replied.get(c.id)?.comment ?? "",
      })),
    };
  }
  const sum = outcome.criteria.reduce((s, c) => s + Math.max(0, c.maxPoints), 0);
  if (outcome.criteria.length === 0 || sum <= 0 || Math.abs(sum - max) < 0.005) {
    return { points: clampTotal(outcome.points), criteria: outcome.criteria };
  }
  const k = max / sum;
  const criteria = outcome.criteria.map((c) => {
    const cap = Math.max(0, c.maxPoints);
    return { ...c, points: round2(Math.min(cap, Math.max(0, c.points)) * k), maxPoints: round2(cap * k) };
  });
  const earned = outcome.criteria.reduce((s, c) => s + Math.min(Math.max(0, c.maxPoints), Math.max(0, c.points)), 0);
  return { points: clampTotal(earned * k), criteria };
}

/**
 * What a model's grading leaves for the teacher (ADR-063 §4), the one
 * shape for the grading pass and the editor's Try. On a reply: the points
 * on the item's scale, in agreement with the breakdown ({@link onItemScale}), the type's own details completed with the
 * justification and the rest of the reply (`details.ai`) — both
 * teacher-only, stripped from every student payload — and the confidence.
 * On a failed call (§2), or with no service at all: a proposal of 0 whose
 * details and comment carry the reason, never a throw; `grader_error` is
 * logged with `context`.
 */
export async function askGrader(
  llm: GradingLlm | null,
  request: LlmGradeRequest,
  call: { billedTo: string | null; purpose: GradePurpose; own: unknown; log: FastifyBaseLogger; context: object },
): Promise<{ points: number; details: Record<string, unknown>; confidence?: LlmConfidence; comment?: string }> {
  if (!llm) return { points: 0, details: { reason: "llm_not_configured" }, comment: "llm_not_configured" };
  try {
    const outcome = await llm.grade(request, call.billedTo, call.purpose);
    const own = call.own && typeof call.own === "object" && !Array.isArray(call.own) ? call.own : {};
    const { points, criteria } = onItemScale(request, outcome);
    return {
      points,
      details: {
        ...own,
        [JUSTIFICATION_KEY]: outcome.justification,
        [AI_KEY]: { model: outcome.model, criteria },
      },
      confidence: outcome.confidence,
    };
  } catch (err) {
    const reason = llmFailure(err);
    if (reason === "grader_error") call.log.error({ err, ...call.context }, "grading: llm call failed");
    return { points: 0, details: { reason }, comment: reason };
  }
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
/** A held-down wand, not a quota (ADR-059): the gateway's daily cap is the ceiling. */
export const LLM_CALLS_PER_MINUTE = 10;

/** A model's text, or a label sent to one, as one line of at most `max` characters. */
export const oneLine = (text: string, max: number): string => text.trim().replace(/\s+/g, " ").slice(0, max);

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
