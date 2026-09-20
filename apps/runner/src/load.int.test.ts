import { execFileSync } from "node:child_process";

import { RunnerOutcome, type RunnerRequest } from "@quiz/core/server";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { detectSocket, loadConfig } from "./config.js";
import { availableLanguages } from "./images.js";

/**
 * The load the runner is sized for: a classroom of thirty students pressing
 * Run within the same ten seconds (PLAN-MVP §8, WP11).
 *
 * The requests go through the real HTTP surface, so the queue, the pool and
 * Podman are all in the measurement. They arrive at a steady three per second
 * rather than all at the same millisecond, because that is what a classroom
 * does and because a burst of thirty measures the queue's patience, not the
 * runner's speed. The bar is a p95 under five seconds — what a student
 * experiences as "it answered" rather than "it hung".
 */

const SOCKET = detectSocket();
const config = loadConfig({
  LOG_LEVEL: "fatal",
  ...(SOCKET === null ? {} : { PODMAN_SOCKET: SOCKET }),
});

function ready(): boolean {
  try {
    const base =
      config.PODMAN_SOCKET === null ? [] : ["--remote", "--url", `unix://${config.PODMAN_SOCKET}`];
    const images = execFileSync(
      config.PODMAN_BIN,
      [...base, "images", "--format", "{{.Repository}}:{{.Tag}}"],
      { encoding: "utf8", timeout: 20_000 },
    );
    return availableLanguages(images.split("\n"), config).includes("c");
  } catch {
    return false;
  }
}

const REQUESTS = 30;
/** The window the thirty students press Run in. */
const WINDOW_MS = 10_000;
const SOURCE =
  '#include <stdio.h>\nint main(void){int n;if(scanf("%d",&n)!=1)n=0;printf("%d\\n",n+1);return 0;}\n';

let app: FastifyInstance | null = null;

describe.skipIf(!ready())("thirty runs at once", () => {
  beforeAll(async () => {
    app = await buildApp({ config });
  });
  afterAll(async () => {
    await app?.close();
  });

  it(`serves ${REQUESTS} interactive runs spread over 10 s with a p95 under 5 s`, async () => {
    const server = app;
    if (server === null) throw new Error("no app");

    const payload = (index: number): RunnerRequest => ({
      language: "c",
      files: [{ name: "main.c", content: SOURCE }],
      compileArgs: "",
      action: "run",
      limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
      cases: [{ name: "one", stdin: `${index}\n` }],
      priority: "interactive",
    });

    const started = Date.now();
    const gap = WINDOW_MS / REQUESTS;
    const timings = await Promise.all(
      Array.from({ length: REQUESTS }, async (_unused, index) => {
        await new Promise((resolve) => setTimeout(resolve, Math.round(index * gap)));
        const at = Date.now();
        const res = await server.inject({ method: "POST", url: "/run", payload: payload(index) });
        expect(res.statusCode).toBe(200);
        const outcome = RunnerOutcome.parse(res.json());
        expect(outcome.compile.ok).toBe(true);
        expect(outcome.cases[0]!.stdout.trim()).toBe(String(index + 1));
        return Date.now() - at;
      }),
    );
    const total = Date.now() - started;

    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
    const median = sorted[Math.floor(sorted.length / 2)]!;
    console.log(
      `[runner] ${REQUESTS} runs over ${WINDOW_MS} ms, done in ${total} ms — ` +
        `median ${median} ms, p95 ${p95} ms, max ${sorted.at(-1)} ms, ` +
        `concurrency ${config.RUNNER_CONCURRENCY}`,
    );

    expect(p95).toBeLessThan(5000);
    // The queue must drain as fast as the classroom fills it: the last answer
    // lands right after the last question, not minutes later.
    expect(total).toBeLessThan(WINDOW_MS + 10_000);
  });

  it("refuses the overflow with 429 rather than queueing it for ever", async () => {
    const small = await buildApp({
      config: { ...config, RUNNER_CONCURRENCY: 1, RUNNER_QUEUE_MAX: 2 },
    });
    try {
      const payload: RunnerRequest = {
        language: "c",
        files: [{ name: "main.c", content: SOURCE }],
        compileArgs: "",
        action: "run",
        limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
        cases: [{ name: "one", stdin: "1\n" }],
        priority: "grading",
      };
      const answers = await Promise.all(
        Array.from({ length: 8 }, () =>
          small.inject({ method: "POST", url: "/run", payload }),
        ),
      );
      const statuses = answers.map((res) => res.statusCode);
      expect(statuses).toContain(429);
      expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(0);
      const busy = answers.find((res) => res.statusCode === 429);
      expect(Number(busy?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    } finally {
      await small.close();
    }
  });
});
