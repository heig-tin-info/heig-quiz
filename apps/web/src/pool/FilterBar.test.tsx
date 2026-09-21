import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { EMPTY_FILTERS, type QuestionFilters } from "./filters";
import { FilterBar } from "./FilterBar";

/*
 * The filter sheet of the pool screen, on its own: what a chip reports, what
 * the tag search narrows, and where the cap on the tag list falls. The
 * page-level wiring (the query string these filters produce) is covered by
 * PoolView.test.tsx and filters.test.ts.
 */

const TAGS = Array.from({ length: 24 }, (_, i) => `tag-${String(i + 1).padStart(2, "0")}`);

function setup(filters: Partial<QuestionFilters> = {}, tags: string[] = TAGS) {
  const onChange = vi.fn();
  renderWithProviders(
    <FilterBar filters={{ ...EMPTY_FILTERS, ...filters }} onChange={onChange} tags={tags} total={7} />,
  );
  return { onChange, user: userEvent.setup() };
}

async function openSheet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Filters/ }));
  return screen.findByRole("dialog");
}

describe("FilterBar", () => {
  it("offers each type as a pressed-or-not chip, with its icon", async () => {
    const { onChange, user } = setup({ types: ["mcq"] });
    const sheet = await openSheet(user);
    const mcq = within(sheet).getByRole("button", { name: "Multiple choice" });
    expect(mcq).toHaveAttribute("aria-pressed", "true");
    const code = within(sheet).getByRole("button", { name: "Code" });
    expect(code).toHaveAttribute("aria-pressed", "false");
    await user.click(code);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ types: ["mcq", "code"] }));
  });

  it("names a difficulty chip by its scale, not by its digit", async () => {
    const { onChange, user } = setup();
    const sheet = await openSheet(user);
    await user.click(within(sheet).getByRole("button", { name: "Difficulty 3 of 5" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ difficulties: [3] }));
  });

  it("caps the tag chips at twenty and offers the rest behind one chip", async () => {
    const { user } = setup();
    const sheet = await openSheet(user);
    expect(within(sheet).getByRole("button", { name: "#tag-20" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "#tag-21" })).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Show all (24)" }));
    expect(within(sheet).getByRole("button", { name: "#tag-24" })).toBeInTheDocument();
  });

  it("keeps a selected tag in the list even past the cap, and first", async () => {
    const { user } = setup({ tags: ["tag-24"] });
    const sheet = await openSheet(user);
    const picked = within(sheet).getByRole("button", { name: "#tag-24" });
    expect(picked).toHaveAttribute("aria-pressed", "true");
    // First of the pills, before tag-01: what is on must be reachable.
    const chips = within(sheet).getAllByRole("button", { name: /^#?tag-/ });
    expect(chips[0]).toBe(picked);
  });

  it("narrows the tag chips as the search is typed", async () => {
    const { user } = setup();
    const sheet = await openSheet(user);
    await user.type(within(sheet).getByLabelText("Search a tag"), "tag22");
    expect(within(sheet).getByRole("button", { name: "#tag-22" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "#tag-01" })).not.toBeInTheDocument();
  });

  it("toggles the first match on Enter", async () => {
    const { onChange, user } = setup();
    const sheet = await openSheet(user);
    await user.type(within(sheet).getByLabelText("Search a tag"), "tag07{Enter}");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tags: ["tag-07"] }));
  });

  it("says so when nothing matches", async () => {
    const { user } = setup();
    const sheet = await openSheet(user);
    await user.type(within(sheet).getByLabelText("Search a tag"), "zzzz");
    expect(within(sheet).getByText("No tag matches.")).toBeInTheDocument();
  });

  it("keeps the deleted switch and the removable chips of the bar", async () => {
    const { onChange, user } = setup({ tags: ["tag-01"], includeDeleted: true });
    // Under the bar, outside the sheet: one chip per active filter.
    await user.click(screen.getByRole("button", { name: "Clear filters — #tag-01" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tags: [] }));
    const sheet = await openSheet(user);
    expect(within(sheet).getByRole("switch", { name: "Show deleted questions" })).toBeChecked();
  });
});
