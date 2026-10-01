/**
 * A model provider behind the gateway (ADR-058 §1). The gateway owns the
 * key, the cap and the log; a provider only turns one request into one
 * structured reply, or into an `LlmError` of the closed vocabulary. The only
 * provider is Anthropic (`./anthropic.ts`); another one is another object of
 * this shape.
 */
import type { z } from "zod";

import type { LlmErrorCode } from "@quiz/contracts";

export interface LlmUsageCount {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderRequest<T> {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  /** The reply must satisfy it; a reply that does not comes back as `value: null`. */
  schema: z.ZodType<T>;
  maxTokens: number;
  /** How much the model thinks; dropped for a model that takes no effort. */
  effort?: "low" | "medium" | "high";
}

export interface ProviderReply<T> extends LlmUsageCount {
  /** The parsed reply, or null when the model's output did not satisfy the schema. */
  value: T | null;
  /** The model that answered, as the provider names it. */
  model: string;
}

export interface LlmProvider {
  readonly id: "anthropic";
  complete<T>(req: ProviderRequest<T>): Promise<ProviderReply<T>>;
}

/**
 * A failed call, by its code only: never the provider's message, which may
 * quote the request (and a header of it). `usage` is what the provider billed
 * before failing — a refusal is billed.
 */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    readonly usage?: LlmUsageCount,
  ) {
    super(`llm: ${code}`);
    this.name = "LlmError";
  }
}

export const asLlmError = (err: unknown): LlmError =>
  err instanceof LlmError ? err : new LlmError("provider_error");
