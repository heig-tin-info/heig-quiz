import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { ProtectedFiles } from "./ProtectedFiles";

/*
 * The protected files (F-PROJ-01, F-PROJ-08, ADR-106 §3): the source's
 * suggestions as checkboxes, any other file added by its path as a chip,
 * checked by the contract's rule before it reaches the list.
 */

const SUGGESTED = ["criteria.yml", "README.md"];

function Harness({ initial, onChange }: { initial: string[]; onChange: (files: string[]) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ProtectedFiles
      suggested={SUGGESTED}
      files={["Makefile", "tests/test_lab.py", "README.md"]}
      value={value}
      onChange={(files) => {
        setValue(files);
        onChange(files);
      }}
    />
  );
}

const field = () => screen.getByLabelText("Add a file");

describe("ProtectedFiles", () => {
  it("adds a path with Enter or the Add button, and shows it as a chip", async () => {
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={["criteria.yml"]} onChange={onChange} />);
    await userEvent.type(field(), "tests/test_lab.py{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["criteria.yml", "tests/test_lab.py"]);
    expect(field()).toHaveValue("");
    await userEvent.type(field(), "Makefile");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onChange).toHaveBeenLastCalledWith(["criteria.yml", "tests/test_lab.py", "Makefile"]);
    const chips = screen.getByRole("list", { name: "Files added by path" });
    expect(chips).toHaveTextContent("tests/test_lab.py");
    expect(chips).toHaveTextContent("Makefile");
    // A suggestion stays a checkbox, never a chip.
    expect(chips).not.toHaveTextContent("criteria.yml");
  });

  it("offers the source's files not yet protected as completions", () => {
    renderWithProviders(<Harness initial={["README.md"]} onChange={vi.fn()} />);
    const list = document.getElementById(field().getAttribute("list")!)!;
    expect([...list.querySelectorAll("option")].map((o) => o.value)).toEqual(["Makefile", "tests/test_lab.py"]);
  });

  it.each(["../x", "/etc/passwd", "tests/../x", "a\\b"])("refuses %s, with the rule said under the field", async (path) => {
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={[]} onChange={onChange} />);
    await userEvent.type(field(), `${path}{Enter}`);
    expect(onChange).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/A path relative to the repository root/)).toBeInTheDocument();
    // Typing again clears the refusal.
    await userEvent.type(field(), "x");
    expect(field()).not.toHaveAttribute("aria-invalid");
  });

  it("does not write a path already protected twice", async () => {
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={["Makefile"]} onChange={onChange} />);
    await userEvent.type(field(), "Makefile{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(field()).toHaveValue("");
  });

  it("removes an added path from its chip", async () => {
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={["criteria.yml", "pytest.ini"]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Unprotect — pytest.ini" }));
    expect(onChange).toHaveBeenLastCalledWith(["criteria.yml"]);
    expect(screen.queryByRole("list", { name: "Files added by path" })).not.toBeInTheDocument();
  });
});
