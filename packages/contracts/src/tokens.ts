/**
 * Personal API tokens (docs/08 §8.3, ADR-022): the bearer credential of a
 * script or an MCP client, minted by a teacher in the settings.
 *
 * The plaintext secret travels exactly once, in the `ApiTokenCreated` answer
 * to the creation; afterwards the list only carries its `prefix`.
 */
import { z } from "zod";

/** Every token starts with this, so a leaked one is recognisable by a secret scanner. */
export const API_TOKEN_PREFIX = "quiz_pat_";

/** The lifetimes the settings offer; `null` never expires. */
export const API_TOKEN_TTL_DAYS = [30, 90, 365] as const;

export const ApiTokenCreate = z.object({
  /** What the teacher calls it: "Claude Desktop", "laptop script". */
  name: z.string().trim().min(1).max(100),
  expiresInDays: z
    .union([z.literal(30), z.literal(90), z.literal(365), z.null()])
    .default(90),
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
});
export type ApiToken = z.infer<typeof ApiToken>;

/** The one answer that carries the secret. */
export const ApiTokenCreated = ApiToken.extend({ token: z.string() });
export type ApiTokenCreated = z.infer<typeof ApiTokenCreated>;
