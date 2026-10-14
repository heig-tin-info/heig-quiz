import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Wrench } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lowScreen, phoneScreen } from "../test/viewport";
import { ToolDock } from "./toolDock";

/*
 * The tool dock's panel (ADR-069, ADR-080): non-modal, except on a phone
 * for a dock that asks for it (`sheetOnPhone`, the help assistant, #450,
 * #849), where it is a modal full-height sheet.
 */
const normal = window.matchMedia;
const realViewport = window.visualViewport;
afterEach(() => {
  // Not `unstubAllGlobals`: it would also drop the setup's `ResizeObserver` and `matchMedia`.
  vi.stubGlobal("matchMedia", normal);
  vi.stubGlobal("visualViewport", realViewport);
});

function dock(sheetOnPhone: boolean) {
  return render(tool(sheetOnPhone));
}

function tool(sheetOnPhone: boolean) {
  return (
    <ToolDock
      icon={Wrench}
      openLabel="Open tool"
      closeLabel="Close tool"
      offset="0px"
      panelClassName="w-80"
      sheetOnPhone={sheetOnPhone}
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
  it("opens a non-modal panel by default, even on a low screen without sheetOnPhone", async () => {
    lowScreen();
    dock(false);
    await userEvent.click(screen.getByRole("button", { name: "Open tool" }));
    expect(screen.getByRole("dialog", { name: "Tool" })).toHaveAttribute("aria-modal", "false");
    expect(document.body.style.overflow).toBe("");
  });

  it("with sheetOnPhone, stays a floating panel on a screen that is not a phone's", async () => {
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

  it("on a phone held upright, opens the same modal sheet (#849)", async () => {
    phoneScreen();
    dock(true);
    await userEvent.click(screen.getByRole("button", { name: "Open tool" }));
    const panel = screen.getByRole("dialog", { name: "Tool" });
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(panel.className).toContain("inset-x-0");
    expect(panel.className).not.toContain("w-80");
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("fits the sheet into what a soft keyboard leaves of the window (#849)", async () => {
    // iOS: the keyboard covers the bottom of the window and pans what is seen 40 px down.
    const vv = Object.assign(new EventTarget(), { offsetTop: 40, height: 400, scale: 1 });
    vi.stubGlobal("visualViewport", vv);
    phoneScreen();
    dock(true);
    await userEvent.click(screen.getByRole("button", { name: "Open tool" }));
    const panel = screen.getByRole("dialog", { name: "Tool" });
    expect(panel.style.top).toBe("calc(40px + var(--banner-h) + 0.75rem)");
    expect(panel.style.height).toBe("calc(400px - var(--banner-h) - 0.75rem)");
    // The keyboard goes: the sheet takes the window again.
    Object.assign(vv, { offsetTop: 0, height: 780 });
    act(() => {
      vv.dispatchEvent(new Event("resize"));
    });
    expect(panel.style.top).toBe("calc(0px + var(--banner-h) + 0.75rem)");
    expect(panel.style.height).toBe("calc(780px - var(--banner-h) - 0.75rem)");
  });

  it("keeps the sheet it opened as while the window turns wide, focus and all", async () => {
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
