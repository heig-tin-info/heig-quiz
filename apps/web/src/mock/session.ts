/**
 * Section 1a — the session: who this browser is, and the public config the
 * shell reads before anything else.
 */
import type {
  ApiToken,
  ApiTokenCreated,
  Me,
  OAuthConnection,
  OAuthRequestView,
  PublicConfig,
} from "@quiz/contracts";
import {
  D,
  H,
  MockError,
  flags,
  iso,
  nextId,
  on,
  role,
} from "./runtime";

// --- Session ---

export let me: Me | null = {
  id: "u-me",
  email: role === "student" ? "lea.rochat@heig-vd.ch" : `${role}@heig-vd.ch`,
  givenName: role === "student" ? "Léa" : role === "admin" ? "Admin" : "Prof",
  familyName: role === "student" ? "Rochat" : "Démo",
  role,
  lastLoginAt: iso(-3 * H),
  avatarUrl: null,
  hasUploadedAvatar: false,
  locale: null,
  dateFormat: null,
  mcqPolicy: null,
};

/**
 * The one way another section changes the session: `?as=guest` on the poll
 * page signs this browser out (section 6). An ES module cannot assign to an
 * imported binding, so the write stays here and the read stays live.
 */
export const setMe = (next: Me | null) => {
  me = next;
};

on("GET", "/app/api/config", (): PublicConfig => ({ devLogin: true }));

on("GET", "/app/api/me", () => {
  if (!me) throw new MockError(401, "Signed out");
  return me;
});
on("PATCH", "/app/api/me", (_m, body) => {
  if (me) me = { ...me, ...(body as Partial<Me>) };
  return me;
});
on("PUT", "/app/api/me/avatar", () => undefined);
on("DELETE", "/app/api/me/avatar", () => undefined);
// --- Personal API tokens (ADR-022) ---

const tokens: ApiToken[] = flags.empty
  ? []
  : [
      {
        id: "t-claude",
        name: "Claude Desktop",
        prefix: "quiz_pat_Xk3v9Q",
        createdAt: iso(-12 * D),
        lastUsedAt: iso(-2 * H),
        expiresAt: iso(78 * D),
        revokedAt: null,
      },
      {
        id: "t-script",
        name: "Import script",
        prefix: "quiz_pat_b7TzR2",
        createdAt: iso(-120 * D),
        lastUsedAt: null,
        expiresAt: iso(-30 * D),
        revokedAt: null,
      },
    ];

on("GET", "/app/api/me/tokens", () => tokens);
on("POST", "/app/api/me/tokens", (_m, body): ApiTokenCreated => {
  const days = body.expiresInDays as number | null;
  const secret = `quiz_pat_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const token: ApiToken = {
    id: nextId("t-"),
    name: String(body.name),
    prefix: secret.slice(0, 15),
    createdAt: iso(0),
    lastUsedAt: null,
    expiresAt: days === null ? null : iso(days * D),
    revokedAt: null,
  };
  tokens.unshift(token);
  return { ...token, token: secret };
});
on("DELETE", "/app/api/me/tokens/:id", (m) => {
  const token = tokens.find((t) => t.id === m.groups!.id);
  if (!token) throw new MockError(404, "Not found");
  token.revokedAt = iso(0);
  return token;
});

// --- OAuth: connected assistants and the consent page (ADR-023) ---

const connections: OAuthConnection[] = flags.empty
  ? []
  : [
      {
        id: "0190d3c4-0000-7000-8000-00000000c1a0",
        clientName: "Claude",
        redirectHost: "claude.ai",
        createdAt: iso(-5 * D),
        lastUsedAt: iso(-1 * H),
      },
    ];

on("GET", "/app/api/me/connections", () => connections);
on("DELETE", "/app/api/me/connections/:id", (m) => {
  const i = connections.findIndex((c) => c.id === m.groups!.id);
  if (i < 0) throw new MockError(404, "Not found");
  connections.splice(i, 1);
  return undefined;
});
// Any id opens the same request; `/oauth/authorize/<id>?loopback=1` shows the
// desktop-client variant with its warning.
on("GET", "/app/api/oauth/requests/:id", (m, _b, url): OAuthRequestView => {
  const loopback = url.searchParams.get("loopback") === "1" || window.location.search.includes("loopback=1");
  return {
    id: m.groups!.id!,
    clientName: loopback ? "Claude Code" : "Claude",
    clientUri: null,
    redirectHost: loopback ? "localhost:39152" : "claude.ai",
    loopback,
    expiresAt: iso(10 * 60_000),
  };
});
on("POST", "/app/api/oauth/requests/:id/decision", () => ({ redirectTo: "/settings" }));

on("POST", "/app/auth/logout", () => {
  me = null;
  return undefined;
});
