import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { SyncBadge, type SyncState } from ".";

describe("SyncBadge", () => {
  const states: SyncState[] = ["saved", "saving", "offline", "closed"];

  it("is a polite status with an icon and a word in every state", () => {
    for (const state of states) {
      const { container, unmount } = renderWithProviders(<SyncBadge state={state} />);
      const badge = screen.getByRole("status");
      expect(badge).toHaveAttribute("aria-live", "polite");
      expect(container.querySelector("svg")).not.toBeNull();
      expect(badge.textContent?.trim()).not.toBe("");
      unmount();
    }
  });

  it("reads the four states out", () => {
    renderWithProviders(
      <>
        <SyncBadge state="saved" />
        <SyncBadge state="saving" />
        <SyncBadge state="offline" />
        <SyncBadge state="closed" />
      </>,
    );
    for (const word of ["Saved", "Saving…", "Offline", "Closed"]) {
      expect(screen.getAllByText(word).length).toBeGreaterThan(0);
    }
  });

  it("spins only while it is saving", () => {
    const { container, rerender } = renderWithProviders(<SyncBadge state="saving" />);
    expect(container.querySelector("svg")).toHaveClass("animate-spin");
    rerender(<SyncBadge state="saved" />);
    expect(container.querySelector("svg")).not.toHaveClass("animate-spin");
  });

  it("speaks French when the locale does", () => {
    renderWithProviders(<SyncBadge state="offline" />, { locale: "fr" });
    expect(screen.getAllByText("Hors ligne").length).toBeGreaterThan(0);
  });
});
