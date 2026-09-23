import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCombobox, type ComboboxOptions } from "./combobox";

/*
 * The two kinds of list the hook serves, asserted on the hook itself: the
 * three call sites (TagInput, TeacherPicker, the pool search) have their own
 * tests through the DOM, and this pins the matrix they rely on.
 */

function key(k: string) {
  return {
    key: k,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as KeyboardEvent<HTMLInputElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

function setup(options: Partial<ComboboxOptions> = {}) {
  const onPick = vi.fn();
  const view = renderHook((props: Partial<ComboboxOptions>) =>
    useCombobox({ count: 3, onPick, ...options, ...props }),
  );
  return { ...view, onPick };
}

afterEach(() => vi.useRealTimers());

describe("useCombobox — picker", () => {
  it("opens on focus and on an arrow, and wraps", () => {
    const { result } = setup();
    expect(result.current.open).toBe(false);
    expect(result.current.inputProps["aria-controls"]).toBe(result.current.listProps.id);

    act(() => result.current.inputProps.onFocus!());
    expect(result.current.open).toBe(true);
    expect(result.current.inputProps["aria-activedescendant"]).toBe(
      result.current.optionProps(0).id,
    );

    const up = key("ArrowUp");
    act(() => result.current.inputProps.onKeyDown(up));
    expect(up.preventDefault).toHaveBeenCalled();
    expect(result.current.active).toBe(2);
  });

  it("leaves Home and End to the caret", () => {
    const { result } = setup();
    act(() => result.current.inputProps.onFocus!());
    const home = key("Home");
    act(() => result.current.inputProps.onKeyDown(home));
    expect(home.preventDefault).not.toHaveBeenCalled();
  });

  it("picks the highlight on Enter, and lets Enter through with no row", () => {
    const { result, onPick, rerender } = setup();
    act(() => result.current.inputProps.onFocus!());
    act(() => result.current.inputProps.onKeyDown(key("ArrowDown")));
    const enter = key("Enter");
    act(() => result.current.inputProps.onKeyDown(enter));
    expect(onPick).toHaveBeenCalledWith(1);
    expect(enter.preventDefault).toHaveBeenCalled();

    rerender({ count: 0 });
    const empty = key("Enter");
    act(() => result.current.inputProps.onKeyDown(empty));
    expect(empty.preventDefault).not.toHaveBeenCalled();
    expect(result.current.inputProps["aria-activedescendant"]).toBeUndefined();
  });

  it("keeps the list 120 ms after the blur, for a click to land", () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => result.current.inputProps.onFocus!());
    act(() => result.current.inputProps.onBlur());
    act(() => vi.advanceTimersByTime(119));
    expect(result.current.open).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.open).toBe(false);
  });

  it("closes on Escape without stopping the event", () => {
    const { result } = setup();
    act(() => result.current.inputProps.onFocus!());
    const esc = key("Escape");
    act(() => result.current.inputProps.onKeyDown(esc));
    expect(result.current.open).toBe(false);
    expect(esc.preventDefault).toHaveBeenCalled();
    expect(esc.stopPropagation).not.toHaveBeenCalled();
  });

  it("clamps the highlight to the last row when the list shrinks under it", () => {
    const { result, onPick, rerender } = setup({ count: 5 });
    act(() => result.current.inputProps.onFocus!());
    act(() => result.current.inputProps.onKeyDown(key("ArrowUp")));
    expect(result.current.active).toBe(4);

    rerender({ count: 2 });
    expect(result.current.active).toBe(1);
    expect(result.current.inputProps["aria-activedescendant"]).toBe(
      result.current.optionProps(1).id,
    );
    act(() => result.current.inputProps.onKeyDown(key("Enter")));
    expect(onPick).toHaveBeenCalledWith(1);
  });

  it("starts the highlight over when the query changes", () => {
    const { result, rerender } = setup({ query: "a" });
    act(() => result.current.inputProps.onFocus!());
    act(() => result.current.inputProps.onKeyDown(key("ArrowDown")));
    expect(result.current.active).toBe(1);
    rerender({ query: "ab" });
    expect(result.current.active).toBe(0);
  });
});

describe("useCombobox — completion", () => {
  it("shows as soon as there are rows, and not before", () => {
    const { result, rerender } = setup({ completion: true, count: 0 });
    expect(result.current.open).toBe(false);
    expect(result.current.inputProps["aria-controls"]).toBeUndefined();
    rerender({ count: 2 });
    expect(result.current.open).toBe(true);
    expect(result.current.inputProps.onFocus).toBeUndefined();
  });

  it("dismisses on Escape and keeps the event from the page", () => {
    const { result } = setup({ completion: true });
    const esc = key("Escape");
    act(() => result.current.inputProps.onKeyDown(esc));
    expect(result.current.open).toBe(false);
    expect(esc.stopPropagation).toHaveBeenCalled();

    // Dismissed, the arrows do not bring it back.
    const down = key("ArrowDown");
    act(() => result.current.inputProps.onKeyDown(down));
    expect(result.current.open).toBe(false);
    expect(down.preventDefault).not.toHaveBeenCalled();
  });

  it("dismisses at once on blur", () => {
    const { result } = setup({ completion: true });
    act(() => result.current.inputProps.onBlur());
    expect(result.current.open).toBe(false);
  });

  it("names the rows with the ids it is given", () => {
    const { result } = setup({
      completion: true,
      listId: "fixed",
      optionId: (i) => `fixed-${["a", "b", "c"][i]}`,
    });
    expect(result.current.listProps.id).toBe("fixed");
    expect(result.current.inputProps["aria-activedescendant"]).toBe("fixed-a");
  });
});
