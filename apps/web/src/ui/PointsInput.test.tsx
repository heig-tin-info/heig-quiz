import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { PointsInput, pointsRange, pointsSuffix, type PointsBounds } from "./PointsInput";

/*
 * The points over their maximum, one pill (F-PROJ-25 as amended): the range
 * and the suffix of each kind, its name and description, the commit when the
 * field is left, and a value outside the range said and never sent.
 */

/** Per kind: bounds, range, suffix, description en / fr, a value outside, one inside. */
const KINDS: [string, PointsBounds, [number, number], string, string, string, string, number][] = [
  ["a maximum", { max: 4 }, [0, 4], "/ 4", "points out of 4", "points sur 4", "5", 2.5],
  ["a penalty", { max: -3 }, [-3, 0], "/ −3", "penalty points, at most 3", "points de pénalité, au plus 3", "-4", -2],
  ["a bonus", { max: 0, bonus: 1 }, [0, 1], "/ +1", "bonus points, at most 1", "points de bonus, au plus 1", "2", 1],
];

function setup(bounds: PointsBounds, value: number | null = null, locale: "en" | "fr" = "en") {
  const onCommit = vi.fn();
  renderWithProviders(<PointsInput bounds={bounds} value={value} label="Tests" onCommit={onCommit} />, { locale });
  return { onCommit, input: screen.getByRole("spinbutton", { name: "Tests" }) };
}

describe.each(KINDS)("PointsInput, %s", (_, bounds, range, suffix, en, fr, outside, inside) => {
  it("bounds, shows and describes its range, the suffix hidden from a screen reader", () => {
    expect(pointsRange(bounds)).toEqual(range);
    expect(pointsSuffix(bounds)).toBe(suffix);
    expect(setup(bounds).input).toHaveAccessibleDescription(en);
    expect(screen.getByText(suffix)).toHaveAttribute("aria-hidden");
    cleanup();
    expect(setup(bounds, null, "fr").input).toHaveAccessibleDescription(fr);
  });

  it("says a value outside the range and never sends it, then sends one inside", async () => {
    const { input, onCommit } = setup(bounds);
    await userEvent.type(input, `${outside}{Enter}`);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(`${en} From ${range[0]} to ${range[1]}`);
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, `${inside}{Enter}`);
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(/^From /)).toBeNull();
    expect(onCommit).toHaveBeenCalledWith(inside);
  });
});

describe("PointsInput", () => {
  it("is empty with a dash when there are no points yet", () => {
    const { input } = setup({ max: 4 });
    expect(input).toHaveValue(null);
    expect(input).toHaveAttribute("placeholder", "—");
  });

  it("commits on blur, not while typing, and sends nothing for an empty field or an unchanged one", async () => {
    const { input, onCommit } = setup({ max: 4 }, 1);
    await userEvent.clear(input);
    await userEvent.type(input, "3");
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(3);

    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.tab();
    await userEvent.click(input);
    await userEvent.type(input, "1");
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledOnce();
  });
});
