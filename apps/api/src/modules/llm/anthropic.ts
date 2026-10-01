/**
 * The Anthropic provider (ADR-058 §1), through the official SDK: one
 * `messages.parse` call with a structured output built from the zod schema.
 *
 * No sampling parameter: the current models refuse a non-default
 * `temperature`. A sober, reproducible answer comes from the schema and a low
 * `effort`. Errors are mapped to the closed vocabulary by their CLASS, never
 * by their message, and the SDK's error object never leaves this file: it
 * can carry the request, and the request carries the key.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ZodError } from "zod";

import { llmModel } from "@quiz/domain";

import { LlmError, type LlmProvider, type LlmUsageCount } from "./provider.js";

/** One retry of the SDK's own (a 429, a 5xx, a dropped connection), then the gateway decides. */
const MAX_RETRIES = 1;
const TIMEOUT_MS = 60_000;

function mapError(err: unknown): LlmError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError("auth_failed");
  }
  if (err instanceof Anthropic.RateLimitError) return new LlmError("rate_limited");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError("timeout");
  if (err instanceof Anthropic.APIError) return new LlmError("provider_error");
  // Not an HTTP failure: the reply came, and `parse` could not read it as
  // JSON (the SDK's own error) or the schema refused it (zod's), a reply cut
  // at `max_tokens` included. Anything else is a fault of ours.
  if (err instanceof Anthropic.AnthropicError || err instanceof ZodError) return new LlmError("invalid_output");
  return new LlmError("provider_error");
}

export const anthropicProvider: LlmProvider = {
  id: "anthropic",
  async complete(req) {
    // `logLevel: "off"`: the SDK's own logger writes to the console, outside
    // pino and its redaction, whatever ANTHROPIC_LOG says.
    const client = new Anthropic({ apiKey: req.apiKey, maxRetries: MAX_RETRIES, timeout: TIMEOUT_MS, logLevel: "off" });
    let res;
    try {
      res = await client.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: {
          format: zodOutputFormat(req.schema),
          ...(req.effort && llmModel(req.model).effort ? { effort: req.effort } : {}),
        },
      });
    } catch (err) {
      throw mapError(err);
    }
    const usage: LlmUsageCount = {
      inputTokens:
        res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
    };
    if (res.stop_reason === "refusal") throw new LlmError("refused", usage);
    return { value: res.parsed_output ?? null, model: res.model, ...usage };
  },
};
