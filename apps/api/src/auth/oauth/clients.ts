/**
 * OAuth clients (ADR-023): who is asking for a token, and where the answer
 * may be sent.
 *
 * Two ways to be a client, both public (PKCE, no secret):
 *
 * - DCR (RFC 7591): the client registers itself and gets an id of ours.
 * - CIMD: the client's id IS the https URL of a JSON document describing it.
 *   The document is fetched — only from the hosts of `OAUTH_CIMD_HOSTS`, so
 *   the server never fetches an address a stranger chose — and cached a day.
 *
 * Redirect URIs are matched EXACTLY, except that a loopback `http` redirect
 * matches on any port (RFC 8252 §7.3): a desktop client such as Claude Code
 * listens on an ephemeral one.
 */
import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { ClientMetadataDocument, type ClientRegistration } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { oauthClients } from "../../db/schema.js";

export type OAuthClient = typeof oauthClients.$inferSelect;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DOCUMENT_MAX_BYTES = 64 * 1024;
const DOCUMENT_TTL_MS = 24 * 3_600_000;

/** A client refused before anything is redirected: shown to the teacher, never sent to a redirect URI. */
export class ClientRefused extends Error {
  constructor(readonly reason: "invalid_client" | "invalid_redirect_uri" | "invalid_client_metadata") {
    super(reason);
  }
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** An address a client may register: https, or http on this machine; never a fragment. */
export function isAcceptableRedirect(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url || url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

export function isLoopback(raw: string): boolean {
  const url = parseUrl(raw);
  return url !== null && url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

/** Whether `requested` is one of `registered`: exact, or loopback with the port ignored. */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const want = parseUrl(requested);
  if (!want || !isLoopback(requested)) return false;
  return registered.some((r) => {
    const have = parseUrl(r);
    return (
      have !== null &&
      isLoopback(r) &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

export async function registerClient(db: Db, body: ClientRegistration, now: Date): Promise<OAuthClient> {
  if (!body.redirect_uris.every(isAcceptableRedirect)) throw new ClientRefused("invalid_redirect_uri");
  const [row] = await db
    .insert(oauthClients)
    .values({
      id: `quiz_client_${randomBytes(16).toString("base64url")}`,
      kind: "dcr",
      name: body.client_name || "MCP client",
      redirectUris: body.redirect_uris,
      clientUri: body.client_uri ?? null,
      createdAt: now,
    })
    .returning();
  return row!;
}

/** A client id that names a metadata document, on an allowed host. */
function documentUrl(clientId: string, allowedHosts: readonly string[]): URL | null {
  const url = parseUrl(clientId);
  if (!url || url.protocol !== "https:" || url.pathname === "/" || url.hash !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  return allowedHosts.includes(url.hostname.toLowerCase()) ? url : null;
}

async function fetchDocument(url: URL): Promise<ClientMetadataDocument> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ClientRefused("invalid_client_metadata");
  }
  if (!res.ok) throw new ClientRefused("invalid_client_metadata");
  const text = await res.text();
  if (text.length > DOCUMENT_MAX_BYTES) throw new ClientRefused("invalid_client_metadata");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ClientRefused("invalid_client_metadata");
  }
  const doc = ClientMetadataDocument.safeParse(json);
  if (!doc.success || doc.data.client_id !== url.href) throw new ClientRefused("invalid_client_metadata");
  if (!doc.data.redirect_uris.every(isAcceptableRedirect)) throw new ClientRefused("invalid_redirect_uri");
  return doc.data;
}

/**
 * The client behind a `client_id`: a registered one, or a metadata document
 * (fetched, or served from the cache while it is under a day old).
 */
export async function resolveClient(
  db: Db,
  clientId: string,
  opts: { allowedHosts: readonly string[]; now: Date },
): Promise<OAuthClient> {
  const [known] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  const url = documentUrl(clientId, opts.allowedHosts);
  if (known && (known.kind === "dcr" || !url)) return known;
  if (known && known.fetchedAt && opts.now.getTime() - known.fetchedAt.getTime() < DOCUMENT_TTL_MS) {
    return known;
  }
  if (!url) throw new ClientRefused("invalid_client");
  const doc = await fetchDocument(url);
  const values = {
    kind: "cimd" as const,
    name: doc.client_name || url.hostname,
    redirectUris: doc.redirect_uris,
    clientUri: doc.client_uri ?? null,
    fetchedAt: opts.now,
  };
  const [row] = await db
    .insert(oauthClients)
    .values({ id: clientId, createdAt: opts.now, ...values })
    .onConflictDoUpdate({ target: oauthClients.id, set: values })
    .returning();
  return row!;
}

/** Reads a client without ever fetching: the token endpoint's lookup. */
export async function findClient(db: Db, clientId: string): Promise<OAuthClient | null> {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  return row ?? null;
}
