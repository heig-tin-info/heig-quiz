/**
 * The LLM gateway (ADR-058 §1): the ONE way the platform calls a model.
 *
 * `complete()` reads the settings, decrypts the key, reserves the call's
 * worst case against the day's cap, calls the provider, and settles the call
 * in `llm_calls` with its real tokens and cost — success or failure, never
 * the content. A reply that does not satisfy the schema is asked once more.
 * Every failure is an `LlmError` of the closed vocabulary. `converse()`
 * (ADR-080 §5) is the multi-turn call with read-only tools: each of its
 * provider requests goes through the same reservation and log.
 *
 * `app.llm` is chosen by `createLlm` (the llm module's entry, ADR-063 §5
 * and §9): the stub, else this gateway's grader, else none.
 */
import { llmWorstCaseUsd, modelFor, type LlmPurpose } from "@quiz/domain";

import type { Clock } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { tracked } from "../../serviceHealth.js";
import { anthropicProvider } from "./anthropic.js";
import { decryptKey } from "./crypto.js";
import {
  asLlmError,
  LlmError,
  type ConverseReply,
  type ConverseRequest,
  type LlmProvider,
  type ProviderRequest,
  type ProviderStep,
} from "./provider.js";
import { reserveCall, settingsRow, settleCall } from "./service.js";

export interface CompleteRequest<T> extends Omit<ProviderRequest<T>, "apiKey" | "model"> {
  purpose: LlmPurpose;
  /** The person the call is made for; null for a call no person made. */
  userId: string | null;
}

export interface ConverseCall extends Omit<ConverseRequest, "apiKey" | "model"> {
  purpose: LlmPurpose;
  userId: string | null;
  /** The chat's share of the day's cap (ADR-080 §4): past it, a request is refused before the cap would. */
  share?: number;
}

export interface Completion<T> {
  value: T;
  /** The model that answered. */
  model: string;
  durationMs: number;
}

/** What one provider request is reserved as. */
interface Meter {
  purpose: LlmPurpose;
  userId: string | null;
  model: string;
  capUsd: number;
  maxTokens: number;
  share?: number | undefined;
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

  /** A call can be made now: a master key, and a key stored. Whether it decrypts is the call's to say. */
  async ready(): Promise<boolean> {
    return this.enabled && (await settingsRow(this.deps.db)).keyCiphertext !== null;
  }

  private get provider(): LlmProvider {
    return this.deps.provider ?? anthropicProvider;
  }

  /** The key, the purpose's model and the cap, or the `LlmError` that says why there is no call. */
  private async credentials(purpose: LlmPurpose): Promise<{ apiKey: string; model: string; capUsd: number }> {
    if (!this.enabled) throw new LlmError("not_configured");
    const row = await settingsRow(this.deps.db);
    if (!row.keyCiphertext) throw new LlmError("not_configured");
    let apiKey: string;
    try {
      apiKey = decryptKey(this.deps.config.LLM_KEY_SECRET, row.provider, row.keyCiphertext);
    } catch {
      throw new LlmError("key_unreadable");
    }
    return { apiKey, model: modelFor(row.models, purpose), capUsd: row.dailyCapUsd };
  }

  async complete<T>(req: CompleteRequest<T>): Promise<Completion<T>> {
    const call = { ...req, ...(await this.credentials(req.purpose)) };
    try {
      return await this.once(call);
    } catch (err) {
      // One more chance for a reply the schema refused; anything else is final.
      if (err instanceof LlmError && err.code === "invalid_output") return this.once(call);
      throw err;
    }
  }

  /**
   * A conversation with read-only tools (ADR-080 §5): the provider runs its
   * loop, and EACH of its requests is reserved at its worst case, logged and
   * settled as a `complete()` call is — never its content. No retry: the
   * teacher asks again.
   */
  async converse(req: ConverseCall): Promise<ConverseReply> {
    const { purpose, userId, share, ...request } = req;
    const { apiKey, model, capUsd } = await this.credentials(purpose);
    const meter: Meter = { purpose, userId, model, capUsd, maxTokens: request.maxTokens, share };
    return this.provider.converse({ ...request, apiKey, model }, (promptChars, send) =>
      this.metered(meter, promptChars, send),
    );
  }

  private async once<T>(
    call: CompleteRequest<T> & { apiKey: string; model: string; capUsd: number },
  ): Promise<Completion<T>> {
    const { purpose, userId, capUsd, ...request } = call;
    const started = Date.now();
    const reply = await this.metered(
      { purpose, userId, model: call.model, capUsd, maxTokens: call.maxTokens },
      call.system.length + call.prompt.length,
      async () => {
        const r = await this.provider.complete(request);
        if (r.value === null) throw new LlmError("invalid_output", r);
        return r;
      },
    );
    return { value: reply.value as T, model: reply.model, durationMs: Date.now() - started };
  }

  /**
   * One provider request: its worst case reserved against the cap (and the
   * purpose's share), the request sent, the call settled with its real
   * tokens and cost — success or failure, never the content.
   */
  private async metered<R extends ProviderStep>(meter: Meter, promptChars: number, send: () => Promise<R>): Promise<R> {
    const { db, clock } = this.deps;
    const { maxTokens, ...call } = meter;
    const id = await reserveCall(db, {
      ...call,
      now: clock.now(),
      provider: this.provider.id,
      worstCaseUsd: llmWorstCaseUsd(meter.model, promptChars, maxTokens),
    });
    const started = Date.now();
    let reply: R;
    try {
      reply = await tracked("llm", send, providerAtFault);
    } catch (err) {
      const failure = asLlmError(err);
      await settleCall(db, id, {
        model: meter.model,
        durationMs: Date.now() - started,
        error: failure.code,
        ...(failure.usage ? { usage: failure.usage } : {}),
      });
      throw failure;
    }
    // Outside the `try`: a failure to record a billed reply is not a provider error.
    await settleCall(db, id, { model: reply.model, durationMs: Date.now() - started, usage: reply });
    return reply;
  }
}
