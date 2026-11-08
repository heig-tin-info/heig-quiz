import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Field, Select, Textarea } from ".";

describe("Field and Select", () => {
  it("binds the label to the control and types into it", async () => {
    renderWithProviders(<Field label="Classroom name" defaultValue="" />);
    const input = screen.getByLabelText("Classroom name");
    await userEvent.type(input, "PRG1");
    expect(input).toHaveValue("PRG1");
  });

  it("shows a suffix unit inside the field and reads it with the value", () => {
    renderWithProviders(<Field label="Duration" suffix="min" type="number" defaultValue={45} />);
    expect(screen.getByLabelText("Duration")).toHaveAccessibleDescription("min");
    expect(screen.getByText("min")).toBeVisible();
  });

  it("puts the height on the control and the width on the wrapper", () => {
    renderWithProviders(
      <>
        <Field label="Default" />
        <Field label="Dense" size="sm" width="w-32" />
        <Field label="Stretched" fullWidth />
      </>,
    );
    // The wrapper is a plain div: a <label> around the control would swallow
    // the help button, so the label points at the control with htmlFor.
    const byLabel = (label: string) => screen.getByLabelText(label);
    expect(byLabel("Dense")).toHaveClass("h-7");
    expect(byLabel("Dense").parentElement).toHaveClass("w-32");
    expect(byLabel("Stretched").parentElement).toHaveClass("w-full");
  });

  it("labels a Select and carries its width on the control wrapper", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Select label="GitHub organization" width="w-40" value="" onChange={onChange}>
        <option value="">Pick an organization</option>
        <option value="heig-prg1-2026">heig-prg1-2026</option>
      </Select>,
    );
    const select = screen.getByLabelText("GitHub organization");
    expect(select.parentElement).toHaveClass("w-40");
    await userEvent.selectOptions(select, "heig-prg1-2026");
    expect(onChange).toHaveBeenCalled();
  });
});

describe("Field help", () => {
  it("names the control even next to a help button, which stays its own button", async () => {
    renderWithProviders(
      <>
        <Field label="Classroom name" help="classrooms" defaultValue="" />
        <Select label="Source repository" help="assignment-source" defaultValue="">
          <option value="">Pick one</option>
          <option value="labo-02">labo-02</option>
        </Select>
        <Textarea label="Roster CSV" help="import-roster" defaultValue="" />
      </>,
    );
    // A <label> wrapping the "?" would make that button the labelled control
    // and leave the real ones nameless.
    expect(screen.getByLabelText("Classroom name").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Source repository").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Roster CSV").tagName).toBe("TEXTAREA");
    expect(screen.getAllByRole("button", { name: "Help" })).toHaveLength(3);
    // Clicking the label text lands on the input, not on the help drawer.
    await userEvent.click(screen.getByText("Classroom name"));
    expect(document.activeElement).toBe(screen.getByLabelText("Classroom name"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
