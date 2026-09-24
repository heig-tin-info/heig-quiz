import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AUTOSAVE_DELAY_MS, useAutosave } from "./autosave";

/** A promise whose resolution the test controls, to hold a save in flight. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAutosave", () => {
  it("saves nothing until something changes", async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useAutosave({ value: "a", save }));
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 4);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.state).toBe("saved");
  });

  it("debounces: three keystrokes, one request, the last value", async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => Promise.resolve());
    const { rerender, result } = renderHook(({ v }) => useAutosave({ value: v, save }), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ v: "abc" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ v: "abcd" });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.state).toBe("saving");
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("abcd");
    expect(result.current.state).toBe("saved");
    expect(result.current.dirty).toBe(false);
  });

  it("keeps one request in flight and sends the latest value afterwards", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const save = vi
      .fn<(v: string) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => Promise.resolve());
    const { rerender } = renderHook(({ v }) => useAutosave({ value: v, save }), {
      initialProps: { v: "a" },
    });
    rerender({ v: "b" });
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(save).toHaveBeenCalledTimes(1);

    // Two more edits while the first save is still on the wire.
    rerender({ v: "c" });
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    rerender({ v: "d" });
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("d");
  });

  it("does not save a value adopted from the server, and still saves the next edit", async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => Promise.resolve());
    const { rerender, result } = renderHook(({ v }) => useAutosave({ value: v, save }), {
      initialProps: { v: { text: "a" } },
    });
    const fromServer = { text: "published" };
    result.current.adopt(fromServer);
    rerender({ v: fromServer });
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 4);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(false);
    expect(result.current.state).toBe("saved");

    rerender({ v: { text: "edited" } });
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ text: "edited" });
  });

  it("Ctrl+S does not wait for the delay", async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => Promise.resolve());
    const { rerender, result } = renderHook(({ v }) => useAutosave({ value: v, save }), {
      initialProps: { v: "a" },
    });
    rerender({ v: "b" });
    await act(async () => {
      result.current.flush();
    });
    expect(save).toHaveBeenCalledWith("b");
    expect(result.current.state).toBe("saved");
  });

  it("reports offline on a failure and keeps the value dirty", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn<(v: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue();
    const { rerender, result } = renderHook(({ v }) => useAutosave({ value: v, save }), {
      initialProps: { v: "a" },
    });
    rerender({ v: "b" });
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(result.current.state).toBe("offline");
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe("saved");
  });
});
