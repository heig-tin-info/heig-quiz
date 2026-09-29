/**
 * The job queues deduplicate nothing (#273): pg-boss on a `standard` queue
 * and the in-process development queue run every job sent, so a grading
 * pass waiting behind another can never swallow the close's pass.
 */
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { GRADING_EVALUATION_QUEUE, InProcessQueue, type JobQueue } from "./jobs.js";
import { enqueueEvaluationGrading, registerGradingJobs } from "./modules/grading/jobs.js";

const silent = () => {};
const log = { info: silent, warn: silent, error: silent, debug: silent } as never;

describe("the in-process queue", () => {
  it("runs every job sent, in order, identical ones included", async () => {
    const queue = new InProcessQueue(true, log);
    const seen: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    await queue.work<{ id: string }>("q", async ({ id }) => {
      seen.push(id);
      if (id === "first") await blocked;
    });
    // `first` runs and holds the queue; the three others wait behind it.
    await queue.send("q", { id: "first" });
    await queue.send("q", { id: "retake" });
    await queue.send("q", { id: "retake" });
    await queue.send("q", { id: "close" });
    release();
    await vi.waitFor(() => expect(seen).toEqual(["first", "retake", "retake", "close"]));
  });
});

describe("the grading.evaluation queue, as pg-boss sees it", () => {
  /** A queue double recording what the application asks pg-boss for. */
  function recorder() {
    const calls: { op: string; name: string; data?: unknown; options?: unknown }[] = [];
    const queue: JobQueue = {
      createQueue: async (name, options) => void calls.push({ op: "create", name, options }),
      send: async (name, data, options) => void calls.push({ op: "send", name, data, options }),
      work: async () => {},
      stop: async () => {},
    };
    return { calls, queue };
  }

  it("is a standard queue: no policy, whose semantics would differ from the in-process one", async () => {
    const { calls, queue } = recorder();
    await registerGradingJobs({} as FastifyInstance, queue);
    const created = calls.find((c) => c.op === "create" && c.name === GRADING_EVALUATION_QUEUE);
    expect(created?.options).not.toHaveProperty("policy");
  });

  it("sends each pass as its own job, with no singleton key", async () => {
    const { calls, queue } = recorder();
    const app = { boss: queue } as unknown as FastifyInstance;
    await enqueueEvaluationGrading(app, { evaluationId: "e", attemptIds: ["a"] });
    await enqueueEvaluationGrading(app, { evaluationId: "e", announce: true });
    const sent = calls.filter((c) => c.op === "send");
    expect(sent.map((c) => c.data)).toEqual([
      { evaluationId: "e", attemptIds: ["a"] },
      { evaluationId: "e", announce: true },
    ]);
    for (const c of sent) expect(c.options ?? {}).not.toHaveProperty("singletonKey");
  });
});
