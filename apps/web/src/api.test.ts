import { describe, expect, it } from "vitest";

import { ApiError, apiErrorMessage } from "./api";

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
