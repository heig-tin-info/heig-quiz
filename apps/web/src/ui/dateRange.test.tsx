import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Field } from "./controls";
import { addDays, addMonths, DateRangeField, monthWeeks, pickDay, type RangeChange } from "./dateRange";

/*
 * What the period picker promises: two clicks make a period, the times ride
 * along, nothing is written until the card closes, and a refusal gives the
 * stored values back.
 */

const local = (y: number, m: number, d: number, h = 8, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

const OPENS = local(2026, 10, 12, 8, 0);
const CLOSES = local(2026, 10, 19, 18, 30);

function setup(value: { start: string | null; end: string | null } = { start: OPENS, end: CLOSES }) {
  const onCommit = vi.fn<(change: RangeChange, reset: () => void) => void>();
  renderWithProviders(
    <DateRangeField
      label="Availability"
      start={{ id: "opens", label: "Opens at", value: value.start }}
      end={{ id: "closes", label: "Closes at", value: value.end }}
      onCommit={onCommit}
    />,
  );
  return { onCommit };
}

const day = (n: number) => screen.getByRole("button", { name: new RegExp(`October ${n}, 2026`) });

describe("calendar arithmetic", () => {
  it("moves by days and by months, clamping to the month's last day", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("lays a month out in weeks that start on the asked day", () => {
    // October 2026 starts on a Thursday.
    const monday = monthWeeks("2026-10-14", 1);
    expect(monday[0]!.findIndex(Boolean)).toBe(3);
    expect(monday.flat().filter(Boolean)).toHaveLength(31);
    expect(monthWeeks("2026-10-14", 0)[0]!.findIndex(Boolean)).toBe(4);
  });

  it("starts a period over from a last day that falls before the first", () => {
    const draft = { startDay: "2026-10-12", startTime: "08:00", endDay: null, endTime: "23:59" };
    expect(pickDay(draft, "end", "2026-10-19")).toMatchObject({ draft: { endDay: "2026-10-19" }, picking: "start" });
    expect(pickDay(draft, "end", "2026-10-05")).toMatchObject({
      draft: { startDay: "2026-10-05", endDay: null },
      picking: "end",
    });
  });
});

describe("DateRangeField", () => {
  it("shows both ends on the trigger, and 'Not set' for an empty one", () => {
    setup({ start: OPENS, end: null });
    expect(screen.getByRole("button", { name: /^opens at.*2026-10-12 08:00/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^closes at.*not set/i })).toBeInTheDocument();
  });

  it("writes both ends once, when the card closes, after two clicks", async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();
    await user.click(screen.getByRole("button", { name: /^opens at/i }));
    const dialog = screen.getByRole("dialog", { name: "Availability" });
    expect(within(dialog).getByRole("grid")).toBeInTheDocument();

    await user.click(day(14));
    await user.click(day(21));
    expect(onCommit).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toEqual({ start: local(2026, 10, 14, 8, 0), end: local(2026, 10, 21, 18, 30) });
    expect(screen.getByRole("button", { name: /^opens at.*2026-10-14 08:00/i })).toBeInTheDocument();
  });

  it("opens on the end that was clicked, and writes only what changed", async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();
    await user.click(screen.getByRole("button", { name: /^closes at/i }));
    await user.click(day(25));
    await user.keyboard("{Escape}");
    expect(onCommit.mock.calls[0]![0]).toEqual({ end: local(2026, 10, 25, 18, 30) });
  });

  it("takes a time for each end", async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();
    await user.click(screen.getByRole("button", { name: /^opens at/i }));
    const start = screen.getByLabelText("Opens at, time");
    await user.clear(start);
    await user.type(start, "09:15");
    await user.keyboard("{Escape}");
    expect(onCommit.mock.calls[0]![0]).toEqual({ start: local(2026, 10, 12, 9, 15) });
  });

  it("writes nothing when nothing changed", async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();
    await user.click(screen.getByRole("button", { name: /^opens at/i }));
    await user.keyboard("{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("puts the stored values back when the write is refused", async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();
    await user.click(screen.getByRole("button", { name: /^opens at/i }));
    await user.click(day(14));
    await user.click(day(21));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /^closes at.*2026-10-21/i })).toBeInTheDocument();

    const reset = onCommit.mock.calls[0]![1];
    await vi.waitFor(() => reset());
    expect(await screen.findByRole("button", { name: /^opens at.*2026-10-12 08:00/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^closes at.*2026-10-19 18:30/i })).toBeInTheDocument();
  });

  it("walks the days with the arrow keys and picks with Enter, then closes with Escape", async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();
    screen.getByRole("button", { name: /^opens at/i }).focus();
    await user.keyboard("{Enter}");
    // The first picked day is the start: focus the stored one, move two on.
    day(12).focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(day(14)).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    expect(day(21)).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCommit.mock.calls[0]![0]).toEqual({ start: local(2026, 10, 14, 8, 0), end: local(2026, 10, 21, 18, 30) });
  });

  it("carries the keyboard across a month with PageDown", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /^opens at/i }));
    day(12).focus();
    await user.keyboard("{PageDown}");
    expect(screen.getByRole("grid", { name: /november 2026/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /November 12, 2026/ })).toHaveFocus();
  });

  it("marks the period for assistive technology", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /^opens at/i }));
    expect(day(12)).toHaveAccessibleName(/opens at$/i);
    expect(day(19)).toHaveAccessibleName(/closes at$/i);
    expect(day(15).closest("td")).toHaveAttribute("aria-selected", "true");
    expect(day(22).closest("td")).toHaveAttribute("aria-selected", "false");
  });
});

describe("Field suffix", () => {
  it("shows the unit inside the field and reads it with the value", () => {
    renderWithProviders(<Field label="Duration" suffix="min" type="number" defaultValue={45} />);
    const input = screen.getByLabelText("Duration");
    expect(input).toHaveAccessibleDescription("min");
    expect(screen.getByText("min")).toBeVisible();
  });

  it("changes nothing for a field without one", () => {
    renderWithProviders(<Field label="Name" />);
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-describedby");
  });
});
