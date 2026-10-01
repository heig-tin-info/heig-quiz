/**
 * The LLM gateway (ADR-058 §1): the ONE way the platform calls a model.
 *
 * `complete()` reads the settings, decrypts the key, reserves the call's
 * worst case against the day's cap, calls the provider, and settles the call
 * in `llm_calls` with its real tokens and cost — success or failure, never
 * the content. A reply that does not satisfy the schema is asked once more.
 * Every failure is an `LlmError` of the closed vocabulary.
 *
 * Not wired into the grading pass (ADR-058 §8): `app.llm` stays ADR-045's.
 */
import { llmWorstCaseUsd, modelFor, type LlmPurpose } from "@quiz/domain";

import type { Clock } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { tracked } from "../../serviceHealth.js";
import { anthropicProvider } from "./anthropic.js";
import { decryptKey } from "./crypto.js";
import { asLlmError, LlmError, type LlmProvider, type ProviderRequest } from "./provider.js";
import { reserveCall, settingsRow, settleCall } from "./service.js";

export interface CompleteRequest<T> extends Omit<ProviderRequest<T>, "apiKey" | "model"> {
  purpose: LlmPurpose;
  /** The person the call is made for; null for a call no person made. */
  userId: string | null;
}

export interface Completion<T> {
  value: T;
  /** The model that answered. */
  model: string;
  durationMs: number;
}

/** What the provider's own reply says about the provider: a refusal or an unreadable reply is an answer. */
const providerAtFault = (err: unknown) =>
  !(err instanceof LlmError && (err.code === "refused" || err.code === "invalid_output"));

export class LlmGateway {
  constructor(
    private readonly deps: {
      db: Db;
      clock: Clock;
      config: Pick<AppConfig, "LLM_KEY_SECRET">;
      provider?: LlmProvider;
    },
  ) {}

  /** A master key is set: the settings can be stored and a call can be made once a key is. */
  get enabled(): boolean {
    return this.deps.config.LLM_KEY_SECRET !== "";
  }

  async complete<T>(req: CompleteRequest<T>): Promise<Completion<T>> {
    if (!this.enabled) throw new LlmError("not_configured");
    const row = await settingsRow(this.deps.db);
    if (!row.keyCiphertext) throw new LlmError("not_configured");
    let apiKey: string;
    try {
      apiKey = decryptKey(this.deps.config.LLM_KEY_SECRET, row.provider, row.keyCiphertext);
    } catch {
      throw new LlmError("key_unreadable");
    }
    const call = { ...req, apiKey, model: modelFor(row.models, req.purpose), capUsd: row.dailyCapUsd };
    try {
      return await this.once(call);
    } catch (err) {
      // One more chance for a reply the schema refused; anything else is final.
      if (err instanceof LlmError && err.code === "invalid_output") return this.once(call);
      throw err;
    }
  }

  private async once<T>(
    call: CompleteRequest<T> & { apiKey: string; model: string; capUsd: number },
  ): Promise<Completion<T>> {
    const { db, clock } = this.deps;
    const provider = this.deps.provider ?? anthropicProvider;
    const { purpose, userId, capUsd, ...request } = call;
    const id = await reserveCall(db, {
      now: clock.now(),
      userId,
      purpose,
      provider: provider.id,
      model: call.model,
      worstCaseUsd: llmWorstCaseUsd(call.model, call.system.length + call.prompt.length, call.maxTokens),
      capUsd,
    });
    const started = Date.now();
    let reply;
    try {
      reply = await tracked("llm", () => provider.complete(request), providerAtFault);
      if (reply.value === null) throw new LlmError("invalid_output", reply);
    } catch (err) {
      const failure = asLlmError(err);
      await settleCall(db, id, {
        model: call.model,
        durationMs: Date.now() - started,
        error: failure.code,
        ...(failure.usage ? { usage: failure.usage } : {}),
      });
      throw failure;
    }
    // Outside the `try`: a failure to record a billed reply is not a provider error.
    const durationMs = Date.now() - started;
    await settleCall(db, id, { model: reply.model, durationMs, usage: reply });
    return { value: reply.value, model: reply.model, durationMs };
  }
}
