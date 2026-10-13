import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { PointsInput, pointsRange, pointsSuffix, type PointsBounds } from "./PointsInput";

/*
 * The points over their maximum, one pill (F-PROJ-25 as amended): the range
 * of each kind, its suffix, its accessible name, the commit when the field is
 * left, and a value outside the range marked and never sent.
 */

describe("pointsRange and pointsSuffix", () => {
  it.each<[string, PointsBounds, [number, number], string]>([
    ["a maximum", { max: 4 }, [0, 4], "/ 4"],
    ["a penalty", { max: -3 }, [-3, 0], "/ −3"],
    ["a bonus", { max: 0, bonus: 1 }, [0, 1], "/ +1"],
    ["a floor of its own (negative marking)", { max: 2, min: -2 }, [-2, 2], "/ 2"],
    ["half points", { max: 2.5 }, [0, 2.5], "/ 2.5"],
  ])("bounds %s", (_, bounds, range, suffix) => {
    expect(pointsRange(bounds)).toEqual(range);
    expect(pointsSuffix(bounds)).toBe(suffix);
  });
});

function setup(bounds: PointsBounds, value: number | null = null, locale: "en" | "fr" = "en") {
  const onCommit = vi.fn();
  const onInvalid = vi.fn();
  renderWithProviders(<PointsInput {...bounds} value={value} label="Tests" onCommit={onCommit} onInvalid={onInvalid} />, { locale });
  return { onCommit, onInvalid, input: screen.getByRole("spinbutton") };
}

describe("PointsInput", () => {
  it("names what it grades and its maximum, the suffix hidden from a screen reader", () => {
    const { input } = setup({ max: 4 }, 3);
    expect(input).toHaveAccessibleName("Tests, points out of 4");
    expect(input).toHaveValue(3);
    const suffix = screen.getByText("/ 4");
    expect(suffix).toHaveAttribute("aria-hidden");
  });

  it.each<[string, PointsBounds, string, string]>([
    ["a penalty", { max: -3 }, "Tests, penalty points, at most 3", "Tests, points de pénalité, au plus 3"],
    ["a bonus", { max: 0, bonus: 1 }, "Tests, bonus points, at most 1", "Tests, points de bonus, au plus 1"],
    ["a maximum", { max: 4 }, "Tests, points out of 4", "Tests, points sur 4"],
  ])("words %s in both languages", (_, bounds, en, fr) => {
    expect(setup(bounds).input).toHaveAccessibleName(en);
    cleanup();
    expect(setup(bounds, null, "fr").input).toHaveAccessibleName(fr);
  });

  it("is empty with a dash when there are no points yet", () => {
    const { input } = setup({ max: 4 });
    expect(input).toHaveValue(null);
    expect(input).toHaveAttribute("placeholder", "—");
  });

  it("commits on Enter and on blur, not while typing, and not when nothing changed", async () => {
    const { input, onCommit } = setup({ max: 4 }, 1);
    await userEvent.clear(input);
    await userEvent.type(input, "2.5");
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenLastCalledWith(2.5);
    expect(input).not.toHaveFocus();

    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, "3");
    await userEvent.tab();
    expect(onCommit).toHaveBeenLastCalledWith(3);
  });

  it("sends nothing for an empty field", async () => {
    const { input, onCommit } = setup({ max: 4 }, 2);
    await userEvent.clear(input);
    await userEvent.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each<[string, PointsBounds, string, number]>([
    ["above a maximum", { max: 4 }, "5", 4],
    ["below zero for a maximum", { max: 4 }, "-1", 0],
    ["below a penalty", { max: -3 }, "-4", -2],
    ["above zero for a penalty", { max: -3 }, "1", -3],
    ["above a bonus", { max: 0, bonus: 1 }, "2", 1],
  ])("marks a value %s and never sends it, then sends one inside", async (_, bounds, outside, inside) => {
    const { input, onCommit, onInvalid } = setup(bounds);
    await userEvent.type(input, `${outside}{Enter}`);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(onInvalid).toHaveBeenLastCalledWith(true);
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, `${inside}{Enter}`);
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(onInvalid).toHaveBeenLastCalledWith(false);
    expect(onCommit).toHaveBeenCalledWith(inside);
  });

  it("is disabled when it cannot be written", () => {
    renderWithProviders(<PointsInput max={4} value={2} label="Tests" disabled onCommit={vi.fn()} />);
    expect(screen.getByRole("spinbutton")).toBeDisabled();
  });
});
