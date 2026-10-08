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

/**
 * A tool the model may call during a conversation (ADR-080 §5, amending
 * ADR-058 §1): READ-ONLY by contract — it reads the corpus in memory, or
 * the API as the asker through GET routes only (ADR-080 §8), and changes
 * nothing. `run` validates its own input and answers a text, at most about
 * 8k tokens; a refusal is a thrown error the model reads, so it can try
 * again.
 */
export interface ReadOnlyTool {
  name: string;
  description: string;
  /** The input's JSON schema, an object with `additionalProperties: false`. */
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  run(input: unknown): string | Promise<string>;
}

/** A conversation turn as stored: plain text, the model's reasoning never kept. */
export interface ConverseTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * A multi-turn request with read-only tools (ADR-080 §5). The system prompt
 * comes in two parts: `stable`, the cached prefix, then `volatile`, what
 * changes from one question to the next. `history` ends with the question.
 * At most `maxSteps` provider requests, the last of which may not call a
 * tool: one question costs at most `maxSteps` reservations.
 */
export interface ConverseRequest {
  apiKey: string;
  model: string;
  system: { stable: string; volatile: string };
  history: ConverseTurn[];
  tools: ReadOnlyTool[];
  maxTokens: number;
  maxSteps: number;
  effort?: "low" | "medium" | "high";
  /**
   * Asked after each step's tool calls ran: true makes the next request the
   * last, which may not call a tool — the teacher assistant's turn ends once
   * a write was prepared (ADR-080 P3, decision 7), so the model only says
   * what it prepared.
   */
  endAfter?: () => boolean;
}

/** One provider request of a conversation, as the gateway meters it. */
export interface ProviderStep extends LlmUsageCount {
  model: string;
}

/**
 * How a provider sends each request of a conversation: the gateway reserves
 * its worst case (`promptChars` and the request's `maxTokens`), calls
 * `send`, and settles the call with what `send` returns or throws.
 */
export type Metered = <R extends ProviderStep>(promptChars: number, send: () => Promise<R>) => Promise<R>;

export interface ConverseReply {
  /** The model's answer, Markdown. */
  text: string;
  /** The model that answered last. */
  model: string;
  /** Provider requests made. */
  steps: number;
}

export interface LlmProvider {
  readonly id: "anthropic";
  complete<T>(req: ProviderRequest<T>): Promise<ProviderReply<T>>;
  converse(req: ConverseRequest, metered: Metered): Promise<ConverseReply>;
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
