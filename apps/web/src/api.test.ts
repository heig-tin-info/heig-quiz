import { afterEach, describe, expect, it, vi } from "vitest";

import { connection } from "./realtime/connection";
import { api, ApiError, apiErrorMessage } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api", () => {
  it("reads no body from a 204 or an empty 202, and parses every other success", async () => {
    const reply = (status: number, body: string | null) =>
      vi.stubGlobal("fetch", async () => new Response(body, { status }));
    reply(202, null);
    await expect(api("/x")).resolves.toBeUndefined();
    // `POST /attempts/:id/run` answers 202 with the run's result in the body.
    reply(202, '{"requestId":"r","result":{"status":"ok"}}');
    await expect(api("/x")).resolves.toEqual({ requestId: "r", result: { status: "ok" } });
    reply(204, null);
    await expect(api("/x")).resolves.toBeUndefined();
    reply(200, '{"a":1}');
    await expect(api("/x")).resolves.toEqual({ a: 1 });
    reply(200, "");
    await expect(api("/x")).rejects.toThrow();
  });
});

describe("apiErrorMessage", () => {
  it("prints the server's message, or the fallback", () => {
    expect(apiErrorMessage(new ApiError(409, { message: "Taken" }), "Failed")).toBe("Taken");
    expect(apiErrorMessage(new ApiError(500, null), "Failed")).toBe("Failed");
    expect(apiErrorMessage(new Error("boom"), "Failed")).toBe("Failed");
  });

  it("words a refusal it knows by its code, not in the server's English (ADR-034)", () => {
    const refused = new ApiError(403, { error: "impersonation_read_only", message: "server English" });
    expect(apiErrorMessage(refused, "Failed")).toBe(
      "You are acting as a student, read only: nothing can be changed from this window.",
    );
  });
});


describe("connection signals", () => {
  it("reports transport failures and gateway outages, never permission refusals or cancellations", async () => {
    const suspect = vi.spyOn(connection, "suspect").mockImplementation(() => {});
    for (const status of [401, 403, 404, 500, 502, 503, 504]) {
      vi.stubGlobal("fetch", async () => new Response("{}", { status }));
      await expect(api("/x")).rejects.toBeInstanceOf(ApiError);
    }
    expect(suspect).toHaveBeenCalledTimes(3);
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    await expect(api("/x")).rejects.toThrow("Failed to fetch");
    expect(suspect).toHaveBeenCalledTimes(4);
    const controller = new AbortController();
    controller.abort();
    await expect(api("/x", { signal: controller.signal })).rejects.toThrow();
    expect(suspect).toHaveBeenCalledTimes(4);
  });
});
