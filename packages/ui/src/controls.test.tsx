import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button, IconButton, Select, TextInput } from "./controls.js";

describe("TextInput", () => {
  it("is a one-line pill on the step of the scale it is given", () => {
    render(<TextInput aria-label="Name" size="sm" className="w-full" />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input.className).toContain("rounded-control");
    expect(input.className).toContain("h-7");
    expect(input.className).toContain("w-full");
    expect(input).toHaveAttribute("type", "text");
  });

  it("is 34 px by default and keeps a type of its own", () => {
    render(<TextInput aria-label="Count" type="number" />);
    const input = screen.getByLabelText("Count");
    expect(input.className).toContain("h-8.5");
    expect(input).toHaveAttribute("type", "number");
  });
});

describe("Select", () => {
  it("wraps the native select with a chevron, the width on the wrapper", () => {
    const onChange = vi.fn();
    const { container } = render(
      <Select aria-label="Kind" width="w-40" onChange={onChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Kind" });
    expect(select.className).toContain("rounded-control");
    expect(select.className).toContain("appearance-none");
    expect(container.firstElementChild?.className).toContain("w-40");
    expect(container.querySelector("svg")).not.toBeNull();
    fireEvent.change(select, { target: { value: "b" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("sits in running text when inline", () => {
    const { container } = render(
      <Select aria-label="Blank" inline wrapperClassName="mx-0.5">
        <option>x</option>
      </Select>,
    );
    expect(container.firstElementChild?.className).toContain("inline-block");
    expect(container.firstElementChild?.className).toContain("mx-0.5");
  });
});

describe("Button and IconButton", () => {
  it("is a type=button pill of the scale, secondary by default", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.className).toContain("rounded-control");
    expect(button.className).toContain("h-8.5");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });

  it("lets a form button submit", () => {
    render(<Button type="submit" variant="primary">Send</Button>);
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("type", "submit");
  });

  it("names an icon-only disc by its label, in two sizes", () => {
    render(
      <>
        <IconButton label="Remove" size="xs">x</IconButton>
        <IconButton label="Add">+</IconButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "Remove" }).className).toContain("size-6");
    expect(screen.getByRole("button", { name: "Add" }).className).toContain("size-7");
  });
});
