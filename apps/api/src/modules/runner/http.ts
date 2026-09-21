/**
 * The HTTP runner: `POST ${RUNNER_URL}/run`, `GET ${RUNNER_URL}/health`
 * (PLAN-MVP §1.7).
 *
 * The whole point of this class is to turn every way an HTTP call can go wrong
 * into one of the two errors the rest of the platform knows about:
 *
 * - `RunnerBusy` (429) — the queues are full; the grading job retries later,
 *   and the request path surfaces it as "try again in a moment";
 * - `RunnerUnavailable` (502/503, a timeout, a refused connection, a body that
 *   is not a `RunnerOutcome`) — nothing is reachable; grading degrades to a
 *   proposed grade and the evaluation can still be released (decision D14).
 *
 * A 502 or a 503 is retried once, because a container engine restarting behind
 * the runner is the common cause and it is over in a second. A 429 is never
 * retried: retrying a full queue is how a full queue stays full.
 */
import {
  RunnerBusy,
  RunnerHealth,
  RunnerOutcome,
  RunnerUnavailable,
  type RunnerRequest,
  type RunnerService,
} from "@quiz/core/server";

/** The `fetch` surface used here; injectable so a test can point it at a local server. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRunnerOptions {
  /** Base URL of the runner service, with or without a trailing slash. */
  url: string;
  timeoutMs: number;
  /** Defaults to the global `fetch` (undici, Node 22). */
  fetch?: FetchLike;
  /** Retries on 502/503. One by default; zero in the tests that assert the mapping. */
  retries?: number;
  /** Shared secret, sent as `Authorization: Bearer` on every call (ADR-016). Empty = none. */
  token?: string;
}

const RETRYABLE = new Set([502, 503, 504]);

/** A health answer that says "nothing there", used for every failure path. */
const down = (reason: string): RunnerHealth => ({
  ok: false,
  languages: [],
  queued: 0,
  avgMs: null,
  reason,
});

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : null;
}

export class HttpRunner implements RunnerService {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetch: FetchLike;
  private readonly retries: number;
  private readonly headers: Record<string, string>;

  constructor(options: HttpRunnerOptions) {
    this.base = options.url.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.retries = options.retries ?? 1;
    this.headers = options.token ? { authorization: `Bearer ${options.token}` } : {};
  }

  async run(req: RunnerRequest): Promise<RunnerOutcome> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.post(`${this.base}/run`, req);

      if (res.ok) return await this.outcome(res);

      // Read and drop the body: leaving it unconsumed keeps the socket busy.
      await res.text().catch(() => "");

      if (res.status === 429) throw new RunnerBusy(retryAfterMs(res));
      if (RETRYABLE.has(res.status)) {
        if (attempt < this.retries) continue;
        throw new RunnerUnavailable(`upstream_${res.status}`);
      }
      throw new RunnerUnavailable(`http_${res.status}`);
    }
  }

  async health(): Promise<RunnerHealth> {
    try {
      const res = await this.fetch(`${this.base}/health`, {
        method: "GET",
        headers: this.headers,
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
      });
      if (!res.ok) {
        await res.text().catch(() => "");
        return down(`http_${res.status}`);
      }
      const parsed = RunnerHealth.safeParse(await res.json());
      return parsed.success ? parsed.data : down("bad_response");
    } catch (err) {
      // `health()` is called by /healthz and by the admin screen: it reports,
      // it never throws.
      return down(isTimeout(err) ? "timeout" : "unreachable");
    }
  }

  private async post(url: string, body: unknown): Promise<Response> {
    try {
      return await this.fetch(url, {
        method: "POST",
        headers: { ...this.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RunnerUnavailable(isTimeout(err) ? "timeout" : "unreachable");
    }
  }

  private async outcome(res: Response): Promise<RunnerOutcome> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new RunnerUnavailable("bad_response");
    }
    const parsed = RunnerOutcome.safeParse(body);
    // A runner answering 200 with something else is as useless as a dead one,
    // and far more confusing downstream: same error, explicit reason.
    if (!parsed.success) throw new RunnerUnavailable("bad_response");
    return parsed.data;
  }
}
