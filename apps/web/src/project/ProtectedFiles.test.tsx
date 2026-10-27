import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { pickerRows, ProtectedFiles } from "./ProtectedFiles";

/*
 * The protected files (F-PROJ-01, F-PROJ-08, ADR-119 §9): picked from the
 * handed-out tree by checkboxes, a directory protecting its content, the
 * entries a grading mode forces ticked and held.
 */

const TREE = [
  { path: ".github", type: "tree" as const },
  { path: ".github/workflows", type: "tree" as const },
  { path: ".github/workflows/grading.yml", type: "blob" as const },
  { path: "README.md", type: "blob" as const },
  { path: "criteria.yml", type: "blob" as const },
  { path: "tests", type: "tree" as const },
  { path: "tests/test_lab.py", type: "blob" as const },
  { path: "tests/conftest.py", type: "blob" as const },
];

function Harness({ initial, forced, onChange }: { initial: string[]; forced?: string[]; onChange: (files: string[]) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ProtectedFiles
      tree={TREE}
      value={value}
      forced={forced}
      onChange={(files) => {
        setValue(files);
        onChange(files);
      }}
    />
  );
}

const box = (name: string) => screen.getByRole("checkbox", { name });

describe("ProtectedFiles", () => {
  it("draws directories first, a listed path the tree lacks at its place", () => {
    expect(pickerRows(TREE, ["docs/old.md"]).map((r) => `${"  ".repeat(r.depth)}${r.name}`)).toEqual([
      ".github",
      "  workflows",
      "    grading.yml",
      "docs",
      "  old.md",
      "tests",
      "  conftest.py",
      "  test_lab.py",
      "criteria.yml",
      "README.md",
    ]);
  });

  it("protects a file by its checkbox, and a directory with its content", async () => {
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={["tests/test_lab.py"]} onChange={onChange} />);
    // The directory holding a protected file starts open.
    expect(box("tests/test_lab.py")).toBeChecked();
    await userEvent.click(box("README.md"));
    expect(onChange).toHaveBeenLastCalledWith(["tests/test_lab.py", "README.md"]);
    // The directory covers its content: listed alone, its files ticked and held.
    await userEvent.click(box("tests"));
    expect(onChange).toHaveBeenLastCalledWith(["README.md", "tests"]);
    expect(box("tests/conftest.py")).toBeChecked();
    expect(box("tests/conftest.py")).toBeDisabled();
    await userEvent.click(box("tests"));
    expect(onChange).toHaveBeenLastCalledWith(["README.md"]);
  });

  it("opens and closes a directory", async () => {
    renderWithProviders(<Harness initial={[]} onChange={vi.fn()} />);
    expect(screen.queryByRole("checkbox", { name: "tests/test_lab.py" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open tests" }));
    expect(box("tests/test_lab.py")).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Close tests" }));
    expect(screen.queryByRole("checkbox", { name: "tests/test_lab.py" })).not.toBeInTheDocument();
  });

  it("holds the forced entries ticked: they cannot be unticked", async () => {
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={["README.md"]} forced={[".github/workflows", "criteria.yml"]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Open .github/workflows" }));
    for (const name of [".github/workflows", "criteria.yml", ".github/workflows/grading.yml"]) {
      expect(box(name)).toBeChecked();
      expect(box(name)).toBeDisabled();
      await userEvent.click(box(name));
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByText("required")).toHaveLength(2);
    expect(screen.getByText("Grading by criteria protects the workflows and criteria.yml.")).toBeInTheDocument();
    // Protected through its directory: no warning.
    expect(screen.queryByText(/workflow can be changed by students/)).not.toBeInTheDocument();
  });

  it("warns while the grading workflow is unprotected", async () => {
    renderWithProviders(<Harness initial={[".github/workflows/grading.yml"]} onChange={vi.fn()} />);
    expect(screen.queryByText(/workflow can be changed by students/)).not.toBeInTheDocument();
    await userEvent.click(box(".github/workflows/grading.yml"));
    expect(screen.getByText(/workflow can be changed by students/)).toBeInTheDocument();
  });
});
