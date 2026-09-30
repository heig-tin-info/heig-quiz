import type { OidcClaims } from "../auth/oidc.js";

/**
 * The claims of a login as `auth/oidc.ts` hands them over, from the raw
 * userinfo: the login address is `raw.email`, everything else empty.
 */
export function oidcClaims(
  sub: string,
  raw: Record<string, unknown>,
  emailVerified: boolean,
  complete = true,
): OidcClaims {
  return {
    sub,
    email: typeof raw.email === "string" ? raw.email : "",
    emailVerified,
    givenName: "",
    familyName: "",
    swissEduId: null,
    picture: null,
    raw,
    complete,
  };
}
