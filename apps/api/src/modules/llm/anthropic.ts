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

import { LlmError, type LlmProvider, type LlmUsageCount, type ReadOnlyTool } from "./provider.js";

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

// `logLevel: "off"`: the SDK's own logger writes to the console, outside
// pino and its redaction, whatever ANTHROPIC_LOG says.
const clientFor = (apiKey: string) =>
  new Anthropic({ apiKey, maxRetries: MAX_RETRIES, timeout: TIMEOUT_MS, logLevel: "off" });

/** What a request is billed, cache writes and reads counted as input, as the cost estimate wants. */
const usageOf = (usage: Anthropic.Usage): LlmUsageCount => ({
  inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
  outputTokens: usage.output_tokens,
});

/**
 * A tool's answer to one call; an unknown tool — any name outside the
 * request's own list — or a refused input is an error the model reads.
 */
async function runTool(tools: readonly ReadOnlyTool[], call: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
  const tool = tools.find((t) => t.name === call.name);
  try {
    if (!tool) throw new Error(`No tool named ${call.name}.`);
    return { type: "tool_result", tool_use_id: call.id, content: await tool.run(call.input) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "The tool failed.";
    return { type: "tool_result", tool_use_id: call.id, content: message, is_error: true };
  }
}

export const anthropicProvider: LlmProvider = {
  id: "anthropic",
  async complete(req) {
    const client = clientFor(req.apiKey);
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
    const usage = usageOf(res.usage);
    if (res.stop_reason === "refusal") throw new LlmError("refused", usage);
    return { value: res.parsed_output ?? null, model: res.model, ...usage };
  },

  /**
   * The conversation loop of ADR-080 §5: the stable system prompt and the
   * tools cached, the conversation's growth cached by the top-level marker,
   * the model's thinking blocks sent back unchanged within the question and
   * never kept beyond it. The last allowed request cannot call a tool, so a
   * question is answered within `maxSteps` requests or fails.
   */
  async converse(req, metered) {
    const client = clientFor(req.apiKey);
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: req.system.stable, cache_control: { type: "ephemeral" } },
      { type: "text", text: req.system.volatile },
    ];
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    const messages: Anthropic.MessageParam[] = req.history.map((t) => ({ role: t.role, content: t.text }));
    const fixedChars = req.system.stable.length + req.system.volatile.length + JSON.stringify(tools).length;
    for (let step = 1; ; step++) {
      const last = step >= req.maxSteps;
      const { message, model } = await metered(fixedChars + JSON.stringify(messages).length, async () => {
        let res: Anthropic.Message;
        try {
          res = await client.messages.create({
            model: req.model,
            max_tokens: req.maxTokens,
            system,
            tools,
            tool_choice: last ? { type: "none" } : { type: "auto" },
            messages,
            cache_control: { type: "ephemeral" },
            ...(req.effort && llmModel(req.model).effort ? { output_config: { effort: req.effort } } : {}),
          });
        } catch (err) {
          throw mapError(err);
        }
        const usage = usageOf(res.usage);
        if (res.stop_reason === "refusal") throw new LlmError("refused", usage);
        return { ...usage, model: res.model, message: res };
      });
      const calls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (last || message.stop_reason !== "tool_use" || calls.length === 0) {
        const text = message.content
          .flatMap((b) => (b.type === "text" ? [b.text] : []))
          .join("\n\n")
          .trim();
        if (text === "") throw new LlmError("invalid_output");
        return { text, model, steps: step };
      }
      messages.push({ role: "assistant", content: message.content });
      // Every result of the turn's calls in ONE user message, in the calls' order.
      messages.push({ role: "user", content: await Promise.all(calls.map((call) => runTool(req.tools, call))) });
    }
  },
};
