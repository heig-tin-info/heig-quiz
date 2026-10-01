import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, apiErrorMessage } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api", () => {
  it("reads no body from a 202 or a 204, and parses every other success", async () => {
    const reply = (status: number, body: string | null) =>
      vi.stubGlobal("fetch", async () => new Response(body, { status }));
    reply(202, null);
    await expect(api("/x")).resolves.toBeUndefined();
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
