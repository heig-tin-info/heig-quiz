import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { TabPanel, Tabs } from ".";

type DemoTab = "assignments" | "students" | "staff";

function TabsHarness({ onChange }: { onChange: (v: DemoTab) => void }) {
  const [value, setValue] = useState<DemoTab>("assignments");
  return (
    <>
      <Tabs
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
        idPrefix="classroom"
        label="Classroom sections"
        items={[
          { value: "assignments", label: "Assignments" },
          { value: "students", label: "Students", count: 24 },
          { value: "staff", label: "Staff" },
        ]}
      />
      <TabPanel idPrefix="classroom" value={value}>
        {value}
      </TabPanel>
    </>
  );
}

describe("Tabs", () => {
  it("keeps one tab in the Tab order (roving tabindex)", () => {
    renderWithProviders(<TabsHarness onChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: /Assignments/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: /Students/ })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: /Assignments/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("selects the next tab on ArrowRight and wraps on the last one", async () => {
    const onChange = vi.fn();
    renderWithProviders(<TabsHarness onChange={onChange} />);
    const tablist = screen.getByRole("tablist", { name: "Classroom sections" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("students");
    expect(screen.getByRole("tab", { name: /Students/ })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Students/ }));
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("assignments");
  });

  it("jumps to the ends with Home and End", () => {
    const onChange = vi.fn();
    renderWithProviders(<TabsHarness onChange={onChange} />);
    const tablist = screen.getByRole("tablist", { name: "Classroom sections" });
    fireEvent.keyDown(tablist, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("staff");
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("assignments");
  });

  it("keeps the strip reachable when the value matches no tab", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Tabs
        value={"nonsense" as DemoTab}
        onChange={onChange}
        label="Classroom sections"
        items={[
          { value: "assignments", label: "Assignments" },
          { value: "students", label: "Students" },
        ]}
      />,
    );
    // No tab is selected, but the first one still holds the Tab order,
    // otherwise a hand-edited ?tab= takes the whole strip off the keyboard.
    expect(screen.getByRole("tab", { name: "Assignments" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Assignments" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    fireEvent.keyDown(screen.getByRole("tablist", { name: "Classroom sections" }), {
      key: "ArrowRight",
    });
    expect(onChange).toHaveBeenLastCalledWith("students");
  });

  /*
   * W2: `aria-controls` is a promise. Only one panel is rendered at a time,
   * so only the SELECTED tab may name one; the others named ids no element
   * carried, which axe reports as an invalid attribute value and a reader
   * follows into nothing.
   */
  it("points the selected tab at a panel that exists, and the others at nothing", async () => {
    renderWithProviders(<TabsHarness onChange={vi.fn()} />);
    const selected = screen.getByRole("tab", { name: /Assignments/ });
    expect(selected).toHaveAttribute("id", "classroom-tab-assignments");
    expect(selected).toHaveAttribute("aria-controls", "classroom-panel-assignments");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", "classroom-panel-assignments");
    expect(panel).toHaveAttribute("aria-labelledby", "classroom-tab-assignments");

    const other = screen.getByRole("tab", { name: /Students/ });
    expect(other).toHaveAttribute("id", "classroom-tab-students");
    expect(other).not.toHaveAttribute("aria-controls");

    // And the wiring follows the selection.
    await userEvent.click(other);
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "classroom-panel-students");
    expect(screen.getByRole("tab", { name: /Students/ })).toHaveAttribute(
      "aria-controls",
      "classroom-panel-students",
    );
  });
});
