/**
 * The scope of a bearer token (ADR-113) — a pure rule (invariant 8). The
 * authentication hook resolves a token, then asks {@link scopeAdmits} whether
 * this request is within its reach; the MCP server asks {@link scopeCovers}
 * which tools to list.
 */

/**
 * The closed set, in the order the settings offer it (the default first):
 * the MCP endpoint and every tool, the MCP endpoint and its reading tools,
 * the whole `/app/api`. Their inclusion is {@link RANK}'s.
 */
export const TOKEN_SCOPES = ["quiz", "quiz:read", "api"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** `quiz:read` ⊂ `quiz` ⊂ `api`. */
const RANK: Record<TokenScope, number> = { "quiz:read": 0, quiz: 1, api: 2 };

/** `api` covers `quiz`, which covers `quiz:read`. */
export function scopeCovers(granted: TokenScope, needed: TokenScope): boolean {
  return RANK[granted] >= RANK[needed];
}

/**
 * Where a request goes, as the scope sees it: the MCP endpoint, an in-process
 * call of one of its tools (the boot-time internal secret), or any other
 * route of `/app/api`.
 */
export type ScopeTarget = "mcp" | "internal" | "elsewhere";

/** The methods that change nothing: what a `quiz:read` tool may call, and a read-only session may send. */
export const SAFE_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS"];

/**
 * Null when the scope admits the request; otherwise the narrowest scope that
 * would (the `scope` of the `insufficient_scope` answer). `quiz:read` lets
 * the MCP envelope through — a `POST`, whatever the tool — and refuses the
 * writes of the tools' own calls.
 */
export function scopeAdmits(
  scope: TokenScope,
  request: { target: ScopeTarget; method: string },
): TokenScope | null {
  if (scope === "api" || request.target === "mcp") return null;
  if (request.target === "elsewhere") return "api";
  if (scope === "quiz" || SAFE_METHODS.includes(request.method.toUpperCase())) return null;
  return "quiz";
}

/**
 * The token scope an OAuth grant gives (ADR-113 §3): the widest MCP scope its
 * space-separated `scope` names. OAuth never yields `api`; a grant naming
 * neither MCP scope yields `quiz:read`, the narrowest (none exists today: the
 * consent always grants `quiz`).
 */
export function scopeOfGrant(grantScope: string): TokenScope {
  return grantScope.split(/\s+/).includes("quiz") ? "quiz" : "quiz:read";
}
