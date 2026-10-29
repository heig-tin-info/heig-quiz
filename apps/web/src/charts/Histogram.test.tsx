import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { histogram } from "@quiz/domain";

import { renderWithProviders } from "../test/render";
import { bucketLabel, Histogram } from "./Histogram";

/*
 * The buckets are `@quiz/domain`'s, not the screen's: the histogram draws
 * what the rule produced, so a grade on a boundary lands in the same bar as
 * in the API's own statistics.
 */

describe("Histogram", () => {
  it("draws the half-grade buckets of @quiz/domain, 1.0 to 6.0", () => {
    const buckets = histogram([1, 3.5, 3.75, 4, 6]);
    expect(buckets).toHaveLength(11);
    renderWithProviders(<Histogram buckets={buckets} />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(11);
    // 3.5 and 3.75 share [3.5, 4.0); 4.0 opens the next one; 6.0 stands alone.
    expect(within(rows[5]!).getByRole("rowheader")).toHaveTextContent("3.5–4.0");
    expect(within(rows[5]!).getByRole("cell")).toHaveTextContent("2");
    expect(within(rows[6]!).getByRole("cell")).toHaveTextContent("1");
    expect(within(rows[10]!).getByRole("rowheader")).toHaveTextContent("6.0");
    expect(within(rows[10]!).getByRole("cell")).toHaveTextContent("1");
  });

  it("is a reading without onSelect, and a row of buttons with it", async () => {
    const buckets = histogram([1, 4, 4.2]);
    const { rerender } = renderWithProviders(<Histogram buckets={buckets} />);
    expect(screen.queryAllByRole("button")).toEqual([]);

    const onSelect = vi.fn();
    rerender(<Histogram buckets={buckets} onSelect={onSelect} selected={4} />);
    expect(screen.getAllByRole("button")).toHaveLength(11);
    expect(screen.getByRole("button", { name: "4.0–4.5: 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1.0–1.5: 1" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "1.0–1.5: 1" }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("names the top bucket by its exact grade, not by a range", () => {
    expect(bucketLabel(6, 0.5)).toBe("6.0");
    expect(bucketLabel(1, 0.5)).toBe("1.0–1.5");
  });
});
