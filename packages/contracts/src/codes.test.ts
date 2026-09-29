import { describe, expect, it } from "vitest";

import { JOIN_CODE_LENGTH, POLL_CODE_LENGTH } from "./codes.js";

describe("the two student codes (ADR-045)", () => {
  it("never share a length, which is what the student's one field dispatches on", () => {
    expect(POLL_CODE_LENGTH).not.toBe(JOIN_CODE_LENGTH);
  });
});
