import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";
import { describe, expect, it } from "vitest";

import { QueueFull, RunQueue } from "./queue.js";

function request(priority: RunnerRequest["priority"], name: string): RunnerRequest {
  return {
    language: "c",
    files: [{ name: "main.c", content: name }],
    compileArgs: "",
    action: "run",
    limits: { timeMs: 1000, memoryMb: 128, outputKb: 64 },
    cases: [],
    priority,
  };
}

const EMPTY: RunnerOutcome = {
  compile: { ok: true, stdout: "", stderr: "", ms: 0 },
  cases: [],
};

/** A run that only finishes when the test says so. */
function gate(): { promise: Promise<RunnerOutcome>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<RunnerOutcome>((resolve) => {
    open = () => resolve(EMPTY);
  });
  return { promise, open };
}

describe("RunQueue", () => {
  it("runs at most `concurrency` requests at a time", async () => {
    const gates = [gate(), gate(), gate()];
    let started = 0;
    const queue = new RunQueue({
      concurrency: 2,
      queueMax: 10,
      run: () => gates[started++]!.promise,
    });

    const all = [
      queue.submit(request("grading", "a")),
      queue.submit(request("grading", "b")),
      queue.submit(request("grading", "c")),
    ];
    await Promise.resolve();

    expect(started).toBe(2);
    expect(queue.stats()).toMatchObject({ running: 2, queued: 1 });

    gates[0]!.open();
    await all[0];
    expect(started).toBe(3);

    gates[1]!.open();
    gates[2]!.open();
    await Promise.all(all);
    expect(queue.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it("serves an interactive request before a grading one, whatever the order", async () => {
    const order: string[] = [];
    const first = gate();
    let calls = 0;
    const queue = new RunQueue({
      concurrency: 1,
      queueMax: 10,
      run: (req) => {
        const name = req.files[0]!.content;
        order.push(name);
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve(EMPTY);
      },
    });

    const busy = queue.submit(request("grading", "first"));
    await Promise.resolve();
    const queued = [
      queue.submit(request("grading", "grading-1")),
      queue.submit(request("interactive", "interactive-1")),
      queue.submit(request("grading", "grading-2")),
      queue.submit(request("interactive", "interactive-2")),
    ];

    first.open();
    await Promise.all([busy, ...queued]);

    expect(order).toEqual([
      "first",
      "interactive-1",
      "interactive-2",
      "grading-1",
      "grading-2",
    ]);
  });

  it("refuses beyond the queue depth, with a Retry-After a caller can believe", async () => {
    const held = gate();
    const queue = new RunQueue({ concurrency: 1, queueMax: 2, run: () => held.promise });

    void queue.submit(request("grading", "running"));
    await Promise.resolve();
    void queue.submit(request("grading", "waiting-1"));
    void queue.submit(request("grading", "waiting-2"));
    expect(queue.depth).toBe(2);

    await expect(queue.submit(request("interactive", "refused"))).rejects.toBeInstanceOf(
      QueueFull,
    );
    await queue.submit(request("grading", "refused")).catch((error: unknown) => {
      expect(error).toBeInstanceOf(QueueFull);
      const full = error as QueueFull;
      expect(full.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(full.retryAfterSeconds).toBeLessThanOrEqual(30);
    });

    held.open();
  });

  it("propagates the failure of a run to its own caller only", async () => {
    let calls = 0;
    const queue = new RunQueue({
      concurrency: 1,
      queueMax: 10,
      run: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(EMPTY);
      },
    });

    await expect(queue.submit(request("grading", "bad"))).rejects.toThrow("boom");
    await expect(queue.submit(request("grading", "good"))).resolves.toEqual(EMPTY);
  });

  it("reports an average once a run has landed", async () => {
    const queue = new RunQueue({ concurrency: 1, queueMax: 4, run: () => Promise.resolve(EMPTY) });
    expect(queue.stats().avgMs).toBeNull();
    await queue.submit(request("grading", "a"));
    expect(queue.stats().avgMs).not.toBeNull();
  });
});
