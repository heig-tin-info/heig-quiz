import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdvancedDisclosure, EditorSection, PromptSection } from "./sections.js";

describe("EditorSection", () => {
  it("is a card with its title, its hint and its fields, in that order", () => {
    const { container } = render(
      <EditorSection title="Supplies" hint="The rails the student may use.">
        <input aria-label="VCC" />
      </EditorSection>,
    );
    const section = container.querySelector("section");
    expect(section?.className).toBe("rounded-card border border-line bg-surface flex flex-col gap-3 p-4");
    expect([...section!.children].map((el) => el.tagName)).toEqual(["H3", "P", "INPUT"]);
    expect(screen.getByRole("heading", { name: "Supplies" })).toBeInTheDocument();
  });

  it("draws no heading of its own without a title, and takes the wider rhythm on request", () => {
    const { container } = render(
      <EditorSection gap="gap-4">
        <span>custom header</span>
      </EditorSection>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelector("section")?.className).toContain("gap-4");
  });
});

describe("PromptSection", () => {
  it("edits the statement and lists its issues under it, then the caller's fields", () => {
    const onChange = vi.fn();
    render(
      <PromptSection
        title="Question"
        id="p"
        label="Statement"
        value="Old"
        onChange={onChange}
        rows={5}
        issues={[{ path: ["prompt"], message: "too short" }]}
      >
        <select aria-label="Language" />
      </PromptSection>,
    );
    expect(screen.getByRole("heading", { name: "Question" })).toBeInTheDocument();
    const field = screen.getByLabelText("Statement");
    expect(field).toHaveAttribute("rows", "5");
    fireEvent.change(field, { target: { value: "New" } });
    expect(onChange).toHaveBeenCalledWith("New");
    expect(screen.getByText("too short")).toBeInTheDocument();
    expect(screen.getByLabelText("Language")).toBeInTheDocument();
  });
});

describe("AdvancedDisclosure", () => {
  it("folds its body under a summary, laid out by the caller", () => {
    const { container } = render(
      <AdvancedDisclosure summary="Advanced options" className="flex flex-col gap-3">
        <span>budget</span>
      </AdvancedDisclosure>,
    );
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Advanced options");
    expect(screen.getByText("budget").parentElement?.className).toBe("mt-4 flex flex-col gap-3");
  });
});
