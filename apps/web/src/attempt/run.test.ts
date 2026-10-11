/**
 * The refusals of a student's run, as the player reads them: no runner is
 * "unavailable" (D14), a saturated one is a failure to retry (ADR-101).
 */
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { postRun } from "./run";

/** What the next `api` call answers. */
let answer: () => Promise<unknown> = async () => undefined;
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: () => answer(),
}));

const refused = (status: number, body: unknown) => async () => {
  throw new ApiError(status, body);
};

describe("postRun", () => {
  it("reads a 503 without a runner as unavailable, for the browser to stand in", async () => {
    answer = refused(503, { error: "runner_unavailable", reason: "not_configured" });
    await expect(postRun("/run", {})).resolves.toBe("unavailable");
  });

  it("throws a 503 busy, so the player says try again in a moment and nothing stands in", async () => {
    answer = refused(503, { error: "runner_unavailable", reason: "busy" });
    await expect(postRun("/run", {})).rejects.toBeInstanceOf(ApiError);
  });

  it("throws a busy result of the stream too", async () => {
    answer = async () => ({ requestId: "r", result: { status: "busy" } });
    await expect(postRun("/run", {})).rejects.toThrow("runner busy");
  });
});
