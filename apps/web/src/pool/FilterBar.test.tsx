import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { EMPTY_FILTERS, type QuestionFilters } from "./filters";
import { FilterBar } from "./FilterBar";
import type { GroupBy } from "./QuestionGroups";

/*
 * The filter sheet of the pool screen, on its own: what a chip reports, what
 * the tag search narrows, and where the cap on the tag list falls. The
 * page-level wiring (the query string these filters produce) is covered by
 * PoolView.test.tsx and filters.test.ts.
 */

const TAGS = Array.from({ length: 24 }, (_, i) => `tag-${String(i + 1).padStart(2, "0")}`);

/**
 * The bar is fully controlled, so a test that types into the field has to
 * hold the state the way the page does — otherwise the value never changes
 * and neither does anything that reads it (the completion popover above all).
 * The spy still sees every call.
 */
function Host({
  initial,
  tags,
  onChange,
  onView,
  onGroup,
}: {
  initial: QuestionFilters;
  tags: string[];
  onChange: (next: QuestionFilters) => void;
  onView: (next: "cards" | "list") => void;
  onGroup: (next: GroupBy) => void;
}) {
  const [filters, setFilters] = useState(initial);
  return (
    <FilterBar
      filters={filters}
      onChange={(next) => {
        onChange(next);
        setFilters(next);
      }}
      tags={tags}
      total={7}
      view="list"
      onView={onView}
      group="none"
      onGroup={onGroup}
    />
  );
}

function setup(filters: Partial<QuestionFilters> = {}, tags: string[] = TAGS) {
  const onChange = vi.fn();
  const onView = vi.fn();
  const onGroup = vi.fn();
  renderWithProviders(
    <Host
      initial={{ ...EMPTY_FILTERS, ...filters }}
      tags={tags}
      onChange={onChange}
      onView={onView}
      onGroup={onGroup}
    />,
  );
  return { onChange, onView, onGroup, user: userEvent.setup() };
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

describe("FilterBar · the search box as a language", () => {
  it("shows a chip for a filter that was TYPED, not ticked", async () => {
    setup({ q: "tag:pointeurs segfault" });
    expect(screen.getByText("#pointeurs")).toBeInTheDocument();
  });

  it("removing that chip takes the token out of the text as well", async () => {
    const { onChange, user } = setup({ q: "tag:pointeurs segfault" });
    await user.click(screen.getByRole("button", { name: "Clear filters — #pointeurs" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ q: "segfault", tags: [] }));
  });

  it("shows the version bounds as one chip, and clears both at once", async () => {
    const { onChange, user } = setup({ q: "version:>1" });
    await user.click(screen.getByRole("button", { name: /Version 2 and up/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ q: "", versionMin: null, versionMax: null }),
    );
  });

  it("offers the pool's tags once the caret sits after tag:", async () => {
    const { user } = setup();
    const field = screen.getByLabelText("Search a question");
    await user.type(field, "tag:");
    const list = await screen.findByRole("listbox");
    expect(within(list).getByText("#tag-01")).toBeInTheDocument();
  });

  it("narrows that list by what follows, and Enter inserts the tag", async () => {
    const { onChange, user } = setup();
    const field = screen.getByLabelText("Search a question");
    await user.type(field, "tag:tag07");
    const list = await screen.findByRole("listbox");
    expect(within(list).getByText("#tag-07")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ q: "tag:tag-07 " }));
  });

  it("offers the four types after type:, by their label", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Search a question"), "type:");
    const list = await screen.findByRole("listbox");
    expect(within(list).getByText("Multiple choice")).toBeInTheDocument();
    expect(within(list).getByText("Code")).toBeInTheDocument();
  });

  it("closes the list on Escape without emptying the field", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Search a question"), "tag:");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("documents the grammar under the field", () => {
    setup();
    expect(screen.getByText(/tag:name/)).toBeInTheDocument();
  });
});

describe("FilterBar · how the list is drawn", () => {
  it("switches between the cards and the table", async () => {
    const { onView, user } = setup();
    await user.click(screen.getByRole("radio", { name: "Cards" }));
    expect(onView).toHaveBeenCalledWith("cards");
  });

  it("carries the grouping and the sort", async () => {
    const { onChange, onGroup, user } = setup();
    // Two segmented tracks, and "Type" is a choice in both: the radiogroup's
    // own name is what tells them apart, for the test as for a screen reader.
    const grouping = screen.getByRole("radiogroup", { name: "Group by" });
    await user.click(within(grouping).getByRole("radio", { name: "Type" }));
    expect(onGroup).toHaveBeenCalledWith("type");
    const sorting = screen.getByRole("radiogroup", { name: "Sort by" });
    await user.click(within(sorting).getByRole("radio", { name: "Name" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sort: "name" }));
  });

  it("flips the direction from one button", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Descending" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dir: "asc" }));
  });
});
