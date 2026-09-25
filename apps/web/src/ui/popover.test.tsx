import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Popover } from "./popover";

/*
 * What the card promises: it opens the way it was told to, it closes on every
 * exit a floating layer has, and the focus comes back to the trigger it was
 * taken from.
 */

const CARD = "Marie Dupont";

function renderPopover(mode: "click" | "hover" = "click") {
  renderWithProviders(
    <Popover
      label={CARD}
      open={mode}
      trigger={<button type="button">Open the card</button>}
    >
      <p>marie.dupont@heig-vd.ch</p>
    </Popover>,
  );
  return screen.getByRole("button", { name: "Open the card" });
}

afterEach(() => vi.useRealTimers());

describe("Popover — click", () => {
  it("announces itself as a dialog trigger and toggles on click", async () => {
    const trigger = renderPopover();
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: CARD })).toBeVisible();

    await userEvent.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and hands the focus back", async () => {
    const trigger = renderPopover();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens from the keyboard with the focus inside the card", async () => {
    const trigger = renderPopover();
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const panel = screen.getByRole("dialog", { name: CARD });
    // Opened by keyboard: the reader is IN the card, not still on the disc.
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("closes on an outside click", async () => {
    const trigger = renderPopover();
    await userEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Popover — hover", () => {
  it("opens after the delay and closes when the pointer leaves", () => {
    vi.useFakeTimers();
    const trigger = renderPopover("hover");

    fireEvent.mouseEnter(trigger);
    // Not at once: a pointer crossing the disc on its way elsewhere opens
    // nothing.
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.getByRole("dialog", { name: CARD })).toBeVisible();

    fireEvent.mouseLeave(trigger);
    // The grace that lets the pointer travel to the panel.
    expect(screen.getByRole("dialog", { name: CARD })).toBeVisible();
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open while the pointer is over the panel", () => {
    vi.useFakeTimers();
    const trigger = renderPopover("hover");
    fireEvent.mouseEnter(trigger);
    act(() => void vi.advanceTimersByTime(200));

    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(screen.getByRole("dialog", { name: CARD }));
    act(() => void vi.advanceTimersByTime(400));
    expect(screen.getByRole("dialog", { name: CARD })).toBeVisible();
  });
});

describe("Popover — page scroll", () => {
  /** The trigger's box, as the layout would report it after a scroll. */
  function placeTrigger(trigger: HTMLElement, top: number) {
    const anchor = trigger.parentElement!;
    anchor.getBoundingClientRect = () =>
      ({ top, bottom: top + 30, left: 100, right: 200, width: 100, height: 30, x: 100, y: top }) as DOMRect;
  }

  it("stays open and follows its trigger while the trigger is on screen", async () => {
    const trigger = renderPopover();
    placeTrigger(trigger, 100);
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: CARD });
    // A scroll the reader did not make: acting in the card shortened the
    // page and the browser clamped it. The trigger moved, but is still there.
    // (A page scroll targets the document, as a browser's does.)
    placeTrigger(trigger, 60);
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByRole("dialog", { name: CARD })).toBe(dialog);
    expect(dialog.style.top).toBe("96px");
  });

  it("closes once the scroll has taken the trigger off screen", async () => {
    const trigger = renderPopover();
    placeTrigger(trigger, 100);
    await userEvent.click(trigger);
    placeTrigger(trigger, -80);
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
