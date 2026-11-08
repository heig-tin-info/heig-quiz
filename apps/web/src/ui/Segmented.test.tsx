import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Segmented } from ".";

describe("Segmented", () => {
  it("is a radiogroup of real radios and reports the change", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Segmented
        name="classrooms-view"
        value="cards"
        onChange={onChange}
        options={[
          { value: "cards", label: "Card view" },
          { value: "list", label: "List view" },
        ]}
      />,
    );
    const group = screen.getByRole("radiogroup");
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "Card view" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "List view" }));
    expect(onChange).toHaveBeenCalledWith("list");
  });
});
