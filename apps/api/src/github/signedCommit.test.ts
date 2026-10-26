import { afterEach, describe, expect, it, vi } from "vitest";

import type { Octokit } from "octokit";

import { signedCommit } from "./signedCommit.js";

/** Octokit's own shape for an HTTP failure: only `status` and `message` matter here. */
function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

/** An Octokit whose `POST /git/commits` answers with `answers` in turn (an Error is thrown). */
function fakeOctokit(...answers: (string | Error)[]) {
  const request = vi.fn(async (route: string, _params: Record<string, unknown>) => {
    if (route !== "POST /repos/{owner}/{repo}/git/commits") throw new Error(`unexpected route ${route}`);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { data: { sha: next } };
  });
  return { octokit: { request } as unknown as Octokit, request };
}

const INPUT = { owner: "org", repo: "labo-squashed", tree: "t1", parents: ["p1"], message: "Project update" };

describe("signedCommit", () => {
  afterEach(() => vi.useRealTimers());

  it("creates the commit with no author nor committer, so that GitHub signs it for the App", async () => {
    const { octokit, request } = fakeOctokit("c1");
    expect(await signedCommit({ octokit, ...INPUT })).toBe("c1");
    expect(request).toHaveBeenCalledTimes(1);
    const body = request.mock.calls[0]![1];
    expect(body).toMatchObject({ owner: "org", repo: "labo-squashed", tree: "t1", parents: ["p1"], message: "Project update" });
    expect(body).not.toHaveProperty("author");
    expect(body).not.toHaveProperty("committer");
    expect(body).not.toHaveProperty("signature");
  });

  it("retries while the tree just pushed is not visible yet, then succeeds", async () => {
    vi.useFakeTimers();
    const { octokit, request } = fakeOctokit(httpError(422, "Tree SHA does not exist"), httpError(404, "Not Found"), "c2");
    const done = signedCommit({ octokit, ...INPUT });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await done).toBe("c2");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("gives up after three retries", async () => {
    vi.useFakeTimers();
    const missing = () => httpError(422, "Tree SHA does not exist");
    const { octokit, request } = fakeOctokit(missing(), missing(), missing(), missing());
    const done = signedCommit({ octokit, ...INPUT });
    const failed = expect(done).rejects.toThrow("Tree SHA does not exist");
    await vi.advanceTimersByTimeAsync(7000);
    await failed;
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("throws any other failure at once", async () => {
    for (const err of [httpError(422, "Invalid request"), httpError(403, "Resource not accessible by integration"), httpError(500, "not found")]) {
      const { octokit, request } = fakeOctokit(err, "never");
      await expect(signedCommit({ octokit, ...INPUT })).rejects.toBe(err);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
});
