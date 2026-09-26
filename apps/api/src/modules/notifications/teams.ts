/**
 * Every HTTP call to Microsoft, and nothing else (ADR-030). Two halves:
 *
 *  - LINKING an account: an OAuth 2.0 authorization-code flow with PKCE,
 *    `state` and `nonce` against the `organizations` endpoint, scopes
 *    `openid profile`. It is only there to learn who the user is in Entra ID
 *    — the tenant (`tid`) and the object id (`oid`) of the ID token. Every
 *    token of the answer is dropped on the floor.
 *
 *  - SENDING a message, as the application and never as the user: an
 *    app-only Graph token for the user's tenant installs the Teams app for
 *    them (a 409 means it already is) and yields the one-to-one chat with the
 *    bot; a Bot Connector token then posts the activity into that chat. The
 *    chat id is returned so the caller can cache it and skip Graph next time.
 *
 * `fetch` is injected: the unit tests replay Microsoft's answers without a
 * network, and nothing else in the API talks to Microsoft.
 */
import { createHash, randomBytes } from "node:crypto";

import type { AppConfig } from "../../config.js";

const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 15_000;

type TeamsConfig = Pick<
  AppConfig,
  | "TEAMS_CLIENT_ID"
  | "TEAMS_CLIENT_SECRET"
  | "TEAMS_APP_ID"
  | "TEAMS_BOT_TENANT"
  | "TEAMS_SERVICE_URL"
>;

/** What a linked account is, for Microsoft. */
export interface TeamsIdentity {
  tenantId: string;
  objectId: string;
}

/** The link as a delivery reads it: the identity, and the chat once known. */
export interface TeamsTarget extends TeamsIdentity {
  chatId: string | null;
}

/** The secrets of one linking attempt, kept in a signed cookie meanwhile. */
export interface TeamsLinkStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export class TeamsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TeamsError";
  }
}

export interface TeamsClient {
  beginLink(redirectUri: string): TeamsLinkStart;
  completeLink(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<TeamsIdentity>;
  /** Posts `html` to the user's chat with the bot; returns the chat id used. */
  send(target: TeamsTarget, html: string): Promise<{ chatId: string }>;
}

const base64url = (buf: Buffer) => buf.toString("base64url");

/** The claims of a JWT, WITHOUT verifying its signature (see `completeLink`). */
export function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new TeamsError("malformed ID token");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new TeamsError("malformed ID token");
  }
}

export function createTeamsClient(config: TeamsConfig, fetchImpl: typeof fetch = fetch): TeamsClient {
  /** Access tokens by audience, until a minute before they expire. */
  const tokens = new Map<string, { value: string; until: number }>();

  async function call(url: string, init: RequestInit): Promise<Response> {
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  async function fail(what: string, res: Response): Promise<never> {
    const body = await res.text().catch(() => "");
    throw new TeamsError(`${what}: ${res.status} ${body.slice(0, 300)}`, res.status);
  }

  /** Client-credentials token of the application in `tenant`, for `scope`. */
  async function appToken(tenant: string, scope: string): Promise<string> {
    const key = `${tenant} ${scope}`;
    const cached = tokens.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    const res = await call(`${LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.TEAMS_CLIENT_ID,
        client_secret: config.TEAMS_CLIENT_SECRET,
        scope,
      }),
    });
    if (!res.ok) await fail(`token for ${scope}`, res);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new TeamsError(`token for ${scope}: no access_token`);
    const ttl = (json.expires_in ?? 600) * 1000;
    tokens.set(key, { value: json.access_token, until: Date.now() + ttl - 60_000 });
    return json.access_token;
  }

  /** Installs the app for the user if needed, and returns their chat with the bot. */
  async function resolveChat(target: TeamsIdentity): Promise<string> {
    const token = await appToken(target.tenantId, "https://graph.microsoft.com/.default");
    const auth = { Authorization: `Bearer ${token}` };
    const user = `${GRAPH}/users/${encodeURIComponent(target.objectId)}/teamwork/installedApps`;

    const install = await call(user, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        "teamsApp@odata.bind": `${GRAPH}/appCatalogs/teamsApps/${encodeURIComponent(config.TEAMS_APP_ID)}`,
      }),
    });
    // 409: already installed for this user, which is the common case.
    if (!install.ok && install.status !== 409) await fail("install the Teams app", install);

    const filter = encodeURIComponent(`teamsApp/id eq '${config.TEAMS_APP_ID.replace(/'/g, "''")}'`);
    const listed = await call(`${user}?$expand=teamsApp&$filter=${filter}`, { headers: auth });
    if (!listed.ok) await fail("find the Teams app installation", listed);
    const installations = ((await listed.json()) as { value?: { id?: string }[] }).value ?? [];
    const installationId = installations[0]?.id;
    if (!installationId) throw new TeamsError("the Teams app is not installed for this user");

    const chat = await call(`${user}/${encodeURIComponent(installationId)}/chat`, { headers: auth });
    if (!chat.ok) await fail("find the chat with the bot", chat);
    const chatId = ((await chat.json()) as { id?: string }).id;
    if (!chatId) throw new TeamsError("the chat with the bot has no id");
    return chatId;
  }

  async function post(chatId: string, html: string): Promise<Response> {
    const token = await appToken(config.TEAMS_BOT_TENANT, "https://api.botframework.com/.default");
    return call(
      `${config.TEAMS_SERVICE_URL}/v3/conversations/${encodeURIComponent(chatId)}/activities`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "message", textFormat: "xml", text: html }),
      },
    );
  }

  return {
    beginLink(redirectUri) {
      const codeVerifier = base64url(randomBytes(32));
      const state = base64url(randomBytes(24));
      const nonce = base64url(randomBytes(24));
      const challenge = base64url(createHash("sha256").update(codeVerifier).digest());
      const url = new URL(`${LOGIN}/organizations/oauth2/v2.0/authorize`);
      url.search = new URLSearchParams({
        client_id: config.TEAMS_CLIENT_ID,
        response_type: "code",
        response_mode: "query",
        redirect_uri: redirectUri,
        scope: "openid profile",
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      return { url: url.href, state, nonce, codeVerifier };
    },

    async completeLink({ code, redirectUri, codeVerifier, nonce }) {
      const res = await call(`${LOGIN}/organizations/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.TEAMS_CLIENT_ID,
          client_secret: config.TEAMS_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          scope: "openid profile",
        }),
      });
      if (!res.ok) await fail("redeem the authorization code", res);
      // Only the ID token is read; the access token of the answer is dropped.
      const json = (await res.json()) as { id_token?: string };
      if (!json.id_token) throw new TeamsError("no ID token in the answer");
      // The ID token came straight from Microsoft's token endpoint over TLS,
      // in exchange for our client secret: OpenID Connect Core §3.1.3.7
      // lets that channel stand in for the signature check. What remains to
      // check is that it was issued to US, for THIS attempt, by the tenant
      // it names.
      const claims = jwtClaims(json.id_token);
      const tid = typeof claims.tid === "string" ? claims.tid : "";
      const oid = typeof claims.oid === "string" ? claims.oid : "";
      if (claims.aud !== config.TEAMS_CLIENT_ID) throw new TeamsError("ID token for another audience");
      if (claims.nonce !== nonce) throw new TeamsError("ID token nonce mismatch");
      if (!tid || !oid) throw new TeamsError("ID token without tid or oid");
      if (claims.iss !== `${LOGIN}/${tid}/v2.0`) throw new TeamsError("ID token issuer mismatch");
      return { tenantId: tid, objectId: oid };
    },

    async send(target, html) {
      let chatId = target.chatId ?? (await resolveChat(target));
      let res = await post(chatId, html);
      // A cached chat that is gone (the app was uninstalled, the chat
      // deleted): find it again once, from Graph, before giving up.
      if ((res.status === 403 || res.status === 404) && target.chatId) {
        chatId = await resolveChat(target);
        res = await post(chatId, html);
      }
      if (!res.ok) await fail("post the Teams message", res);
      return { chatId };
    },
  };
}
