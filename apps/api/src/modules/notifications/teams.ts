/**
 * Every HTTP call the platform makes to Microsoft, and nothing else
 * (ADR-030): the bot posts an activity into a Teams chat through Bot
 * Connector, as itself.
 *
 *  - a client-credentials token of the bot's Entra application, for the
 *    scope `https://api.botframework.com/.default`, issued by
 *    `TEAMS_BOT_TENANT` (`botframework.com` for a multi-tenant bot, the home
 *    tenant id for a single-tenant one), cached until a minute before expiry;
 *  - `POST {serviceUrl}/v3/conversations/{id}/activities`.
 *
 * The `serviceUrl` came from an activity Microsoft posted to us, and the
 * bearer token goes wherever it points: it is checked against the allowlist
 * of Teams hosts at reception AND here, before every send, so a row written
 * before a rule changed cannot send the token elsewhere either.
 *
 * `fetch` is injected: the unit tests replay Microsoft's answers without a
 * network.
 */
import type { AppConfig } from "../../config.js";

const LOGIN = "https://login.microsoftonline.com";
const BOT_SCOPE = "https://api.botframework.com/.default";
const TIMEOUT_MS = 15_000;

/**
 * The hosts Bot Connector gives as `serviceUrl` for Microsoft Teams in the
 * public cloud: `https://smba.trafficmanager.net/<region>/` (`amer`, `emea`,
 * `apac`, `in`, `teams`, or a tenant id). The government and sovereign clouds
 * (`smba.infra.gcc.teams.microsoft.com`, `….gov.teams.microsoft.us`, …) are
 * left out on purpose: HEIG-VD is not in them, and a host added here is a
 * host the bot's token may be sent to.
 */
export const TEAMS_SERVICE_HOSTS: readonly string[] = ["smba.trafficmanager.net"];

/** HTTPS, an allowed host, the default port, no credentials, query or fragment. */
export function allowedServiceUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    TEAMS_SERVICE_HOSTS.includes(url.hostname)
  );
}

/** Where one chat is answered: the pair Bot Connector gave us for it. */
export interface TeamsConversation {
  serviceUrl: string;
  conversationId: string;
}

/** The subset of a Bot Framework activity the bot sends. */
export interface OutgoingActivity {
  type: "message";
  text?: string;
  textFormat?: "plain" | "xml" | "markdown";
  attachments?: { contentType: string; content: unknown }[];
}

export class TeamsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The request was never made: the `serviceUrl` is not an allowed one. */
    readonly refused = false,
  ) {
    super(message);
    this.name = "TeamsError";
  }

  /**
   * 403: the person blocked the bot or removed the app; 404: the chat is
   * gone. Retrying cannot change either — the delivery is dropped (the link
   * stays until the uninstall event or the user removes it). A refused
   * `serviceUrl` would be refused again just as well.
   */
  get permanent(): boolean {
    return this.refused || this.status === 403 || this.status === 404;
  }
}

export interface TeamsClient {
  send(to: TeamsConversation, activity: OutgoingActivity): Promise<void>;
}

type TeamsConfig = Pick<AppConfig, "TEAMS_CLIENT_ID" | "TEAMS_CLIENT_SECRET" | "TEAMS_BOT_TENANT">;

export function createTeamsClient(config: TeamsConfig, fetchImpl: typeof fetch = fetch): TeamsClient {
  let token: { value: string; until: number } | null = null;

  async function call(url: string, init: RequestInit): Promise<Response> {
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  async function fail(what: string, res: Response): Promise<never> {
    const body = await res.text().catch(() => "");
    throw new TeamsError(`${what}: ${res.status} ${body.slice(0, 300)}`, res.status);
  }

  async function botToken(): Promise<string> {
    if (token && token.until > Date.now()) return token.value;
    const res = await call(
      `${LOGIN}/${encodeURIComponent(config.TEAMS_BOT_TENANT)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.TEAMS_CLIENT_ID,
          client_secret: config.TEAMS_CLIENT_SECRET,
          scope: BOT_SCOPE,
        }),
      },
    );
    // A token failure is OUR configuration (a lapsed secret): never permanent.
    if (!res.ok) await fail("Bot Connector token", res);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new TeamsError("Bot Connector token: no access_token");
    const ttl = (json.expires_in ?? 600) * 1000;
    token = { value: json.access_token, until: Date.now() + ttl - 60_000 };
    return json.access_token;
  }

  return {
    async send(to, activity) {
      if (!allowedServiceUrl(to.serviceUrl)) {
        throw new TeamsError(`refused serviceUrl ${to.serviceUrl}`, undefined, true);
      }
      const base = to.serviceUrl.replace(/\/+$/, "");
      const res = await call(
        `${base}/v3/conversations/${encodeURIComponent(to.conversationId)}/activities`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await botToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(activity),
        },
      );
      if (!res.ok) await fail("post the Teams message", res);
    },
  };
}
