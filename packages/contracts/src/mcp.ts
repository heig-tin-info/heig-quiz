/**
 * The MCP endpoint (`POST /app/api/mcp`, ADR-022): JSON-RPC 2.0 messages of
 * the Model Context Protocol, Streamable HTTP transport, JSON responses.
 *
 * Only the ENVELOPE is validated here. The arguments of a `tools/call` are
 * validated by the tool's own schema, and then again by the route it
 * forwards to — the same contracts the web app sends against.
 */
import { z } from "zod";

export const JsonRpcId = z.union([z.string(), z.number().int()]);
export type JsonRpcId = z.infer<typeof JsonRpcId>;

/** A request (with `id`) or a notification (without). */
export const McpMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId.optional(),
  method: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type McpMessage = z.infer<typeof McpMessage>;

/** `tools/call` params. */
export const McpToolCall = z.object({
  name: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type McpToolCall = z.infer<typeof McpToolCall>;

/** The protocol revisions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
