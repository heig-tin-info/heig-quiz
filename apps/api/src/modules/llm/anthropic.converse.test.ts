/**
 * The Anthropic provider's conversation loop (ADR-080 §5), with the SDK's
 * `messages.create` replaced: the bound on the requests of one question,
 * the tool results sent back, the cached system prefix, and every request
 * metered by the gateway's hook.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic extends actual.default {
    constructor(opts: ConstructorParameters<typeof actual.default>[0]) {
      super(opts);
      (this as unknown as { messages: unknown }).messages = { create };
    }
  }
  return { ...actual, default: FakeAnthropic };
});

const { anthropicProvider } = await import("./anthropic.js");
const { LlmError } = await import("./provider.js");
type Req = import("./provider.js").ConverseRequest;

const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 };
const toolTurn = (id: string) => ({
  model: "claude-sonnet-5-5",
  stop_reason: "tool_use",
  usage,
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "tool_use", id, name: "read_guide", input: { page: "guide/pools" } },
  ],
});
const textTurn = (text: string, stop = "end_turn") => ({
  model: "claude-sonnet-5-5",
  stop_reason: stop,
  usage,
  content: [{ type: "text", text }],
});

const request = (overrides: Partial<Req> = {}): Req => ({
  apiKey: "sk-ant-test",
  model: "claude-sonnet-5-5",
  system: { stable: "RULES AND INDEX", volatile: "SCREEN" },
  history: [{ role: "user", text: "Comment partager ?" }],
  tools: [
    {
      name: "read_guide",
      description: "Reads a page.",
      inputSchema: { type: "object", properties: { page: { type: "string" } }, required: ["page"], additionalProperties: false },
      run: (input) => `page ${(input as { page: string }).page}`,
    },
  ],
  maxTokens: 1000,
  maxSteps: 4,
  effort: "low",
  ...overrides,
});

/** The gateway's hook, counting the requests and their reserved prompt sizes. */
const meter = () => {
  const sizes: number[] = [];
  const metered = (async (chars: number, send: () => Promise<unknown>) => {
    sizes.push(chars);
    return send();
  }) as import("./provider.js").Metered;
  return { sizes, metered };
};

beforeEach(() => create.mockReset());

describe("anthropicProvider.converse", () => {
  it("runs the tool and answers, sending the thinking back within the question", async () => {
    create.mockResolvedValueOnce(toolTurn("t1")).mockResolvedValueOnce(textTurn("Clique sur **Partager**."));
    const { sizes, metered } = meter();
    const reply = await anthropicProvider.converse(request(), metered);
    expect(reply).toEqual({ text: "Clique sur **Partager**.", model: "claude-sonnet-5-5", steps: 2 });
    expect(sizes).toHaveLength(2);
    const second = create.mock.calls[1]![0];
    expect(second.messages[1]).toMatchObject({ role: "assistant" });
    expect(second.messages[1].content[0]).toMatchObject({ type: "thinking", signature: "sig" });
    expect(second.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "page guide/pools" }],
    });
    // The stable prefix is cached, the screen after it is not; the conversation's growth is.
    expect(second.system).toEqual([
      { type: "text", text: "RULES AND INDEX", cache_control: { type: "ephemeral" } },
      { type: "text", text: "SCREEN" },
    ]);
    expect(second.cache_control).toEqual({ type: "ephemeral" });
    expect(second.output_config).toEqual({ effort: "low" });
  });

  it("stops at maxSteps: the last request may not call a tool", async () => {
    create
      .mockResolvedValueOnce(toolTurn("t1"))
      .mockResolvedValueOnce(toolTurn("t2"))
      .mockResolvedValueOnce(textTurn("Voici ce que dit le guide."))
      .mockResolvedValueOnce(toolTurn("never asked"));
    const { sizes, metered } = meter();
    const reply = await anthropicProvider.converse(request({ maxSteps: 3 }), metered);
    expect(reply.steps).toBe(3);
    expect(sizes).toHaveLength(3);
    expect(create.mock.calls.map((c) => c[0].tool_choice.type)).toEqual(["auto", "auto", "none"]);
  });

  it("answers an unknown tool and a failing one with an error the model reads", async () => {
    create
      .mockResolvedValueOnce({ ...toolTurn("t1"), content: [{ type: "tool_use", id: "t1", name: "write_pool", input: {} }] })
      .mockResolvedValueOnce(textTurn("Je ne peux que lire."));
    const failing = request();
    failing.tools[0]!.run = () => {
      throw new Error("bad input");
    };
    await anthropicProvider.converse(request(), meter().metered);
    expect(create.mock.calls[1]![0].messages[2].content[0]).toMatchObject({ is_error: true, content: "No tool named write_pool." });
    create.mockReset();
    create.mockResolvedValueOnce(toolTurn("t2")).mockResolvedValueOnce(textTurn("ok"));
    await anthropicProvider.converse(failing, meter().metered);
    expect(create.mock.calls[1]![0].messages[2].content[0]).toMatchObject({ is_error: true, content: "bad input" });
  });

  it("awaits asynchronous tools and returns every result of a turn in one message, in order", async () => {
    create
      .mockResolvedValueOnce({
        ...toolTurn("t1"),
        content: [
          { type: "tool_use", id: "slow", name: "read_guide", input: { page: "slow" } },
          { type: "tool_use", id: "fast", name: "read_guide", input: { page: "fast" } },
        ],
      })
      .mockResolvedValueOnce(textTurn("ok"));
    const delayed = request();
    delayed.tools[0]!.run = async (input) => {
      const { page } = input as { page: string };
      await new Promise((resolve) => setTimeout(resolve, page === "slow" ? 20 : 0));
      return `page ${page}`;
    };
    await anthropicProvider.converse(delayed, meter().metered);
    expect(create.mock.calls[1]![0].messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "slow", content: "page slow" },
        { type: "tool_result", tool_use_id: "fast", content: "page fast" },
      ],
    });
  });

  it("maps a refusal and an empty answer to the gateway's vocabulary", async () => {
    create.mockResolvedValueOnce(textTurn("", "refusal"));
    await expect(anthropicProvider.converse(request(), meter().metered)).rejects.toMatchObject({ code: "refused" });
    create.mockResolvedValueOnce(textTurn("   "));
    await expect(anthropicProvider.converse(request(), meter().metered)).rejects.toBeInstanceOf(LlmError);
  });

  it("sends no effort to a model that takes none", async () => {
    create.mockResolvedValueOnce(textTurn("ok"));
    await anthropicProvider.converse(request({ model: "claude-haiku-4-5" }), meter().metered);
    expect(create.mock.calls[0]![0].output_config).toBeUndefined();
  });
});
