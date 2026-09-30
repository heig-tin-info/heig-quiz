/**
 * Invariant 5 at boot: the ticker, which closes every deadline, starts
 * whatever happens to the job registrations beside it. A registration that
 * throws is logged, and the live clock runs anyway.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

const startTicker = vi.fn();
vi.mock("./ticker.js", async (original) => ({
  ...(await original<typeof import("./ticker.js")>()),
  startTicker,
}));
vi.mock("./modules/grading/jobs.js", async (original) => ({
  ...(await original<typeof import("./modules/grading/jobs.js")>()),
  registerGradingJobs: async () => {
    throw new Error("grading registration broke");
  },
}));
vi.mock("./modules/system/jobs.js", async (original) => ({
  ...(await original<typeof import("./modules/system/jobs.js")>()),
  registerSystemJobs: async () => {
    throw new Error("system registration broke");
  },
}));

const { buildApp } = await import("./app.js");
const { loadConfig } = await import("./config.js");

describe("boot with a failing job registration", () => {
  let dir: string;
  let close = async () => {};
  afterAll(async () => {
    await close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("still starts the ticker", async () => {
    dir = await mkdtemp(join(tmpdir(), "quiz-boot-"));
    const config = loadConfig({
      NODE_ENV: "test",
      // No migration: the seeding fails too, and is only logged as well.
      DATABASE_URL: `pglite://${join(dir, "db")}`,
      ASSETS_DIR: join(dir, "assets"),
      WORKER_MODE: "all",
      LOG_LEVEL: "fatal",
    });
    const app = await buildApp({ config });
    close = () => app.close();
    expect(app.boss).toBeDefined();
    expect(startTicker).toHaveBeenCalledOnce();
  });
});
