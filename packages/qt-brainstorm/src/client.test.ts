import { describe, expect, it } from "vitest";

import { brainstormClient } from "./client.js";

describe("brainstormClient", () => {
  it("starts empty and reads an answer as given", () => {
    expect(brainstormClient.emptyAnswer({ prompt: "", maxIdeas: 1 })).toEqual({ ideas: [] });
    expect(brainstormClient.isAnswered({ ideas: ["a"] })).toBe(true);
    expect(brainstormClient.summarize?.({ ideas: ["a", "b"] }, { prompt: "", maxIdeas: 2 })).toBe("a · b");
    expect(brainstormClient.summarize?.(null, { prompt: "", maxIdeas: 2 })).toBe("");
  });
});
