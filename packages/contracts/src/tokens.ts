/**
 * Personal API tokens (docs/08 §8.3, ADR-022): the bearer credential of a
 * script or an MCP client, minted by a teacher in the settings.
 *
 * The plaintext secret travels exactly once, in the `ApiTokenCreated` answer
 * to the creation; afterwards the list only carries its `prefix`.
 */
import { z } from "zod";

import { CONTESTATIONS_CONSENT, MCP_CONSENT_REVISION, TOKEN_SCOPES, type TokenScope as DomainTokenScope } from "@quiz/domain";

import type { UserRole } from "./admin.js";

/** Every token starts with this, so a leaked one is recognisable by a secret scanner. */
export const API_TOKEN_PREFIX = "quiz_pat_";

/**
 * The lifetimes the settings offer; `null` never expires, unless
 * {@link tokenMustExpire} says otherwise.
 */
export const API_TOKEN_TTL_DAYS = [30, 90, 365] as const;

/**
 * What a personal token reaches (ADR-113; the set is `@quiz/domain`'s):
 * chosen at the creation, never edited. The database's CHECK is built from
 * the same list.
 */
export { TOKEN_SCOPES };
export const TokenScope = z.enum(TOKEN_SCOPES);
export type TokenScope = DomainTokenScope;

/**
 * The revision of the consent a token or an OAuth grant was made under
 * (ADR-139 §14; `@quiz/domain`'s): the current one is
 * {@link MCP_CONSENT_REVISION}, and what a reach needs (students'
 * contestations: {@link CONTESTATIONS_CONSENT}) is refused below it, `403
 * consent_required`, until the teacher consents again — a new token, or the
 * assistant reconnected.
 */
export { CONTESTATIONS_CONSENT, MCP_CONSENT_REVISION };
export const ConsentRevision = z.number().int().positive();

/**
 * A token that may not be endless (`token_expiry_required`): an
 * administrator's, which must expire to reach the administration routes
 * (audit L6), and one with the whole API (ADR-113 §1).
 */
export function tokenMustExpire(role: UserRole, scope: TokenScope): boolean {
  return role === "admin" || scope === "api";
}

export const ApiTokenCreate = z.object({
  /** What the teacher calls it: "Claude Desktop", "laptop script". */
  name: z.string().trim().min(1).max(100),
  expiresInDays: z.literal(API_TOKEN_TTL_DAYS).nullable().default(90),
  /** The product's default: the MCP endpoint, read and write. */
  scope: TokenScope.default("quiz"),
  /** The consent revision the form showed (ADR-139 §14); absent, an old form: 1. Never recorded above the current one. */
  consentRevision: ConsentRevision.optional(),
});
export type ApiTokenCreate = z.infer<typeof ApiTokenCreate>;

export const ApiToken = z.object({
  id: z.uuid(),
  name: z.string(),
  /** `quiz_pat_AbCd…`: enough to recognise it, never enough to use it. */
  prefix: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  scope: TokenScope,
  /** The consent it was made under: below {@link CONTESTATIONS_CONSENT}, it reads no contestation (a new token does). */
  consentRevision: ConsentRevision,
});
export type ApiToken = z.infer<typeof ApiToken>;

/** The one answer that carries the secret. */
export const ApiTokenCreated = ApiToken.extend({ token: z.string() });
export type ApiTokenCreated = z.infer<typeof ApiTokenCreated>;
