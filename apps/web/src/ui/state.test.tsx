import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePersistentChoice } from "./state";

const KEY = "quiz-test-choice";
const VALUES = ["cards", "list"] as const;

describe("usePersistentChoice", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("starts on the fallback when nothing is stored", () => {
    const { result } = renderHook(() => usePersistentChoice(KEY, VALUES, "cards"));
    expect(result.current[0]).toBe("cards");
  });

  it("reads a stored value that is one of the choices", () => {
    localStorage.setItem(KEY, "list");
    const { result } = renderHook(() => usePersistentChoice(KEY, VALUES, "cards"));
    expect(result.current[0]).toBe("list");
  });

  it("ignores a stored value outside the choices", () => {
    localStorage.setItem(KEY, "grid");
    const { result } = renderHook(() => usePersistentChoice(KEY, VALUES, "cards"));
    expect(result.current[0]).toBe("cards");
  });

  it("accepts a predicate for an open set", () => {
    localStorage.setItem(KEY, "room-42");
    const any = (raw: string): raw is string => true;
    const { result } = renderHook(() => usePersistentChoice<string>(KEY, any, ""));
    expect(result.current[0]).toBe("room-42");
  });

  it("writes the choice and updates the value", () => {
    const { result } = renderHook(() => usePersistentChoice(KEY, VALUES, "cards"));
    act(() => result.current[1]("list"));
    expect(result.current[0]).toBe("list");
    expect(localStorage.getItem(KEY)).toBe("list");
  });

  it("survives a storage that throws on read and on write (private window)", () => {
    const refusing = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };
    vi.stubGlobal("localStorage", refusing);
    const { result } = renderHook(() => usePersistentChoice(KEY, VALUES, "cards"));
    expect(result.current[0]).toBe("cards");
    act(() => result.current[1]("list"));
    expect(result.current[0]).toBe("list");
  });
});
