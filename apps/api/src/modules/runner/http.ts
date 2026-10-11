/**
 * The HTTP runner: `POST ${RUNNER_URL}/run`, `GET ${RUNNER_URL}/health`
 * (PLAN-MVP §1.7).
 *
 * The whole point of this class is to turn every way an HTTP call can go wrong
 * into one of the two errors the rest of the platform knows about:
 *
 * - `RunnerBusy` (429, or no answer in time) — the queues are full, or the
 *   request waited longer than its queue allowance; the grading job retries
 *   later, and the request path surfaces it as "try again in a moment";
 * - `RunnerUnavailable` (502/503, a refused connection, a body that is not a
 *   `RunnerOutcome`) — nothing is reachable; grading degrades to a proposed
 *   grade and the evaluation can still be released (decision D14).
 *
 * The wait is budgeted per request (ADR-101): the request carries its
 * `budgetMs` — the formula of `@quiz/core`, capped for an interactive call —
 * which the runner enforces by truncating, and the API waits that plus a queue
 * allowance. So a program that loops forever comes back as timed-out cases,
 * a result; a call that times out here has spent its time in the queue, which
 * is saturation, and saturation is `RunnerBusy`.
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
  RUNNER_TTL_SLACK_MS,
  requestBudgetMs,
  type RunnerRequest,
  type RunnerService,
} from "@quiz/core/server";

import { readCapped } from "../../cappedBody.js";

/** The `fetch` surface used here; injectable so a test can point it at a local server. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRunnerOptions {
  /** Base URL of the runner service, with or without a trailing slash. */
  url: string;
  /**
   * The most an interactive request may run (`RUNNER_TIMEOUT_MS`): its
   * `budgetMs`, which the runner enforces by truncating. A grading request
   * gets its full budget.
   */
  interactiveCeilingMs: number;
  /** How long to wait for a budgeted request; {@link callTimeoutMs} unless a test needs it short. */
  waitMs?: (req: RunnerRequest & { budgetMs: number }) => number;
  /** Defaults to the global `fetch` (undici, Node 22). */
  fetch?: FetchLike;
  /** Retries on 502/503. One by default; zero in the tests that assert the mapping. */
  retries?: number;
  /** Shared secret, sent as `Authorization: Bearer` on every call (ADR-016). Empty = none. */
  token?: string;
}

const RETRYABLE = new Set([502, 503, 504]);

/**
 * How long a request may wait in the runner's queue before the API gives up
 * (ADR-101). A student at the Run button is told "busy" after a short wait; a
 * grading run waits past the runner's 10 s aging and one running request.
 */
const QUEUE_ALLOWANCE_MS = { interactive: 20_000, grading: 60_000 } as const;

/** The request as sent: its `budgetMs`, the interactive ceiling applied. */
function budgeted(req: RunnerRequest, interactiveCeilingMs: number): RunnerRequest & { budgetMs: number } {
  const ceiling = req.priority === "interactive" ? interactiveCeilingMs : Number.POSITIVE_INFINITY;
  return { ...req, budgetMs: Math.min(requestBudgetMs(req), ceiling) };
}

/** How long the API waits for a budgeted request: its queue allowance, its budget, the slack. */
function callTimeoutMs(req: RunnerRequest & { budgetMs: number }): number {
  return QUEUE_ALLOWANCE_MS[req.priority] + req.budgetMs + RUNNER_TTL_SLACK_MS;
}

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

/**
 * The most a runner may answer, in bytes. Fixed and generous: a program's
 * output is capped in bytes by the runner, but JSON escaping multiplies it
 * (a control byte becomes `\u00XX`, six), so no tight bound derives from
 * the request. This one only stops a runner that streams without end.
 */
const MAX_OUTCOME_BYTES = 32 * 1024 * 1024;

/** A `/health` answer is a few hundred bytes. */
const MAX_HEALTH_BYTES = 64 * 1024;

/**
 * The body as JSON, read chunk by chunk and abandoned past `maxBytes`, so a
 * runner that streams without end cannot fill the API's memory.
 */
async function cappedJson(res: Response, maxBytes: number): Promise<unknown> {
  if (res.body === null) throw new RunnerUnavailable("bad_response");
  const bytes = await readCapped(res, maxBytes);
  if (bytes === null) throw new RunnerUnavailable("response_too_large");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RunnerUnavailable("bad_response");
  }
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : null;
}

export class HttpRunner implements RunnerService {
  private readonly base: string;
  private readonly interactiveCeilingMs: number;
  private readonly waitMs: (req: RunnerRequest & { budgetMs: number }) => number;
  private readonly fetch: FetchLike;
  private readonly retries: number;
  private readonly headers: Record<string, string>;

  constructor(options: HttpRunnerOptions) {
    this.base = options.url.replace(/\/+$/, "");
    this.interactiveCeilingMs = options.interactiveCeilingMs;
    this.waitMs = options.waitMs ?? callTimeoutMs;
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.retries = options.retries ?? 1;
    this.headers = options.token ? { authorization: `Bearer ${options.token}` } : {};
  }

  async run(req: RunnerRequest): Promise<RunnerOutcome> {
    const sent = budgeted(req, this.interactiveCeilingMs);
    for (let attempt = 0; ; attempt++) {
      const res = await this.post(`${this.base}/run`, sent, this.waitMs(sent));

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
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        await res.text().catch(() => "");
        return down(`http_${res.status}`);
      }
      const parsed = RunnerHealth.safeParse(await cappedJson(res, MAX_HEALTH_BYTES));
      return parsed.success ? parsed.data : down("bad_response");
    } catch (err) {
      // `health()` is called by /healthz and by the admin screen: it reports,
      // it never throws.
      return down(isTimeout(err) ? "timeout" : "unreachable");
    }
  }

  private async post(url: string, body: unknown, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetch(url, {
        method: "POST",
        headers: { ...this.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // The runner bounds the run itself: the time went to the queue.
      if (isTimeout(err)) throw new RunnerBusy(null);
      throw new RunnerUnavailable("unreachable");
    }
  }

  private async outcome(res: Response): Promise<RunnerOutcome> {
    let body: unknown;
    try {
      body = await cappedJson(res, MAX_OUTCOME_BYTES);
    } catch (err) {
      throw err instanceof RunnerUnavailable ? err : new RunnerUnavailable("bad_response");
    }
    const parsed = RunnerOutcome.safeParse(body);
    // A runner answering 200 with something else is as useless as a dead one,
    // and far more confusing downstream: same error, explicit reason.
    if (!parsed.success) throw new RunnerUnavailable("bad_response");
    return parsed.data;
  }
}
