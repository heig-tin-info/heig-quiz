/**
 * Every HTTP call the platform makes to Microsoft, and nothing else
 * (ADR-030): an activity-feed notification to one Teams user, through
 * Microsoft Graph, as the HEIG Quiz application.
 *
 *  - a client-credentials token of the Entra application, IN THE RECIPIENT'S
 *    TENANT (`login.microsoftonline.com/<tid>`), for the scope
 *    `https://graph.microsoft.com/.default`, cached per tenant until a minute
 *    before it expires. The application is multi-tenant; its permission,
 *    `TeamsActivity.Send.User`, is resource-specific: each user granted it to
 *    the app by installing the Teams app, and Graph checks it per recipient;
 *  - `POST /v1.0/users/{oid}/teamwork/sendActivityNotification`.
 *
 * A 403 or 404 from Graph means the app is not installed for that user, its
 * permission was not consented (an older manifest), a policy blocks it, or
 * the user is gone; a 400 means the request does not fit the app the user
 * installed (an activity type an older manifest does not declare, #198):
 * retrying cannot change any of that, so the error is `permanent`
 * and the delivery is dropped — the link is KEPT (reinstalling the app is the
 * user's fix, and the link then works again). A token failure is our own
 * configuration (a lapsed secret) and is retried like any other failure.
 *
 * `fetch` is injected: the unit tests replay Microsoft's answers without a
 * network.
 */
import type { AppConfig } from "../../config.js";
import { tracked } from "../../serviceHealth.js";

const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const TIMEOUT_MS = 15_000;

/** A Teams user, as the link knows them. */
export interface TeamsRecipient {
  /** The Entra tenant of the account (lower-case). */
  tenantId: string;
  /** The Entra object id of the account in that tenant. */
  aadObjectId: string;
}

/**
 * One activity-feed notification. `activityType` is one of the manifest's
 * `activities.activityTypes`; `templateParameters` fill its `templateText`,
 * which Teams renders in the language of the recipient's client.
 */
export interface ActivityNotification {
  /** The first line of the notification: the evaluation's or the pool's name. */
  topic: string;
  /** Where a click leads: a Teams deep link (Graph requires teams.microsoft.com). */
  webUrl: string;
  activityType: string;
  /** The line under it, already rendered in the recipient's platform language. */
  previewText: string;
  templateParameters: Record<string, string>;
}

export class TeamsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Graph's own error code (`error.code` of the body), for the logs. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "TeamsError";
  }

  /**
   * 400: the activity does not fit the manifest the user installed (a type
   * an older version does not declare, until they re-upload the app); 403:
   * the app is not installed for the user, its permission is missing, or a
   * policy forbids it; 404: no such user. A retry meets the same answer.
   * A token failure never carries a status (`fail(…, retryable)`), so a 400
   * from the login endpoint stays retryable.
   */
  get permanent(): boolean {
    return this.status === 400 || this.status === 403 || this.status === 404;
  }
}

export interface TeamsClient {
  notify(to: TeamsRecipient, notification: ActivityNotification): Promise<void>;
}

type TeamsConfig = Pick<AppConfig, "TEAMS_CLIENT_ID" | "TEAMS_CLIENT_SECRET">;

export function createTeamsClient(config: TeamsConfig, fetchImpl: typeof fetch = fetch): TeamsClient {
  /** One token per tenant: a client-credentials token is issued by one. */
  const tokens = new Map<string, { value: string; until: number }>();

  async function call(url: string, init: RequestInit): Promise<Response> {
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  /** Throws; `retryable` drops the status, so the error is never `permanent`. */
  async function fail(what: string, res: Response, retryable = false): Promise<never> {
    const body = await res.text().catch(() => "");
    let code: string | undefined;
    try {
      const parsed = JSON.parse(body) as { error?: { code?: unknown } | string };
      const raw = typeof parsed.error === "object" ? parsed.error?.code : parsed.error;
      if (typeof raw === "string") code = raw;
    } catch {
      // Not JSON: the status says enough.
    }
    // Microsoft's own words stay out of the logs: the status and the code say it.
    throw new TeamsError(`${what}: ${res.status}${code ? ` ${code}` : ""}`, retryable ? undefined : res.status, code);
  }

  async function graphToken(tenantId: string): Promise<string> {
    const cached = tokens.get(tenantId);
    if (cached && cached.until > Date.now()) return cached.value;
    const res = await call(`${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.TEAMS_CLIENT_ID,
        client_secret: config.TEAMS_CLIENT_SECRET,
        scope: GRAPH_SCOPE,
      }),
    });
    // A token failure is OUR configuration (a lapsed secret, the app missing
    // from that tenant): never permanent, whatever the status.
    if (!res.ok) await fail("Graph token", res, true);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new TeamsError("Graph token: no access_token");
    const ttl = (json.expires_in ?? 600) * 1000;
    tokens.set(tenantId, { value: json.access_token, until: Date.now() + ttl - 60_000 });
    return json.access_token;
  }

  return {
    // Recorded for the services' status (ADR-055 §6). A permanent refusal is
    // about ONE recipient (the app not installed for them): Microsoft
    // answered, so it counts as an answer, not as the service failing.
    notify: (to, n) =>
      tracked("teams", () => send(to, n), (err) => !(err instanceof TeamsError && err.permanent)),
  };

  async function send(to: TeamsRecipient, n: ActivityNotification): Promise<void> {
    const token = await graphToken(to.tenantId);
    const res = await call(
      `${GRAPH}/users/${encodeURIComponent(to.aadObjectId)}/teamwork/sendActivityNotification`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: { source: "text", value: n.topic, webUrl: n.webUrl },
          activityType: n.activityType,
          previewText: { content: n.previewText },
          templateParameters: Object.entries(n.templateParameters).map(([name, value]) => ({ name, value })),
        }),
      },
    );
    if (!res.ok) await fail("send the Teams activity", res);
  }
}
