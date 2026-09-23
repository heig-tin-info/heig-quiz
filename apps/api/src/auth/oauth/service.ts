/**
 * The OAuth 2.1 authorization server (ADR-023): authorization requests, the
 * teacher's consent, the code exchange and the refresh — every secret stored
 * as its SHA-256 only, like a session (AU-06).
 *
 *   request   10 minutes to be answered on the consent page
 *   code      60 seconds, one use, bound to the client, the redirect URI,
 *             the PKCE challenge (S256) and the resource
 *   access    1 hour, an `api_tokens` row bound to the MCP endpoint
 *   refresh   90 days from its last use, rotated on every use
 */
import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";

import { OAUTH_SCOPE, OAUTH_SCOPES_SUPPORTED, type OAuthConnection, type OAuthRequestView } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { apiTokens, oauthClients, oauthGrants, oauthRequests } from "../../db/schema.js";
import { hashToken, newToken } from "../session.js";
import { isLoopback, type OAuthClient } from "./clients.js";

const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 90 * 86_400_000;

export const ACCESS_PREFIX = "quiz_oat_";
const REFRESH_PREFIX = "quiz_ort_";

/** An RFC 6749 §5.2 error: the token endpoint answers `400 { error, error_description }`. */
export class OAuthError extends Error {
  constructor(
    readonly error: "invalid_request" | "invalid_grant" | "invalid_client" | "invalid_target" | "unsupported_grant_type",
    readonly description: string,
  ) {
    super(description);
  }
}

/** The MCP endpoint (`modules/mcp/routes.ts`): the resource every OAuth token is bound to. */
export const MCP_PATH = "/app/api/mcp";
export const mcpResource = (issuer: string) => `${issuer}${MCP_PATH}`;

/** RFC 8707 resources compared the tolerant way: case of scheme and host, trailing slash. */
export function sameResource(a: string, b: string): boolean {
  const norm = (raw: string) => {
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
    } catch {
      return raw;
    }
  };
  return norm(a) === norm(b);
}

/** The scope granted: what was asked for among what exists, `quiz` at least. */
export function grantedScope(requested: string | undefined): string {
  const asked = (requested ?? "").split(/\s+/).filter((s) => (OAUTH_SCOPES_SUPPORTED as readonly string[]).includes(s));
  return [...new Set([OAUTH_SCOPE, ...asked])].join(" ");
}

const hostOf = (uri: string) => {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
};

/** Appends the response parameters (and RFC 9207's `iss`) to a redirect URI. */
function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.href;
}

export async function createRequest(
  db: Db,
  input: {
    client: OAuthClient;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    resource: string;
    state: string | null;
    now: Date;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(oauthRequests).values({
    id,
    clientId: input.client.id,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scope: input.scope,
    resource: input.resource,
    state: input.state,
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + REQUEST_TTL_MS),
  });
  return id;
}

/** A request still waiting for its answer, with its client. */
async function pendingRequest(db: Db, id: string, now: Date) {
  const [row] = await db
    .select({ request: oauthRequests, client: oauthClients })
    .from(oauthRequests)
    .innerJoin(oauthClients, eq(oauthRequests.clientId, oauthClients.id))
    .where(
      and(
        eq(oauthRequests.id, id),
        isNull(oauthRequests.approvedAt),
        isNull(oauthRequests.usedAt),
        gt(oauthRequests.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function requestView(db: Db, id: string, now: Date): Promise<OAuthRequestView | null> {
  const row = await pendingRequest(db, id, now);
  if (!row) return null;
  return {
    id: row.request.id,
    clientName: row.client.name,
    clientUri: row.client.clientUri,
    redirectHost: hostOf(row.request.redirectUri),
    loopback: row.client.redirectUris.every(isLoopback),
    expiresAt: row.request.expiresAt.toISOString(),
  };
}

/**
 * The teacher's answer. Approval mints the code; refusal consumes the
 * request. Either way the answer is the URL the browser goes to next.
 */
export async function decide(
  db: Db,
  input: { id: string; userId: string; approve: boolean; issuer: string; now: Date },
): Promise<{ redirectTo: string; clientId: string } | null> {
  const row = await pendingRequest(db, input.id, input.now);
  if (!row) return null;
  const { request } = row;
  if (!input.approve) {
    await db.update(oauthRequests).set({ usedAt: input.now }).where(eq(oauthRequests.id, request.id));
    return {
      clientId: request.clientId,
      redirectTo: redirectWith(request.redirectUri, {
        error: "access_denied",
        state: request.state,
        iss: input.issuer,
      }),
    };
  }
  const code = newToken();
  const [updated] = await db
    .update(oauthRequests)
    .set({
      userId: input.userId,
      codeHash: hashToken(code),
      approvedAt: input.now,
      expiresAt: new Date(input.now.getTime() + CODE_TTL_MS),
    })
    .where(and(eq(oauthRequests.id, request.id), isNull(oauthRequests.approvedAt)))
    .returning({ id: oauthRequests.id });
  if (!updated) return null;
  return {
    clientId: request.clientId,
    redirectTo: redirectWith(request.redirectUri, { code, state: request.state, iss: input.issuer }),
  };
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueAccess(db: Db, grant: typeof oauthGrants.$inferSelect, clientName: string, now: Date) {
  const token = `${ACCESS_PREFIX}${newToken()}`;
  await db.insert(apiTokens).values({
    id: randomUUID(),
    userId: grant.userId,
    name: clientName,
    tokenHash: hashToken(token),
    prefix: token.slice(0, ACCESS_PREFIX.length + 6),
    createdAt: now,
    expiresAt: new Date(now.getTime() + ACCESS_TTL_S * 1000),
    grantId: grant.id,
    audience: grant.resource,
  });
  return token;
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export async function exchangeCode(
  db: Db,
  input: { code: string; redirectUri: string; verifier: string; clientId: string | undefined; resource: string | undefined; now: Date },
): Promise<TokenResponse> {
  // Consumed FIRST, atomically: a code is worth one exchange, whatever follows.
  const [request] = await db
    .update(oauthRequests)
    .set({ usedAt: input.now })
    .where(and(eq(oauthRequests.codeHash, hashToken(input.code)), isNull(oauthRequests.usedAt)))
    .returning();
  if (!request || !request.userId) throw new OAuthError("invalid_grant", "Unknown or already used code");
  if (request.expiresAt.getTime() <= input.now.getTime()) throw new OAuthError("invalid_grant", "Expired code");
  if (input.clientId === undefined || input.clientId !== request.clientId) {
    throw new OAuthError("invalid_grant", "The code was issued to another client");
  }
  if (input.redirectUri !== request.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
  if (s256(input.verifier) !== request.codeChallenge) throw new OAuthError("invalid_grant", "PKCE verification failed");
  if (input.resource !== undefined && !sameResource(input.resource, request.resource)) {
    throw new OAuthError("invalid_target", "The code was issued for another resource");
  }
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, request.clientId));
  const refresh = `${REFRESH_PREFIX}${newToken()}`;
  const [grant] = await db
    .insert(oauthGrants)
    .values({
      id: randomUUID(),
      userId: request.userId,
      clientId: request.clientId,
      scope: request.scope,
      resource: request.resource,
      refreshHash: hashToken(refresh),
      createdAt: input.now,
      lastUsedAt: input.now,
      expiresAt: new Date(input.now.getTime() + REFRESH_TTL_MS),
    })
    .returning();
  const access = await issueAccess(db, grant!, client?.name ?? "MCP client", input.now);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: grant!.scope };
}

/**
 * A refresh: the presented token is swapped for a new one in the same
 * statement that invalidates it (rotation, OAuth 2.1 §4.3.1). The one before
 * it is remembered so a replay is recognised: `invalid_grant`, like any other
 * dead refresh token, which is the code clients react to.
 */
export async function refresh(
  db: Db,
  input: { refreshToken: string; clientId: string | undefined; resource: string | undefined; now: Date },
): Promise<TokenResponse> {
  const presented = hashToken(input.refreshToken);
  const next = `${REFRESH_PREFIX}${newToken()}`;
  const [grant] = await db
    .update(oauthGrants)
    .set({
      refreshHash: hashToken(next),
      previousRefreshHash: presented,
      lastUsedAt: input.now,
      expiresAt: new Date(input.now.getTime() + REFRESH_TTL_MS),
    })
    .where(
      and(
        eq(oauthGrants.refreshHash, presented),
        isNull(oauthGrants.revokedAt),
        gt(oauthGrants.expiresAt, input.now),
        ...(input.clientId === undefined ? [] : [eq(oauthGrants.clientId, input.clientId)]),
      ),
    )
    .returning();
  if (!grant) throw new OAuthError("invalid_grant", "Unknown, expired or revoked refresh token");
  if (input.resource !== undefined && !sameResource(input.resource, grant.resource)) {
    throw new OAuthError("invalid_target", "The grant is for another resource");
  }
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, grant.clientId));
  const access = await issueAccess(db, grant, client?.name ?? "MCP client", input.now);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: next, scope: grant.scope };
}

// --- The teacher's list of connected assistants ----------------------------

export async function listConnections(db: Db, userId: string, now: Date): Promise<OAuthConnection[]> {
  const rows = await db
    .select({ grant: oauthGrants, client: oauthClients })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
    .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt), gt(oauthGrants.expiresAt, now)))
    .orderBy(desc(oauthGrants.createdAt));
  return rows.map(({ grant, client }) => ({
    id: grant.id,
    clientName: client.name,
    redirectHost: hostOf(client.redirectUris[0] ?? ""),
    createdAt: grant.createdAt.toISOString(),
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
  }));
}

/** Revokes a grant and every access token issued under it, at once. */
export async function revokeConnection(db: Db, userId: string, grantId: string, now: Date) {
  const [grant] = await db
    .update(oauthGrants)
    .set({ revokedAt: now })
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
    .returning();
  if (!grant) return null;
  await db
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(and(eq(apiTokens.grantId, grant.id), isNull(apiTokens.revokedAt)));
  return grant;
}

/**
 * The ticker's sweep: answered or abandoned requests, access tokens a day
 * past their hour, grants dead for a month, and self-registered clients that
 * never got a grant (DCR registers a client per connection attempt).
 */
export async function purgeOAuth(db: Db, now: Date) {
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  await db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, hourAgo));
  await db.delete(apiTokens).where(and(isNotNull(apiTokens.grantId), lt(apiTokens.expiresAt, dayAgo)));
  await db
    .delete(oauthGrants)
    .where(or(lt(oauthGrants.expiresAt, monthAgo), lt(oauthGrants.revokedAt, monthAgo)));
  const orphans = await db
    .select({ id: oauthClients.id })
    .from(oauthClients)
    .leftJoin(oauthGrants, eq(oauthGrants.clientId, oauthClients.id))
    .where(and(eq(oauthClients.kind, "dcr"), lt(oauthClients.createdAt, dayAgo), isNull(oauthGrants.id)));
  for (const { id } of orphans) await db.delete(oauthClients).where(eq(oauthClients.id, id));
}
