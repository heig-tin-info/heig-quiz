import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useWandRunner } from "./wand.js";

describe("useWandRunner", () => {
  it("holds the running key until the request settles, failure included", async () => {
    const { result } = renderHook(() => useWandRunner<string>());
    let fail = (_: Error) => {};
    act(() => result.current.run("a", () => new Promise<void>((_, reject) => (fail = reject))));
    expect(result.current.running).toBe("a");
    await act(async () => fail(new Error("worded by the host")));
    expect(result.current.running).toBeNull();
  });
});
