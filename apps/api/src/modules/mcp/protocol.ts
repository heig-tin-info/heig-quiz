/**
 * The Model Context Protocol, server side, for the one transport and the one
 * capability this platform offers (ADR-022): Streamable HTTP answered in plain
 * JSON (no SSE stream, no session id — every POST stands alone), and `tools`.
 *
 * Hand-written rather than taken from the SDK: what is needed is four
 * methods of JSON-RPC, and the SDK's transport wants to own the HTTP
 * response, which Fastify already does. The whole protocol surface is here.
 */
import { z } from "zod";

import { MCP_PROTOCOL_VERSIONS, McpMessage, McpToolCall, type JsonRpcId } from "@quiz/contracts";

import { ApiError, ToolRefusal, toolByName, toolDescriptors, type Api } from "./tools.js";

/** JSON-RPC 2.0 error codes. */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export const SERVER_INFO = { name: "heig-quiz", title: "HEIG-VD Quiz", version: "0.1.0" } as const;

/**
 * Read by the model once, at the handshake: the domain in six sentences, so
 * that it does not have to discover by failing that an evaluation only takes
 * published questions from a pool linked to its course.
 */
export const INSTRUCTIONS = [
  "This server authors content on the HEIG-VD quiz platform, as the teacher who created the token.",
  "Model: a course has classrooms (one class of students for a period) and is linked to question pools.",
  "Questions live in pools. A question must be PUBLISHED to be used; create_question publishes by default.",
  "An evaluation (exam or exercise) belongs to a classroom and may only use questions of pools linked to that classroom's course: call link_pool_to_course first.",
  "Before writing a question, call describe_question_types with its type and follow the schema and rules exactly.",
  "Look before creating: list_courses, get_course and list_pools, so nothing is created twice. Evaluations are created as drafts; the teacher opens them from the web app. Give the teacher the returned `url` links.",
].join(" ");

export interface RpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (id: JsonRpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: JsonRpcId | null, code: number, message: string, data?: unknown): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

/** A tool's answer: its result as JSON text, or the refusal the model can act on. */
function toolResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], isError };
}

async function callTool(api: Api, params: unknown, log: (err: unknown) => void) {
  const call = McpToolCall.safeParse(params ?? {});
  if (!call.success) return { error: "Invalid tools/call params" };
  const tool = toolByName.get(call.data.name);
  if (!tool) return { error: `Unknown tool: ${call.data.name}` };
  const args = tool.input.safeParse(call.data.arguments);
  if (!args.success) {
    return {
      result: toolResult({
        error: "invalid_arguments",
        issues: args.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      }, true),
    };
  }
  try {
    return { result: toolResult(await tool.run(api, args.data)) };
  } catch (error) {
    if (error instanceof ApiError) {
      // 404 is also "you may not reach it" (invariant 6): say both.
      const hint = error.status === 404 ? "Not found, or not accessible to this teacher." : undefined;
      return { result: toolResult({ error: "refused", status: error.status, body: error.body, hint }, true) };
    }
    if (error instanceof ToolRefusal) {
      return { result: toolResult({ error: error.message, details: error.details }, true) };
    }
    log(error);
    return { result: toolResult({ error: "internal_error" }, true) };
  }
}

/**
 * One JSON-RPC message in, at most one response out (null for a notification
 * or a response the client sent us, which need no answer).
 */
export async function handleMessage(
  raw: unknown,
  api: Api,
  log: (err: unknown) => void,
): Promise<RpcResponse | null> {
  const parsed = McpMessage.safeParse(raw);
  if (!parsed.success) {
    // A client's response to a server request, which this server never sends.
    if (z.object({ jsonrpc: z.literal("2.0"), id: z.unknown() }).safeParse(raw).success && !("method" in (raw as object))) {
      return null;
    }
    return fail(null, RPC.invalidRequest, "Invalid JSON-RPC message");
  }
  const { id, method, params } = parsed.data;
  if (id === undefined) return null;

  switch (method) {
    case "initialize": {
      const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : MCP_PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: toolDescriptors() });
    case "tools/call": {
      const outcome = await callTool(api, params, log);
      if ("error" in outcome) return fail(id, RPC.invalidParams, outcome.error!);
      return ok(id, outcome.result);
    }
    default:
      return fail(id, RPC.methodNotFound, `Method not found: ${method}`);
  }
}
