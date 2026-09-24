/**
 * The OAuth 2.1 authorization server in front of the MCP endpoint (ADR-023).
 *
 * The wire names are the RFCs' own (snake_case): `/authorize` and `/token`
 * are RFC 6749 + PKCE (RFC 7636) + resource indicators (RFC 8707), `/register`
 * is RFC 7591. Only the consent page's two calls are ours (camelCase).
 */
import { z } from "zod";

/** The one scope this server grants: author on the teacher's behalf through MCP. */
export const OAUTH_SCOPE = "quiz";
export const OAUTH_SCOPES_SUPPORTED = [OAUTH_SCOPE, "offline_access"] as const;

/** RFC 7636 §4.1: 43 to 128 characters of the unreserved set. */
const Pkce = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

/** `GET /app/oauth/authorize` */
export const AuthorizeQuery = z.object({
  response_type: z.string(),
  client_id: z.string().min(1).max(2000),
  redirect_uri: z.string().min(1).max(2000),
  code_challenge: Pkce.optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().max(1000).optional(),
  state: z.string().max(2000).optional(),
  resource: z.string().max(2000).optional(),
});
export type AuthorizeQuery = z.infer<typeof AuthorizeQuery>;

/** `POST /app/oauth/token`, form-encoded. */
export const TokenRequest = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1).max(200),
    redirect_uri: z.string().min(1).max(2000),
    code_verifier: Pkce,
    client_id: z.string().min(1).max(2000).optional(),
    resource: z.string().max(2000).optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1).max(200),
    client_id: z.string().min(1).max(2000).optional(),
    scope: z.string().max(1000).optional(),
    resource: z.string().max(2000).optional(),
  }),
]);
export type TokenRequest = z.infer<typeof TokenRequest>;

/** `POST /app/oauth/register` (RFC 7591 §2); unknown members are ignored. */
export const ClientRegistration = z.object({
  redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(10),
  client_name: z.string().trim().max(200).optional(),
  client_uri: z.string().max(2000).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().max(1000).optional(),
});
export type ClientRegistration = z.infer<typeof ClientRegistration>;

/** A Client ID Metadata Document, as fetched from the client's `client_id` URL. */
export const ClientMetadataDocument = z.object({
  client_id: z.string(),
  client_name: z.string().trim().max(200).optional(),
  client_uri: z.string().max(2000).optional(),
  redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(20),
});
export type ClientMetadataDocument = z.infer<typeof ClientMetadataDocument>;

// --- The consent page (the SPA) --------------------------------------------

/** `GET /app/api/oauth/requests/:id`: what the teacher is asked to allow. */
export const OAuthRequestView = z.object({
  id: z.uuid(),
  clientName: z.string(),
  clientUri: z.string().nullable(),
  /** Where the answer goes, shown as a host: the phishing tell. */
  redirectHost: z.string(),
  /** Every registered redirect is on this machine (a desktop client, or a stranger on it). */
  loopback: z.boolean(),
  expiresAt: z.iso.datetime(),
});
export type OAuthRequestView = z.infer<typeof OAuthRequestView>;

/** `POST /app/api/oauth/requests/:id/decision` */
export const OAuthDecision = z.object({ approve: z.boolean() });
export type OAuthDecision = z.infer<typeof OAuthDecision>;

export const OAuthDecisionResult = z.object({ redirectTo: z.string() });
export type OAuthDecisionResult = z.infer<typeof OAuthDecisionResult>;

/** `GET /app/api/me/connections`: the assistants the teacher let in. */
export const OAuthConnection = z.object({
  id: z.uuid(),
  clientName: z.string(),
  redirectHost: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type OAuthConnection = z.infer<typeof OAuthConnection>;
