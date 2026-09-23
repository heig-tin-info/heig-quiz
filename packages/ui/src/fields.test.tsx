import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CheckboxField, FieldCell, NumberField, Segmented } from "./fields.js";

describe("Segmented", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
  ] as const;

  it("is a named radiogroup of native radios", () => {
    const onChange = vi.fn();
    render(
      <>
        <span id="lbl">Kind</span>
        <Segmented name="k" labelledBy="lbl" value="a" options={options} onChange={onChange} />
      </>,
    );
    const group = screen.getByRole("radiogroup", { name: "Kind" });
    expect(group.className).toContain("rounded-full");
    expect(screen.getByRole("radio", { name: "Alpha" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("becomes a recessed panel when it wraps, and dims when disabled", () => {
    render(<Segmented name="k" value="a" options={options} onChange={() => {}} wrap disabled />);
    const group = screen.getByRole("radiogroup");
    expect(group.className).toContain("rounded-card");
    expect(group.className).toContain("opacity-60");
    expect(screen.getByRole("radio", { name: "Beta" })).toBeDisabled();
  });
});

describe("FieldCell", () => {
  it("labels its control and takes the caller's column classes", () => {
    const { container } = render(
      <FieldCell label="Name" htmlFor="n" className="flex-1">
        <input id="n" />
      </FieldCell>,
    );
    expect(screen.getByLabelText("Name").id).toBe("n");
    expect(container.firstElementChild?.className).toBe("flex flex-col gap-1.5 flex-1");
  });
});

describe("NumberField", () => {
  it("reports numbers, and an emptied field as 0 without onClear", () => {
    const onChange = vi.fn();
    render(<NumberField id="p" label="Points" value={2} onChange={onChange} />);
    const field = screen.getByLabelText("Points");
    expect(field).toHaveValue(2);
    fireEvent.change(field, { target: { value: "3.5" } });
    expect(onChange).toHaveBeenLastCalledWith(3.5);
    fireEvent.change(field, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("calls onClear for an emptied nullable field, and shows null as empty", () => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    render(
      <NumberField
        id="t"
        label="Time"
        aria-label="Time 1"
        value={500}
        onChange={onChange}
        onClear={onClear}
      />,
    );
    fireEvent.change(screen.getByLabelText("Time 1"), { target: { value: "" } });
    expect(onClear).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never shows NaN", () => {
    render(<NumberField id="x" label="X" value={Number.NaN} onChange={() => {}} />);
    expect(screen.getByLabelText("X")).toHaveValue(null);
  });
});

describe("CheckboxField", () => {
  it("is a native checkbox inside its label", () => {
    const onChange = vi.fn();
    render(<CheckboxField label="Hidden" aria-label="Hidden 2" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Hidden 2"));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByText("Hidden").className).toContain("h-8.5");
  });
});
