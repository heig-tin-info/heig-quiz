import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button, IconButton, Select, TextInput } from "./controls.js";

describe("TextInput", () => {
  it("is a text field unless given a type", () => {
    render(
      <>
        <TextInput aria-label="Name" />
        <TextInput aria-label="Count" type="number" />
      </>,
    );
    expect(screen.getByLabelText("Name")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Count")).toHaveAttribute("type", "number");
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
    expect(container.firstElementChild).toHaveClass("w-40");
    expect(container.querySelector("svg")).not.toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("sits in running text when inline", () => {
    const { container } = render(
      <Select aria-label="Blank" inline wrapperClassName="mx-0.5">
        <option>x</option>
      </Select>,
    );
    expect(container.firstElementChild).toHaveClass("inline-block", "mx-0.5");
  });
});

describe("Button and IconButton", () => {
  it("is a type=button that clicks, and lets a form button submit", () => {
    const onClick = vi.fn();
    render(
      <>
        <Button onClick={onClick}>Go</Button>
        <Button type="submit">Send</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "button");
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("type", "submit");
  });

  it("names an icon-only disc by its label and reports a pressed state", () => {
    render(
      <>
        <IconButton label="Remove" danger>x</IconButton>
        <IconButton label="Filter" active>+</IconButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "Remove" })).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Filter" })).toHaveAttribute("aria-pressed", "true");
  });
});
