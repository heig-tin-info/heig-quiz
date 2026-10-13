import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Wrench } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lowScreen } from "../test/viewport";
import { ToolDock } from "./toolDock";

/*
 * The tool dock's panel (ADR-069, ADR-080): non-modal, except on a low
 * screen for a dock that asks for it (`sheetWhenLow`, the help assistant,
 * #450), where it is a modal full-height sheet.
 */
const normal = window.matchMedia;
afterEach(() => vi.stubGlobal("matchMedia", normal));

function dock(sheetWhenLow: boolean) {
  return render(tool(sheetWhenLow));
}

function tool(sheetWhenLow: boolean) {
  return (
    <ToolDock
      icon={Wrench}
      openLabel="Open tool"
      closeLabel="Close tool"
      offset="0px"
      panelClassName="w-80"
      sheetWhenLow={sheetWhenLow}
    >
      {(close, titleId) => (
        <>
          <h2 id={titleId}>Tool</h2>
          <input aria-label="Field" />
          <button type="button" onClick={close}>
            Done
          </button>
        </>
      )}
    </ToolDock>
  );
}

describe("ToolDock", () => {
  it("opens a non-modal panel by default, even on a low screen without sheetWhenLow", async () => {
    lowScreen();
    dock(false);
    await userEvent.click(screen.getByRole("button", { name: "Open tool" }));
    expect(screen.getByRole("dialog", { name: "Tool" })).toHaveAttribute("aria-modal", "false");
    expect(document.body.style.overflow).toBe("");
  });

  it("with sheetWhenLow, stays a floating panel on a screen that is not low", async () => {
    dock(true);
    await userEvent.click(screen.getByRole("button", { name: "Open tool" }));
    const panel = screen.getByRole("dialog", { name: "Tool" });
    expect(panel).toHaveAttribute("aria-modal", "false");
    expect(panel.className).toContain("w-80");
  });

  it("on a low screen, opens a modal sheet: focus inside, scroll locked, Escape gives the focus back", async () => {
    lowScreen();
    dock(true);
    const trigger = screen.getByRole("button", { name: "Open tool" });
    await userEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Tool" });
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(panel.className).toContain("inset-x-0");
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
  });

  it("keeps the sheet it opened as while the phone rotates to portrait, focus and all", async () => {
    lowScreen();
    const { rerender } = dock(true);
    await userEvent.click(screen.getByRole("button", { name: "Open tool" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Field" }), "ab");
    vi.stubGlobal("matchMedia", normal);
    rerender(tool(true));
    expect(screen.getByRole("dialog", { name: "Tool" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("textbox", { name: "Field" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("keeps the floating panel it opened as while the phone rotates to landscape: no trap mid-typing", async () => {
    const { rerender } = dock(true);
    await userEvent.click(screen.getByRole("button", { name: "Open tool" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Field" }), "ab");
    lowScreen();
    rerender(tool(true));
    expect(screen.getByRole("dialog", { name: "Tool" })).toHaveAttribute("aria-modal", "false");
    expect(screen.getByRole("textbox", { name: "Field" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  it("decides again at the next opening", async () => {
    const { rerender } = dock(true);
    const trigger = screen.getByRole("button", { name: "Open tool" });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    lowScreen();
    rerender(tool(true));
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Tool" })).toHaveAttribute("aria-modal", "true");
  });
});
