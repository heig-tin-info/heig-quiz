import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Tip } from ".";

describe("Tip", () => {
  it("appears after the delay on hover and leaves on Escape", () => {
    vi.useFakeTimers();
    renderWithProviders(
      <Tip label="Lock repository (block pushes)">
        <button type="button">Lock</button>
      </Tip>,
    );
    const anchor = screen.getByRole("button", { name: "Lock" }).parentElement!;
    fireEvent.mouseEnter(anchor);
    // Nothing yet: the bubble waits 120 ms, so brushing past a row is silent.
    expect(screen.queryByText("Lock repository (block pushes)")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("Lock repository (block pushes)")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Lock repository (block pushes)")).toBeNull();
  });

  it("gives way to the click on a trigger that keeps its click to itself", () => {
    vi.useFakeTimers();
    renderWithProviders(
      <Tip label="Ada Lovelace" side="right">
        <span onClick={(e) => e.stopPropagation()}>
          <button type="button">Account</button>
        </span>
      </Tip>,
    );
    const button = screen.getByRole("button", { name: "Account" });
    fireEvent.mouseEnter(button.parentElement!.parentElement!);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    // A `Menu` trigger stops its click from bubbling: the Tip still hears it.
    fireEvent.click(button);
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    vi.useRealTimers();
  });

  it("renders the child untouched when there is no label", () => {
    const { container } = renderWithProviders(
      <Tip label={null}>
        <button type="button">Lock</button>
      </Tip>,
    );
    const button = screen.getByRole("button", { name: "Lock" });
    expect(button.parentElement).toBe(container);
  });
});
